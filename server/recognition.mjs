// Suggestions describe the pixels; file names and existing titles are never inputs.
export function englishName(name) {
  if (name === 'ruan_mei_(honkai:_star_rail)') return 'RuanMei';
  return name.replace(/_?\([^)]*\)/g, '').replaceAll('_', ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b[a-z]/g, ch => ch.toUpperCase());
}

export function summarizeRecognition(files, predictions, ratings) {
  const characters = predictions.filter(p => p.category === 4 && p.score >= .85)
    .map(p => ({ name: p.name, englishName: englishName(p.name), confidence: p.score, fileId: p.fileId }));
  const perFile = files.map(file => {
    const rows = predictions.filter(p => p.fileId === file.id);
    const names = new Set(rows.filter(p => p.score >= .5).map(p => p.name));
    const multiple = [...names].some(n => /^(?:[2-9]|6\+)(?:girls|boys|others)$|^multiple_(?:girls|boys|others)$/.test(n)) ||
      ['1girl', '1boy', '1other'].filter(n => names.has(n)).length > 1;
    const single = !multiple && (names.has('solo') || ['1girl','1boy','1other'].some(n => names.has(n)));
    const scores = ratings.filter(r => r.fileId === file.id).sort((a,b) => b.score-a.score);
    const complete = ['general','sensitive','questionable','explicit'].every(n => scores.some(r => r.name === n));
    const top = scores[0];
    const graphic = rows.some(p => ['guro','gore','disembowelment','dismemberment'].includes(p.name) && p.score >= .65);
    const adult = scores.filter(r => ['questionable','explicit'].includes(r.name)).reduce((n,r) => n+r.score, 0);
    const rating = graphic ? 'r18g' : !complete ? null : adult >= .35 ? 'r18' : top?.score >= .5 ? 'all' : null;
    return { fileId: file.id, multiple, single, rating,
      sexualContent: rating === 'all' ? (scores.find(r=>r.name==='sensitive')?.score >= .2 || adult >= .1) : null,
      ratingConfidence: top?.score ?? null };
  });
  const identities = [...new Set(characters.map(c=>c.name))];
  const title = files.length === 1 && perFile[0]?.single && identities.length === 1 ? characters[0].englishName : '';
  const severity = { all: 0, r18: 1, r18g: 2 };
  const rating = perFile.length && perFile.every(f=>f.rating) ? perFile.reduce((a,f)=>severity[f.rating]>severity[a]?f.rating:a,'all') : null;
  return { title: title.length <= 32 ? title : '', characters, perFile, rating,
    sexualContent: rating === 'all' ? perFile.some(f=>f.sexualContent) : null,
    titleReason: files.length !== 1 ? '多张图片，标题留空' : perFile[0]?.multiple || identities.length > 1 ? '检测到多角色或身份歧义，标题留空' : title ? '已识别单角色英文名' : '未可靠识别单角色，标题留空',
    message: '标题和分级已按识图结果填写，可以手动修改。未识别或不确定的内容保留为空。' };
}

