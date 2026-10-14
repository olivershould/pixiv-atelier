import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { chooseSchedule, readForm } from '../server/browser-driver.mjs';
import { createBrowserConnector, scheduleLabels } from '../server/browser-connector.mjs';

const targetId = 'A'.repeat(32);
const account = { id: 'account', pixivUserId: '101', browser: { targetId, postingEnabled: true } };
const job = () => ({ id: 'job', accountId: account.id, title: 'Furina', caption: '', tags: ['原神'], tagsConfirmed: true,
  scheduledAt: '2026-10-14T00:00:00Z', timezone: 'Asia/Tokyo',
  files: [{ id: 'file', name: 'test.png', size: 100, mime: 'image/png' }],
  content: { type: 'illust', rating: 'all', sexualContent: false, aiGenerated: true, visibility: 'public',
    allowTagEdit: true, allowComments: true, allowCollection: true, original: false,
    thumbnail: { page: 1, x: .5, y: .5 } } });

function pickerPage() {
  const nodes = [], controls = [], outside = [];
  const state = { openCount: 0, optionClicks: 0, menuVisible: false };
  const node = (text, { title = null, visible = true, disabled = false, popup = null, onClick = () => {} } = {}) => ({
    textContent: text, title, visible, disabled,
    getAttribute(name) { return name === 'title' ? this.title : name === 'aria-disabled' ? String(this.disabled) : name === 'aria-controls' ? popup : null; },
    querySelector: () => null,
    checkVisibility() { return typeof this.visible === 'function' ? this.visible() : this.visible; },
    contains: () => false,
    click: onClick,
  });
  const date = node('2026年10月14日', { title: '2026年10月14日' });
  const time = node('01:00 JST', { title: '01:00 JST', onClick: () => { state.openCount++; state.menuVisible = !state.menuVisible; } });
  controls.push(node('无关控件'), date, time);
  const root = { querySelectorAll: selector => {
    if (selector === '[tabindex="0"]') return controls;
    assert.equal(selector, '[role="button"]');
    return nodes;
  } };
  const reserve = { closest: selector => { assert.equal(selector, 'label'); return { parentElement: root }; } };
  const document = {
    querySelector: selector => { assert.equal(selector, 'input[name=reserve]'); return reserve; },
    querySelectorAll: selector => {
      assert.equal(selector, '[role="button"]');
      return [...controls, ...nodes, ...outside];
    },
  };
  const choose = args => vm.runInNewContext(`(${chooseSchedule.toString()})(${JSON.stringify(args)})`, { document });
  const addOption = (text, options = {}) => {
    const option = node(text, { visible: () => state.menuVisible, onClick: () => { state.optionClicks++; }, ...options });
    nodes.push(option); return option;
  };
  return { choose, state, date, time, controls, nodes, outside, addOption, node, document, root };
}

test('picker recognizes the selected date semantically without clicking unrelated focusable controls', () => {
  const f = pickerPage();
  assert.equal(f.choose({ kind: 'date', text: '2026年10月14日' }).status, 'chosen');
  assert.equal(f.state.openCount, 0);
  assert.equal(f.state.optionClicks, 0);
});

test('picker opens once, tolerates delayed options and normalizes time whitespace and zero padding', () => {
  const f = pickerPage();
  const args = { kind: 'time', text: '09:00 JST' };
  assert.equal(f.choose(args).status, 'opened');
  assert.equal(f.choose({ ...args, phase: 'select' }).status, 'pending');
  assert.equal(f.state.openCount, 1);
  f.addOption('9:00\u00a0JST');
  f.addOption('09:00 JST', { visible: false });
  assert.equal(f.choose({ ...args, phase: 'select' }).status, 'selected');
  assert.equal(f.state.optionClicks, 1);
  assert.equal(f.choose({ ...args, phase: 'verify' }).status, 'pending');
  assert.equal(f.state.optionClicks, 1, 'verification cannot replay an option click');
  f.time.title = f.time.textContent = '09:00 JST';
  assert.equal(f.choose({ ...args, phase: 'verify' }).status, 'chosen');
  assert.equal(f.state.openCount, 1);
});

