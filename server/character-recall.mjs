// Only exact bytes with an explicit user confirmation can supply identity.
// Embedding similarity is a candidate, never a calibrated identity probability.
export async function applyCharacterMemory(result, memory, mode) {
  const files = result.analyzedFiles || [];
  if (files.length !== 1 || !result.recognition || result.recognition.perFile?.[0]?.multiple) return result;
  const file = files[0];
  const { exact, candidates } = await memory.match({ mode, sha256: file.sha256, descriptor: file.descriptor });
  const recognition = { ...result.recognition, memory: { exact, candidates } };
  if (!exact) return { ...result, recognition };
  const name = `memory:${exact.id}`;
  const character = { name, englishName: exact.englishName, confidence: 1, fileId: file.id,
    source: 'user-confirmed-image', gameTags: exact.gameTags, characterTags: exact.characterTags };
  // The user may be correcting the classifier. Do not retain its conflicting
  // identity/game queries, but continue to infer rating and scene from pixels.
  const predictions = (result.predictions || []).filter(p => p.category !== 4);
  predictions.push({ name, category: 4, score: 1, fileId: file.id, source: character.source });
  const oldIdentities = new Set((result.predictions || []).filter(p => p.category === 4).map(p => p.name));
  return { ...result, predictions,
    candidates: (result.candidates || []).filter(c => !(c.modelNames || []).some(n => oldIdentities.has(n))),
    unmapped: (result.unmapped || []).filter(c => c.category !== 4),
    recognition: { ...recognition, title: exact.englishName, characters: [character],
      titleReason: '来自你对同一图片的角色确认',
      message: '角色名称来自本机记忆；分级和画面标签仍按当前图片识别。' } };
}
