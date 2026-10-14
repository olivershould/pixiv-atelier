import { randomUUID } from 'node:crypto';
import { BrowserError } from './browser-driver.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (message, code = 'browser_error') => new BrowserError(message, code);

// This connection attaches to existing Chrome targets without activating their
// tabs or windows. It never exports cookies and never retries a sent operation.
export function createBackgroundBrowser({ endpoint, WebSocketImpl = globalThis.WebSocket, timeoutMs = 45000, connectTimeoutMs = 15000 } = {}) {
  let current = null, selected = null, sequence = 0;

  function abandon(context, error) {
    if (context.closed) return;
    context.closed = true;
    if (current === context) current = null;
    context.rejectOpen?.(error);
    for (const request of context.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    context.pending.clear();
    context.sessions.clear();
    try { context.socket?.close(); } catch {}
  }

  function waitForConnection(context) {
    return new Promise((resolve, reject) => {
      // Chrome consent can arrive after the requesting API call has timed out.
      // Keep that handshake, but never queue or replay the caller's operation.
      const timer = setTimeout(() => {
        if (!context.opened) reject(failure('Chrome 尚未允许后台连接，请在远程调试提示中点击允许后重试。', 'approval_required'));
      }, connectTimeoutMs);
      // These handlers also consume a later socket failure after this caller
      // has timed out. Actual CDP requests retain their own response timeout.
      context.ready.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async function connect() {
    if (current) return waitForConnection(current);
    const context = { pending: new Map(), sessions: new Map(), closed: false, opened: false };
    current = context;
    context.ready = (async () => {
      try {
        if (typeof endpoint !== 'function') throw failure('未配置 Chrome 连接。', 'disconnected');
        const url = await endpoint();
        if (context.closed) throw failure('Chrome 连接已关闭。', 'disconnected');
        if (!/^wss?:\/\//.test(url || '')) throw failure('Chrome 返回了无效的连接地址。', 'disconnected');
        const socket = context.socket = new WebSocketImpl(url);
        await new Promise((resolve, reject) => {
          context.rejectOpen = reject;
          socket.addEventListener('open', () => {
            context.opened = true; context.rejectOpen = null; resolve();
          }, { once: true });
          socket.addEventListener('close', () => abandon(context, failure('Chrome 连接已中断；结果不明时不会重复操作。', 'disconnected')));
          socket.addEventListener('error', () => abandon(context, failure('无法连接 Chrome，请检查远程调试授权。', 'disconnected')));
          socket.addEventListener('message', event => {
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }
            if (message.id !== undefined) {
              const request = context.pending.get(message.id);
              if (!request) return;
              context.pending.delete(message.id); clearTimeout(request.timer);
              if (message.error) request.reject(failure(String(message.error.message || 'Chrome 操作失败。').slice(0, 500), /target|session.*closed|session.*not found/i.test(message.error.message || '') ? 'tab_gone' : 'browser_error'));
              else request.resolve(message.result || {});
            } else if (message.method === 'Target.targetDestroyed') {
              context.sessions.delete(message.params?.targetId);
            } else if (message.method === 'Target.detachedFromTarget') {
              for (const [target, entry] of context.sessions) if (entry.sessionId === message.params?.sessionId) context.sessions.delete(target);
            }
          });
        });
        if (context.closed) throw failure('Chrome 连接已中断。', 'disconnected');
        await send(context, 'Target.setDiscoverTargets', { discover: true });
        return context;
      } catch (error) { abandon(context, error); throw error; }
    })();
    return waitForConnection(context);
  }

  function send(context, method, params = {}, sessionId) {
    if (context.closed || context.socket?.readyState !== 1) return Promise.reject(failure('Chrome 连接已中断；未重试操作。', 'disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => abandon(context, failure('Chrome 响应超时；结果不明时不会重复操作。', 'timeout')), timeoutMs);
      context.pending.set(id, { resolve, reject, timer });
      try { context.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { abandon(context, failure('Chrome 连接已中断；未重试操作。', 'disconnected')); }
    });
  }

  async function targetSession(context, targetId) {
    if (!targetId) throw failure('尚未选择 Chrome 标签页。', 'unbound');
    const { targetInfos = [] } = await send(context, 'Target.getTargets');
    const target = targetInfos.find(item => item.targetId === targetId && ['page', 'webview'].includes(item.type));
    if (!target) { context.sessions.delete(targetId); throw failure('绑定的 Chrome 标签页已关闭，请重新绑定。', 'tab_gone'); }
    let entry = context.sessions.get(targetId);
    if (!entry) {
      const attached = await send(context, 'Target.attachToTarget', { targetId, flatten: true });
      if (!attached.sessionId) throw failure('无法连接指定 Chrome 标签页。', 'tab_gone');
      entry = { sessionId: attached.sessionId };
      await send(context, 'Runtime.enable', {}, entry.sessionId);
      await send(context, 'Page.enable', {}, entry.sessionId);
      context.sessions.set(targetId, entry);
    }
    return { context, target, sessionId: entry.sessionId };
  }

  async function active() {
    const targetId = selected;
    return targetSession(await connect(), targetId);
  }

  async function expression(handle, code, returnByValue = true) {
    const result = await send(handle.context, 'Runtime.evaluate', {
      expression: code, returnByValue, awaitPromise: true,
    }, handle.sessionId);
    if (result.exceptionDetails) throw failure(String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '网页操作失败。').slice(0, 500));
    return returnByValue ? result.result?.value : result.result;
  }

  async function evaluate(fn, arg) {
    return expression(await active(), `(${fn.toString()})(${JSON.stringify(arg ?? null)})`);
  }

  async function tabs() {
    const context = await connect();
    const { targetInfos = [] } = await send(context, 'Target.getTargets');
    return targetInfos.filter(tab => ['page', 'webview'].includes(tab.type)).map(tab => ({
      targetId: tab.targetId, title: tab.title, url: tab.url, active: tab.targetId === selected,
    }));
  }

  async function select(targetId) {
    selected = targetId;
    const { target } = await active();
    return { targetId: target.targetId, title: target.title, url: target.url, active: true };
  }

  async function openTab(url) {
    const handle = await active();
    const browserContextId = handle.target.browserContextId;
    if (!browserContextId) throw failure('无法确认 Chrome 账号所属环境，未创建投稿标签页。', 'identity_mismatch');
    // Open a uniquely identifiable empty page first. The real URL is visited
    // only after checking that the new page belongs to the selected profile.
    const markerUrl = `about:blank#pixiv-publisher-${randomUUID()}`;
    let targetId;
    try {
      ({ targetId } = await send(handle.context, 'Target.createTarget', {
        url: markerUrl, background: true, browserContextId,
      }));
    } catch (error) {
      // Chrome's profile lookup supports only the last-used regular profile
      // and CDP-created contexts. A page session uses the same global lookup.
      // This exact rejection happens before creation; all other failures stay
      // final because their result may be unknown.
      if (error.message !== `Failed to find browser context with id ${browserContextId}`) throw error;
      targetId = await openSiblingTab(handle, markerUrl);
    }
    if (!targetId) throw failure('Chrome 未返回新标签页，未重试创建。');
    const created = await targetSession(handle.context, targetId);
    if (created.target.browserContextId !== browserContextId) {
      await send(handle.context, 'Target.closeTarget', { targetId }).catch(() => {});
      handle.context.sessions.delete(targetId);
      throw failure('新标签页的 Chrome 账号环境不一致，已停止操作。', 'identity_mismatch');
    }
    // Pixiv can defer interactive widgets on a background page. Emulate an
    // active document on this dedicated, verified tab only; this CDP command
    // does not activate the Chrome tab or bring its window to the foreground.
    // A rejection stays final: never substitute real window activation.
    await send(handle.context, 'Emulation.setFocusEmulationEnabled', { enabled: true }, created.sessionId);
    const navigation = await send(handle.context, 'Page.navigate', { url }, created.sessionId);
    if (navigation.errorText) throw failure(`投稿页面未能打开：${navigation.errorText}`);
    // Navigation acknowledgement can precede the target URL update. Wait only
    // for this new tab to leave its marker; never repeat the navigation.
    const deadline = Date.now() + Math.min(timeoutMs, 10000);
    do {
      const { target } = await targetSession(handle.context, targetId);
      if (target.browserContextId !== browserContextId) throw failure('投稿标签页的 Chrome 账号环境已改变，已停止操作。', 'identity_mismatch');
      if (target.url && target.url !== markerUrl && target.url !== 'about:blank') {
        selected = targetId;
        return { targetId: target.targetId, title: target.title, url: target.url, active: true };
      }
      if (Date.now() >= deadline) throw failure('等待投稿页面打开超时；未重复导航。', 'timeout');
      await pause(100);
    } while (true);
  }

  async function openSiblingTab(handle, markerUrl) {
    const { targetInfos = [] } = await send(handle.context, 'Target.getTargets');
    const existing = new Set(targetInfos.map(target => target.targetId));
    const { frameTree } = await send(handle.context, 'Page.getFrameTree', {}, handle.sessionId);
    if (!frameTree?.frame?.id) throw failure('无法确认原标签页，未创建后台投稿页。');
    const { executionContextId } = await send(handle.context, 'Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'pixiv-publisher-background-tab',
    }, handle.sessionId);
    if (!executionContextId) throw failure('Chrome 无法建立隔离操作环境，未创建后台投稿页。');
    // Blink explicitly preserves Ctrl/Meta-click's background-tab disposition
    // for an isolated world (navigation_policy.cc). In the main world synthetic
    // clicks become foreground tabs, so never substitute a normal evaluation.
    const opened = await send(handle.context, 'Runtime.evaluate', {
      expression: `(${openBackgroundLink.toString()})(${JSON.stringify(markerUrl)})`,
      contextId: executionContextId, returnByValue: true, awaitPromise: true, userGesture: true,
    }, handle.sessionId);
    if (opened.exceptionDetails) throw failure('Chrome 未能创建后台投稿页；未重试创建。');
    const deadline = Date.now() + Math.min(timeoutMs, 10000);
    do {
      const { targetInfos: currentTargets = [] } = await send(handle.context, 'Target.getTargets');
      const matches = currentTargets.filter(target => !existing.has(target.targetId) && target.type === 'page' && target.url === markerUrl);
      if (matches.length === 1) return matches[0].targetId;
      if (matches.length > 1) throw failure('出现多个后台标签页，无法确认目标；已停止操作。');
      if (Date.now() >= deadline) throw failure('未找到创建的后台投稿页；未重试创建。', 'timeout');
      await pause(100);
    } while (true);
  }

  async function command(args) {
    const [action, selector, ...values] = args;
    if (action === 'tab' && selector === 'list') return { tabs: await tabs() };
    if (action === 'tab' && selector === 'close') {
      const targetId = values[0] || selected;
      const context = await connect();
      await targetSession(context, targetId);
      await send(context, 'Target.closeTarget', { targetId });
      context.sessions.delete(targetId);
      if (selected === targetId) selected = null;
      return { closed: true, targetId };
    }
    const handle = await active();
    if (action === 'wait' && selector === '--fn') {
      const deadline = Date.now() + timeoutMs;
      do {
        if (await expression(handle, `Boolean(${values[0]})`)) return { success: true };
        if (Date.now() >= deadline) throw failure('等待网页状态超时。', 'timeout');
        await pause(100);
      } while (true);
    }
    if (action === 'upload') {
      const object = await expression(handle, `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if (nodes.length !== 1 || nodes[0].type !== 'file') throw new Error('找不到唯一的图片上传控件。'); return nodes[0]; })()`, false);
      if (!object?.objectId || object.subtype === 'null') throw failure('找不到图片上传控件。');
      try { await send(handle.context, 'DOM.setFileInputFiles', { files: values, objectId: object.objectId }, handle.sessionId); }
      finally { if (!handle.context.closed) await send(handle.context, 'Runtime.releaseObject', { objectId: object.objectId }, handle.sessionId).catch(() => {}); }
      return { uploaded: values.length };
    }
    if (!['fill', 'check', 'uncheck', 'click'].includes(action)) throw failure(`后台浏览器不支持此操作：${action}`);
    return expression(handle, `(${interact.toString()})(${JSON.stringify({ action, selector, value: values[0] ?? '' })})`);
  }

  function close() {
    if (current) abandon(current, failure('Chrome 连接已关闭。', 'disconnected'));
    selected = null;
  }
  return { tabs, select, evaluate, openTab, command, close };
}

function openBackgroundLink(url) {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.hidden = true;
  document.documentElement.append(link);
  try {
    link.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true, view: window, ctrlKey: true, metaKey: true }));
  } finally { link.remove(); }
}

function interact({ action, selector, value }) {
  const elements = document.querySelectorAll(selector);
  if (elements.length !== 1) throw new Error(`网页控件数量不符：${selector}`);
  const element = elements[0];
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('网页控件已禁用。');
  if (action === 'fill') {
    if (element.readOnly) throw new Error('网页控件不可编辑。');
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('网页控件不支持填写。');
    element.focus({ preventScroll: true });
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.value !== value) throw new Error('填写的内容未被网页接受。');
  } else {
    const checked = action === 'check';
    if (action !== 'click' && !['checkbox', 'radio'].includes(element.type)) throw new Error('网页控件不是勾选项。');
    if (action === 'click' || element.checked !== checked) {
      element.focus({ preventScroll: true });
      element.click();
    }
    if (action !== 'click' && element.checked !== checked) throw new Error('网页未接受勾选状态。');
  }
  return { success: true };
}
