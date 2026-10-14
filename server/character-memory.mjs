import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MODES = new Set(['demo', 'live']);
const SHA256 = /^[a-f0-9]{64}$/i;
const FILE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DESCRIPTOR_VERSION = 'wd-swinv2-v3-pooled-v1';
const DESCRIPTOR_SIZE = 1024;
const MAX_CHARACTERS = 200;
const MAX_SAMPLES = 20;
const MAX_STORE_BYTES = 128 * 1024 * 1024;

export class CharacterMemoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CharacterMemoryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) { throw new CharacterMemoryError('CHARACTER_MEMORY_INVALID_INPUT', message); }
function modeName(mode) { if (!MODES.has(mode)) invalid('角色记忆的使用模式无效。'); return mode; }
function englishTitle(value) {
  if (typeof value !== 'string') invalid('请填写角色的英文名称。');
  if (/[\u0000-\u001f\u007f]/.test(value)) invalid('角色英文名称不能含控制字符。');
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 32 || !/^[A-Za-z0-9][A-Za-z0-9 .'-]*$/.test(name) || !/[A-Za-z]/.test(name)) invalid('角色英文名称最多 32 个字符，请使用英文字母、数字、空格或英文标点。');
  return name.replace(/(^|[ -])([a-z])/g, (_, before, letter) => before + letter.toUpperCase());
}
function tagNames(value) {
  if (!Array.isArray(value) || value.length > 4) invalid('每类角色记忆标签最多填写 4 个。');
  const result = [];
  for (const original of value) {
    if (typeof original !== 'string') invalid('角色记忆标签必须是文字。');
    const tag = original.trim();
    if (!tag || tag.length > 64 || /[\u0000-\u001f\u007f]/.test(tag)) invalid('角色记忆标签须为 1 到 64 个字符，且不能含控制字符。');
    if (!result.includes(tag)) result.push(tag);
  }
  return result;
}
function shaValue(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid('角色参考图片摘要无效。');
  return value.toLowerCase();
}
function fileIdValue(value) {
  if (typeof value !== 'string' || !FILE_ID.test(value)) invalid('角色参考图片标识无效。');
  return value;
}
function descriptorValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== DESCRIPTOR_VERSION || typeof value.modelSha256 !== 'string' || !SHA256.test(value.modelSha256) || !Array.isArray(value.values) || value.values.length !== DESCRIPTOR_SIZE || value.values.some(number => typeof number !== 'number' || !Number.isFinite(number))) invalid('角色参考图片的外观特征无效。');
  const norm = Math.sqrt(value.values.reduce((total, number) => total + number * number, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.005) invalid('角色参考图片的外观特征未正确归一化。');
  return { version: DESCRIPTOR_VERSION, modelSha256: value.modelSha256.toLowerCase(), values: value.values.map(number => number / norm) };
}
function publicIdentity(character) {
  return {
    id: character.id, englishName: character.englishName,
    gameTags: [...character.gameTags], characterTags: [...character.characterTags],
    sampleCount: character.samples.length, updatedAt: character.updatedAt,
    samples: character.samples.map(({ fileId, sha256, addedAt }) => ({ fileId, sha256, addedAt })),
  };
}
function identityKey(character) {
  return JSON.stringify([character.englishName.toLowerCase(), character.gameTags.map(tag => tag.normalize('NFKC').toLowerCase()).sort()]);
}
function validTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }

function validateStore(document) {
  if (!document || document.version !== 1 || !document.modes || !Array.isArray(document.modes.demo) || !Array.isArray(document.modes.live)) invalid('角色记忆文件结构无效。');
  const normalized = { version: 1, modes: { demo: [], live: [] } };
  for (const mode of MODES) {
    const characters = document.modes[mode];
    if (characters.length > MAX_CHARACTERS) invalid('角色记忆数量超出限制。');
    const ids = new Set(), hashes = new Set(), identities = new Set();
    for (const character of characters) {
      if (!character || !UUID.test(character.id || '') || ids.has(character.id) || !validTimestamp(character.updatedAt) || !Array.isArray(character.samples) || !character.samples.length || character.samples.length > MAX_SAMPLES) invalid('角色记忆记录格式无效或重复。');
      ids.add(character.id);
      const item = { id: character.id, englishName: englishTitle(character.englishName), gameTags: tagNames(character.gameTags), characterTags: tagNames(character.characterTags), updatedAt: character.updatedAt, samples: [] };
      const key = identityKey(item);
      if (identities.has(key)) invalid('角色记忆身份重复。');
      identities.add(key);
      for (const sample of character.samples) {
        if (!sample || !validTimestamp(sample.addedAt)) invalid('角色参考图片记录格式无效。');
        const sha256 = shaValue(sample.sha256);
        if (hashes.has(sha256)) invalid('一张参考图片关联了多个角色。');
        hashes.add(sha256);
        item.samples.push({ fileId: fileIdValue(sample.fileId), sha256, addedAt: sample.addedAt, descriptor: descriptorValue(sample.descriptor) });
      }
      normalized.modes[mode].push(item);
    }
  }
  return normalized;
}

/**
 * User-confirmed identities are shared by accounts, but isolated by demo/live
 * mode. Callers must obtain file IDs, hashes and descriptors from trusted local
 * uploads. Similarity is only a reference suggestion, never identity confidence.
 */
