import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRecognition } from './recognition.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_WORK_BYTES = 200 * 1024 * 1024;
const DESCRIPTOR_VERSION = 'wd-swinv2-v3-pooled-v1';
const DESCRIPTOR_DIMENSIONS = 1024;
const RATING_NAMES = new Set(['general', 'sensitive', 'questionable', 'explicit', 'safe', 'rating:general', 'rating:sensitive', 'rating:questionable', 'rating:explicit']);

export class TaggerError extends Error {
  constructor(code, message, status = 503) { super(message); this.name = 'TaggerError'; this.code = code; this.status = status; }
}

function error(code, message, status) { return new TaggerError(code, message, status); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function normalizeName(value) { return value.trim().normalize('NFKC').toLowerCase().replaceAll(' ', '_'); }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function conciseFailure(value) {
  const message = typeof value === 'string' ? value : value?.message;
  return nonempty(message) ? message.slice(0, 500) : '本地图像识别服务未能完成请求。';
}

/** Static mappings supply search terms. Only legacy evidence can verify tags. */
export async function loadTagCatalog(catalogPath = path.join(DEFAULT_ROOT, 'server', 'tag-catalog.json')) {
  let raw, document;
  try { raw = await fs.readFile(catalogPath); document = JSON.parse(raw); }
  catch { throw error('TAG_CATALOG_UNAVAILABLE', '本地标签映射库不存在或格式无效。'); }
  const staticMapping = document.schemaVersion === 2 && document.kind === 'static_mapping';
  if ((!staticMapping && document.schemaVersion !== 1) || !nonempty(document.version) || !Array.isArray(document.entries) || !Array.isArray(document.evidence)
    || (staticMapping && document.evidence.length)) throw error('TAG_CATALOG_INVALID', '本地标签映射库结构无效。');
  const evidence = new Map();
  for (const item of document.evidence) {
    if (!item || !nonempty(item.id) || evidence.has(item.id) || item.kind !== 'user_screenshot' || !nonempty(item.image) || path.basename(item.image) !== item.image || !SHA256.test(item.sha256 || '') || !/^\d{4}-\d{2}-\d{2}$/.test(item.observedAt || '') || !nonempty(item.provenance) || !Array.isArray(item.verifiedTags) || !item.verifiedTags.every(nonempty)) {
      throw error('TAG_CATALOG_INVALID', '标签证据需要原始截图名称、SHA-256、日期及可见标签记录。');
    }
    evidence.set(item.id, structuredClone(item));
  }
  const names = new Map(), tags = new Set(), ids = new Set();
  for (const entry of document.entries) {
    if (!entry || !nonempty(entry.id) || ids.has(entry.id) || !nonempty(entry.tag) || entry.tag.length > 64 || tags.has(entry.tag) || !Array.isArray(entry.modelNames) || !entry.modelNames.length || !entry.modelNames.every(nonempty) || !Array.isArray(entry.evidenceIds)
      || (staticMapping ? entry.evidenceIds.length !== 0 : !entry.evidenceIds.length)) throw error('TAG_CATALOG_INVALID', '标签映射格式无效或重复。');
    ids.add(entry.id); tags.add(entry.tag);
    const sources = entry.evidenceIds.map(id => evidence.get(id));
    if (sources.some(source => !source || !source.verifiedTags.includes(entry.tag))) throw error('TAG_CATALOG_INVALID', '标签映射缺少明确支持该标签的来源证据。');
    for (const originalName of entry.modelNames) {
      const name = normalizeName(originalName);
      if (RATING_NAMES.has(name) || names.has(name)) throw error('TAG_CATALOG_INVALID', '标签映射重复，或试图把模型评级作为作品标签。');
      names.set(name, { ...structuredClone(entry), evidence: structuredClone(sources), verified: !staticMapping });
    }
  }
  return { version: document.version, sha256: hash(raw), entries: document.entries.length, names, evidence: [...evidence.values()] };
}

function modelMetadata(response) {
  if (!nonempty(response.model) || !nonempty(response.modelVersion) || !Array.isArray(response.modelFiles) || !response.modelFiles.length || response.modelFiles.some(file => !file || !nonempty(file.name) || !SHA256.test(file.sha256 || ''))) {
    throw error('TAGGER_PROTOCOL', '识图服务未提供有效模型版本及原始模型文件摘要。', 502);
  }
  if (response.manifestSha256 !== undefined && !SHA256.test(response.manifestSha256)) throw error('TAGGER_PROTOCOL', '识图服务的模型清单摘要无效。', 502);
  const provenance = response.provenance || (response.manifestSha256 ? { manifestSha256: response.manifestSha256, sources: response.sources || [] } : null);
  return { model: response.model, modelVersion: response.modelVersion, modelFiles: structuredClone(response.modelFiles), ...(provenance ? { provenance: structuredClone(provenance) } : {}) };
}

function validatedDescriptor(value, metadata) {
  const modelSha256 = metadata.modelFiles.find(file => file.name === 'model.onnx')?.sha256;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'modelSha256', 'values'].includes(key))
    || value.version !== DESCRIPTOR_VERSION || typeof value.modelSha256 !== 'string' || !SHA256.test(value.modelSha256)
    || typeof modelSha256 !== 'string' || value.modelSha256.toLowerCase() !== modelSha256.toLowerCase()
    || !Array.isArray(value.values) || value.values.length !== DESCRIPTOR_DIMENSIONS
    || value.values.some(item => !Number.isFinite(item) || Math.abs(item) > 1)) return null;
  const normSquared = value.values.reduce((total, item) => total + item * item, 0);
  if (Math.abs(normSquared - 1) > 1e-5) return null;
  return { version: value.version, modelSha256: value.modelSha256.toLowerCase(), values: [...value.values] };
}

