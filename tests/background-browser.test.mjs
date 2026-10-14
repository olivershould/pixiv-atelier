import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBackgroundBrowser } from '../server/background-browser.mjs';

function fixture(t, handler, timeoutMs = 1000, { autoOpen = true, connectTimeoutMs } = {}) {
  const requests = [], sockets = [];
  let endpointCalls = 0;
  const targets = [
    { targetId: 'A', type: 'page', url: 'https://www.pixiv.net/', title: 'Example Alpha', browserContextId: 'profile-a' },
    { targetId: 'B', type: 'page', url: 'https://www.pixiv.net/', title: 'Example Beta', browserContextId: 'profile-b' },
  ];
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.readyState = 0; sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.open());
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(data) {
      const request = JSON.parse(data); requests.push(request);
      const reply = result => this.message({ id: request.id, result });
      if (handler?.({ request, socket: this, reply, targets }) === true) return;
      switch (request.method) {
        case 'Target.getTargets': return reply({ targetInfos: targets });
        case 'Target.attachToTarget': return reply({ sessionId: `session-${request.params.targetId}` });
        case 'Target.createTarget': {
          const target = { targetId: 'NEW', type: 'page', url: request.params.url, title: '', browserContextId: request.params.browserContextId };
          targets.push(target); return reply({ targetId: target.targetId });
        }
        case 'Page.getFrameTree': return reply({ frameTree: { frame: { id: `frame-${request.sessionId}` } } });
        case 'Page.createIsolatedWorld': return reply({ executionContextId: 42 });
        case 'Page.navigate': {
          const target = targets.find(item => `session-${item.targetId}` === request.sessionId);
          if (target) target.url = request.params.url;
          return reply({ frameId: `frame-${request.sessionId}` });
        }
        case 'Runtime.evaluate': return reply({ result: { value: request.sessionId } });
        default: return reply({});
      }
    }
    message(data) { queueMicrotask(() => { const event = new Event('message'); event.data = JSON.stringify(data); this.dispatchEvent(event); }); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const browser = createBackgroundBrowser({ endpoint: async () => { endpointCalls++; return 'ws://127.0.0.1:9222/devtools/browser/test'; }, WebSocketImpl: FakeWebSocket, timeoutMs, connectTimeoutMs });
  t.after(() => browser.close());
  return { browser, requests, sockets, targets, endpointCalls: () => endpointCalls };
}

test('background browser routes selected targets without activating Chrome', async t => {
  const f = fixture(t);
  assert.equal((await f.browser.tabs()).length, 2);
  await f.browser.select('A');
  await f.browser.select('A');
  assert.equal(await f.browser.evaluate(() => location.href), 'session-A');
  await f.browser.select('B');
  assert.equal(await f.browser.evaluate(() => location.href), 'session-B');
  assert.equal(f.endpointCalls(), 1);
  assert.equal(f.requests.filter(request => request.method === 'Target.attachToTarget').length, 2);
  assert.ok(f.requests.every(request => !['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(request.method)));
});

test('caller timeout preserves the pending Chrome handshake for retries and concurrent callers', async t => {
  const f = fixture(t, null, 1000, { autoOpen: false, connectTimeoutMs: 15 });
  const results = await Promise.allSettled([f.browser.tabs(), f.browser.select('A')]);
  assert.deepEqual(results.map(result => result.reason?.code), ['approval_required', 'approval_required']);
  await assert.rejects(f.browser.tabs(), { code: 'approval_required' });
  assert.equal(f.endpointCalls(), 1);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].readyState, 0);
  assert.equal(f.requests.length, 0);
});

test('late Chrome consent initializes once and retry reuses the same connection without replay', async t => {
  const f = fixture(t, null, 1000, { autoOpen: false, connectTimeoutMs: 15 });
  await assert.rejects(f.browser.select('A'), { code: 'approval_required' });
  await assert.rejects(f.browser.evaluate(() => document.querySelector('button').click()), { code: 'approval_required' });
  f.sockets[0].open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests.map(request => request.method), ['Target.setDiscoverTargets']);
  assert.equal((await f.browser.tabs()).length, 2);
  assert.equal(await f.browser.evaluate(() => location.href), 'session-A');
  assert.equal(f.endpointCalls(), 1);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests.filter(request => request.method === 'Target.setDiscoverTargets').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 1);
});