export async function createCharacterMemory({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) invalid('角色记忆保存目录无效。');
  const filename = path.join(path.resolve(dataDir), 'character-memory.json');
  let state = { version: 1, modes: { demo: [], live: [] } };
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) invalid('角色记忆文件大小或类型无效。');
    state = validateStore(JSON.parse(await fs.readFile(filename, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new CharacterMemoryError('CHARACTER_MEMORY_CORRUPT', '角色记忆文件无法读取或格式损坏；已保留原文件，请检查后再试。', 503);
  }
  let pending = Promise.resolve();
  function serialized(action) {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }
  async function persist(next) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, filename);
      state = next;
    } catch {
      throw new CharacterMemoryError('CHARACTER_MEMORY_WRITE_FAILED', '角色记忆保存失败，原有记忆未更改。', 503);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  return {
    list({ mode } = {}) {
      return serialized(() => [...state.modes[modeName(mode)]].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(publicIdentity));
    },
    remember({ mode, englishName, gameTags = [], characterTags = [], fileId, sha256, descriptor, confirmedSingleCharacter, characterId } = {}) {
      return serialized(async () => {
        modeName(mode);
        if (confirmedSingleCharacter !== true) invalid('请先确认参考图片中只有这一个角色。');
        const input = { englishName: englishTitle(englishName), gameTags: tagNames(gameTags), characterTags: tagNames(characterTags) };
        const hash = shaValue(sha256), referenceId = fileIdValue(fileId), visual = descriptorValue(descriptor);
        const next = structuredClone(state), characters = next.modes[mode];
        let target;
        if (characterId !== undefined && characterId !== null) {
          if (typeof characterId !== 'string' || !UUID.test(characterId)) invalid('角色记忆标识无效。');
          target = characters.find(character => character.id === characterId);
          if (!target) throw new CharacterMemoryError('CHARACTER_MEMORY_NOT_FOUND', '这个角色记忆已不存在，请刷新后再试。', 404);
          if (characters.some(character => character.id !== target.id && identityKey(character) === identityKey(input))) invalid('已有同名、同作品的角色记忆，请选择该记录。');
        } else {
          target = characters.find(character => identityKey(character) === identityKey(input));
        }
        const oldSample = characters.flatMap(character => character.samples).find(sample => sample.sha256 === hash);
        if (target && !target.samples.some(sample => sample.sha256 === hash) && target.samples.length >= MAX_SAMPLES) throw new CharacterMemoryError('CHARACTER_MEMORY_LIMIT', `每个角色最多保存 ${MAX_SAMPLES} 张参考图片。`, 409);
        const now = new Date().toISOString();
        // Correcting an association moves this image; it never leaves conflicting
        // identities behind, and an identity with no remaining references is removed.
        for (const character of characters) {
          if (character.id === target?.id) continue;
          const before = character.samples.length;
          character.samples = character.samples.filter(sample => sample.sha256 !== hash);
          if (character.samples.length !== before) character.updatedAt = now;
        }
        next.modes[mode] = characters.filter(character => character.samples.length);
        if (!target) {
          if (next.modes[mode].length >= MAX_CHARACTERS) throw new CharacterMemoryError('CHARACTER_MEMORY_LIMIT', `最多保存 ${MAX_CHARACTERS} 个角色。`, 409);
          target = { id: randomUUID(), ...input, updatedAt: now, samples: [] };
          next.modes[mode].push(target);
        }
        Object.assign(target, input, { updatedAt: now });
        const sample = { fileId: referenceId, sha256: hash, addedAt: oldSample?.addedAt || now, descriptor: visual || oldSample?.descriptor || null };
        const existingIndex = target.samples.findIndex(item => item.sha256 === hash);
        if (existingIndex < 0) target.samples.push(sample);
        else target.samples[existingIndex] = sample;
        await persist(next);
        return publicIdentity(target);
      });
    },
    forget({ mode, id } = {}) {
      return serialized(async () => {
        modeName(mode);
        if (typeof id !== 'string' || !UUID.test(id)) invalid('角色记忆标识无效。');
        if (!state.modes[mode].some(character => character.id === id)) return false;
        const next = structuredClone(state);
        next.modes[mode] = next.modes[mode].filter(character => character.id !== id);
        await persist(next);
        return true;
      });
    },
    match({ mode, sha256, descriptor } = {}) {
      return serialized(() => {
        const characters = state.modes[modeName(mode)], hash = shaValue(sha256), visual = descriptorValue(descriptor);
        const exact = characters.find(character => character.samples.some(sample => sample.sha256 === hash));
        const candidates = [];
        if (visual) {
          for (const character of characters) {
            if (character.id === exact?.id) continue;
            let similarity = -1;
            for (const sample of character.samples) {
              const stored = sample.descriptor;
              if (!stored || stored.version !== visual.version || stored.modelSha256 !== visual.modelSha256) continue;
              const score = stored.values.reduce((sum, number, index) => sum + number * visual.values[index], 0);
              similarity = Math.max(similarity, Math.min(1, Math.max(-1, score)));
            }
            if (similarity >= 0.8) candidates.push({ ...publicIdentity(character), similarity });
          }
        }
        candidates.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
        return { exact: exact ? publicIdentity(exact) : null, candidates: candidates.slice(0, 3) };
      });
    },
  };
}