test('time option labels may omit JST inside the Japan-time picker', () => {
  const f = pickerPage(); f.state.menuVisible = true;
  f.addOption('09:00');
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST', phase: 'select' }).status, 'selected');
  assert.equal(f.state.optionClicks, 1);
});

test('Pixiv controls and options can expose their label only through nested title spans', () => {
  const f = pickerPage(); f.state.menuVisible = true;
  let selectedLabel = '01:00 JST';
  f.time.title = null;
  f.time.querySelector = selector => {
    assert.equal(selector, '[title]');
    return { getAttribute: () => selectedLabel };
  };
  const option = f.addOption('09:00 JST');
  option.querySelector = selector => {
    assert.equal(selector, '[title]');
    return { getAttribute: () => '09:00 JST' };
  };
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST', phase: 'select' }).status, 'selected');
  selectedLabel = '09:00 JST';
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST', phase: 'verify' }).status, 'chosen');
  assert.equal(f.state.optionClicks, 1);
});

test('multiple visible matching options fail closed instead of toggling the control', () => {
  const f = pickerPage(); f.state.menuVisible = true;
  f.addOption('09:00 JST'); f.addOption('09:00 JST');
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST', phase: 'select' }).status, 'ambiguous');
  assert.equal(f.state.optionClicks, 0);
  assert.equal(f.state.openCount, 0);
});

test('disabled and hidden candidates cannot be selected', () => {
  const f = pickerPage(); f.state.menuVisible = true;
  f.addOption('09:00 JST', { disabled: true }); f.addOption('09:00 JST', { visible: false });
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST', phase: 'select' }).status, 'pending');
  assert.equal(f.state.optionClicks, 0);
  f.time.disabled = true;
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST' }).status, 'unavailable');
  assert.equal(f.state.openCount, 0);
});

test('picker ignores matching buttons outside the reservation block', () => {
  const f = pickerPage(); f.state.menuVisible = true;
  f.outside.push(f.node('09:00 JST', { onClick: () => assert.fail('outside the reservation block') }));
  f.addOption('09:00 JST');
  assert.equal(f.choose({ kind: 'time', text: '09:00 JST', phase: 'select' }).status, 'selected');
  assert.equal(f.state.optionClicks, 1);
});

test('form readback uses selected controls and excludes labels from the open option menu', () => {
  const f = pickerPage(); f.state.menuVisible = true;
  f.addOption('09:00 JST'); f.addOption('11:00 JST');
  const tagInput = { parentElement: { parentElement: { children: [] } } };
  const querySelector = f.document.querySelector;
  f.document.querySelector = selector => selector === 'input[placeholder="标签"]' ? tagInput : querySelector(selector);
  f.document.querySelectorAll = () => [];
  const result = vm.runInNewContext(`(${readForm.toString()})()`, {
    document: f.document,
    location: { origin: 'https://www.pixiv.net', pathname: '/illustration/create', href: 'https://www.pixiv.net/illustration/create' },
  });
  assert.deepEqual(Array.from(result.scheduleLabels), ['2026年10月14日', '01:00 JST']);
});

