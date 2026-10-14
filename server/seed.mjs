import { randomUUID } from 'node:crypto';

export function blankState() {
  return {
    accounts: [], jobs: [], logs: [],
    settings: { demo: false, mode: 'live', queuePaused: false, timezone: 'Asia/Shanghai', reservationCapacity: 10 },
  };
}

export function createDemoState(now = new Date()) {
  const time = new Date(now);
  const stamp = time.toISOString();
  const state = blankState();
  state.settings = { ...state.settings, demo: true, mode: 'demo', demoNow: stamp };
  state.accounts = [
    { id: 'demo-main', name: '青空工作室', pixivUserId: '演示账号 01', avatarColor: '#9ca88d' },
    { id: 'demo-sketch', name: '日常速写', pixivUserId: '演示账号 02', avatarColor: '#bf927c' },
    { id: 'demo-archive', name: '灵感收藏夹', pixivUserId: '演示账号 03', avatarColor: '#8d9bac' },
  ].map(account => ({ ...account, demo: true, connected: true, paused: false, premium: true,
    timezone: 'Asia/Shanghai', remote: { syncOk: true, syncedAt: stamp, total: 0, reservations: [] } }));
  // All thirty works belong to one account, so the ten-slot rolling limit is visible.
  const titles = ['风经过的夏天', '海边来信', '午后的光', '蓝色假日', '山间慢行', '云的方向', '下一站晴天', '窗边植物', '晚风与灯', '微小的日常'];
  const localDay = new Date(time.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const firstDay = new Date(`${localDay}T20:00:00+08:00`);
  if (firstDay <= time) firstDay.setUTCDate(firstDay.getUTCDate() + 1);
  for (let i = 0; i < 30; i++) {
    const batch = Math.floor(i / 10);
    const scheduledAt = new Date(firstDay.getTime() + batch * 86400000).toISOString();
    const id = `demo-work-${String(i + 1).padStart(2, '0')}`;
    const idempotencyKey = `demo-reservation-${id}`;
    state.jobs.push({
      id, accountId: 'demo-main', title: `${titles[i % 10]} · ${String(i + 1).padStart(2, '0')}`,
      caption: '这是一条本地演示作品，用来预览预约投稿流程。', tags: ['オリジナル', '風景', 'イラスト'], tagsConfirmed: true,
      files: [{ id: `demo-art-${(i % 6) + 1}`, name: `演示封面-${(i % 6) + 1}.svg`, url: `/art-${(i % 6) + 1}.svg`, mime: 'image/svg+xml', size: 0, demo: true }],
      status: i < 10 ? 'reserved' : 'queued', scheduledAt, timezone: 'Asia/Shanghai',
      createdAt: stamp, updatedAt: stamp, demo: true,
      content: { type: 'illust', aiGenerated: false, rating: 'all', visibility: 'public', original: true,
        sexualContent: false, adultAttributes: [], allowTagEdit: true, allowComments: true, allowCollection: true, tools: [], seriesId: '', imageResponse: '',
        allowImageResponse: false, contestTag: '', poll: { question: '', answers: [] }, thumbnail: { page: 1, x: 0.5, y: 0.5 } },
      ...(i < 10 ? { idempotencyKey, remoteId: `demo-pixiv-${i + 1}`, reservedAt: stamp } : {}),
    });
    if (i < 10) state.accounts[0].remote.reservations.push({ remoteId: `demo-pixiv-${i + 1}`, jobId: id, idempotencyKey, scheduledAt, status: 'reserved' });
  }
  state.accounts[0].remote.total = 10;
  state.logs.push({ id: randomUUID(), at: stamp, level: 'info', message: '演示已就绪：30 件作品分三天排期，第一批 10 件已模拟预约。没有连接或发布到真实 pixiv。', demo: true });
  return state;
}
