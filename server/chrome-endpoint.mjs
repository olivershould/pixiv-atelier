import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserError } from './browser-driver.mjs';

// Discover Chrome without launching agent-browser or activating any browser tab.
// Chrome still enforces its own remote-debugging consent for the connection.
export async function chromeEndpoint({ userDataDir, readFile = fs.readFile } = {}) {
  const root = userDataDir || process.env.PIXIV_CHROME_USER_DATA_DIR || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  let text;
  try { text = await readFile(path.join(root, 'DevToolsActivePort'), 'utf8'); }
  catch { throw new BrowserError('无法找到 Chrome 远程调试连接。请保持 Chrome 打开，并在 chrome://inspect/#remote-debugging 允许远程调试。', 'disconnected'); }
  const [port, browserPath] = String(text).trim().split(/\r?\n/);
  if (!/^\d+$/.test(port || '') || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath || '')) {
    throw new BrowserError('Chrome 远程调试地址无效，请重新开启远程调试。', 'disconnected');
  }
  return `ws://127.0.0.1:${Number(port)}${browserPath}`;
}