async function connectorFixture(t, picker) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'huaxu-schedule-picker-'));
  t.after(async () => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const commands = [], calls = [];
  const driver = {
    tabs: async () => [{ targetId, url: 'https://www.pixiv.net/' }],
    select: async () => {},
    openTab: async () => ({ targetId, url: 'https://www.pixiv.net/illustration/create' }),
    command: async args => {
      commands.push(args);
      // Stop at the upload boundary: these tests must never submit anything.
      if (args[0] === 'upload') throw new Error('test reached upload boundary');
    },
    evaluate: async (fn, args) => {
      if (fn.name === 'readIdentity') return { loggedIn: true, pixivUserId: '101', premium: true };
      if (fn.name === 'readRemote') return { identity: { pixivUserId: '101', premium: true },
        responses: [{ kind: 'illust', reserved: [] }, { kind: 'novel', reserved: [] }] };
      if (fn.name === 'readAccountAvatar') return null;
      if (fn.name === 'chooseSchedule') { calls.push(args); return picker(args); }
      throw new Error(`Unexpected browser function: ${fn.name}`);
    },
  };
  const connector = await createBrowserConnector({ dataDir, driver, now: () => new Date('2026-10-13T15:59:00Z') });
  return { connector, commands, calls };
}

test('failed-run timestamp formats as the correct future Japan date and time', () => {
  assert.deepEqual(scheduleLabels(job().scheduledAt), { date: '2026年10月14日', time: '09:00 JST' });
});

test('connector waits for menu rendering and selection readback without reopening or reselecting', async t => {
  const timeResults = [
    { status: 'opened', current: '01:00 JST' },
    { status: 'pending', current: '01:00 JST' },
    { status: 'selected', current: '01:00 JST' },
    { status: 'pending', current: '01:00 JST' },
    { status: 'chosen', current: '09:00 JST' },
  ];
  const f = await connectorFixture(t, ({ kind }) => kind === 'date' ? { status: 'chosen' } : timeResults.shift());
  const result = await f.connector.reserve(account, job(), ['test.png'], 'polling');
  assert.match(result.error, /test reached upload boundary/);
  assert.deepEqual(f.calls.filter(call => call.kind === 'time').map(call => call.phase), ['open', 'select', 'select', 'verify', 'verify']);
  assert.equal(f.commands.filter(args => args[0] === 'upload').length, 1);
});

test('date and time failures identify the exact field and never upload images', async t => {
  for (const kind of ['date', 'time']) {
    const f = await connectorFixture(t, args => args.kind === kind
      ? { status: 'ambiguous', current: kind === 'date' ? '2026年10月15日' : '01:00 JST' }
      : { status: 'chosen' });
    const result = await f.connector.reserve(account, job(), ['test.png'], `ambiguous-${kind}`);
    assert.equal(result.outcome, 'not_uploaded');
    assert.match(result.error, new RegExp(`预约${kind === 'date' ? '日期' : '时间'}选择失败`));
    assert.match(result.error, /匹配到多个选项/);
    assert.match(result.error, /尚未上传图片/);
    assert.equal(f.commands.some(args => args[0] === 'upload'), false);
  }
});

test('an unavailable schedule control stops before upload', async t => {
  const f = await connectorFixture(t, () => ({ status: 'unavailable', current: '01:00 JST' }));
  const result = await f.connector.reserve(account, job(), ['test.png'], 'unavailable');
  assert.equal(result.outcome, 'not_uploaded');
  assert.match(result.error, /控件不可用/);
  assert.equal(f.commands.some(args => args[0] === 'upload'), false);
});

test('a missing menu option times out after bounded polling without another open or upload', async t => {
  const f = await connectorFixture(t, ({ kind, phase }) => kind === 'date' ? { status: 'chosen' }
    : { status: phase === 'open' ? 'opened' : 'pending', current: '01:00 JST' });
  const result = await f.connector.reserve(account, job(), ['test.png'], 'timeout');
  assert.equal(result.outcome, 'not_uploaded');
  assert.match(result.error, /预约时间选择失败：等待选项显示超时/);
  assert.match(result.error, /09:00 JST.*01:00 JST/);
  const timeCalls = f.calls.filter(call => call.kind === 'time');
  assert.equal(timeCalls.length, 30);
  assert.equal(timeCalls.filter(call => call.phase === 'open').length, 1);
  assert.equal(f.commands.some(args => args[0] === 'upload'), false);
});
