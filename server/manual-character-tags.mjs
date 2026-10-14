import { knownCharacterTagIdentities, knownCharacterGameFamilies } from './recognition.mjs';

const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_]/g, '');
function clean(values) {
  const found = new Map();
  for (const value of values || []) if (typeof value === 'string' && value.trim() && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
    && !found.has(normalized(value))) found.set(normalized(value), value);
  return [...found.values()];
}
const games = knownCharacterGameFamilies();
// These additional vocabulary entries are usable only when the account's
// verified history/common tags already contain the identity, never from a
// manually pinned name alone. All output tags still need exact Pixiv proof.
const historyAliases = [
  { englishName: 'Robin', game: 'star-rail', characterTags: ['ロビン(スターレイル)', '知更鸟', 'Robin'] },
  { englishName: 'Firefly', game: 'star-rail', characterTags: ['ホタル(スターレイル)', '流萤', 'Firefly'] },
  { englishName: 'Sparkle', game: 'star-rail', characterTags: ['花火(スターレイル)', 'Sparkle'] },
  { englishName: 'Evernight', game: 'star-rail', characterTags: ['長夜月', 'Evernight'] },
  { englishName: 'TheHerta', game: 'star-rail', characterTags: ['マダム・ヘルタ', 'TheHerta'] },
  { englishName: 'Ellen', game: 'zenless', characterTags: ['EllenJoe', 'Ellen Joe', 'Ellen'] },
];
// Vocabulary is also useful to list a verified common-tag identity that has
// fallen outside the recent-work window. It is never proof of tag existence.
export function knownManualCharacterTagIdentities() {
  return [...knownCharacterTagIdentities(), ...historyAliases.map(identity => ({ ...identity,
    gameTags: [...games.find(game => game.key === identity.game).tags], characterTags: [...identity.characterTags] }))];
}
const gameForTag = tag => games.find(game => game.tags.some(word => normalized(word) === normalized(tag)));
const gameForQualifier = tag => {
  const match = String(tag).normalize('NFKC').match(/^.+\(([^)]+)\)$/);
  return match ? games.find(game => game.qualifiers.some(word => normalized(word) === normalized(match[1]))) : null;
};
const gameKey = tags => [...new Set(tags.map(tag => gameForTag(tag)?.key || `custom:${normalized(tag)}`))].sort().join('|');
const sameName = (name, identity) => [identity.englishName, ...(identity.characterTags || [])].some(value => normalized(value) === normalized(name));
const fromMemory = character => ({ id: `memory:${character.id}`, englishName: character.englishName,
  gameTags: clean(character.gameTags), characterTags: clean([...(character.characterTags || []), character.englishName]),
  confirmedGameTags: clean(character.gameTags), confirmedCharacterTags: clean(character.characterTags), source: 'user-memory' });
function preferenceOrder(tags, evidence) {
  const preferred = clean(evidence.preferredTags), frequent = clean(evidence.frequentTags), excluded = new Set(clean(evidence.excludedTags).map(normalized));
  const index = (list, value) => { const rank = list.findIndex(tag => normalized(tag) === normalized(value)); return rank < 0 ? 10000 : rank; };
  return clean(tags).filter(tag => !excluded.has(normalized(tag))).sort((a, b) => index(preferred, a) - index(preferred, b) || index(frequent, a) - index(frequent, b));
}
function histories(evidence) {
  return (evidence.recentWorks || []).filter(work => work && typeof work.title === 'string' && Array.isArray(work.tags));
}
function mergeIdentities(identities) {
  const grouped = new Map();
  for (const identity of identities) {
    const key = `${normalized(identity.englishName)}:${gameKey(identity.gameTags)}`, previous = grouped.get(key);
    if (previous) {
      previous.gameTags = clean([...previous.gameTags, ...identity.gameTags]);
      previous.characterTags = clean([...previous.characterTags, ...identity.characterTags]);
    } else grouped.set(key, { ...identity, gameTags: [...identity.gameTags], characterTags: [...identity.characterTags] });
  }
  return [...grouped.values()];
}
function historyIdentities(name, evidence) {
  const result = [];
  for (const work of histories(evidence).filter(work => normalized(work.title) === normalized(name))) {
    const workTags = clean(work.tags), families = [...new Map(workTags.map(gameForTag).filter(Boolean).map(game => [game.key, game])).values()];
    for (const game of families) {
      const characterTags = workTags.filter(tag => gameForQualifier(tag)?.key === game.key || (normalized(tag) === normalized(name) && !gameForTag(tag)));
      // Only a scoped character tag or the exact declared name can establish
      // identity. Generic scenes/anatomy from a titled old work are not labels.
      if (!characterTags.length) continue;
      const scoped = characterTags.filter(tag => gameForQualifier(tag));
      if (scoped.length > 1) {
        for (const tag of scoped) result.push({ id: `history:${game.key}:${normalized(tag)}`, englishName: name,
          gameTags: game.tags, characterTags: [tag], source: 'pixiv-history', separateIdentity: true });
      } else result.push({ id: `history:${game.key}:${normalized(name)}`, englishName: name,
        gameTags: game.tags, characterTags: clean([...characterTags, name]), source: 'pixiv-history' });
    }
  }
  const remoteTags = clean([...(evidence.frequentTags || []), ...histories(evidence).flatMap(work => work.tags)]);
  const directGame = gameForQualifier(name);
  if (directGame && remoteTags.some(tag => normalized(tag) === normalized(name))) {
    result.push({ id: `history:${directGame.key}:${normalized(name)}`, englishName: name,
      gameTags: directGame.tags, characterTags: [name], source: 'pixiv-history' });
  }
  for (const identity of historyAliases.filter(identity => sameName(name, identity))) {
    const game = games.find(game => game.key === identity.game);
    const observed = identity.characterTags.filter(tag => remoteTags.some(value => normalized(value) === normalized(tag)));
    const scoped = observed.some(tag => gameForQualifier(tag)?.key === game.key);
    const associated = histories(evidence).some(work => work.tags.some(tag => gameForTag(tag)?.key === game.key)
      && work.tags.some(tag => observed.some(value => normalized(value) === normalized(tag))));
    if (scoped || associated) result.push({ id: `history:${game.key}:${normalized(identity.englishName)}`, englishName: identity.englishName,
      gameTags: game.tags, characterTags: identity.characterTags, source: 'pixiv-history' });
  }
  return result;
}

