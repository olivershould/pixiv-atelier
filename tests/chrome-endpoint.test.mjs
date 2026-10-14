import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeEndpoint } from '../server/chrome-endpoint.mjs';

test('Chrome discovery reads the existing local endpoint without launching or switching tabs', async () => {
  let readPath;
  const result = await chromeEndpoint({ userDataDir: 'chrome-profile', readFile: async file => { readPath = file; return '9222\r\n/devtools/browser/1234-abcd\r\n'; } });
  assert.match(readPath, /chrome-profile[\\/]DevToolsActivePort$/);
  assert.equal(result, 'ws://127.0.0.1:9222/devtools/browser/1234-abcd');
});

test('Chrome discovery rejects missing or malformed local connection data without an activating fallback', async () => {
  await assert.rejects(chromeEndpoint({ readFile: async () => { throw new Error('missing'); } }), { code: 'disconnected' });
  for (const text of ['0\n/devtools/browser/id', '65536\n/devtools/browser/id', '9222\nhttps://other.test', '9222\n/devtools/browser/id?redirect=bad', '9222\n']) {
    await assert.rejects(chromeEndpoint({ readFile: async () => text }), { code: 'disconnected' });
  }
});