// These are search terms, not proof that a Pixiv tag exists. Suggestions need
// a Pixiv match, either live or an explicitly identified earlier verification.
const aliases = {
  '1girl':['女の子'], '2girls':['女の子'], multiple_girls:['女の子'], '1boy':['男の子'],
  navel:['おへそ'], smile:['笑顔','笑颜'], barefoot:['裸足'], bare_shoulders:['肩出し'], swimsuit:['水着'],
  armpits:['腋'], sideboob:['横乳'], back:['背中'], toes:['足指'], kimono:['着物'], scenery:['風景'],
  yukata:['浴衣'], china_dress:['チャイナドレス'], shorts:['ショートパンツ'], short_shorts:['ショートパンツ'],
  white_pantyhose:['白タイツ'], black_pantyhose:['黒タイツ','黒スト'], dark_skin:['褐色'], onsen:['温泉'],
  breasts:['胸','おっぱい'], large_breasts:['巨乳'], huge_breasts:['爆乳'],
  thighs:['太もも'], legs:['脚'], soles:['足裏'], thighhighs:['ニーソックス','ニーハイ'],
  pantyhose:['パンティストッキング'], cleavage:['胸の谷間'],
  'lumine_(genshin_impact)':['蛍(原神)','荧'], 'barbara_(genshin_impact)':['バーバラ(原神)'],
  kamisato_ayaka:['神里綾華','神里绫华'], 'mona_(genshin_impact)':['モナ(原神)'],
  'ganyu_(genshin_impact)':['甘雨(原神)','甘雨'], 'hu_tao_(genshin_impact)':['胡桃(原神)','胡桃'],
  'keqing_(genshin_impact)':['刻晴'], 'raiden_shogun':['雷電将軍','雷电将军'],
  'nahida_(genshin_impact)':['ナヒーダ','纳西妲'], 'furina_(genshin_impact)':['フリーナ','フリーナ(原神)','芙宁娜'],
  yae_miko:['八重神子','yaemiko'], sangonomiya_kokomi:['珊瑚宮心海'],
  'nilou_(genshin_impact)':['ニィロウ','妮露'], 'yelan_(genshin_impact)':['夜蘭','yelan'],
  'fischl_(genshin_impact)':['フィッシュル(原神)'], 'amber_(genshin_impact)':['アンバー(原神)'],
  'shenhe_(genshin_impact)':['申鶴','Shenhe'], 'noelle_(genshin_impact)':['ノエル(原神)'],
  'yoimiya_(genshin_impact)':['宵宮','宵宫'], 'lisa_(genshin_impact)':['リサ(原神)'], 'eula_(genshin_impact)':['エウルア'],
  'kafka_(honkai:_star_rail)':['カフカ(スターレイル)','Kafka'],
  'silver_wolf_(honkai:_star_rail)':['銀狼(スターレイル)'],
  'march_7th_(honkai:_star_rail)':['三月なのか','三月七','March7th'],
  'stelle_(honkai:_star_rail)':['星(スターレイル)'],
  'himeko_(honkai:_star_rail)':['姫子(スターレイル)'],
  'ruan_mei_(honkai:_star_rail)':['RuanMei','Ruan Mei','阮梅'],
  'sparxie_(honkai:_star_rail)':['火花(スターレイル)','Sparxie'],
};