export function planManualCharacterTags({ name, characters = [], evidence = {} } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    return { status: 'not-found', name: '', queries: [], candidates: [], gameTags: [], characterTags: [], tags: [], source: null, message: '请填写明确的角色名称。' };
  }
  name = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const memories = characters.filter(character => sameName(name, character)).map(fromMemory);
  const known = knownCharacterTagIdentities().filter(identity => sameName(name, identity)).map(identity => ({ ...identity, id: `known:${identity.name}`, source: 'known-alias' }));
  const declared = [...known, ...historyAliases.filter(identity => sameName(name, identity)).map(identity => ({ ...identity,
    id: `known:${identity.game}:${normalized(identity.englishName)}`, gameTags: games.find(game => game.key === identity.game).tags, source: 'known-alias' }))];
  const historic = historyIdentities(name, evidence).map(identity => {
    const canonical = declared.find(item => gameKey(item.gameTags) === gameKey(identity.gameTags));
    return canonical ? { ...identity, englishName: canonical.englishName } : identity;
  });
  const conflicting = historic.filter(identity => {
    const expected = declared.filter(item => gameKey(item.gameTags) === gameKey(identity.gameTags));
    return expected.length && identity.characterTags.some(tag => gameForQualifier(tag)
      && !expected.some(item => item.characterTags.some(alias => normalized(alias) === normalized(tag))));
  });
  const uncertainScoped = new Map();
  for (const identity of historic) {
    const key = gameKey(identity.gameTags);
    if (!declared.some(item => gameKey(item.gameTags) === key)) {
      const tags = uncertainScoped.get(key) || new Set();
      for (const tag of identity.characterTags.filter(gameForQualifier)) tags.add(normalized(tag));
      uncertainScoped.set(key, tags);
    }
  }
  const historicalConflict = conflicting.length || [...uncertainScoped.values()].some(tags => tags.size > 1);
  let identities;
  if (historicalConflict && !memories.some(memory => memory.confirmedGameTags.length && memory.confirmedCharacterTags.length)) {
    identities = [...new Map([...conflicting, ...declared, ...historic].map(identity => [`${identity.id}:${identity.characterTags.join('|')}`, identity])).values()];
  } else if (memories.length) identities = memories.map(memory => {
    if (memory.confirmedGameTags.length && memory.confirmedCharacterTags.length) return memory;
    const alternatives = mergeIdentities([...historic, ...known]).filter(identity => !memory.gameTags.length || gameKey(identity.gameTags) === gameKey(memory.gameTags));
    return alternatives.length === 1 ? { ...memory, gameTags: memory.gameTags.length ? memory.gameTags : alternatives[0].gameTags,
      characterTags: clean([...memory.characterTags, ...alternatives[0].characterTags]) } : memory;
  });
  else {
    // Multiple scoped characters on one exact-title work cannot be collapsed
    // merely because the work has one English title.
    const separate = historic.filter(identity => identity.separateIdentity);
    identities = separate.length > 1 ? separate : mergeIdentities([...historic, ...known]);
  }
  const candidates = identities.map(identity => ({ id: identity.id, englishName: identity.englishName,
    gameTags: [...identity.gameTags], characterTags: [...identity.characterTags], source: identity.source }));
  const base = { name, candidates, gameTags: [], characterTags: [], tags: [], evidence: structuredClone(evidence) };
  if (identities.length !== 1) return { ...base, status: identities.length ? 'ambiguous' : 'not-found', queries: [], source: null,
    message: identities.length ? '这个名称对应多个角色或游戏，请填写更明确的角色标签。' : '尚无可靠的角色与游戏对应记录，请手动选择标签或补充角色记忆。' };
  const identity = identities[0], queries = [];
  const gameTags = preferenceOrder(identity.gameTags, evidence), characterTags = preferenceOrder(identity.characterTags, evidence);
  for (const [tagRole, tags] of [['game', gameTags], ['character', characterTags]]) for (const word of tags) {
    if (!queries.some(query => normalized(query.word) === normalized(word))) queries.push({ word, tagRole, concept: `${tagRole}:${identity.id}` });
  }
  return { ...base, status: 'resolved', identity, queries: queries.slice(0, 32), source: identity.source,
    message: '已根据手动填写的名称确定角色，正在核实对应的 Pixiv 标签。' };
}

