export const QUEUE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function nextQueueCheck(now) {
  return new Date(Date.parse(now) + QUEUE_CHECK_INTERVAL_MS).toISOString();
}

export function summarizeQueueRun(before, after, run) {
  const prior = new Map(before.map(job => [job.id, job.status]));
  const changed = status => after.filter(job => job.status === status && prior.get(job.id) !== status).length;
  const result = { ...run, running: false, reserved: changed('reserved'), published: changed('published'),
    failed: changed('failed'), needsReview: changed('needs_review'), remaining: after.filter(job => job.status === 'queued').length };
  result.message = `本轮已预约 ${result.reserved} 件，确认发布 ${result.published} 件；剩余 ${result.remaining} 件待补位。`;
  if (result.failed || result.needsReview || result.errors.length) {
    result.message += ` ${result.failed} 件失败，${result.needsReview} 件需核对${result.errors.length ? `，${result.errors.length} 项执行问题` : ''}，请查看执行记录。`;
  }
  return result;
}