// General character vocabulary for manual identity matching. This does not add
// labels to the image model or prove a Pixiv tag exists; callers still require
// account history or Pixiv evidence before using a verified tag.
const historicalCharacterVocabulary = [
  { name: 'velina_(zenless_zone_zero)', englishName: 'Velina', characterTags: ['ヴェリナ・エガード', 'Velina Airgid'] },
  { name: 'remielle_(zenless_zone_zero)', englishName: 'Remielle', characterTags: ['レミエール・ダン', 'Remielle Dan'] },
  { name: 'claret_(zenless_zone_zero)', englishName: 'Claret', characterTags: ['クラレッタ', 'クラレッタ・フリンツ', 'Claret Flint'] },
  { name: 'yixuan_(zenless_zone_zero)', englishName: 'Yixuan', characterTags: ['儀玄'] },
  { name: 'ye_shunguang_(zenless_zone_zero)', englishName: 'Ye Shunguang', characterTags: ['葉瞬光'] },
  { name: 'nicole_demara_(zenless_zone_zero)', englishName: 'Nicole Demara', characterTags: ['NicoleDemara'] },
  { name: 'sunna_(zenless_zone_zero)', englishName: 'Sunna', characterTags: ['千夏(ゼンゼロ)', '千夏'] },
  { name: 'aemeath_(wuthering_waves)', englishName: 'Aemeath', characterTags: ['エイメス'] },
  { name: 'hyacine_(honkai:_star_rail)', englishName: 'Hyacine', characterTags: ['ヒアンシー'] },
  { name: 'lauma_(genshin_impact)', englishName: 'Lauma', characterTags: ['ラウマ'] },
  { name: 'skirk_(genshin_impact)', englishName: 'Skirk', characterTags: ['スカーク'] },
  { name: 'acheron_(honkai:_star_rail)', englishName: 'Acheron', characterTags: ['黄泉(スターレイル)'] },
  { name: 'black_swan_(honkai:_star_rail)', englishName: 'Black Swan', characterTags: ['ブラックスワン(スターレイル)'] },
  { name: 'topaz_(honkai:_star_rail)', englishName: 'Topaz', characterTags: ['トパーズ(スターレイル)'] },
  // Keep Herta distinct from The Herta; a bare ヘルタ stays Herta.
  { name: 'herta_(honkai:_star_rail)', englishName: 'Herta', characterTags: ['ヘルタ', 'ヘルタ(スターレイル)'] },
  { name: 'chiori_(genshin_impact)', englishName: 'Chiori', characterTags: ['千織(原神)'] },
  { name: 'lynette_(genshin_impact)', englishName: 'Lynette', characterTags: ['リネット(原神)', 'リネット'] },
  { name: 'sandrone_(genshin_impact)', englishName: 'Sandrone', characterTags: ['サンドローネ(原神)'] },
  // These aliases identify one character; actual tag availability is separate.
  { name: 'bronya_rand_(honkai:_star_rail)', englishName: 'Bronya Rand', characterTags: ['ブローニャ・ランド'] },
  { name: 'tingyun_(honkai:_star_rail)', englishName: 'Tingyun', characterTags: ['停雲'] },
  { name: 'jingliu_(honkai:_star_rail)', englishName: 'Jingliu', characterTags: ['镜流', '鏡流'] },
  { name: 'qingque_(honkai:_star_rail)', englishName: 'Qingque', characterTags: ['青雀'] },
  { name: 'huohuo_(honkai:_star_rail)', englishName: 'Huohuo', characterTags: ['フォフォ'] },
  { name: 'jinhsi_(wuthering_waves)', englishName: 'Jinhsi', characterTags: ['今汐'] },
  { name: 'changli_(wuthering_waves)', englishName: 'Changli', characterTags: ['長離'] },
  { name: 'belle_(zenless_zone_zero)', englishName: 'Belle', characterTags: ['リン(ゼンゼロ)'] },
  { name: 'arlecchino_(genshin_impact)', englishName: 'Arlecchino', characterTags: ['アルレッキーノ(原神)'] },
  { name: 'columbina_(genshin_impact)', englishName: 'Columbina', characterTags: ['コロンビーナ(原神)'] },
  { name: 'odette_(genshin_impact)', englishName: 'Odette', characterTags: ['オデット(原神)'] },
  { name: 'zhu_yuan_(zenless_zone_zero)', englishName: 'Zhu Yuan', characterTags: ['ZhuYuan'] },
  { name: 'anby_(zenless_zone_zero)', englishName: 'Anby', characterTags: ['アンビー・デマラ'] },
  { name: 'rover_(wuthering_waves)', englishName: 'Rover', characterTags: ['漂泊者'] },
  { name: 'zani_(wuthering_waves)', englishName: 'Zani', characterTags: ['ザンニー', '赞妮'] },
  // Identity aliases do not create posting templates without account evidence.
  { name: 'caelus_(honkai:_star_rail)', englishName: 'Caelus', characterTags: ['穹(スターレイル)'] },
  { name: 'paimon_(genshin_impact)', englishName: 'Paimon', characterTags: ['パイモン(原神)'] },
  { name: 'wise_(zenless_zone_zero)', englishName: 'Wise', characterTags: ['アキラ(ゼンゼロ)'] },
  { name: 'aether_(genshin_impact)', englishName: 'Aether', characterTags: ['空(原神)'] },
  { name: 'ishtar_(fate)', englishName: 'Ishtar', characterTags: ['イシュタル(Fate)'] },
  { name: 'feixiao_(honkai:_star_rail)', englishName: 'Feixiao', characterTags: ['飛霄'] },
  { name: 'fu_xuan_(honkai:_star_rail)', englishName: 'Fu Xuan', characterTags: ['FuXuan'] },
  // This explicit variant must not add gender to neutral Rover/漂泊者.
  { name: 'female_rover_(wuthering_waves)', englishName: 'Female Rover', characterTags: ['女漂泊者'] },
];
const characterGameFamilies = [
  { key: 'genshin', concept: 'game:genshin_impact', tags: ['原神', 'GenshinImpact'], qualifiers: ['原神', 'genshin impact'], marker: 'genshin_impact', names: ['kamisato_ayaka', 'raiden_shogun', 'yae_miko', 'sangonomiya_kokomi'] },
  { key: 'star-rail', concept: 'game:honkai_star_rail', tags: ['崩壊スターレイル', '崩壊:スターレイル', '崩坏星穹铁道', 'HonkaiStarRail'], qualifiers: ['スターレイル', '崩壊スターレイル', 'honkai: star rail', 'star rail'], marker: 'honkai:_star_rail' },
  { key: 'zenless', concept: 'game:zenless_zone_zero', tags: ['ゼンレスゾーンゼロ', '绝区零', 'ZenlessZoneZero'], qualifiers: ['ゼンゼロ', 'ゼンレスゾーンゼロ', '绝区零', 'zenless zone zero'], marker: 'zenless_zone_zero' },
  { key: 'fire-emblem', concept: 'game:fire_emblem', tags: ['ファイアーエムブレム', 'FireEmblem'], qualifiers: ['ファイアーエムブレム', 'fire emblem'], marker: 'fire_emblem' },
  { key: 'wuthering-waves', concept: 'game:wuthering_waves', tags: ['WutheringWaves', '鳴潮', '鸣潮'], qualifiers: ['wuthering waves', '鳴潮', '鸣潮'], marker: 'wuthering_waves' },
  { key: 'fate', concept: 'game:fate', tags: ['Fate/GrandOrder', 'TYPE-MOON'], qualifiers: ['Fate', 'Fate/GrandOrder'], marker: 'fate' },
];

