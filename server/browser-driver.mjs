import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class BrowserError extends Error {
  constructor(message, code = 'browser_error') { super(message); this.status = 503; this.code = code; }
}

function commandError(value) {
  const message = String(value?.message || value || '浏览器操作失败。');
  if (/waiting for remote-debugging approval/i.test(message)) return new BrowserError('Chrome 正在等待授权。请在 Chrome 弹出的远程调试提示中点击「允许」，然后重新检测。', 'approval_required');
  if (/tab_gone|pinned tab.*closed/i.test(message)) return new BrowserError('绑定的 Pixiv 标签页已关闭，请重新绑定。', 'tab_gone');
  if (/no.*(?:chrome|browser).*running|could not.*connect|connection refused/i.test(message)) return new BrowserError('无法连接现有 Chrome。请保持 Chrome 打开并开启远程调试。', 'disconnected');
  return new BrowserError(message.slice(0, 500), value?.code);
}

// Never invoke a shell: titles, captions and file names are data, not commands.
export function createAgentBrowser({ executable, session = 'pixiv-publisher' } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session)) throw new Error('浏览器会话名称无效。');
  let resolved;
  async function locate() {
    if (resolved) return resolved;
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const suffixes = process.platform === 'win32'
      ? [`agent-browser-win32-${process.arch}.exe`, 'agent-browser.exe']
      : [`agent-browser-${process.platform}-${process.arch}`, 'agent-browser'];
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const explicit = [executable, process.env.PIXIV_AGENT_BROWSER_PATH].filter(Boolean)
      .flatMap(file => path.isAbsolute(file) || /[/\\]/.test(file) ? [file] : pathDirs.map(dir => path.join(dir, file)));
    const candidates = [...explicit, ...suffixes.flatMap(suffix => [
      path.join(home, 'tools/agent-browser/node_modules/agent-browser/bin', suffix),
      path.join(os.homedir(), '.local/bin', suffix),
      ...pathDirs.flatMap(dir => [path.join(dir, suffix), path.join(dir, 'node_modules/agent-browser/bin', suffix)]),
    ])];
    for (const file of candidates) { try { if (!(await fs.stat(file)).isFile()) continue; await fs.access(file); resolved = file; return file; } catch {} }
    throw new BrowserError('未找到 agent-browser。请安装配套命令行工具，或设置 PIXIV_AGENT_BROWSER_PATH。', 'cli_missing');
  }
  async function command(args, input) {
    const file = await locate();
    return new Promise((resolve, reject) => {
      const child = spawn(file, ['--auto-connect', '--pin-tab', '--session', session, '--json', ...args], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let output = '', settled = false;
      const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
      const timer = setTimeout(() => { child.kill(); finish(new BrowserError('Chrome 响应超时。请检查浏览器的远程调试授权；结果不明时不会重复提交。', 'timeout')); }, 45000);
      child.stdout.on('data', part => {
        output += part.toString();
        if (output.length > 8 * 1024 * 1024) { child.kill(); finish(new BrowserError('浏览器返回内容超出安全范围。')); }
        // A newly spawned daemon can inherit stdout. Resolve on the JSON result
        // instead of waiting forever for the inherited pipe to close.
        for (const line of output.split(/\r?\n/).filter(Boolean)) {
          try { const data = JSON.parse(line); if (typeof data.success === 'boolean') {
            if (data.success) finish(null, data.data);
            else finish(commandError(data.error));
          }} catch {}
        }
      });
      child.stderr.resume(); // Do not log page contents or browser credentials.
      child.on('error', () => finish(new BrowserError('agent-browser 无法启动，请检查安装路径。', 'cli_missing')));
      child.on('close', () => { if (!settled) {
        try { const data = JSON.parse(output); if (data.success) return finish(null, data.data); } catch {}
        finish(new BrowserError('未收到有效的浏览器结果。请保持 Chrome 开启并允许远程调试。'));
      }});
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  return {
    command,
    evaluate: async (fn, arg) => (await command(['eval', '--stdin'], `(${fn.toString()})(${JSON.stringify(arg ?? null)})`)).result,
    tabs: async () => (await command(['tab', 'list'])).tabs,
    select: target => command(['tab', target]),
    openTab: async url => { await command(['tab', 'new', url]); return (await command(['tab', 'list'])).tabs.find(tab => tab.active); },
  };
}

// These functions run in the selected Pixiv page. Only non-secret fields leave
// Chrome; cookies, tokens, passwords and the serialized state never do.
export function readIdentity() {
  if (location.origin !== 'https://www.pixiv.net') throw new Error('标签页不是 Pixiv。');
  let props = {}, state = {};
  try { props = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps || {}; } catch {}
  try { state = JSON.parse(props.serverSerializedPreloadedState || '{}'); } catch {}
  const self = state.userData?.self;
  const ga = props.gaUserData || (window.dataLayer || []).find(item => item?.user_id) || {};
  const id = String(self?.id || ga.userId || ga.user_id || '');
  const loggedIn = props.isLoggedIn === true || ga.login === true || ga.login === 'yes';
  const name = self?.name || [...document.querySelectorAll('button img[alt]')].map(e => e.alt).find(Boolean) || '';
  return { loggedIn: loggedIn && /^\d+$/.test(id), pixivUserId: id, name,
    premium: self?.premium === true || ga.premium === true || ga.premium === 'yes', url: location.href };
}

export async function readRemote({ expectedId, includePublishedIndex = false }) {
  if (location.origin !== 'https://www.pixiv.net') throw new Error('标签页不再是 Pixiv。');
  // Fetch fresh server-rendered identity in this tab's own cookie context. A
  // stale open page must not authorize an operation after login has changed.
  const response = await fetch('/dashboard/works', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('无法核对 Pixiv 登录状态。');
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  const p = JSON.parse(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
  const s = JSON.parse(p?.serverSerializedPreloadedState || '{}');
  const self = s.userData?.self, id = String(self?.id || p?.gaUserData?.userId || '');
  if (!p?.isLoggedIn || id !== expectedId) throw new Error('Pixiv 登录账号已改变或已退出，请重新绑定。');
  const responses = [];
  for (const kind of ['illust', 'novel']) {
    const r = await fetch(`/ajax/dashboard/works/${kind}/request_strategy?lang=zh`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (!r.ok) throw new Error('Pixiv 预约列表读取失败。');
    const j = await r.json();
    if (j.error || !Array.isArray(j.body?.data?.reservedWorks)) throw new Error('Pixiv 预约列表格式已变化。');
    responses.push({ kind, reserved: j.body.data.reservedWorks.map(row => ({ reserveId: row.reserveId, releaseDate: row.releaseDate,
      title: row.title, pageCount: row.pageCount, workType: row.workType })),
      // Publication needs an explicit artwork ID. Only return IDs, not content.
      publishedIds: (j.body.data.works || []).map(row => String(row.workId)) });
  }
  let publicationIndex;
  if (includePublishedIndex) {
    // This complete, account-owned index supplies a before/after publication
    // baseline. A dashboard's most recent page cannot prove a unique match.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/ajax/user/${expectedId}/profile/all?lang=zh`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error();
      const json = await response.json(), body = json.body;
      const collection = value => value === null || value && typeof value === 'object' && !Array.isArray(value) || Array.isArray(value) && value.length === 0;
      if (json.error || !body || !Object.hasOwn(body, 'illusts') || !Object.hasOwn(body, 'manga') || !collection(body.illusts) || !collection(body.manga)) throw new Error();
      const artworkIds = [...new Set([...Object.keys(body.illusts || {}), ...Object.keys(body.manga || {})])];
      if (artworkIds.length > 50000 || artworkIds.some(value => !/^\d+$/.test(value))) throw new Error();
      publicationIndex = { complete: true, pixivUserId: expectedId, artworkIds };
    } catch { publicationIndex = { complete: false, pixivUserId: expectedId }; }
    finally { clearTimeout(timer); }
  }
  return { identity: { pixivUserId: id, name: self?.name || '', premium: self?.premium === true || p.gaUserData?.premium === true }, responses,
    ...(publicationIndex ? { publicationIndex } : {}) };
}

export function readForm() {
  if (location.origin !== 'https://www.pixiv.net' || !/^\/(illustration|manga)\/create/.test(location.pathname)) throw new Error('当前不是 Pixiv 投稿表单。');
  const fields = [...document.querySelectorAll('input,textarea')].filter(e => e.type !== 'hidden').map(e => ({
    name: e.name, type: e.type, placeholder: e.placeholder, value: e.type === 'file' ? '' : e.value,
    checked: e.checked, fileCount: e.files?.length,
  }));
  const reserve = document.querySelector('input[name=reserve]');
  const schedule = reserve?.closest('label')?.parentElement;
  const scheduleLabels = [...(schedule?.querySelectorAll('[tabindex="0"]') || [])].map(element => {
    // Read one selected label per control, not every titled span in an open
    // menu (Pixiv repeats a label in nested title elements).
    const value = String(element.getAttribute('title') || element.querySelector('[title]')?.getAttribute('title') || element.textContent || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const date = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
    if (date) return `${date[1]}年${Number(date[2])}月${Number(date[3])}日`;
    const time = /^(\d{1,2}):(\d{2}) ?JST$/.exec(value);
    return time ? `${time[1].padStart(2, '0')}:${time[2]} JST` : '';
  }).filter(Boolean);
  const tagInput = document.querySelector('input[placeholder="标签"]');
  const tags = [...(tagInput?.parentElement?.parentElement?.children || [])].filter(e => !e.contains(tagInput)).map(e => e.textContent.trim()).filter(Boolean);
  return { url: location.href, fields, scheduleLabels,
    tags, imageCount: new Set([...document.querySelectorAll('img[src^="blob:"]')].filter(e => e.naturalWidth > 0).map(e => e.src)).size,
    submitEnabled: [...document.querySelectorAll('button')].some(e => e.textContent.trim() === '投稿' && !e.classList.contains('gtm-work-post-button-in-header-click') && e.checkVisibility() && !e.disabled) };
}

export function clickSubmit() {
  const buttons = [...document.querySelectorAll('button')].filter(e => e.textContent.trim() === '投稿' && !e.classList.contains('gtm-work-post-button-in-header-click') && e.checkVisibility());
  if (buttons.length !== 1 || buttons[0].disabled) return { clicked: false };
  buttons[0].click();
  return { clicked: true };
}

export function chooseSchedule({ kind, text, phase = 'open' }) {
  if (!['date', 'time'].includes(kind) || !['open', 'select', 'verify'].includes(phase)) throw new Error('预约选择参数无效。');
  const normalized = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const label = element => normalized(element.getAttribute('title') || element.querySelector('[title]')?.getAttribute('title') || element.textContent);
  const valueOf = value => {
    const raw = normalized(value);
    if (kind === 'date') {
      const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(raw);
      return match ? `${match[1]}-${Number(match[2])}-${Number(match[3])}` : null;
    }
    const match = /^(\d{1,2}):(\d{2})(?: ?JST)?$/.exec(raw);
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? `${Number(match[1])}:${match[2]}` : null;
  };
  const visible = element => element.checkVisibility();
  const disabled = element => element.disabled || element.getAttribute('aria-disabled') === 'true';
  const reserve = document.querySelector('input[name=reserve]');
  const root = reserve?.closest('label')?.parentElement;
  const controls = [...(root?.querySelectorAll('[tabindex="0"]') || [])].filter(visible);
  const matchingControls = controls.filter(element => valueOf(label(element)) !== null);
  if (matchingControls.length > 1) return { status: 'ambiguous', current: '' };
  const control = matchingControls[0];
  if (!control) return { status: 'pending', current: '' };
  const current = label(control), target = valueOf(text);
  if (!target || disabled(control)) return { status: 'unavailable', current };
  if (valueOf(current) === target) return { status: 'chosen', current };
  // Once an option has been clicked, only read the control until React commits
  // its value. A successful click alone is not confirmation of the selection.
  if (phase === 'verify') return { status: 'pending', current };
  // Pixiv renders both menus inside this reservation block. Searching the
  // whole document can mistake an unrelated or hidden duplicate for a slot.
  const options = [...(root?.querySelectorAll('[role="button"]') || [])]
    .filter(element => visible(element) && !disabled(element) && !controls.some(item => item === element || item.contains(element)) && valueOf(label(element)) === target);
  if (options.length > 1) return { status: 'ambiguous', current };
  if (options.length === 1) { options[0].click(); return { status: 'selected', current }; }
  if (phase === 'open') { control.click(); return { status: 'opened', current }; }
  return { status: 'pending', current };
}

export async function readPublished({ artworkId, expectedId }) {
  if (location.origin !== 'https://www.pixiv.net' || !/^\d+$/.test(artworkId)) throw new Error('作品链接无效。');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
  const response = await fetch(`/ajax/illust/${artworkId}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
  if (!response.ok) throw new Error('无法读取这件 Pixiv 作品。');
  const json = await response.json(), work = json.body;
  if (json.error || String(work?.userId) !== expectedId || String(work?.id) !== artworkId) throw new Error('作品不存在，或不属于绑定的 Pixiv 账号。');
  if (work.isReserved === true || work.isDraft === true || ['reserved', 'draft', 'scheduled'].includes(work.status)) throw new Error('作品尚未发布。');
  return { artworkId, title: work.title, pageCount: work.pageCount, userId: String(work.userId), createDate: work.createDate,
    illustType: work.illustType };
  } finally { clearTimeout(timer); }
}

export async function readTags({ expectedId, words, includeHistory = false, historyLimit = 6 }) {
  if (location.origin !== 'https://www.pixiv.net') throw new Error('标签页不是 Pixiv。');
  words = [...new Set(words)].slice(0, 256);
  const page = await fetch('/illustration/create', { credentials:'same-origin', cache:'no-store', redirect:'error' });
  if (!page.ok) throw new Error('无法读取账号常用标签。');
  const doc = new DOMParser().parseFromString(await page.text(),'text/html');
  const p = JSON.parse(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
  const s = JSON.parse(p?.serverSerializedPreloadedState || '{}');
  if (!p?.isLoggedIn || String(s.userData?.self?.id || p?.gaUserData?.userId) !== expectedId) throw new Error('登录账号发生变化，请重新绑定。');
  const frequentTags = [...new Set([...doc.querySelectorAll('.gtm-history-illust-tag-click')].map(e=>e.textContent.trim().replace(/^#\s*/,'')))];
  // All operations after identity verification are independent, read-only GETs.
  // Limit concurrency while retaining query/artwork order in the final result.
  async function mapLimited(items, limit, operation) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const index = next++; results[index] = await operation(items[index]); }
    }));
    return results;
  }
  const searched = await mapLimited(words.slice(0, 32), 4, async word => {
    const matches = [];
    const url = `/ajax/tags/suggest_by_word?word=${encodeURIComponent(word)}&content_types_to_count%5B%5D=illust&lang=zh`;
    const r = await fetch(url,{credentials:'same-origin',redirect:'error'});
    if(!r.ok)throw new Error('Pixiv 全站标签检索暂时不可用。');
    const j=await r.json();
    if(j.error||!Array.isArray(j.body?.candidates))throw new Error('Pixiv 标签检索返回格式变化。');
    for(const c of j.body.candidates)if(typeof c.tag_name==='string')matches.push({word,tag:c.tag_name,count:c.total_count??0,url:location.origin+url});
    return matches;
  });
  const matches = searched.flat();
  // Preserve matches to recognized concepts outside the network search budget:
  // these tags already have current account evidence, so no extra GET is needed.
  const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[ _]/g, '');
  for (const word of words) for (const tag of frequentTags) {
    if (normalized(tag) === normalized(word) && !matches.some(match => match.word === word && match.tag === tag)) {
      matches.push({ word, tag, url:'https://www.pixiv.net/illustration/create', count:null });
    }
  }
  const recentWorks = [];
  let historyWarning;
  if (includeHistory) {
    const limit = Number.isInteger(historyLimit) ? Math.max(1, Math.min(60, historyLimit)) : 6;
    // Read only this freshly verified account's latest published illustrations.
    // History is optional: a temporary dashboard failure must not discard the
    // complete tag search above or expose another account's artwork metadata.
    try {
      const r = await fetch('/ajax/dashboard/works/illust/request_strategy?lang=zh', { credentials:'same-origin', cache:'no-store', redirect:'error' });
      if (!r.ok) throw new Error();
      const j = await r.json();
      if (j.error || !Array.isArray(j.body?.data?.works)) throw new Error();
      const ids = [...new Set(j.body.data.works.map(work => String(work.workId)).filter(id => /^\d+$/.test(id)))].slice(0, limit);
      const details = await mapLimited(ids, 3, async artworkId => {
        try {
          const response = await fetch(`/ajax/illust/${artworkId}`, { credentials:'same-origin', cache:'no-store', redirect:'error' });
          if (!response.ok) throw new Error();
          const json = await response.json(), work = json.body;
          if (json.error || String(work?.id) !== artworkId || String(work?.userId) !== expectedId || !Array.isArray(work.tags?.tags)) throw new Error();
          const tags = [...new Set(work.tags.tags.map(item => item?.tag).filter(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 100))].slice(0, 10);
          return { artworkId, title: typeof work.title === 'string' ? work.title.slice(0, 200) : '', tags };
        } catch {
          historyWarning = '部分已发布作品的标签暂时无法核对，已继续使用全站标签匹配。';
        }
      });
      recentWorks.push(...details.filter(Boolean));
    } catch {
      historyWarning = '暂时无法读取已发布作品的标签，已继续使用全站标签匹配。';
    }
    for (const work of recentWorks) for (const tag of work.tags) for (const word of words) {
      // A historical tag proves existence only for the same recognized query;
      // unrelated tags from old pictures must never become suggestions.
      if (normalized(tag) === normalized(word) && !matches.some(match => match.word === word && match.tag === tag)) {
        matches.push({ word, tag, count: null, url: `https://www.pixiv.net/artworks/${work.artworkId}` });
      }
    }
  }
  return { frequentTags, matches, checkedAt:new Date().toISOString(), pixivUserId:expectedId,
    ...(includeHistory ? { recentWorks, ...(historyWarning ? { historyWarning } : {}) } : {}) };
}

// Serialized into the already bound Pixiv tab. Index and detail batches are
// separate evaluations so a large library never exceeds the browser's 45s
// command limit. Every batch checks fresh login state before reading artwork.
export async function readPublishedHistory({ expectedId, artworkIds, historyOffset = 0, historyLimit = 2000 }) {
  if (location.origin !== 'https://www.pixiv.net' || !/^\d+$/.test(expectedId)) throw new Error('标签页不是绑定的 Pixiv 账号。');
  function failure(code, details = {}) { return Object.assign(new Error(code), { historyError: { code, ...details } }); }
  function safeError(error, phase, artworkId) {
    return { phase, ...(error?.historyError || { code: error?.name === 'AbortError' ? 'timeout' : 'network_error' }), ...(artworkId ? { artworkId } : {}) };
  }
  function parseJson(text) { try { return JSON.parse(text); } catch { throw failure('invalid_json'); } }
  async function read(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const retry = response.headers?.get?.('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : NaN;
        throw failure('http_error', { httpStatus: response.status,
          ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: Math.min(86400, seconds) } : {}) });
      }
      // Consume the body before cancelling the timer; stalled responses are
      // bounded too, not only the arrival of HTTP headers.
      return await response.text();
    } catch (error) {
      if (error.historyError) throw error;
      throw failure(error?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  let props, state;
  try {
    const page = await read('/illustration/create');
    const doc = new DOMParser().parseFromString(page, 'text/html');
    props = parseJson(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
    state = parseJson(props?.serverSerializedPreloadedState || '{}');
    if (!props) throw failure('schema_changed');
  } catch (error) { return { pixivUserId: expectedId, historyError: safeError(error, 'identity') }; }
  if (!props?.isLoggedIn || String(state.userData?.self?.id || props?.gaUserData?.userId) !== expectedId) throw new Error('登录账号发生变化，请重新绑定。');
  if (artworkIds === undefined) {
    try {
    const result = parseJson(await read(`/ajax/user/${expectedId}/profile/all?lang=zh`));
    const body = result.body;
    const collection = value => value === null || value && typeof value === 'object' && !Array.isArray(value) || Array.isArray(value) && value.length === 0;
    if (result.error) throw failure('remote_error');
    if (!body || !Object.hasOwn(body, 'illusts') || !Object.hasOwn(body, 'manga') || !collection(body.illusts) || !collection(body.manga)) throw failure('schema_changed');
    const ids = [...new Set([...Object.keys(body.illusts || {}), ...Object.keys(body.manga || {})])];
    if (ids.some(id => !/^\d+$/.test(id))) throw failure('schema_changed');
    // Artwork IDs sort newest first without precision loss for long IDs.
    ids.sort((a, b) => b.length - a.length || b.localeCompare(a));
    const offset = Number.isSafeInteger(historyOffset) ? Math.max(0, historyOffset) : 0;
    const limit = Number.isSafeInteger(historyLimit) ? Math.max(1, Math.min(2000, historyLimit)) : 2000;
    return { pixivUserId: expectedId, source: 'pixiv-profile-all', total: ids.length, offset,
      artworkIds: ids.slice(offset, offset + limit), limit, checkedAt: new Date().toISOString() };
    } catch (error) { return { pixivUserId: expectedId, historyError: safeError(error, 'index') }; }
  }
  if (!Array.isArray(artworkIds) || artworkIds.length > 10 || artworkIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('历史作品批次无效。');
  const ids = [...new Set(artworkIds)], results = new Array(ids.length), attemptedIds = [], failedIds = [], historyErrors = [];
  const deadline = Date.now() + 25000;
  let next = 0, rateLimited = false;
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
    while (next < ids.length && Date.now() < deadline && !rateLimited) {
      const index = next++, artworkId = ids[index];
      attemptedIds.push(artworkId);
      try {
        const result = parseJson(await read(`/ajax/illust/${artworkId}`, Math.max(1, Math.min(8000, deadline - Date.now()))));
        const work = result.body;
        if (result.error) throw failure('remote_error');
        if (String(work?.id) !== artworkId) throw failure('artwork_mismatch');
        if (String(work?.userId) !== expectedId) throw failure('owner_mismatch');
        if (!Array.isArray(work.tags?.tags)) throw failure('schema_changed');
        if (work.isReserved === true || work.isDraft === true || ['reserved', 'draft', 'scheduled'].includes(work.status)) throw failure('not_published');
        const tags = [...new Set(work.tags.tags.map(item => item?.tag).filter(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 100))].slice(0, 10);
        results[index] = { artworkId, title: typeof work.title === 'string' ? work.title.slice(0, 200) : '', tags };
      } catch (error) {
        failedIds.push(artworkId);
        const report = safeError(error, 'detail', artworkId);
        historyErrors.push(report);
        if (report.httpStatus === 429) rateLimited = true;
      }
    }
  }));
  return { pixivUserId: expectedId, recentWorks: results.filter(Boolean), attemptedArtworkIds: ids.filter(id => attemptedIds.includes(id)),
    failedArtworkIds: ids.filter(id => failedIds.includes(id)), remainingArtworkIds: ids.slice(next), historyErrors, rateLimited, checkedAt: new Date().toISOString() };
}