test('explicit close rejects pending callers and stops the handshake', async t => {
  const f = fixture(t, null, 1000, { autoOpen: false, connectTimeoutMs: 1000 });
  const waiting = assert.rejects(f.browser.tabs(), { code: 'disconnected' });
  await new Promise(resolve => setImmediate(resolve));
  f.browser.close();
  await waiting;
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.requests.length, 0);
});

test('socket failure after caller timeout is consumed and the next explicit call may reconnect', async t => {
  const f = fixture(t, null, 1000, { autoOpen: false, connectTimeoutMs: 15 });
  await assert.rejects(f.browser.tabs(), { code: 'approval_required' });
  f.sockets[0].dispatchEvent(new Event('error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sockets[0].readyState, 3);
  const retry = f.browser.tabs();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  assert.equal((await retry).length, 2);
  assert.equal(f.endpointCalls(), 2);
});

test('new posting tab stays in the selected account context and opens in background', async t => {
  const f = fixture(t);
  await f.browser.select('B');
  const tab = await f.browser.openTab('https://www.pixiv.net/illustration/create');
  assert.equal(tab.targetId, 'NEW');
  assert.equal(tab.active, true);
  const create = f.requests.find(request => request.method === 'Target.createTarget');
  assert.match(create.params.url, /^about:blank#pixiv-publisher-/);
  assert.equal(create.params.background, true);
  assert.equal(create.params.browserContextId, 'profile-b');
  const focus = f.requests.find(request => request.method === 'Emulation.setFocusEmulationEnabled');
  assert.deepEqual(focus.params, { enabled: true });
  assert.equal(focus.sessionId, 'session-NEW');
  const focusIndex = f.requests.indexOf(focus);
  assert.ok(focusIndex > f.requests.findIndex(request => request.method === 'Target.createTarget'));
  assert.ok(focusIndex < f.requests.findIndex(request => request.method === 'Page.navigate'));
  assert.deepEqual(f.requests.find(request => request.method === 'Page.navigate').params, { url: 'https://www.pixiv.net/illustration/create' });
  assert.equal(tab.url, 'https://www.pixiv.net/illustration/create');
  assert.equal(await f.browser.evaluate(() => 1), 'session-NEW');
  assert.ok(f.requests.every(request => !/bringToFront|activateTarget/.test(request.method)));
});

function rejectRegularProfile({ request, socket }) {
  if (request.method !== 'Target.createTarget') return false;
  socket.message({ id: request.id, error: { message: `Failed to find browser context with id ${request.params.browserContextId}` } });
  return true;
}

test('secondary Chrome profile creates a sibling in an isolated world without navigating the source', async t => {
  const links = [], clicks = [];
  const f = fixture(t, input => {
    if (rejectRegularProfile(input)) return true;
    const { request, reply, targets } = input;
    if (request.method !== 'Runtime.evaluate' || request.params.contextId !== 42) return;
    const document = {
      createElement(type) {
        assert.equal(type, 'a');
        return {
          dispatchEvent(event) {
            clicks.push(event);
            targets.push({ targetId: 'SIBLING', type: 'page', url: this.href, browserContextId: 'profile-b' });
          },
          remove() { links.splice(links.indexOf(this), 1); },
        };
      },
      documentElement: { append(link) { links.push(link); } },
    };
    class MouseEvent { constructor(type, options) { Object.assign(this, { type }, options); } }
    vm.runInNewContext(request.params.expression, { document, MouseEvent, window: {} });
    reply({ result: {} }); return true;
  });
  await f.browser.select('B');
  assert.equal((await f.browser.openTab('https://www.pixiv.net/illustration/create')).targetId, 'SIBLING');
  assert.equal(links.length, 0);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].ctrlKey, true);
  assert.equal(clicks[0].metaKey, true);
  assert.equal(clicks[0].bubbles, false);
  assert.equal(f.targets.find(target => target.targetId === 'B').url, 'https://www.pixiv.net/');
  const isolated = f.requests.find(request => request.method === 'Page.createIsolatedWorld');
  assert.equal(isolated.sessionId, 'session-B');
  assert.equal(isolated.params.frameId, 'frame-session-B');
  const evaluation = f.requests.find(request => request.method === 'Runtime.evaluate');
  assert.equal(evaluation.params.contextId, 42);
  assert.equal(evaluation.params.userGesture, true);
  assert.equal(evaluation.sessionId, 'session-B');
  assert.equal(f.requests.filter(request => request.method === 'Target.createTarget').length, 1);
  assert.equal(f.requests.find(request => request.method === 'Page.navigate').sessionId, 'session-SIBLING');
  assert.deepEqual(f.requests.filter(request => request.method === 'Emulation.setFocusEmulationEnabled').map(request => request.sessionId), ['session-SIBLING']);
  assert.ok(f.requests.every(request => !/bringToFront|activateTarget|setWindowBounds/.test(request.method)));
  assert.ok(!evaluation.params.expression.includes('window.open'));
});

test('a mismatched new profile is closed before visiting Pixiv and the original selection is retained', async t => {
  const f = fixture(t, ({ request, reply, targets }) => {
    if (request.method !== 'Target.createTarget') return;
    targets.push({ targetId: 'WRONG', type: 'page', url: request.params.url, browserContextId: 'profile-a' });
    reply({ targetId: 'WRONG' }); return true;
  });
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), { code: 'identity_mismatch' });
  assert.equal(f.requests.filter(request => request.method === 'Emulation.setFocusEmulationEnabled').length, 0);
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 0);
  assert.deepEqual(f.requests.filter(request => request.method === 'Target.closeTarget').map(request => request.params.targetId), ['WRONG']);
  assert.equal(await f.browser.evaluate(() => 1), 'session-B');
});