/**
 * A persistent local Python worker. Configuring this provider does not connect
 * a Pixiv account. `spawnProcess` exists solely for protocol unit tests.
 */
export function createTagger(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || DEFAULT_ROOT);
  const dataDir = path.resolve(options.dataDir || path.join(projectRoot, '.data'));
  const catalogPath = path.resolve(options.catalogPath || path.join(projectRoot, 'server', 'tag-catalog.json'));
  const timeoutMs = options.timeoutMs ?? 120000;
  const minScore = options.minScore ?? 0.35;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(minScore) || minScore <= 0 || minScore > 1) throw new TypeError('识图超时或置信度阈值无效。');
  let child = null, workerSignature = '', buffer = '', pending = null, sequence = Promise.resolve(), closed = false, cachedStatus = null;
  const enqueue = operation => { const result = sequence.then(operation, operation); sequence = result.catch(() => {}); return result; };

  async function configuration() {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(options.configPath || path.join(dataDir, 'tagger-config.json'), 'utf8')); }
    catch (reason) { if (reason.code !== 'ENOENT') throw error('TAGGER_CONFIG_INVALID', '本地识图配置文件格式无效。'); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw error('TAGGER_CONFIG_INVALID', '本地识图配置必须是对象。');
    const configuredPath = options.pythonPath ?? process.env.PIXIV_TAGGER_PYTHON ?? saved.pythonPath;
    let pythonPath = nonempty(configuredPath) ? path.resolve(projectRoot, configuredPath.trim()) : '';
    if (configuredPath === undefined) {
      // A project-owned runtime remains available without another app or PATH.
      const bundledPython = path.join(projectRoot, '.runtime', 'python', 'python.exe');
      try { if ((await fs.stat(bundledPython)).isFile()) pythonPath = bundledPython; }
      catch (reason) { if (reason.code !== 'ENOENT') throw reason; }
    }
    const modelDir = path.resolve(projectRoot, options.modelDir || process.env.TAGGER_MODEL_DIR || saved.modelDir || path.join(dataDir, 'models', 'wd-swinv2-v3'));
    const runtimeDir = path.resolve(projectRoot, options.runtimeDir || process.env.TAGGER_RUNTIME || saved.runtimeDir || path.join(projectRoot, '.runtime', 'tagger'));
    const uploadDir = path.resolve(options.uploadDir || path.join(dataDir, 'uploads'));
    const workerPath = path.resolve(options.workerPath || path.join(projectRoot, 'tagger', 'worker.py'));
    return { pythonPath, modelDir, runtimeDir, uploadDir, workerPath, signature: JSON.stringify([pythonPath, modelDir, runtimeDir, uploadDir, workerPath]) };
  }

  function stopWorker(reason = error('TAGGER_STOPPED', '本地图像识别服务已停止。')) {
    const previous = child;
    child = null; workerSignature = ''; buffer = ''; cachedStatus = null;
    if (pending) { clearTimeout(pending.timer); const reject = pending.reject; pending = null; reject(reason); }
    if (previous) { try { previous.kill(); } catch { /* The process may already have exited. */ } }
  }

  async function ensureWorker(config) {
    if (closed) throw error('TAGGER_CLOSED', '本地图像识别服务已关闭。');
    if (!config.pythonPath) throw error('TAGGER_NOT_CONFIGURED', '尚未配置本地识图 Python 环境。');
    if (child && workerSignature === config.signature) return;
    if (child) stopWorker();
    try {
      const [worker, model, runtime] = await Promise.all([fs.stat(config.workerPath), fs.stat(config.modelDir), fs.stat(config.runtimeDir)]);
      if (!worker.isFile() || !model.isDirectory() || !runtime.isDirectory()) throw new Error('missing');
      if (path.isAbsolute(config.pythonPath) && !(await fs.stat(config.pythonPath)).isFile()) throw new Error('python');
    } catch { throw error('TAGGER_FILES_MISSING', '本地识图程序、模型目录或依赖环境尚未准备好。'); }
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|PASSWORD|SECRET|API_KEY)/i.test(key) && !/^PYTHON/i.test(key)));
    const processHandle = (options.spawnProcess || spawn)(config.pythonPath, ['-I', '-X', 'utf8', '-u', config.workerPath], {
      cwd: projectRoot, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment, TAGGER_RUNTIME: config.runtimeDir, TAGGER_MODEL_DIR: config.modelDir, TAGGER_UPLOAD_DIR: config.uploadDir },
    });
    child = processHandle; workerSignature = config.signature; buffer = '';
    processHandle.stdout.setEncoding('utf8');
    processHandle.stdout.on('data', chunk => {
      if (child !== processHandle) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) { stopWorker(error('TAGGER_PROTOCOL', '识图服务返回的数据超过限制。', 502)); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); } catch { stopWorker(error('TAGGER_PROTOCOL', '识图服务返回了无效 JSON。', 502)); return; }
        if (!pending || !response || response.id !== pending.id || typeof response.ok !== 'boolean') { stopWorker(error('TAGGER_PROTOCOL', '识图服务的请求标识或响应格式不匹配。', 502)); return; }
        const request = pending; clearTimeout(request.timer); pending = null;
        if (response.ok) request.resolve(response);
        else { cachedStatus = null; request.reject(error('TAGGER_WORKER_ERROR', conciseFailure(response.error))); }
      }
    });
    // Drain stderr; diagnostics may contain file paths and must not become tag evidence.
    processHandle.stderr.on('data', () => {});
    processHandle.stdin.on('error', () => { if (child === processHandle) stopWorker(error('TAGGER_PROCESS_EXIT', '无法写入本地图像识别进程。')); });
    processHandle.on('error', () => { if (child === processHandle) stopWorker(error('TAGGER_START_FAILED', '无法启动已配置的本地 Python 识图环境。')); });
    processHandle.on('exit', () => { if (child === processHandle) stopWorker(error('TAGGER_PROCESS_EXIT', '本地图像识别进程已退出，请检查模型及依赖。')); });
  }

  function request(payload) {
    return new Promise((resolve, reject) => {
      if (!child) { reject(error('TAGGER_NOT_RUNNING', '本地图像识别进程未运行。')); return; }
      const id = randomUUID();
      const timer = setTimeout(() => stopWorker(error('TAGGER_TIMEOUT', '本地图像识别超时；未生成或确认任何标签。', 504)), timeoutMs);
      pending = { id, resolve, reject, timer };
      try { child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`); }
      catch { stopWorker(error('TAGGER_PROCESS_EXIT', '无法发送本地图像识别请求。')); }
    });
  }

  async function health(config, catalog) {
    await ensureWorker(config);
    const response = await request({ op: 'health' });
    if (response.ready !== true || !child || workerSignature !== config.signature) throw error('TAGGER_NOT_READY', '本地图像识别模型尚未就绪。');
    const metadata = modelMetadata(response);
    cachedStatus = { configured: true, ready: true, available: true, source: 'local', ...metadata, catalogVersion: catalog.version, catalogSha256: catalog.sha256, catalogEntries: catalog.entries, checkedAt: new Date().toISOString() };
    return structuredClone(cachedStatus);
  }

  async function status({ refresh = false } = {}) {
    let config, catalog;
    try {
      [config, catalog] = await Promise.all([configuration(), loadTagCatalog(catalogPath)]);
      if (!refresh && cachedStatus && child && workerSignature === config.signature && Date.now() - Date.parse(cachedStatus.checkedAt) < 10000 && cachedStatus.catalogSha256 === catalog.sha256) return structuredClone(cachedStatus);
      return await enqueue(() => health(config, catalog));
    } catch (reason) {
      cachedStatus = null;
      if (reason.code === 'TAGGER_PROTOCOL') stopWorker(reason);
      return { configured: Boolean(config?.pythonPath), ready: false, available: false, source: 'local', catalogVersion: catalog?.version || null, catalogEntries: catalog?.entries || 0, code: reason.code || 'TAGGER_UNAVAILABLE', error: conciseFailure(reason), message: conciseFailure(reason) };
    }
  }

  async function prepareFiles(files, config) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 200) throw error('TAGGER_INVALID_FILES', '识图需要 1–200 张已上传的图片。', 400);
    let uploadRoot;
    try { uploadRoot = await fs.realpath(config.uploadDir); } catch { throw error('TAGGER_INVALID_FILES', '本地图片存储目录不存在。', 400); }
    const prepared = [], ids = new Set(); let total = 0;
    for (const file of files) {
      if (!file || !nonempty(file.id) || file.id.length > 100 || ids.has(file.id) || !nonempty(file.path) || !path.isAbsolute(file.path)) throw error('TAGGER_INVALID_FILES', '识图文件需要不重复的标识及本地绝对路径。', 400);
      ids.add(file.id);
      let actualPath, stat;
      try { actualPath = await fs.realpath(file.path); stat = await fs.stat(actualPath); }
      catch { throw error('TAGGER_INVALID_FILES', '所选图片已不存在，请重新上传。', 400); }
      if (!within(uploadRoot, actualPath) || !stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw error('TAGGER_INVALID_FILES', '识图仅允许读取上传目录中的有效图片文件。', 400);
      total += stat.size;
      if (total > MAX_WORK_BYTES) throw error('TAGGER_INVALID_FILES', '识图图片总大小不能超过 200 MB。', 400);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(actualPath)) digest.update(chunk);
      const sha256 = digest.digest('hex');
      if (file.sha256 !== undefined && (!SHA256.test(file.sha256) || file.sha256.toLowerCase() !== sha256)) throw error('TAGGER_HASH_MISMATCH', '所选图片已改变，请刷新后重新分析。', 409);
      prepared.push({ id: file.id, path: actualPath, sha256 });
    }
    return prepared;
  }

  async function analyze(files) {
    const [config, catalog] = await Promise.all([configuration(), loadTagCatalog(catalogPath)]);
    const prepared = await prepareFiles(files, config);
    return enqueue(async () => {
      try {
      const metadata = await health(config, catalog);
      const started = Date.now(), predictions = [], ratings = [], analyzedFiles = [], imageCache = new Map();
      for (const file of prepared) {
        let positive = imageCache.get(file.sha256);
        if (!positive) {
          const response = await request({ op: 'analyze', files: [file] });
          const observed = modelMetadata(response);
          if (observed.model !== metadata.model || observed.modelVersion !== metadata.modelVersion || JSON.stringify(observed.modelFiles) !== JSON.stringify(metadata.modelFiles)) throw error('TAGGER_MODEL_CHANGED', '识图期间模型版本发生改变，请重新分析。', 409);
          if (!Array.isArray(response.analyzedFiles) || response.analyzedFiles.length !== 1 || response.analyzedFiles[0].id !== file.id || response.analyzedFiles[0].sha256?.toLowerCase() !== file.sha256 || !Array.isArray(response.predictions) || response.predictions.length > 10000) throw error('TAGGER_PROTOCOL', '识图结果没有匹配当前图片的摘要或预测记录。', 502);
          positive = { predictions: [], ratings: [] };
          if (Object.hasOwn(response.analyzedFiles[0], 'descriptor')) {
            positive.descriptor = validatedDescriptor(response.analyzedFiles[0].descriptor, metadata);
            positive.descriptorUnavailable = !positive.descriptor;
          }
          for (const prediction of response.predictions) {
            if (!prediction || prediction.fileId !== file.id || !nonempty(prediction.name) || prediction.name.length > 200 || ![0, 4, 9].includes(prediction.category) || !Number.isFinite(prediction.score) || prediction.score < 0 || prediction.score > 1) throw error('TAGGER_PROTOCOL', '识图服务返回了无效的分类结果。', 502);
            const name = normalizeName(prediction.name);
            if (prediction.category === 9 || RATING_NAMES.has(name) || prediction.score < minScore) continue;
            positive.predictions.push({ name, category: prediction.category, score: prediction.score });
          }
          for (const rating of response.ratings || []) {
            if (rating.fileId !== file.id || rating.category !== 9 || !['general','sensitive','questionable','explicit'].includes(rating.name) || !Number.isFinite(rating.score) || rating.score < 0 || rating.score > 1) throw error('TAGGER_PROTOCOL', '识图分级结果无效。', 502);
            positive.ratings.push({ name: rating.name, score: rating.score });
          }
          imageCache.set(file.sha256, positive);
        }
        analyzedFiles.push({ id: file.id, sha256: file.sha256, ...(positive.descriptor ? { descriptor: structuredClone(positive.descriptor) } : {}) });
        predictions.push(...positive.predictions.map(prediction => ({ ...prediction, fileId: file.id })));
        ratings.push(...positive.ratings.map(rating => ({ ...rating, fileId: file.id })));
      }
      const candidates = new Map(), unmapped = new Map();
      for (const prediction of predictions) {
        const entry = catalog.names.get(prediction.name);
        if (entry) {
          const reason = entry.verified
            ? `本地模型识别结果匹配已保存截图中的标签；来源日期 ${entry.evidence[0].observedAt}，不是实时检索。`
            : '本地静态词表建议，尚未核实 Pixiv 标签。连接账号后可通过历史投稿或实时搜索确认；也可手动选择。';
          const candidate = candidates.get(entry.tag) || { tag: entry.tag, confidence: 0, modelScore: 0, modelNames: [], fileIds: [], existing: entry.verified, verified: entry.verified, evidence: structuredClone(entry.evidence), catalogEntryId: entry.id, reason: `${reason}${entry.note || ''}` };
          candidate.confidence = candidate.modelScore = Math.max(candidate.modelScore, prediction.score);
          if (!candidate.modelNames.includes(prediction.name)) candidate.modelNames.push(prediction.name);
          if (!candidate.fileIds.includes(prediction.fileId)) candidate.fileIds.push(prediction.fileId);
          candidates.set(entry.tag, candidate);
        } else {
          const key = `${prediction.category}:${prediction.name}`;
          const item = unmapped.get(key) || { name: prediction.name, category: prediction.category, score: 0, fileIds: [], existing: false, verified: false };
          item.score = Math.max(item.score, prediction.score);
          if (!item.fileIds.includes(prediction.fileId)) item.fileIds.push(prediction.fileId);
          unmapped.set(key, item);
        }
      }
      const warnings = ['识图模型可能遗漏或误认角色；未可靠识别的标题或分级会留空。'];
      if ([...imageCache.values()].some(item => item.descriptorUnavailable)) warnings.push('部分图片的角色记忆特征无效，已忽略；本次标题、分级和标签识别仍正常处理。');
      if (!candidates.size) warnings.push('本次识图没有匹配到有来源证据的 Pixiv 标签；未映射的分类结果不会自动作为标签。');
      return {
        source: 'local', demo: false, model: metadata.model, modelVersion: metadata.modelVersion,
        modelFiles: metadata.modelFiles, ...(metadata.provenance ? { provenance: metadata.provenance } : {}),
        inputFingerprint: hash(JSON.stringify({ files: prepared.map(file => file.sha256), model: metadata.model, modelVersion: metadata.modelVersion, modelFiles: metadata.modelFiles, catalog: catalog.sha256, minScore })),
        analyzedFiles, predictions, recognition: summarizeRecognition(analyzedFiles, predictions, ratings), catalogVersion: catalog.version, catalogSha256: catalog.sha256,
        candidates: [...candidates.values()].sort((a, b) => b.modelScore - a.modelScore),
        unmapped: [...unmapped.values()].sort((a, b) => b.score - a.score), warnings, durationMs: Date.now() - started,
      };
      } catch (reason) {
        cachedStatus = null;
        if (['TAGGER_PROTOCOL', 'TAGGER_MODEL_CHANGED'].includes(reason.code)) stopWorker(reason);
        throw reason;
      }
    });
  }

  async function close() { closed = true; stopWorker(); }
  return { status, analyze, close };
}
