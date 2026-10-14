export function defaultPostingTime(account = {}) {
  if (/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(account.defaultPostingTime || '')) return account.defaultPostingTime;
  return '09:00';
}
export function nextPostingSchedule(account, now = new Date()) {
  const current = +new Date(now);
  const japan = new Date(current + 9*3600000).toISOString().slice(0,10);
  const candidate = Date.parse(`${japan}T${defaultPostingTime(account)}:00+09:00`);
  return new Date(candidate > current ? candidate : candidate + 86400000).toISOString();
}