test('unsupported focus emulation stops the new tab before navigation without activating Chrome', async t => {
  const f = fixture(t, ({ request, socket }) => {
    if (request.method !== 'Emulation.setFocusEmulationEnabled') return;
    socket.message({ id: request.id, error: { message: 'Emulation.setFocusEmulationEnabled was not found' } }); return true;
  });
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), /not found/);
  assert.deepEqual(f.requests.filter(request => request.method === 'Emulation.setFocusEmulationEnabled').map(request => request.sessionId), ['session-NEW']);
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 0);
  assert.ok(f.requests.every(request => !/bringToFront|activateTarget|setWindowBounds/.test(request.method)));
  assert.equal(await f.browser.evaluate(() => 1), 'session-B');
});

test('posting tab waits for a delayed target URL update after one navigation', async t => {
  let navigationUrl, navigationPolls = 0;
  const f = fixture(t, ({ request, reply, targets }) => {
    if (request.method === 'Page.navigate') { navigationUrl = request.params.url; reply({ frameId: 'frame-new' }); return true; }
    if (request.method === 'Target.getTargets' && navigationUrl && ++navigationPolls === 2) {
      targets.find(target => target.targetId === 'NEW').url = navigationUrl;
    }
  });
  await f.browser.select('B');
  const tab = await f.browser.openTab('https://www.pixiv.net/illustration/create');
  assert.equal(tab.url, 'https://www.pixiv.net/illustration/create');
  assert.equal(navigationPolls, 2);
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 1);
  assert.equal(f.targets.find(target => target.targetId === 'B').url, 'https://www.pixiv.net/');
  assert.equal(await f.browser.evaluate(() => 1), 'session-NEW');
});

test('an unchanged blank URL times out without renavigation or selecting the new tab', async t => {
  const f = fixture(t, ({ request, reply }) => {
    if (request.method === 'Page.navigate') { reply({ frameId: 'frame-new' }); return true; }
  }, 20);
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), { code: 'timeout' });
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'Target.createTarget').length, 1);
  assert.equal(await f.browser.evaluate(() => 1), 'session-B');
});