// All three identity consumers share the same family spellings and qualifiers.
export function knownCharacterGameFamilies() {
  return characterGameFamilies.map(({ key, tags, qualifiers }) => ({ key, tags: [...tags], qualifiers: [...qualifiers] }));
}
const roleOrder = { game: 0, rating: 1, character: 2, scene: 3 };
const normalizeTag = value => value.normalize('NFKC').toLowerCase().replace(/[ _]/g, '');
const ratingTag = rating => rating === 'r18' ? 'R-18' : rating === 'r18g' ? 'R-18G' : null;
const sceneConcept = name => /^(?:[1-9]|6\+|multiple_)(?:girls?)$/.test(name) ? 'girl' : /^(?:[1-9]|6\+|multiple_)(?:boys?)$/.test(name) ? 'boy' : name === 'short_shorts' ? 'shorts' : name;

function accountPreferences(result = {}) {
  const tagRanks = tags => new Map((Array.isArray(tags) ? tags : []).filter(tag => typeof tag === 'string' && tag.trim())
    .map((tag, i) => [normalizeTag(tag), i]).reverse());
  const pool = tagRanks(result.preferredTags), favorites = tagRanks(result.frequentTags), excluded = tagRanks(result.excludedTags);
  const history = new Map(), companions = new Map();
  for (const work of result.recentWorks || []) {
    const seen = new Set();
    for (const [position, item] of (work.tags || []).entries()) {
      const tag = typeof item === 'string' ? item : item?.tag;
      if (typeof tag !== 'string' || !tag.trim() || seen.has(normalizeTag(tag))) continue;
      const key = normalizeTag(tag), old = history.get(key) || { count: 0, position: 0 };
      seen.add(key);
      history.set(key, { count: old.count + 1, position: old.position + position });
    }
    for (const tag of seen) {
      if (!companions.has(tag)) companions.set(tag, new Map());
      const counts = companions.get(tag);
      for (const other of seen) if (tag !== other) counts.set(other, (counts.get(other) || 0) + 1);
    }
  }
  return { pool, favorites, history, companions, excluded, established: Boolean(pool.size || favorites.size || history.size || excluded.size) };
}

