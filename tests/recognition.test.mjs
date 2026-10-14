import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRecognition,rankPixivTags,tagQueries,selectAutomaticTags,annotateTagCandidates} from '../server/recognition.mjs';
import {defaultPostingTime,nextPostingSchedule} from '../server/scheduling.mjs';
const files=[{id:'a'}];
const p=(name,score=.95,category=0,fileId='a')=>({name,score,category,fileId});
const ratings=(fileId='a',adult=false)=>['general','sensitive','questionable','explicit'].map((name,i)=>({fileId,name,score:adult?[.01,.04,.15,.8][i]:[.9,.08,.01,.01][i]}));
test('English title requires a confident single identity in exactly one single-person image',()=>{
 const predictions=[p('1girl'),p('solo'),p('kamisato_ayaka',.96,4)];
 assert.equal(summarizeRecognition(files,predictions,ratings()).title,'Kamisato Ayaka');
 assert.equal(summarizeRecognition([{id:'a'},{id:'b'}],predictions,ratings()).title,'');
 assert.equal(summarizeRecognition(files,[...predictions,p('2girls')],ratings()).title,'');
 assert.equal(summarizeRecognition(files,[...predictions,p('1boy')],ratings()).title,'');
 assert.equal(summarizeRecognition(files,[...predictions,p('lumine_(genshin_impact)',.92,4)],ratings()).title,'');
 assert.equal(summarizeRecognition(files,[p('1girl'),p('robin_(fire_emblem)',.45,4)],ratings()).title,'');
 assert.equal(summarizeRecognition(files,[p('1girl')],ratings()).title,'');
});
test('rating aggregates the strictest result and never assumes missing image ratings are safe',()=>{
 assert.equal(summarizeRecognition(files,[],ratings()).rating,'all');
 assert.equal(summarizeRecognition(files,[],ratings()).sexualContent,false);
 assert.equal(summarizeRecognition([{id:'a'},{id:'b'}],[],[...ratings(),...ratings('b',true)]).rating,'r18');
 assert.equal(summarizeRecognition([{id:'a'},{id:'b'}],[],ratings()).rating,null);
 assert.equal(summarizeRecognition(files,[p('guro')],ratings()).rating,'r18g');
 assert.equal(summarizeRecognition(files,[],[]).rating,null);
});
test('whole-site matches extend beyond local catalog, favorites rank first only when relevant',()=>{
 const queries=tagQueries([p('blue_hair'),p('navel',.8),p('kamisato_ayaka',.99,4)]);
 const result={frequentTags:['無関係','おへそ'],checkedAt:'2026-10-13T00:00:00Z',matches:[
 {word:'blue hair',tag:'Blue_hair',url:'https://www.pixiv.net/ajax/tags/suggest_by_word'},
 {word:'おへそ',tag:'おへそ',url:'https://www.pixiv.net/illustration/create'},
 {word:'Kamisato Ayaka',tag:'Kamisato Ayaka cosplay',url:'https://www.pixiv.net/ajax/tags/suggest_by_word'}]};
 assert.deepEqual(rankPixivTags(queries,result).map(c=>c.tag),['おへそ','Blue_hair']);
 assert.equal(rankPixivTags(queries,result)[0].preferred,true);
 assert.ok(tagQueries([p('unknown_new_character',.96,4)]).some(q=>q.word==='Unknown New Character'));
});
const matched=(queries,{preferredTags=[],frequentTags=[],recentWorks=[],only}={})=>rankPixivTags(queries,{preferredTags,frequentTags,recentWorks,checkedAt:'2026-10-13T00:00:00Z',matches:queries.filter(q=>!only||only.includes(q.word)).map(q=>({word:q.word,tag:q.word,url:'https://www.pixiv.net/ajax/tags/suggest_by_word'}))});
test('automatic tags follow game, age rating, identity, then relevant scenes and prefer account spelling',()=>{
 const predictions=[p('navel',.91),p('smile',.88),p('1girl'),p('nahida_(genshin_impact)',.99,4)];
 const recognition=summarizeRecognition(files,predictions,ratings('a',true));
 const queries=tagQueries(predictions,[],recognition);
 const candidates=matched(queries,{frequentTags:['おへそ','纳西妲','GenshinImpact','笑颜']});
 const tags=selectAutomaticTags(candidates,recognition);
 assert.deepEqual(tags.slice(0,3),['GenshinImpact','R-18','纳西妲']);
 assert.ok(tags.includes('おへそ'));
 assert.ok(tags.includes('笑颜'));
 assert.ok(!tags.includes('navel')&&!tags.includes('ナヒーダ')&&!tags.includes('原神'));
 assert.ok(!tags.includes('笑顔'));
 assert.deepEqual(candidates.filter(c=>c.tag==='R-18').map(c=>c.tagRole),['rating']);
});
test('published history preserves repeatedly paired game spellings in their observed order',()=>{
 const predictions=[p('kafka_(honkai:_star_rail)',.99,4),p('navel',.85)];
 const recognition=summarizeRecognition(files,predictions,ratings());
 const queries=tagQueries(predictions,[],recognition);
 assert.ok(queries.some(q=>q.word==='HonkaiStarRail'));
 assert.ok(queries.some(q=>q.word==='崩壊スターレイル'));
 const works=[1,2,3].map(artworkId=>({artworkId,title:'Kafka',tags:['HonkaiStarRail','崩壊スターレイル','カフカ(スターレイル)','おへそ']}));
 const candidates=matched(queries,{frequentTags:['崩壊スターレイル','HonkaiStarRail','カフカ(スターレイル)'],recentWorks:works});
 assert.deepEqual(selectAutomaticTags(candidates,recognition).slice(0,3),['HonkaiStarRail','崩壊スターレイル','カフカ(スターレイル)']);
 const once=matched(queries,{frequentTags:['崩壊スターレイル','HonkaiStarRail'],recentWorks:works.slice(0,1)});
 assert.equal(selectAutomaticTags(once,recognition).filter(tag=>['HonkaiStarRail','崩壊スターレイル'].includes(tag)).length,1);
});
test('first network queries reserve game, rating and identities ahead of many scene predictions',()=>{
 const predictions=[...Array.from({length:100},(_,i)=>p(`scene_${i}`,1)),p('nahida_(genshin_impact)',.9,4),p('kafka_(honkai:_star_rail)',.91,4)];
 const recognition=summarizeRecognition(files,predictions,ratings('a',true));
 const queries=tagQueries(predictions,[],recognition);
 assert.ok(queries.length>32&&queries.length<=256);
 for(const word of ['原神','R-18','纳西妲','カフカ(スターレイル)','HonkaiStarRail'])assert.ok(queries.slice(0,32).some(q=>q.word===word),word);
 const tags=selectAutomaticTags(matched(queries),recognition);
 assert.equal(tags.length,10);
 assert.ok(tags.includes('R-18'));
 assert.equal(new Set(tags).size,10);
});
test('query priority keeps reliable translated scenes in the network budget and later favorites available',()=>{
 const predictions=[...Array.from({length:80},(_,i)=>p(`scene_${i}`,1)),p('navel',.72),p('smile',.75),p('bare_shoulders',.8)];
 const queries=tagQueries(predictions);
 assert.ok(queries.length>32);
 for(const word of ['おへそ','笑顔','笑颜','肩出し'])assert.ok(queries.slice(0,32).some(q=>q.word===word),word);
 assert.ok(queries.slice(32).some(q=>q.word==='scene 79'));
 const favorite=matched(queries,{only:['scene 79'],frequentTags:['scene 79']});
 assert.deepEqual(selectAutomaticTags(favorite,{}),['scene 79']);
 assert.equal(tagQueries(Array.from({length:400},(_,i)=>p(`scene_${i}`,1))).length,256);
});
test('account pool order outranks higher image scores and unrelated favorites are never injected',()=>{
 const queries=tagQueries([p('navel',.73),p('smile',.91),p('book',.99)]);
 const candidates=matched(queries,{preferredTags:['笑颜','おへそ','無関係','極上の女体'],frequentTags:['Book','笑顔'],recentWorks:[{tags:['笑顔','Book']}]});
 assert.deepEqual(candidates.slice(0,2).map(candidate=>candidate.tag),['笑颜','おへそ']);
 assert.ok(!candidates.some(candidate=>['無関係','極上の女体'].includes(candidate.tag)));
 assert.deepEqual(selectAutomaticTags(candidates),['笑颜','おへそ','book']);
});
test('established account preferences keep unfamiliar scene terms as suggestions without filling automatic tags',()=>{
 const predictions=[p('mona_(genshin_impact)',.99,4),p('1girl'),p('navel',.8),p('book',.99),p('cup',.99),p('shirt',.99)];
 const recognition=summarizeRecognition(files,predictions,ratings());
 const queries=tagQueries(predictions,[],recognition);
 for(const preferences of [{preferredTags:['おへそ']},{frequentTags:['おへそ']},{recentWorks:[{tags:['おへそ']}]}]){
  const candidates=matched(queries,preferences);
  assert.ok(candidates.some(candidate=>candidate.tag==='book'&&!candidate.preferred));
  assert.deepEqual(selectAutomaticTags(candidates,recognition),['原神','モナ(原神)','おへそ']);
 }
 assert.ok(selectAutomaticTags(matched(queries),recognition).includes('book'),'no established account context retains ordinary fallback');
 assert.deepEqual(selectAutomaticTags(matched(queries,{preferredTags:['無関係']}),recognition),['原神','モナ(原神)']);
});
test('query budget prioritizes familiar evidence-linked spellings without adding arbitrary pool tags',()=>{
 const predictions=[...Array.from({length:100},(_,i)=>p(`scene_${i}`,1)),p('navel',.75),p('large_breasts',.72),p('thighs',.79),p('smile',.69)];
 const queries=tagQueries(predictions,[],{}, {preferredTags:['巨乳','おへそ','scene 99','太もも','笑颜','魅惑のふともも','無関係']});
 assert.deepEqual(queries.slice(0,4).map(query=>query.word),['巨乳','おへそ','scene 99','太もも']);
 assert.ok(!queries.some(query=>['魅惑のふともも','無関係'].includes(query.word)));
 const automatic=selectAutomaticTags(matched(queries,{preferredTags:['巨乳','おへそ','太もも','笑颜','魅惑のふともも']}));
 assert.deepEqual(automatic,['巨乳','おへそ','太もも']);
});
test('cached matches retain the original verification time and require explicit earlier Pixiv proof',()=>{
 const queries=tagQueries([p('navel',.9),p('smile',.9)]);
 const candidates=rankPixivTags(queries,{preferredTags:['おへそ','笑顔'],source:'pixiv-cache',cached:true,
  checkedAt:'2026-10-12T00:00:00Z',matches:[
   {word:'おへそ',tag:'おへそ',url:'https://www.pixiv.net/illustration/create',source:'pixiv-cache',verified:true,checkedAt:'2026-10-11T00:00:00Z'},
   {word:'笑顔',tag:'笑顔',url:'https://www.pixiv.net/illustration/create',source:'pixiv-cache'}]});
 assert.equal(candidates[0].source,'pixiv-cache');
 assert.equal(candidates[0].cached,true);
 assert.equal(candidates[0].freshVerified,false);
 assert.equal(candidates[0].verified,true);
 assert.deepEqual(candidates[0].evidence,[{kind:'pixiv_tag_cache',tag:'おへそ',url:'https://www.pixiv.net/illustration/create',checkedAt:'2026-10-11T00:00:00Z'}]);
 assert.equal(candidates[1].verified,false);
 assert.deepEqual(selectAutomaticTags(candidates),['おへそ']);
});
test('removed pool tags stay available for manual choice but history does not auto-select them again',()=>{
 const preferences={preferredTags:['笑顔'],frequentTags:['おへそ','笑顔'],recentWorks:[{tags:['おへそ','笑顔']}],excludedTags:['おへそ']};
 const queries=tagQueries([p('navel',.99),p('smile',.8)],[],{},preferences);
 assert.equal(queries[0].word,'笑顔');
 const candidates=rankPixivTags(queries,{...preferences,matches:queries.map(query=>({word:query.word,tag:query.word,url:'https://www.pixiv.net/illustration/create'}))});
 assert.equal(candidates.find(candidate=>candidate.tag==='おへそ').preferred,false);
 assert.deepEqual(selectAutomaticTags(candidates),['笑顔']);
 const allRemoved=rankPixivTags(queries,{...preferences,preferredTags:[],excludedTags:['おへそ','笑顔'],matches:queries.map(query=>({word:query.word,tag:query.word,url:'https://www.pixiv.net/illustration/create'}))});
 assert.deepEqual(selectAutomaticTags(allRemoved),[]);
});
test('automatic tags require image evidence, exact Pixiv proof and compatible age rating',()=>{
 const predictions=[p('kamisato_ayaka',.84,4),p('navel',.69),p('smile',.75),p('solo')];
 const recognition=summarizeRecognition(files,predictions,ratings());
 const queries=tagQueries(predictions,[],recognition);
 assert.ok(!queries.some(q=>q.tagRole==='character'||q.tagRole==='game'||q.tagRole==='rating'));
 const candidates=matched(queries);
 const adultQueries=tagQueries([],[],{rating:'r18'});
 const adultCandidate=matched(adultQueries)[0];
 assert.deepEqual(selectAutomaticTags([...candidates,adultCandidate],recognition),['笑顔']);
 assert.deepEqual(selectAutomaticTags([{...candidates.find(c=>c.tag==='笑顔'),verified:false}],recognition),[]);
 assert.deepEqual(selectAutomaticTags([{...candidates.find(c=>c.tag==='笑顔'),evidence:[]}],recognition),[]);
 assert.deepEqual(selectAutomaticTags(matched(tagQueries([],[],{rating:'r18g'})),{rating:'r18g'}),['R-18G']);
 assert.deepEqual(selectAutomaticTags([], {rating:'r18'}),[]);
});
test('catalog fallback annotates low-confidence identities as identities and never turns them into scenes',()=>{
 const predictions=[p('nahida_(genshin_impact)',.6,4),p('navel',.92)];
 const recognition=summarizeRecognition(files,predictions,ratings());
 const proof=[{kind:'user_screenshot',verifiedTags:['纳西妲','おへそ']}];
 const catalog=[{tag:'纳西妲',modelScore:.6,modelNames:['nahida_(genshin_impact)'],existing:true,verified:true,evidence:proof},
  {tag:'おへそ',modelScore:.92,modelNames:['navel'],existing:true,verified:true,evidence:proof}];
 const annotated=annotateTagCandidates(catalog,predictions,recognition);
 assert.equal(annotated[0].tagRole,'character');
 assert.equal(annotated[1].tagRole,'scene');
 assert.deepEqual(selectAutomaticTags(annotated,recognition),['おへそ']);
 assert.deepEqual(annotated[0].evidence,catalog[0].evidence);
});
test('multi-image recognition merges tag evidence but retains distinct character concepts',()=>{
 const predictions=[p('nahida_(genshin_impact)',.98,4),p('nahida_(genshin_impact)',.99,4,'b'),p('furina_(genshin_impact)',.96,4,'b')];
 const recognition=summarizeRecognition([{id:'a'},{id:'b'}],predictions,[...ratings(),...ratings('b')]);
 const queries=tagQueries(predictions,[],recognition);
 assert.deepEqual(new Set(queries.find(q=>q.word==='原神').fileIds),new Set(['a','b']));
 const tags=selectAutomaticTags(matched(queries,{frequentTags:['纳西妲','芙宁娜']}),recognition);
 assert.equal(recognition.title,'');
 assert.deepEqual(tags,['原神','纳西妲','芙宁娜']);
});
test('account defaults select the strictly next Japan posting slot across time and date boundaries',()=>{
 assert.equal(defaultPostingTime({pixivUserId:'202'}),'09:00');
 assert.equal(defaultPostingTime({name:'Example Alpha'}),'09:00');
 assert.equal(defaultPostingTime({name:'Example Beta',defaultPostingTime:'13:30'}),'13:30');
 const cases=[
  [{name:'Example Alpha'},'2026-10-13T01:00:00+08:00','2026-10-13T00:00:00.000Z'],
  [{name:'Example Beta',defaultPostingTime:'11:00'},'2026-10-13T01:00:00+08:00','2026-10-13T02:00:00.000Z'],
  [{name:'Example Alpha'},'2026-10-12T23:59:59.999Z','2026-10-13T00:00:00.000Z'],
  [{name:'Example Alpha'},'2026-10-13T00:00:00Z','2026-10-14T00:00:00.000Z'],
  [{name:'Example Alpha'},'2026-10-13T01:00:00Z','2026-10-14T00:00:00.000Z'],
  [{name:'Example Beta',defaultPostingTime:'11:00'},'2026-10-13T01:00:00Z','2026-10-13T02:00:00.000Z'],
  [{defaultPostingTime:'13:30'},'2026-10-13T04:29:59Z','2026-10-13T04:30:00.000Z'],
  [{defaultPostingTime:'13:30'},'2026-10-13T04:30:00Z','2026-10-14T04:30:00.000Z'],
  [{defaultPostingTime:'00:00'},'2026-10-12T14:59:59Z','2026-10-12T15:00:00.000Z'],
  [{defaultPostingTime:'00:00'},'2026-10-12T15:00:00Z','2026-10-13T15:00:00.000Z'],
  [{name:'Example Alpha'},'2026-10-12T23:30:00+08:00','2026-10-13T00:00:00.000Z'],
  [{name:'Example Beta',defaultPostingTime:'11:00'},'2026-12-31T15:00:00Z','2027-01-01T02:00:00.000Z'],
  [{name:'Example Alpha'},'2026-12-31T12:00:00Z','2027-01-01T00:00:00.000Z'],
  [{name:'Example Alpha'},'2028-02-28T12:00:00Z','2028-02-29T00:00:00.000Z'],
  [{name:'Example Alpha'},'2028-02-29T12:00:00Z','2028-03-01T00:00:00.000Z'],
 ];
 for(const [account,now,expected] of cases)assert.equal(nextPostingSchedule(account,now),expected,JSON.stringify({account,now}));
});