export function resolveManualCharacterTags(plan, searched = {}) {
  const base = { status: plan.status, name: plan.name, candidates: plan.candidates || [], gameTags: [], characterTags: [], tags: [],
    source: null, identitySource: plan.identity?.source || plan.source || null, message: plan.message };
  if (plan.status !== 'resolved' || !plan.identity) return base;
  const evidence = { ...plan.evidence, ...searched, preferredTags: searched.preferredTags || plan.evidence?.preferredTags || [],
    excludedTags: searched.excludedTags || plan.evidence?.excludedTags || [] };
  if (plan.identity.source === 'user-memory' && plan.identity.confirmedGameTags?.length && plan.identity.confirmedCharacterTags?.length) {
    const gameTags = preferenceOrder(plan.identity.confirmedGameTags, evidence).slice(0, 4);
    const characterTags = preferenceOrder(plan.identity.confirmedCharacterTags, evidence).slice(0, 4);
    if (gameTags.length && characterTags.length) return { ...base, status: 'resolved', identity: { id: plan.identity.id, englishName: plan.identity.englishName },
      gameTags, characterTags, tags: [...gameTags, ...characterTags], source: 'user-memory',
      evidence: [{ kind: 'user_character_memory', id: plan.identity.id }], message: '已使用你在角色记忆中明确保存的游戏与角色标签。' };
  }
  const matched = [];
  for (const query of plan.queries) for (const match of searched.matches || []) {
    const cached = match.source === 'pixiv-cache' || searched.cached === true || searched.source === 'pixiv-cache';
    if (typeof match.tag !== 'string' || normalized(match.word) !== normalized(query.word) || normalized(match.tag) !== normalized(query.word)
      || match.verified === false || (cached && match.verified !== true) || !Number.isFinite(Date.parse(match.checkedAt || searched.checkedAt))) continue;
    let url;
    try { url = new URL(match.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'www.pixiv.net') continue;
    matched.push({ tag: match.tag, tagRole: query.tagRole, cached, checkedAt: match.checkedAt || searched.checkedAt, url: match.url });
  }
  const select = role => {
    const ordered = preferenceOrder(matched.filter(item => item.tagRole === role).map(item => item.tag), evidence);
    const selected = ordered.slice(0, 1);
    // Repeated bilingual spellings are kept only when this account actually
    // used the pair together in at least two old works.
    for (const tag of ordered.slice(1)) {
      const paired = histories(evidence).filter(work => selected.every(prior => work.tags.some(value => normalized(value) === normalized(prior)))
        && work.tags.some(value => normalized(value) === normalized(tag))).length;
      if (paired >= 2) selected.push(tag);
      if (selected.length === 4) break;
    }
    const positions = tag => { const entries = histories(evidence).map(work => work.tags.findIndex(value => normalized(value) === normalized(tag))).filter(index => index >= 0);
      return entries.length ? entries.reduce((total, index) => total + index, 0) / entries.length : 10000; };
    return selected.sort((a, b) => positions(a) - positions(b));
  };
  const gameTags = select('game'), characterTags = select('character');
  if (!gameTags.length || !characterTags.length) return { ...base, status: 'not-found', message: '角色或游戏标签尚未完成 Pixiv 精确核实，暂未自动加入。' };
  const proof = matched.filter(item => [...gameTags, ...characterTags].some(tag => normalized(tag) === normalized(item.tag)));
  const source = proof.every(item => item.cached) ? 'pixiv-cache' : proof.some(item => item.cached) ? 'mixed' : 'pixiv';
  return { ...base, status: 'resolved', identity: { id: plan.identity.id, englishName: plan.identity.englishName }, gameTags, characterTags,
    tags: [...gameTags, ...characterTags].slice(0, 8), source, evidence: proof,
    message: '已按手动填写的角色名称加入对应游戏与角色标签。' };
}