test('a profile change while waiting for navigation stops before selecting that target', async t => {
  const f = fixture(t, ({ request, reply, targets }) => {
    if (request.method !== 'Page.navigate') return;
    Object.assign(targets.find(target => target.targetId === 'NEW'), { browserContextId: 'profile-a', url: request.params.url });
    reply({ frameId: 'frame-new' }); return true;
  });
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), { code: 'identity_mismatch' });
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 1);
  assert.equal(await f.browser.evaluate(() => 1), 'session-B');
});

test('missing source profile fails closed instead of using the default Chrome profile', async t => {
  const f = fixture(t);
  delete f.targets[1].browserContextId;
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), { code: 'identity_mismatch' });
  assert.equal(f.requests.filter(request => request.method === 'Target.createTarget').length, 0);
});

test('unknown target creation errors never trigger another creation path', async t => {
  const f = fixture(t, ({ request, socket }) => {
    if (request.method !== 'Target.createTarget') return;
    socket.message({ id: request.id, error: { message: 'Failed to open a new tab' } }); return true;
  });
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), /Failed to open/);
  assert.equal(f.requests.filter(request => request.method === 'Target.createTarget').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'Page.createIsolatedWorld').length, 0);
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 0);
});

test('a fallback with no resulting target times out without another click or navigation', async t => {
  const f = fixture(t, rejectRegularProfile, 20);
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), { code: 'timeout' });
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 0);
  assert.equal(await f.browser.evaluate(() => 1), 'session-B');
});

test('a missing isolated world never falls back to a foreground main-world click', async t => {
  const f = fixture(t, input => {
    if (rejectRegularProfile(input)) return true;
    if (input.request.method === 'Page.createIsolatedWorld') { input.reply({}); return true; }
  });
  await f.browser.select('B');
  await assert.rejects(f.browser.openTab('https://www.pixiv.net/illustration/create'), /隔离操作环境/);
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 0);
  assert.equal(f.requests.filter(request => request.method === 'Page.navigate').length, 0);
});

test('a closed or missing target fails instead of falling back to another account', async t => {
  const f = fixture(t);
  await f.browser.select('A');
  f.targets.splice(0, 1);
  await assert.rejects(f.browser.evaluate(() => 'mutation'), { code: 'tab_gone' });
  await assert.rejects(f.browser.select('MISSING'), { code: 'tab_gone' });
  await assert.rejects(f.browser.evaluate(() => 'mutation'), { code: 'tab_gone' });
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 0);
});

test('connection loss rejects a sent mutation without retry; next call may reconnect', async t => {
  let disconnect = true;
  const f = fixture(t, ({ request, socket }) => {
    if (request.method === 'Runtime.evaluate' && disconnect) { disconnect = false; queueMicrotask(() => socket.close()); return true; }
  });
  await f.browser.select('A');
  await assert.rejects(f.browser.evaluate(() => document.querySelector('button').click()), { code: 'disconnected' });
  assert.equal(f.endpointCalls(), 1);
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 1);
  assert.equal(await f.browser.evaluate(() => location.href), 'session-A');
  assert.equal(f.endpointCalls(), 2);
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 2);
});

test('page evaluation errors are surfaced without replay', async t => {
  const f = fixture(t, ({ request, reply }) => {
    if (request.method === 'Runtime.evaluate') {
      reply({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: Pixiv 登录账号已改变' } } }); return true;
    }
  });
  await f.browser.select('A');
  await assert.rejects(f.browser.evaluate(() => 1), /Pixiv 登录账号已改变/);
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 1);
});

test('a CDP session error never causes a mutation to run in a different tab', async t => {
  const f = fixture(t, ({ request, socket }) => {
    if (request.method === 'Runtime.evaluate') {
      socket.message({ id: request.id, error: { message: 'Session with given id not found.' } }); return true;
    }
  });
  await f.browser.select('A');
  await assert.rejects(f.browser.evaluate(() => 'mutation'), { code: 'tab_gone' });
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 1);
});

