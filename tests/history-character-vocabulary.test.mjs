import test from 'node:test';
import assert from 'node:assert/strict';
import { knownCharacterGameFamilies, knownCharacterTagIdentities, summarizeRecognition, tagQueries } from '../server/recognition.mjs';
import { planManualCharacterTags, resolveManualCharacterTags } from '../server/manual-character-tags.mjs';
import { buildPostingTemplates, buildCharacterCatalog, composePostingTemplate, matchPostingTemplates } from '../server/posting-templates.mjs';

const checkedAt = '2030-01-01T00:00:00.000Z';
const scope = { mode: 'live', accountId: 'test-beta', pixivUserId: '12345' };
const cases = [
  ['Velina', 'ヴェリナ・エガード', ['ZenlessZoneZero', '绝区零', 'ゼンレスゾーンゼロ']],
  ['RemielleDan', 'レミエール・ダン', ['ZenlessZoneZero', '绝区零', 'ゼンレスゾーンゼロ']],
  ['ClaretFlint', 'クラレッタ・フリンツ', ['ZenlessZoneZero', '绝区零', 'ゼンレスゾーンゼロ']],
  ['Yixuan', '儀玄', ['ZenlessZoneZero', '绝区零']],
  ['YeShunguang', '葉瞬光', ['ZenlessZoneZero', '绝区零']],
  ['NicoleDemara', 'NicoleDemara', ['ZenlessZoneZero', '绝区零']],
  ['Sunna', '千夏(ゼンゼロ)', ['ZenlessZoneZero', '绝区零', 'ゼンレスゾーンゼロ']],
  ['Aemeath', 'エイメス', ['WutheringWaves', '鳴潮']],
  ['Hyacine', 'ヒアンシー', ['HonkaiStarRail', '崩壊スターレイル']],
  ['Lauma', 'ラウマ', ['GenshinImpact', '原神']],
  ['Skirk', 'スカーク', ['GenshinImpact', '原神']],
  ['Acheron', '黄泉(スターレイル)', ['HonkaiStarRail', '崩壊スターレイル']],
  ['BlackSwan', 'ブラックスワン(スターレイル)', ['HonkaiStarRail', '崩壊スターレイル']],
  ['Topaz', 'トパーズ(スターレイル)', ['HonkaiStarRail', '崩壊スターレイル']],
  ['Herta', 'ヘルタ', ['HonkaiStarRail', '崩壊スターレイル']],
  ['Chiori', '千織(原神)', ['GenshinImpact', '原神']],
  ['Lynette', 'リネット(原神)', ['GenshinImpact', '原神']],
  ['Sandrone', 'サンドローネ(原神)', ['GenshinImpact', '原神']],
  ['Bronya Rand', 'ブローニャ・ランド', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['Tingyun', '停雲', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['Jingliu', '镜流', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['Qingque', '青雀', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['Huohuo', 'フォフォ', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['Jinhsi', '今汐', ['WutheringWaves', '鳴潮', '鸣潮']],
  ['Changli', '長離', ['WutheringWaves', '鳴潮', '鸣潮']],
  ['Belle', 'リン(ゼンゼロ)', ['ZenlessZoneZero', '绝区零']],
  ['Arlecchino', 'アルレッキーノ(原神)', ['GenshinImpact', '原神']],
  ['Columbina', 'コロンビーナ(原神)', ['GenshinImpact', '原神']],
  ['Odette', 'オデット(原神)', ['GenshinImpact', '原神']],
  ['Zhuyuan', 'ZhuYuan', ['ZenlessZoneZero', '绝区零']],
  ['Anby', 'アンビー・デマラ', ['ZenlessZoneZero', '绝区零']],
  ['Rover', '漂泊者', ['WutheringWaves', '鳴潮']],
  ['Zani', 'ザンニー', ['WutheringWaves', '鳴潮']],
  ['Ishtar', 'イシュタル(Fate)', ['Fate/GrandOrder', 'TYPE-MOON']],
  ['Feixiao', '飛霄', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['FuXuan', 'FuXuan', ['崩坏星穹铁道', '崩壊:スターレイル']],
  ['Female Rover', '女漂泊者', ['鳴潮', 'WutheringWaves', '鸣潮']],
];
const work = (id, title, tags) => ({ artworkId: String(id), title, tags, status: 'published', verified: true });
const build = recentWorks => buildPostingTemplates({ scope, evidence: { checkedAt, recentWorks } });

test('verified account spellings including bare Japanese names build precise historical identities', () => {
  const works = cases.map(([name, tag, games], index) => work(index + 1, name, [...games, tag, '女の子']));
  const catalog = build(works);
  assert.deepEqual(catalog.unresolvedWorks, []);
  assert.equal(catalog.templates.length, cases.length);
  for (const [index, [name, tag, games]] of cases.entries()) {
    const matches = matchPostingTemplates(catalog, name);
    assert.equal(matches.length, 1, name);
    assert.deepEqual(matches[0].gameTags, games, name);
    assert.deepEqual(matches[0].characterTags, [tag], name);
    assert.deepEqual(matches[0].orderedTags, works[index].tags, name);
    assert.deepEqual(composePostingTemplate(matches[0], { rating: 'all' }).tags, works[index].tags, name);
    assert.equal(matchPostingTemplates(catalog, tag).length, 1, tag);
  }
});

test('vocabulary alone supplies neither Pixiv evidence nor image identity', () => {
  for (const [name, tag, games] of cases) {
    const plan = planManualCharacterTags({ name });
    assert.equal(plan.status, 'resolved', name);
    assert.equal(resolveManualCharacterTags(plan).status, 'not-found', name);
    assert.deepEqual(resolveManualCharacterTags(plan).tags, [], name);
    const catalog = buildCharacterCatalog({ scope, evidence: { frequentTags: [...games, tag] } });
    assert.equal(catalog.templates.length, 0, `unchecked common tags: ${name}`);
  }
  assert.equal(summarizeRecognition([{ id: 'image' }], [], []).title, '');
  assert.deepEqual(tagQueries([], [], {}), []);
});

test('all three Wuthering Waves game spellings share one family and retain exact account ordering', () => {
  const games = ['WutheringWaves', '鳴潮', '鸣潮'];
  const families = knownCharacterGameFamilies();
  assert.deepEqual(families.find(family => family.key === 'wuthering-waves').tags, games);
  const identity = knownCharacterTagIdentities().find(item => item.englishName === 'Aemeath');
  assert.deepEqual(identity.gameTags, games);
  const catalog = build(games.map((tag, index) => work(index + 1, 'Aemeath', [tag, 'エイメス', '女の子'])));
  assert.equal(catalog.templates.length, 1);
  assert.equal(catalog.templates[0].variants.length, 3);
  for (const [index, tag] of games.entries()) {
    const variant = catalog.templates[0].variants.find(item => item.sourceArtworkIds.includes(String(index + 1)));
    assert.deepEqual(variant.gameTags, [tag]);
    assert.deepEqual(variant.orderedTags, [tag, 'エイメス', '女の子']);
    const manual = planManualCharacterTags({ name: 'Aemeath', characters: [{ id: 'memory', englishName: 'Aemeath', gameTags: [tag], characterTags: [] }] });
    assert.equal(manual.status, 'resolved');
    assert.ok(manual.identity.characterTags.includes('エイメス'));
  }
  const allTags = build([work(9, 'Aemeath', ['鳴潮', 'WutheringWaves', '鸣潮', 'エイメス'])]);
  assert.deepEqual(allTags.templates[0].gameTags, ['鳴潮', 'WutheringWaves', '鸣潮']);
});

test('scoped Wuthering Waves histories learn new explicit names without relying on known vocabulary', () => {
  for (const [index, qualifier] of ['鳴潮', '鸣潮', 'Wuthering Waves'].entries()) {
    const tag = `NewCharacter(${qualifier})`;
    const plan = planManualCharacterTags({ name: 'NewCharacter', evidence: { recentWorks: [work(index + 1, 'NewCharacter', ['WutheringWaves', tag])] } });
    assert.equal(plan.status, 'resolved');
    assert.ok(plan.identity.characterTags.includes(tag));
    assert.deepEqual(build([work(index + 1, 'NewCharacter', ['WutheringWaves', tag])]).templates[0].characterTags, [tag]);
  }
});

test('same English name in different games remains ambiguous and Velina never becomes Wuthering Waves Verina', () => {
  const catalog = build([
    work(1, 'Velina', ['ZenlessZoneZero', 'ヴェリナ・エガード']),
    work(2, 'Velina', ['WutheringWaves', 'Velina(鳴潮)']),
    work(3, 'Verina', ['WutheringWaves', 'ヴェリナ・エガード']),
  ]);
  const matches = matchPostingTemplates(catalog, 'Velina');
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].id, matches[1].id);
  assert.deepEqual(catalog.unresolvedWorks.map(item => item.artworkId), ['3']);
  assert.equal(matchPostingTemplates(catalog, 'Verina').length, 0);
});

test('new common-tag identities borrow format only from their own account and same game', () => {
  const catalog = buildCharacterCatalog({ scope,
    evidence: { checkedAt, frequentTags: ['WutheringWaves', '鳴潮', 'エイメス'],
      recentWorks: [work(1, 'Known', ['R-18', '鸣潮', 'WutheringWaves', 'Known(鳴潮)'])] } });
  const supplemental = matchPostingTemplates(catalog, 'Aemeath')[0];
  assert.equal(supplemental.source, 'account-style');
  assert.equal(supplemental.formatSource, 'account-history');
  assert.deepEqual(composePostingTemplate(supplemental, { rating: 'all' }).tags, ['鸣潮', 'WutheringWaves', 'エイメス']);
});

test('alternate full-name character tags and Furina scoped alias preserve historical spelling', () => {
  const claret = build([work(1, 'ClaretFlint', ['ZenlessZoneZero', 'クラレッタ', 'クラレッタ・フリンツ'])]).templates[0];
  assert.deepEqual(claret.characterTags, ['クラレッタ', 'クラレッタ・フリンツ']);
  assert.equal(matchPostingTemplates({ templates: [claret] }, 'Claret Flint').length, 1);
  const furina = build([work(2, 'Furina', ['GenshinImpact', '原神', 'フリーナ(原神)'])]);
  assert.deepEqual(furina.templates[0].characterTags, ['フリーナ(原神)']);
});

test('pairing tags and bare fireworks labels do not become individual characters', () => {
  for (const title of ['星ホタ', '穹ホタ', '花火']) {
    assert.equal(planManualCharacterTags({ name: title }).status, 'not-found');
  }
  const catalog = buildCharacterCatalog({ scope,
    evidence: { checkedAt, frequentTags: ['HonkaiStarRail', '崩壊スターレイル', '星ホタ', '穹ホタ', '花火'] } });
  assert.equal(catalog.templates.length, 0);
});

test('Herta and TheHerta retain distinct history identities and exact character tags', () => {
  const catalog = build([
    work(1, 'Herta', ['HonkaiStarRail', '崩壊スターレイル', 'ヘルタ']),
    work(2, 'TheHerta', ['HonkaiStarRail', '崩壊スターレイル', 'マダム・ヘルタ']),
  ]);
  assert.equal(catalog.templates.length, 2);
  assert.deepEqual(catalog.unresolvedWorks, []);
  assert.deepEqual(matchPostingTemplates(catalog, 'Herta')[0].characterTags, ['ヘルタ']);
  assert.deepEqual(matchPostingTemplates(catalog, 'The Herta')[0].characterTags, ['マダム・ヘルタ']);
  assert.equal(knownCharacterTagIdentities().find(item => item.englishName === 'Herta').characterTags.includes('マダム・ヘルタ'), false);
});

test('untitled, abbreviated and misspelled titles recover one canonical identity from explicit tags', () => {
  const titles = ['', '无题', '無題', 'Untitled', 'Mnoa', 'Mona'];
  const works = titles.map((title, index) => work(index + 1, title, ['GenshinImpact', '原神', 'モナ(原神)']));
  const catalog = build(works);
  assert.equal(catalog.templates.length, 1);
  assert.equal(catalog.templates[0].englishName, 'Mona');
  assert.equal(catalog.templates[0].sampleCount, titles.length);
  assert.deepEqual(catalog.unresolvedWorks, []);
  assert.equal(matchPostingTemplates(catalog, 'Mnoa').length, 1);
  for (const title of titles.slice(0, 4)) assert.equal(matchPostingTemplates(catalog, title).length, 0);
  assert.equal(catalog.templates[0].id, build([works[4]]).templates[0].id);
  const actualAliases = build([
    work(20, 'Nicole', ['ZenlessZoneZero', 'NicoleDemara']),
    work(21, 'Raiden', ['原神', '雷電将軍']),
    work(22, 'Evernigh', ['HonkaiStarRail', '長夜月']),
  ]);
  assert.deepEqual(actualAliases.templates.map(item => item.englishName), ['Nicole Demara', 'Raiden Shogun', 'Evernight']);
});

test('a scoped historical name resolves other untitled works without naming an identity Untitled', () => {
  const catalog = build([
    work(1, '无题', ['ZenlessZoneZero', 'NewCharacter(ゼンゼロ)']),
    work(2, 'NewCharacter', ['ZenlessZoneZero', 'NewCharacter(ゼンゼロ)']),
  ]);
  assert.equal(catalog.templates.length, 1);
  assert.equal(catalog.templates[0].englishName, 'NewCharacter');
  assert.equal(catalog.templates[0].sampleCount, 2);
  assert.deepEqual(catalog.unresolvedWorks, []);
  const unknown = build([work(3, '无题', ['原神', 'UnknownPerson(原神)'])]);
  assert.equal(unknown.templates.length, 0);
  assert.equal(unknown.unresolvedWorks.length, 1);
});

test('same character spelling variants merge while exact per-work tags and order survive', () => {
  const works = [
    work(1, 'Ellen', ['ZenlessZoneZero', 'EllenJoe']),
    work(2, 'Ellen Joe', ['绝区零', 'Ellen Joe']),
    work(3, 'EllenJoe', ['绝区零', 'EllenJoe', 'Ellen Joe']),
  ];
  const catalog = build(works);
  assert.equal(catalog.templates.length, 1);
  assert.equal(catalog.templates[0].variants.length, 3);
  assert.deepEqual(catalog.templates[0].sourceArtworkIds, ['1', '2', '3']);
  for (const row of works) {
    const variant = catalog.templates[0].variants.find(item => item.sourceArtworkIds.includes(row.artworkId));
    assert.deepEqual(composePostingTemplate({ ...catalog.templates[0], variants: [variant] }, { rating: 'all' }).tags, row.tags);
  }
});

test('all known characters including bare tags and foreign-game tags exclude single-character templates', () => {
  const works = [
    work(1, 'Ganyu', ['原神', '甘雨', '刻晴']),
    work(2, '无题', ['HonkaiStarRail', '長夜月', 'ヘルタ']),
    work(3, 'Mona', ['原神', 'モナ(原神)', '花火(スターレイル)']),
    work(4, 'Robin', ['HonkaiStarRail', 'ロビン(スターレイル)', '星(スターレイル)']),
    work(5, 'Robin & Firefly', ['HonkaiStarRail', 'ロビン(スターレイル)']),
    work(6, 'Mona', ['原神', 'HonkaiStarRail', 'モナ(原神)']),
  ];
  const catalog = build(works);
  assert.equal(catalog.templates.length, 0);
  assert.equal(catalog.unresolvedWorks.length, works.length);
  const choices = buildCharacterCatalog({ scope, evidence: { checkedAt, recentWorks: works.slice(0, 1) } });
  for (const name of ['Ganyu', 'Keqing']) {
    const selected = matchPostingTemplates(choices, name)[0];
    assert.equal(selected.source, 'account-style');
    assert.equal(selected.sampleCount, 0);
    assert.equal(selected.characterTags.length, 1);
  }
});

test('explicit title contradictions cannot be bypassed by tag recovery or merged shared memory', () => {
  const works = [
    work(1, 'Mona', ['原神', 'リサ(原神)']),
    work(2, 'NewCharacter(原神)', ['原神', 'モナ(原神)']),
  ];
  const catalog = build(works);
  assert.equal(catalog.templates.length, 0);
  assert.equal(catalog.unresolvedWorks.length, 2);
  const memory = { id: 'bad', englishName: 'Group', gameTags: ['原神'], characterTags: ['甘雨', '刻晴'] };
  const result = buildCharacterCatalog({ scope, characters: [memory],
    evidence: { checkedAt, recentWorks: [work(3, 'Group', ['原神', '甘雨', '刻晴'])] } });
  assert.equal(result.historyTemplateCount, 0);
  assert.equal(matchPostingTemplates(result, 'Group').length, 0);
});

test('same unknown title with disjoint scoped character tags keeps independent identities', () => {
  const catalog = build([
    work(1, 'NewName', ['原神', 'CharacterA(原神)']),
    work(2, 'NewName', ['原神', 'CharacterB(原神)']),
  ]);
  assert.equal(catalog.templates.length, 2);
  assert.equal(matchPostingTemplates(catalog, 'NewName').length, 2);
  assert.notEqual(catalog.templates[0].id, catalog.templates[1].id);
});

test('matching an unknown bare title and tag cannot establish character identity', () => {
  for (const title of ['Swimsuit', 'NovelAI', 'UnknownName']) {
    const row = work(1, title, ['原神', title, '女の子']);
    const catalog = build([row]);
    assert.equal(catalog.templates.length, 0, title);
    assert.equal(catalog.unresolvedWorks.length, 1, title);
  }
  const row = work(2, 'ConfirmedName', ['原神', 'ConfirmedName', '女の子']);
  const character = { id: 'user-confirmed', englishName: 'ConfirmedName', gameTags: ['原神'], characterTags: ['ConfirmedName'] };
  const remembered = buildPostingTemplates({ scope, evidence: { checkedAt, recentWorks: [row] }, characters: [character] });
  assert.equal(remembered.templates.length, 1);
  assert.equal(remembered.templates[0].englishName, 'ConfirmedName');
  // Manual declaration retains its existing explicit user workflow.
  assert.equal(planManualCharacterTags({ name: 'ConfirmedName', characters: [character] }).status, 'resolved');
});

test('expanded history translations preserve both Zani labels without inferring Rover gender', () => {
  const zani = build([work(1, 'Zani', ['WutheringWaves', '鳴潮', 'ザンニー', '赞妮'])]);
  assert.equal(zani.templates.length, 1);
  assert.deepEqual(zani.templates[0].characterTags, ['ザンニー', '赞妮']);
  const rover = build([work(2, 'Rover', ['WutheringWaves', '鳴潮', '漂泊者'])]);
  assert.deepEqual(composePostingTemplate(rover.templates[0], { rating: 'all' }).tags, ['WutheringWaves', '鳴潮', '漂泊者']);
  const herta = build([work(3, 'Herta', ['HonkaiStarRail', 'ヘルタ(スターレイル)'])]);
  assert.deepEqual(herta.templates[0].characterTags, ['ヘルタ(スターレイル)']);
  const jingliu = build([work(4, 'Jingliu', ['HonkaiStarRail', '鏡流'])]);
  assert.deepEqual(jingliu.templates[0].characterTags, ['鏡流']);
});

test('audited multi-character titles supply selection vocabulary without creating single-character histories', () => {
  const recentWorks = [
    work('301', 'Caelus & Firefly', ['HonkaiStarRail', 'ホタル(スターレイル)', '穹(スターレイル)']),
    work('302', 'Lumine & Paimon', ['原神', 'パイモン(原神)', '蛍(原神)']),
    work('303', 'Belle & Wise', ['ゼンレスゾーンゼロ', 'アキラ(ゼンゼロ)', 'リン(ゼンゼロ)']),
    work('304', 'Furina & Aether', ['原神', '空(原神)', 'フリーナ']),
  ];
  const catalog = buildCharacterCatalog({ scope, evidence: { checkedAt, recentWorks } });
  assert.equal(catalog.historyTemplateCount, 0);
  assert.equal(catalog.unresolvedWorks.length, 4);
  for (const [name, tag] of [['Caelus', '穹(スターレイル)'], ['Paimon', 'パイモン(原神)'], ['Wise', 'アキラ(ゼンゼロ)'], ['Aether', '空(原神)']]) {
    const template = matchPostingTemplates(catalog, name)[0];
    assert.equal(template.source, 'account-style');
    assert.equal(template.sampleCount, 0);
    assert.deepEqual(template.sourceArtworkIds, []);
    assert.deepEqual(template.characterTags, [tag]);
  }
});

test('Fate history preserves its franchise labels and explicit female Rover stays distinct from neutral Rover', () => {
  const fate = build([work('305', 'Ishtar', ['Fate/GrandOrder', 'TYPE-MOON', 'イシュタル(Fate)'])]);
  assert.deepEqual(composePostingTemplate(fate.templates[0], { rating: 'all' }).tags, ['Fate/GrandOrder', 'TYPE-MOON', 'イシュタル(Fate)']);
  assert.deepEqual(knownCharacterGameFamilies().find(game => game.key === 'fate').tags, ['Fate/GrandOrder', 'TYPE-MOON']);
  const rover = build([
    work(2, 'Rover', ['WutheringWaves', '鳴潮', '漂泊者']),
    work(3, 'Female Rover', ['鳴潮', 'WutheringWaves', '女漂泊者', '鸣潮']),
  ]);
  assert.equal(rover.templates.length, 2);
  assert.equal(matchPostingTemplates(rover, 'Rover').length, 1);
  assert.deepEqual(matchPostingTemplates(rover, 'Rover')[0].characterTags, ['漂泊者']);
  assert.deepEqual(matchPostingTemplates(rover, 'Female Rover')[0].characterTags, ['女漂泊者']);
  const missing = build([work('306', 'Robin', ['崩坏星穹铁道', '崩壊:スターレイル', '女の子'])]);
  assert.equal(missing.templates.length, 0);
  assert.equal(missing.unresolvedWorks.length, 1);
});
