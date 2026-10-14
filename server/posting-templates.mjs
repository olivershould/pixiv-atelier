import { createHash } from 'node:crypto';
import { planManualCharacterTags, knownManualCharacterTagIdentities } from './manual-character-tags.mjs';
import { tagQueries, knownCharacterTagIdentities, knownCharacterGameFamilies } from './recognition.mjs';

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_]/g, '');
const ratingTag = value => value === 'r18' ? 'R-18' : value === 'r18g' ? 'R-18G' : null;
const isRating = value => /^r-?18g?$/i.test(normalize(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const contains = (list, tag) => list.some(item => normalize(item) === normalize(tag));
const gameDefinitions = knownCharacterGameFamilies();
function clean(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value.trim() || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value) || result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

// Repetition is not proof that a costume, pose, body detail, or adult action is
// present in a new picture. Only these broad editorial labels can become a
// default, and only after at least three distinct works and 60% of the history.
const safeBaseLabels = new Set(['女の子', '男の子', '極上の女体', '魅惑のふともも', '妖姿媚態'].map(normalize));

function identityFromTitle(work, characters) {
  // History owns the exact account spelling. Shared memory only helps establish
  // a previously unknown identity; its foreign-account tags are never emitted.
  let plan = planManualCharacterTags({ name: work.title, evidence: { recentWorks: [work] } });
  if (plan.status === 'not-found') plan = planManualCharacterTags({ name: work.title, characters, evidence: { recentWorks: [work] } });
  if (plan.status === 'ambiguous') {
    // A single historical work can disambiguate names shared by different
    // games. Never use this to bypass two conflicting identities in one game.
    const candidates = plan.candidates || [];
    const families = candidates.map(candidate => gameFamily(candidate.gameTags));
    const matching = candidates.filter(candidate => work.tags.some(tag => contains(candidate.gameTags, tag))
      && work.tags.some(tag => contains(candidate.characterTags, tag)));
    if (matching.length === 1 && new Set(families).size === candidates.length) {
      plan = { ...plan, status: 'resolved', identity: matching[0] };
    }
  }
  if (plan.status !== 'resolved' || !plan.identity) return null;
  const gameTags = work.tags.filter(tag => contains(plan.identity.gameTags || [], tag));
  const characterTags = work.tags.filter(tag => contains(plan.identity.characterTags || [], tag));
  if (!gameTags.length || !characterTags.length || gameTags.length > 4 || characterTags.length > 4) return null;
  const vocabulary = knownCharacterTagIdentities().filter(item => normalize(item.englishName) === normalize(plan.identity.englishName)
    && item.characterTags.some(tag => contains(characterTags, tag)));
  return { englishName: plan.identity.englishName, aliases: clean([work.title, plan.identity.englishName, plan.identity.name,
    ...(plan.identity.characterTags || []), ...vocabulary.flatMap(item => [item.name, ...item.characterTags])]),
    family: clean(plan.identity.gameTags).map(normalize).sort().join('|'),
    identityKey: clean(plan.identity.characterTags).map(normalize).sort().join('|'), gameTags, characterTags };
}

const placeholderTitle = value => !String(value || '').trim() || /^(?:无题|無題|untitled(?:\s*\d+)?|no[\s_-]*title)$/i.test(String(value).trim());
const combinedTitle = value => /\S\s*(?:&|＆|\+|＋)\s*\S/.test(String(value));
const titleAliases = value => placeholderTitle(value) || combinedTitle(value) ? [] : [value];
function scopedGame(tag) {
  const match = String(tag).normalize('NFKC').match(/^.+\(([^)]+)\)$/);
  return match ? gameDefinitions.find(game => contains(game.qualifiers, match[1])) : null;
}
function workGameFamily(work) {
  if (work.familyKey != null) return work.familyKey;
  const tags = work.tags.filter(tag => gameDefinitions.some(game => contains(game.tags, tag)));
  return (work.familyKey = gameFamily(tags));
}
function tagIdentities(work, identities) {
  const family = workGameFamily(work);
  const keys = work.tagKeys ||= work.tags.map(normalize);
  return identities.filter(identity => (identity.familyKey ??= gameFamily(identity.gameTags)) === family
    && keys.some(key => (identity.characterTagKeys ||= new Set(identity.characterTags.map(normalize))).has(key)));
}

// Build identity vocabulary once for this account's archive. Unknown names can
// be learned only from an explicit single-character historical title/tag pair.
// Untitled works and multi-character works cannot create new identity names.
function historyIdentityContext(works, characters) {
  const known = knownManualCharacterTagIdentities().map(identity => ({ ...identity,
    key: `known:${gameFamily(identity.gameTags)}:${normalize(identity.englishName)}`,
    aliases: clean([identity.name, identity.englishName, ...identity.characterTags]),
    gameTags: [...identity.gameTags], characterTags: [...identity.characterTags] }));
  const identities = [...known];
  for (const memory of characters || []) {
    if (placeholderTitle(memory.englishName) || !memory.gameTags?.length || !memory.characterTags?.length) continue;
    const matches = known.filter(identity => gameFamily(identity.gameTags) === gameFamily(memory.gameTags)
      && memory.characterTags.some(tag => contains(identity.characterTags, tag)));
    // A memory containing two known characters is not an identity bridge.
    if (matches.length > 1) continue;
    if (matches.length === 1) {
      const identity = matches[0];
      identity.characterTags = clean([...identity.characterTags, ...memory.characterTags]);
      identity.aliases = clean([...identity.aliases, memory.englishName, ...memory.characterTags]);
    } else identities.push({ ...memory, key: `memory:${memory.id || digest(memory)}`,
      aliases: clean([memory.englishName, ...memory.characterTags]),
      gameTags: [...memory.gameTags], characterTags: [...memory.characterTags] });
  }
  const declared = identities.map(identity => ({ ...identity, aliases: [...identity.aliases], characterTags: [...identity.characterTags] }));
  for (const work of works) {
    if (placeholderTitle(work.title) || combinedTitle(work.title)
      || !/^[A-Za-z][A-Za-z0-9 .'-]{0,63}$/.test(work.title.trim())) continue;
    const family = workGameFamily(work);
    if (!family || family.includes('|') || tagIdentities(work, identities).length) continue;
    const identity = identityFromTitle(work, []);
    if (!identity) continue;
    // Do not learn a supposedly new character from a known foreign-game tag.
    if (work.tags.some(tag => !contains([work.title], tag) && known.some(item => contains(item.characterTags, tag)))) continue;
    const scoped = work.tags.filter(scopedGame);
    // A repeated title is not proof that a bare tag denotes a character:
    // Swimsuit, scenery, tools, and events can also appear as both title/tag.
    if (scoped.length !== 1 || scoped.some(tag => !contains(identity.characterTags, tag))) continue;
    const previous = identities.find(item => gameFamily(item.gameTags) === family
      && item.characterTags.some(tag => contains(identity.characterTags, tag)));
    if (previous) previous.aliases = clean([...previous.aliases, ...identity.aliases]);
    else identities.push({ ...identity, key: `learned:${family}:${identity.characterTags.map(normalize).sort().join('|')}` });
  }
  const byTag = new Map();
  for (const identity of identities) for (const tag of identity.characterTags) {
    const key = normalize(tag), matches = byTag.get(key) || new Set();
    matches.add(identity); byTag.set(key, matches);
  }
  return { identities, declared, byTag };
}

function identifyWork(work, context) {
  const family = workGameFamily(work);
  if (!family || family.includes('|') || combinedTitle(work.title)) return null;
  const matches = [...new Set(work.tags.flatMap(tag => [...(context.byTag.get(normalize(tag)) || [])]))]
    .filter(identity => (identity.familyKey ??= gameFamily(identity.gameTags)) === family);
  if (matches.length !== 1) return null;
  const identity = matches[0];
  // Inspect every tag, including bare Japanese and foreign-game identities.
  // A second character must never become a conditional scene tag.
  if (work.tags.some(tag => !contains(identity.characterTags, tag)
    && (scopedGame(tag) || context.byTag.has(normalize(tag))))) return null;
  if (!placeholderTitle(work.title)) {
    if (scopedGame(work.title) && !contains(identity.characterTags, work.title)) return null;
    const declared = context.declared.filter(item => contains(item.aliases, work.title));
    const explicitOtherGameName = identity.key.startsWith('learned:')
      && !declared.some(item => gameFamily(item.gameTags) === family)
      && work.tags.some(tag => contains(identity.characterTags, tag)
        && normalize(tag.replace(/\([^)]*\)$/, '')) === normalize(work.title));
    if (declared.length && !declared.some(item => item.key === identity.key) && !explicitOtherGameName) return null;
  }
  const gameTags = work.tags.filter(tag => contains(identity.gameTags, tag));
  const characterTags = work.tags.filter(tag => contains(identity.characterTags, tag));
  if (!gameTags.length || !characterTags.length || gameTags.length > 4 || characterTags.length > 4) return null;
  return { englishName: identity.englishName,
    aliases: clean([...titleAliases(work.title), identity.englishName, ...(identity.aliases || []), ...identity.characterTags]),
    family, identityKey: identity.key, gameTags, characterTags };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length ? ordered[Math.floor((ordered.length - 1) / 2)] : null;
}

/** Build pure, account-scoped templates from verified published-work evidence. */
export function buildPostingTemplates({ scope = {}, evidence = {}, characters = [] } = {}) {
  const accountScope = { mode: scope.mode || 'live', accountId: scope.accountId || '', pixivUserId: String(scope.pixivUserId || '') };
  const works = [], seenIds = new Set();
  for (const work of evidence.recentWorks || []) {
    if (!work || typeof work.title !== 'string' || !Array.isArray(work.tags) || !work.artworkId || seenIds.has(String(work.artworkId))) continue;
    if (work.status && !['published', 'public'].includes(work.status)) continue;
    if (work.verified === false) continue;
    const tags = clean(work.tags);
    if (!tags.length) continue;
    seenIds.add(String(work.artworkId));
    works.push({ artworkId: String(work.artworkId), title: work.title, tags, source: work.source || 'pixiv-history' });
  }
  const counts = new Map();
  for (const work of works) for (const key of new Set(work.tags.map(normalize))) counts.set(key, (counts.get(key) || 0) + 1);
  const stable = tag => safeBaseLabels.has(normalize(tag)) && (counts.get(normalize(tag)) || 0) >= 3 && counts.get(normalize(tag)) / works.length >= .6;
  const defaultRatingPosition = median(works.map(work => work.tags.findIndex(isRating)).filter(position => position >= 0));
  const groups = new Map(), unresolvedWorks = [];
  const identityContext = historyIdentityContext(works, characters);
  for (const work of works) {
    const identity = identifyWork(work, identityContext);
    if (!identity) { unresolvedWorks.push({ artworkId: work.artworkId, title: work.title, reason: '角色与游戏的对应关系不够明确' }); continue; }
    const key = `${normalize(identity.englishName)}:${identity.family}:${identity.identityKey}`;
    const group = groups.get(key) || { identity, works: [], aliases: [], variants: new Map() };
    group.works.push(work);
    group.aliases = clean([...group.aliases, ...identity.aliases]);
    const signature = JSON.stringify(work.tags);
    let variant = group.variants.get(signature);
    if (!variant) {
      const otherTags = work.tags.filter(tag => !isRating(tag) && !contains([...identity.gameTags, ...identity.characterTags], tag));
      variant = { id: `variant:${digest([accountScope, key, work.tags])}`, orderedTags: [...work.tags], gameTags: [...identity.gameTags],
        characterTags: [...identity.characterTags], baseTags: otherTags.filter(stable), conditionalTags: otherTags.filter(tag => !stable(tag)),
        rating: work.tags.some(tag => /^r-?18g$/i.test(normalize(tag))) ? 'r18g' : work.tags.some(isRating) ? 'r18' : 'all',
        sourceArtworkIds: [], sampleCount: 0 };
      group.variants.set(signature, variant);
    }
    variant.sourceArtworkIds.push(work.artworkId); variant.sampleCount++;
    groups.set(key, group);
  }
  const templates = [...groups.entries()].map(([key, group]) => {
    // Map insertion order is source recency, which resolves equal-frequency ties.
    const variants = [...group.variants.values()].sort((a, b) => b.sampleCount - a.sampleCount);
    const primary = variants[0];
    const tagRoles = Object.fromEntries(variants.flatMap(variant => variant.orderedTags.map(tag => [tag, isRating(tag) ? 'rating'
      : contains(variant.gameTags, tag) ? 'game' : contains(variant.characterTags, tag) ? 'character' : 'scene'])));
    return { id: `history:${digest([accountScope, key])}`, ...accountScope, source: 'pixiv-history', englishName: group.identity.englishName,
      aliases: group.aliases, gameTags: [...primary.gameTags], characterTags: [...primary.characterTags], baseTags: [...primary.baseTags],
      conditionalTags: clean(variants.flatMap(variant => variant.conditionalTags)), orderedTags: [...primary.orderedTags], variants,
      sourceArtworkIds: group.works.map(work => work.artworkId), sampleCount: group.works.length, historyCount: works.length,
      defaultRatingPosition, tagRoles, evidenceCheckedAt: evidence.checkedAt || null,
      basePolicy: { minimumWorks: 3, minimumFraction: .6, editable: true },
      sources: group.works.map(work => ({ artworkId: work.artworkId, source: work.source })) };
  });
  return { templates, historyCount: works.length, unresolvedWorks };
}

const gameFamilies = gameDefinitions.map(game => game.tags);
function gameFamily(tags) {
  return [...new Set(clean(tags).map(tag => {
    const index = gameFamilies.findIndex(words => contains(words, tag));
    return index < 0 ? `custom:${normalize(tag)}` : `game:${index}`;
  }))].sort().join('|');
}
const identityNames = identity => clean([identity.englishName, identity.name, ...(identity.aliases || []), ...(identity.characterTags || [])]);
function sameIdentity(a, b) {
  return gameFamily(a.gameTags) === gameFamily(b.gameTags)
    && identityNames(a).some(name => contains(identityNames(b), name));
}
function usableWorks(evidence) {
  return (evidence.recentWorks || []).filter(work => work?.artworkId && Array.isArray(work.tags)
    && work.verified !== false && (!work.status || ['published', 'public'].includes(work.status)));
}
function sharedTagNames(values) {
  return clean((Array.isArray(values) ? values : []).flatMap(value => {
    // Strings are a caller-supplied verified library, never a raw manual pool.
    if (typeof value === 'string') return [value];
    if (!value?.tag || value.verified === false || !Number.isFinite(Date.parse(value.checkedAt))) return [];
    try { const url = new URL(value.url); return url.protocol === 'https:' && url.hostname === 'www.pixiv.net' ? [value.tag] : []; }
    catch { return []; }
  }));
}

/** Keep actual character histories first; fill gaps from verified identities.
 * Cross-account evidence proves a character tag exists, never its placement.
 */
export function buildCharacterCatalog({ scope = {}, evidence = {}, characters = [], sharedVerifiedTags = [] } = {}) {
  const historical = buildPostingTemplates({ scope, evidence, characters });
  const accountScope = { mode: scope.mode || 'live', accountId: scope.accountId || '', pixivUserId: String(scope.pixivUserId || '') };
  const ownTags = clean([...(Number.isFinite(Date.parse(evidence.checkedAt)) ? evidence.frequentTags || [] : []),
    ...usableWorks(evidence).flatMap(work => work.tags)]);
  const sharedTags = sharedTagNames(sharedVerifiedTags);
  const excluded = clean(evidence.excludedTags || []);
  const vocabulary = knownManualCharacterTagIdentities();
  const identities = [];
  for (const memory of characters || []) {
    if (!memory || typeof memory.englishName !== 'string' || !memory.englishName.trim()) continue;
    const matches = vocabulary.filter(identity => identityNames(identity).some(name => contains(identityNames(memory), name))
      && (!memory.gameTags?.length || gameFamily(identity.gameTags) === gameFamily(memory.gameTags)));
    if (matches.length > 1) continue;
    const known = matches.length === 1 ? matches[0] : null;
    const gameTags = clean(known?.gameTags?.length ? known.gameTags : memory.gameTags);
    const characterTags = clean([...(memory.characterTags || []), ...(known?.characterTags || [])]);
    if (!gameTags.length || !characterTags.length) continue;
    identities.push({ ...memory, gameTags, characterTags,
      aliases: clean([...identityNames(memory), ...(known ? identityNames(known) : [])]),
      confirmedGameTags: clean(memory.gameTags), confirmedCharacterTags: clean(memory.characterTags),
      memory: Boolean(memory.gameTags?.length && memory.characterTags?.length) });
  }
  for (const identity of vocabulary) {
    const previous = identities.find(item => sameIdentity(item, identity));
    if (previous) previous.aliases = clean([...identityNames(previous), ...identityNames(identity)]);
    else identities.push({ ...identity, aliases: identityNames(identity), memory: false });
  }
  const supplemental = [];
  for (const identity of identities) {
    if (historical.templates.some(template => sameIdentity(template, identity))) continue;
    if (supplemental.some(template => sameIdentity(template, identity))) continue;
    const ownCharacters = ownTags.filter(tag => contains(identity.characterTags, tag) && !contains(excluded, tag));
    const libraryCharacters = sharedTags.filter(tag => contains(identity.characterTags, tag) && !contains(excluded, tag));
    const rememberedCharacters = (identity.confirmedCharacterTags || []).filter(tag => !contains(excluded, tag));
    const characterTags = ownCharacters.length ? [ownCharacters[0]]
      : identity.memory && rememberedCharacters.length ? rememberedCharacters.slice(0, 4) : libraryCharacters.slice(0, 1);
    if (!characterTags.length) continue;
    const identitySource = identity.memory ? 'user-memory' : ownCharacters.length ? 'account-common-tags' : 'verified-tag-library';
    const formatTemplates = historical.templates.filter(template => gameFamily(template.gameTags) === gameFamily(identity.gameTags));
    const formatVariants = formatTemplates.flatMap(template => template.variants.map(variant => ({ template, variant })));
    const key = `${normalize(identity.englishName)}:${gameFamily(identity.gameTags)}`;
    const variantsByFormat = new Map();
    for (const { template, variant } of formatVariants) {
      const gameTags = [...variant.gameTags], baseTags = [...variant.baseTags];
      let inserted = false;
      const orderedTags = clean(variant.orderedTags.flatMap(tag => {
        if (contains(variant.characterTags, tag)) { if (inserted) return []; inserted = true; return characterTags; }
        return isRating(tag) || contains(gameTags, tag) || contains(baseTags, tag) ? [tag] : [];
      }));
      if (!inserted) orderedTags.push(...characterTags);
      const signature = JSON.stringify(orderedTags), prior = variantsByFormat.get(signature);
      if (prior) {
        prior.formatSampleCount += variant.sampleCount;
        prior.formatSourceArtworkIds = clean([...prior.formatSourceArtworkIds, ...variant.sourceArtworkIds]);
        prior.conditionalTags = clean([...prior.conditionalTags, ...variant.conditionalTags]);
      } else variantsByFormat.set(signature, {
        id: `account-format:${digest([accountScope, key, orderedTags])}`, orderedTags, gameTags, characterTags: [...characterTags],
        baseTags, conditionalTags: [...variant.conditionalTags], rating: variant.rating, sourceArtworkIds: [], sampleCount: 0,
        formatSourceArtworkIds: [...variant.sourceArtworkIds], formatSampleCount: variant.sampleCount,
        defaultRatingPosition: template.defaultRatingPosition,
      });
    }
    let variants = [...variantsByFormat.values()].sort((a, b) => b.formatSampleCount - a.formatSampleCount);
    const formatSource = variants.length ? 'account-history' : 'verified-account-tags';
    if (!variants.length) {
      const ownGames = ownTags.filter(tag => contains(identity.gameTags, tag) && !contains(excluded, tag));
      const gameTags = ownGames.length ? ownGames.slice(0, 4)
        : identity.memory ? (identity.confirmedGameTags || []).filter(tag => !contains(excluded, tag)).slice(0, 4) : [];
      if (!gameTags.length) continue;
      const orderedTags = [...gameTags, ...characterTags];
      variants = [{ id: `account-format:${digest([accountScope, key, orderedTags])}`, orderedTags, gameTags,
        characterTags: [...characterTags], baseTags: [], conditionalTags: [], rating: 'all', sourceArtworkIds: [], sampleCount: 0,
        formatSourceArtworkIds: [], formatSampleCount: 0, defaultRatingPosition: null }];
    }
    const primary = variants[0], actualFormatSource = formatSource === 'verified-account-tags'
      && !ownTags.some(tag => contains(primary.gameTags, tag)) ? 'user-memory' : formatSource;
    const formatSourceArtworkIds = clean(variants.flatMap(variant => variant.formatSourceArtworkIds));
    supplemental.push({ id: `account-style:${digest([accountScope, key])}`, ...accountScope,
      source: 'account-style', identitySource, englishName: identity.englishName, aliases: identityNames(identity),
      gameTags: [...primary.gameTags], characterTags: [...characterTags], baseTags: [...primary.baseTags],
      conditionalTags: clean(variants.flatMap(variant => variant.conditionalTags)),
      orderedTags: [...primary.orderedTags], variants, sourceArtworkIds: [], sampleCount: 0, historyCount: historical.historyCount,
      formatSource: actualFormatSource, formatSourceArtworkIds, defaultRatingPosition: primary.defaultRatingPosition,
      tagRoles: Object.fromEntries(variants.flatMap(variant => variant.orderedTags.map(tag => [tag, isRating(tag) ? 'rating'
        : contains(variant.gameTags, tag) ? 'game' : contains(characterTags, tag) ? 'character' : 'scene']))),
      evidenceCheckedAt: evidence.checkedAt || null,
      basePolicy: { minimumWorks: 3, minimumFraction: .6, editable: true },
      sources: [{ source: identitySource, characterTags: [...characterTags] }],
    });
  }
  return { ...historical, templates: [...historical.templates, ...supplemental.slice(0, 200)],
    historyTemplateCount: historical.templates.length, supplementalTemplateCount: Math.min(supplemental.length, 200) };
}

/** Exact normalized aliases only. Multiple results require an explicit choice. */
export function matchPostingTemplates(catalog, name) {
  if (typeof name !== 'string' || !name.trim()) return [];
  const templates = Array.isArray(catalog) ? catalog : catalog?.templates || [];
  return templates.filter(template => [template.englishName, ...(template.aliases || [])].some(alias => normalize(alias) === normalize(name)));
}

function currentSceneTags(sceneTags, predictions) {
  const explicit = (sceneTags || []).flatMap(item => typeof item === 'string' ? [item]
    : item?.tag && item.verified !== false && (!item.tagRole || item.tagRole === 'scene') && (item.score ?? item.modelScore ?? item.confidence ?? 1) >= .7 ? [item.tag] : []);
  const reliable = (predictions || []).filter(item => item.category === 0 && item.score >= .85);
  return clean([...explicit, ...tagQueries(reliable).filter(query => query.tagRole === 'scene').map(query => query.word)]).filter(tag => !isRating(tag));
}

/** Apply current scene/rating evidence while keeping the chosen old format. */
export function composePostingTemplate(template, { rating, sceneTags = [], predictions = [] } = {}) {
  if (!template || !template.id) return { tags: [], optionalTags: [], templateId: null };
  const available = currentSceneTags(sceneTags, predictions), adultTag = ratingTag(rating);
  const variants = template.variants?.length ? template.variants : [template];
  const scored = variants.map((variant, index) => {
    const conditions = variant.conditionalTags || [], supported = conditions.filter(tag => contains(available, tag)).length;
    return { variant, index, supported, missing: conditions.length - supported, ratingMatch: variant.rating === rating ? 1 : 0 };
  }).sort((a, b) => b.supported - a.supported || b.ratingMatch - a.ratingMatch
    || (b.variant.sampleCount || b.variant.formatSampleCount || 0) - (a.variant.sampleCount || a.variant.formatSampleCount || 0)
    || a.missing - b.missing || a.index - b.index);
  const variant = scored[0].variant;
  const core = clean([...(variant.gameTags || template.gameTags || []), ...(variant.characterTags || template.characterTags || [])]);
  const base = clean(variant.baseTags || template.baseTags || []);
  const supportedConditions = clean((variant.conditionalTags || []).filter(tag => contains(available, tag)));
  const allowed = clean([...core, ...base, ...supportedConditions]);
  let ordered = clean(variant.orderedTags || template.orderedTags || []).filter(tag => !isRating(tag) && contains(allowed, tag));
  for (const tag of [...core, ...base, ...supportedConditions]) if (!contains(ordered, tag)) ordered.push(tag);
  if (adultTag) {
    const sourceOrder = variant.orderedTags || template.orderedTags || [];
    const originalPosition = sourceOrder.findIndex(isRating);
    let position;
    if (originalPosition >= 0) position = sourceOrder.slice(0, originalPosition).filter(tag => contains(ordered, tag)).length;
    else if (template.defaultRatingPosition != null) position = Math.min(template.defaultRatingPosition, ordered.length);
    else position = ordered.findIndex(tag => contains(variant.characterTags || template.characterTags || [], tag));
    ordered.splice(Math.max(0, position), 0, adultTag);
  }
  // Current scene suggestions may add a historical conditional from another
  // variant, but the previous work never supplies evidence for a new picture.
  const allConditions = clean(variants.flatMap(item => item.conditionalTags || []));
  for (const tag of allConditions) if (contains(available, tag) && !contains(ordered, tag)) ordered.push(tag);
  const mandatory = clean([...core, ...(adultTag ? [adultTag] : [])]);
  const extras = ordered.filter(tag => !contains(mandatory, tag)).slice(0, Math.max(0, 10 - mandatory.length));
  const tags = ordered.filter(tag => contains(mandatory, tag) || contains(extras, tag)).slice(0, 10);
  const optionalTags = allConditions.filter(tag => !contains(tags, tag));
  return { tags, optionalTags, templateId: template.id, variantId: variant.id || null, englishName: template.englishName,
    gameTags: [...(variant.gameTags || template.gameTags || [])], characterTags: [...(variant.characterTags || template.characterTags || [])],
    baseTags: base.filter(tag => contains(tags, tag)), conditionalTags: tags.filter(tag => contains(allConditions, tag)),
    source: template.source || 'pixiv-history', sourceArtworkIds: [...(variant.sourceArtworkIds || template.sourceArtworkIds || [])], sampleCount: template.sampleCount,
    ...(template.source === 'account-style' ? { identitySource: template.identitySource, formatSource: template.formatSource,
      formatSourceArtworkIds: [...(variant.formatSourceArtworkIds || template.formatSourceArtworkIds || [])] } : {}),
    mode: template.mode, accountId: template.accountId, pixivUserId: template.pixivUserId, rating: rating || null };
}