test('a timed out mutation closes its connection without replaying the command', async t => {
  const f = fixture(t, ({ request }) => request.method === 'Runtime.evaluate', 20);
  await f.browser.select('A');
  await assert.rejects(f.browser.evaluate(() => 'mutation'), { code: 'timeout' });
  assert.equal(f.endpointCalls(), 1);
  assert.equal(f.requests.filter(request => request.method === 'Runtime.evaluate').length, 1);
  assert.equal(f.sockets[0].readyState, 3);
});

test('upload targets the selected session and releases its object without exposing credentials', async t => {
  const f = fixture(t, ({ request, reply }) => {
    if (request.method === 'Runtime.evaluate') { reply({ result: { type: 'object', objectId: 'file-input' } }); return true; }
  });
  await f.browser.select('B');
  await f.browser.command(['upload', 'input[name="files[]"]', 'D:\\images\\one.png']);
  assert.deepEqual(f.requests.find(request => request.method === 'DOM.setFileInputFiles'), {
    id: f.requests.find(request => request.method === 'DOM.setFileInputFiles').id,
    method: 'DOM.setFileInputFiles', params: { files: ['D:\\images\\one.png'], objectId: 'file-input' }, sessionId: 'session-B',
  });
  assert.equal(f.requests.at(-1).method, 'Runtime.releaseObject');
  assert.ok(f.requests.every(request => !/cookie/i.test(request.method)));
});

test('background form actions use native value setter, blur previous input, and verify checks', async t => {
  const events = [];
  let focused;
  class Input {
    constructor(type = 'text') { this.type = type; this.checked = false; this._value = ''; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    getAttribute() { return null; }
    focus() { if (focused && focused !== this) events.push('blur'); focused = this; }
    click() { events.push('click'); if (this.type === 'checkbox') this.checked = !this.checked; }
    dispatchEvent(event) { events.push(event.type); }
  }
  class Textarea extends Input {}
  Object.defineProperty(Textarea.prototype, 'value', Object.getOwnPropertyDescriptor(Input.prototype, 'value'));
  const tag = new Input(), title = new Input(), checkbox = new Input('checkbox');
  Object.defineProperty(tag, 'value', { get() { return this._value; }, set() { throw new Error('React own setter must not be called'); } });
  const elements = { '#tag': tag, '#title': title, '#check': checkbox };
  const document = { querySelectorAll: selector => elements[selector] ? [elements[selector]] : [] };
  const f = fixture(t, ({ request, reply }) => {
    if (request.method !== 'Runtime.evaluate') return;
    try { reply({ result: { value: vm.runInNewContext(request.params.expression, { document, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, Event }) } }); }
    catch (error) { reply({ exceptionDetails: { text: error.message } }); }
    return true;
  });
  await f.browser.select('A');
  await f.browser.command(['fill', '#tag', 'Robin']);
  await f.browser.command(['click', '#title']);
  assert.equal(tag.value, 'Robin');
  assert.deepEqual(events, ['input', 'change', 'blur', 'click']);
  await f.browser.command(['check', '#check']);
  await f.browser.command(['check', '#check']);
  assert.equal(checkbox.checked, true);
  await f.browser.command(['uncheck', '#check']);
  assert.equal(checkbox.checked, false);
  assert.equal(events.filter(event => event === 'click').length, 3);
  await assert.rejects(f.browser.command(['fill', '#missing', 'value']), /控件数量不符/);
});

test('a DOM wait reuses the chosen session without switching or activation', async t => {
  let attempts = 0;
  const f = fixture(t, ({ request, reply }) => {
    if (request.method === 'Runtime.evaluate') { reply({ result: { value: ++attempts > 1 } }); return true; }
  });
  await f.browser.select('A');
  await f.browser.command(['wait', '--fn', 'document.readyState === "complete"']);
  assert.equal(attempts, 2);
  assert.ok(f.requests.filter(request => request.method === 'Runtime.evaluate').every(request => request.sessionId === 'session-A'));
});