function preferenceFor(word, preferences) {
  const key = normalizeTag(word), used = preferences.history.get(key);
  if (preferences.excluded.has(key)) return { preferred: false, poolRank: 10000, frequencyRank: 10000, historyCount: 0, historyPosition: null };
  return { preferred: preferences.pool.has(key) || preferences.favorites.has(key) || Boolean(used),
    poolRank: preferences.pool.get(key) ?? 10000, frequencyRank: preferences.favorites.get(key) ?? 10000,
    historyCount: used?.count || 0, historyPosition: used ? used.position / used.count : null };
}

function comparePreference(a, b) {
  return (a.poolRank ?? 10000) - (b.poolRank ?? 10000) || Number(b.preferred) - Number(a.preferred) ||
    (b.historyCount || 0) - (a.historyCount || 0) || (a.historyPosition ?? 10000) - (b.historyPosition ?? 10000) ||
    (a.frequencyRank ?? 10000) - (b.frequencyRank ?? 10000);
}

function characterGame(name) {
  const family = characterGameFamilies.find(game => name.includes(game.marker) || game.names?.includes(name));
  return family ? { concept: family.concept, words: family.tags } : null;
}

// Detached search aliases for an explicit manual identity declaration. These
// are vocabulary, never proof of image identity or proof that a tag exists.
export function knownCharacterTagIdentities() {
  return [...Object.keys(aliases).filter(name => characterGame(name)).map(name => ({ name, englishName: englishName(name),
    gameTags: [...characterGame(name).words], characterTags: [...aliases[name], englishName(name)] })),
  ...historicalCharacterVocabulary.map(identity => ({ ...identity, gameTags: [...characterGame(identity.name).words],
    characterTags: [...identity.characterTags, identity.englishName] }))];
}

export function tagQueries(predictions, candidates = [], recognition = {}, options = {}) {
  const queries = new Map();
  const preferences = accountPreferences(options);
  const rows = [...predictions].sort((a, b) => b.score - a.score);
  const add = (word, p, tagRole, concept, mapped = false) => {
    if (typeof word !== 'string' || !word || word.length > 64) return;
    const key = normalizeTag(word), old = queries.get(key);
    const query = { word, score: p.score, modelName: p.name, modelNames: [p.name].filter(Boolean), fileIds: [p.fileId].filter(Boolean), tagRole, concept, mapped };
    if (old) {
      const merged = roleOrder[old.tagRole] < roleOrder[tagRole] || (old.tagRole === tagRole && old.score >= p.score) ? old : query;
      queries.set(key, { ...merged, mapped: old.mapped || mapped, score: Math.max(old.score, p.score), fileIds: [...new Set([...old.fileIds, ...query.fileIds])], modelNames: [...new Set([...old.modelNames, ...query.modelNames])] });
    } else queries.set(key, query);
  };
  for (const p of rows) {
    if (p.category === 4) {
      if (p.score < .85) continue;
      const remembered = (recognition.characters || []).find(c => c.name === p.name && c.source === 'user-confirmed-image');
      if (remembered) {
        for (const word of remembered.gameTags || []) add(word, p, 'game', `game:${p.name}`);
        for (const word of [...(remembered.characterTags || []), remembered.englishName]) add(word, p, 'character', `character:${p.name}`);
        continue;
      }
      const game = characterGame(p.name);
      for (const word of game?.words || []) add(word, p, 'game', game.concept);
      for (const word of [...(aliases[p.name] || []), englishName(p.name)]) add(word, p, 'character', `character:${p.name}`);
    } else if (p.category === 0) {
      for (const word of aliases[p.name] || []) add(word, p, 'scene', `scene:${sceneConcept(p.name)}`, true);
      if (!/^(?:\d|multiple_|solo$)/.test(p.name)) add(p.name.replaceAll('_', ' '), p, 'scene', `scene:${sceneConcept(p.name)}`);
    }
  }
  for (const c of candidates) {
    // The local catalog can supply an additional exact translation, but its
    // confidence and semantic role must still come from the current image.
    for (const p of rows.filter(row => (c.modelNames || []).includes(row.name))) {
      if (p.category === 4 && p.score >= .85) add(c.tag, p, 'character', `character:${p.name}`);
      else if (p.category === 0) add(c.tag, p, 'scene', `scene:${sceneConcept(p.name)}`, true);
    }
  }
  const adultTag = ratingTag(recognition.rating);
  if (adultTag) add(adultTag, { score: 1, name: recognition.rating }, 'rating', `rating:${recognition.rating}`);

  // The browser searches the first 32 words remotely and compares this larger
  // list with account history. Keep core and translated scene queries first so
  // the network budget is useful without dropping lower-ranked favorite tags.
  // Round-robin core aliases give each identity a chance before synonyms.
  const ordered = [...queries.values()].sort((a, b) => roleOrder[a.tagRole] - roleOrder[b.tagRole] || b.score - a.score);
  const coreGroups = new Map();
  for (const q of ordered.filter(q => q.tagRole !== 'scene')) {
    if (!coreGroups.has(q.concept)) coreGroups.set(q.concept, []);
    coreGroups.get(q.concept).push(q);
  }
  for (const group of coreGroups.values()) group.sort((a, b) => comparePreference(preferenceFor(a.word, preferences), preferenceFor(b.word, preferences)));
  const core = [];
  for (let i = 0; [...coreGroups.values()].some(group => group[i]); i++) for (const group of coreGroups.values()) if (group[i]) core.push(group[i]);
  const scenes = ordered.filter(q => q.tagRole === 'scene').sort((a, b) => {
    const aPreference = preferenceFor(a.word, preferences), bPreference = preferenceFor(b.word, preferences);
    const aReliable = aPreference.preferred && a.score >= .7, bReliable = bPreference.preferred && b.score >= .7;
    return Number(bReliable) - Number(aReliable) || (aReliable && bReliable ? comparePreference(aPreference, bPreference) : 0) ||
      Number(b.mapped && b.score >= .7) - Number(a.mapped && a.score >= .7) || b.score - a.score;
  });
  return [...core, ...scenes].slice(0, 256);
}

function compareCandidates(a, b) {
  return roleOrder[a.tagRole] - roleOrder[b.tagRole] || comparePreference(a, b) || b.modelScore - a.modelScore;
}

export function annotateTagCandidates(candidates, predictions = [], recognition = {}) {
  return (candidates || []).map(candidate => {
    const prediction = predictions.filter(p => (candidate.modelNames || []).includes(p.name)).sort((a, b) => b.score - a.score)[0];
    const character = (recognition.characters || []).find(c => (candidate.modelNames || []).includes(c.name));
    if (!candidate.tagRole && !character && ![0, 4].includes(prediction?.category)) return { ...candidate };
    const tagRole = candidate.tagRole || (prediction?.category === 4 || character ? 'character' : 'scene');
    const name = prediction?.name || character?.name || candidate.modelNames?.[0];
    return { ...candidate, tagRole, concept: candidate.concept || `${tagRole}:${tagRole === 'scene' ? sceneConcept(name) : name}` };
  });
}

export function rankPixivTags(queries, result) {
  const preferences = accountPreferences(result);
  const candidates = new Map();
  for (const q of queries) for (const item of (result.matches || []).filter(m => m.word === q.word)) {
    // Prefix suggestions can name unrelated characters; require an exact alias.
    if (typeof item.tag !== 'string' || normalizeTag(item.tag) !== normalizeTag(q.word)) continue;
    const key = normalizeTag(item.tag), old = candidates.get(key), preference = preferenceFor(item.tag, preferences);
    const cached = item.source === 'pixiv-cache' || result.cached === true || result.source === 'pixiv-cache';
    const verified = cached ? item.verified === true : item.verified !== false;
    const candidate = { tag: item.tag, confidence: q.score, modelScore: q.score, existing: true, verified,
      tagRole: q.tagRole || 'scene', concept: q.concept || `scene:${q.modelName || key}`,
      ...preference, accountPreferenceContext: preferences.established,
      historyCompanions: Object.fromEntries(preferences.companions.get(key) || []),
      fileIds: q.fileIds || [], modelNames: q.modelNames || [q.modelName].filter(Boolean),
      source: cached ? 'pixiv-cache' : 'pixiv', cached, freshVerified: verified && !cached,
      sourceUrl: `https://www.pixiv.net/tags/${encodeURIComponent(item.tag)}/artworks`,
      evidence: [{ kind: cached ? 'pixiv_tag_cache' : 'pixiv_tag_search', tag: item.tag, url: item.url, checkedAt: item.checkedAt || result.checkedAt }],
      reason: `${cached ? 'Pixiv 已核对标签缓存' : 'Pixiv 全站标签匹配'}${preference.poolRank < 10000 ? ' · 此账号常用标签池' : preference.preferred ? ' · 此账号经常使用' : ''}${preference.historyCount ? ' · 已发布作品使用过' : ''}；识图概念：${q.modelName || q.word}` };
    if (!old) candidates.set(key, candidate);
    else candidates.set(key, { ...(compareCandidates(candidate, old) < 0 ? candidate : old),
      confidence: Math.max(old.confidence, candidate.confidence), modelScore: Math.max(old.modelScore, candidate.modelScore),
      fileIds: [...new Set([...old.fileIds, ...candidate.fileIds])], modelNames: [...new Set([...old.modelNames, ...candidate.modelNames])] });
  }
  return [...candidates.values()].sort(compareCandidates).slice(0, 40);
}

export function selectAutomaticTags(candidates, recognition = {}) {
  const identities = new Set((recognition.characters || []).filter(c => c.confidence >= .85).map(c => c.name));
  const selected = [], concepts = new Map(), tags = new Set();
  const accountPreferenceContext = (candidates || []).some(candidate => candidate.accountPreferenceContext);
  const eligible = [];
  for (const original of candidates || []) {
    if (!original.existing || !original.verified || !Array.isArray(original.evidence) || !original.evidence.length || typeof original.tag !== 'string') continue;
    const names = original.modelNames || [];
    const character = names.find(name => identities.has(name));
    const tagRole = original.tagRole || (character ? 'character' : 'scene');
    const score = original.modelScore ?? original.confidence ?? 0;
    // A catalog fallback without live semantic metadata is accepted only for
    // known scene mappings or an identity confirmed by this recognition run.
    if (!original.tagRole && !character && !names.some(name => Object.hasOwn(aliases, name) && !characterGame(name))) continue;
    if (tagRole === 'rating') {
      if (original.tag !== ratingTag(recognition.rating)) continue;
    } else if (tagRole === 'character' || tagRole === 'game') {
      if (score < .85 || !character) continue;
    } else if (tagRole !== 'scene' || score < .7 || (accountPreferenceContext && !original.preferred)) continue;
    eligible.push({ ...original, tagRole, modelScore: score, concept: original.concept || `${tagRole}:${character || sceneConcept(names[0])}` });
  }
  for (const candidate of eligible.sort(compareCandidates)) {
    const key = normalizeTag(candidate.tag);
    const prior = concepts.get(candidate.concept) || [];
    if (tags.has(key)) continue;
    if (prior.length && !(['game', 'character'].includes(candidate.tagRole) && prior.length === 1 &&
        (candidate.historyCompanions?.[normalizeTag(prior[0].tag)] || 0) >= 2)) continue;
    concepts.set(candidate.concept, [...prior, candidate]); tags.add(key); selected.push(candidate);
    if (selected.length === 10) break;
  }
  return selected.sort((a, b) => roleOrder[a.tagRole] - roleOrder[b.tagRole] ||
    (['game', 'character'].includes(a.tagRole) && a.historyPosition !== null && b.historyPosition !== null &&
      a.historyPosition !== undefined && b.historyPosition !== undefined ? a.historyPosition - b.historyPosition : 0) || compareCandidates(a, b))
    .map(candidate => candidate.tag);
}
