import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDemoState } from '../server/seed.mjs';

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js');
const appSource = await fs.readFile(sourcePath, 'utf8');
const NOW = '2026-10-04T10:00:00.000Z';
const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * Execute the real browser script and its registered event handlers. This tiny
 * DOM is only an event/render boundary, not a second implementation of app.js.
 * Assertions inspect rendered HTML and requests; none inspect source strings.
 */
async function browserFixture(t, browserRoutes = false, initialTime = NOW) {
  let clock = Date.parse(initialTime);
  class BrowserDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let state = { ...createDemoState(new Date(initialTime)), mode: 'live', now: initialTime, connectorConfigured: false, tagger: { available: true, catalogEntries: 5 } };
  state.settings = { ...state.settings, mode: 'live', demo: false };
  for(const job of state.jobs){job.canDeleteLocally=job.status==='queued';job.deleteBlockedReason=job.canDeleteLocally?'':'作品已经提交到 Pixiv，请保留记录以核对状态。';}
  const handlers = new Map(), requests = [], pending = [], syncPending = [], queuePending = [], memoryPending = [], deletePending = [], poolPending = [], characterPending = [], eventPromises = [], intervals = new Map();
  const tagPools=new Map(),templateCatalogs=new Map(),templatePending=[];let deferPoolReads=false,deferTemplateReads=false;
  const nameTimers=new Map();let timerSequence=0,deferCharacterResolves=false;
  let characters = [];
  let appHtml='';const domProperties=new Map();
  const decodeHtml=value=>value.replace(/&quot;|&#39;|&lt;|&gt;|&amp;/g,entity=>({'&quot;':'"','&#39;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'}[entity]));
  const app = { get innerHTML(){return appHtml;}, set innerHTML(value){appHtml=value;domProperties.clear();for(const[key,element]of Object.entries(memoryTagInputs)){element.value=decodeHtml(value.match(new RegExp(`<input[^>]*id="memory-tag-input-${key}"[^>]*value="([^"]*)"`))?.[1]||'');}}, addEventListener(type, listener) { const items = handlers.get(type) || []; items.push(listener); handlers.set(type, items); } };
  const modalBody = { scrollTop: 0 };
  const tagInput = {value:'',focus(){}};
  const memoryTagInputs=Object.fromEntries(['gameTags','characterTags'].map(key=>[key,{id:`memory-tag-input-${key}`,dataset:{memoryTagInput:key},value:'',focus(){},setSelectionRange(){}}]));
  const searchInput = {value:'',focus(){},setSelectionRange(){}};
  const classes = new Set();
  const toast = { textContent: '', classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } };
  const document = {
    activeElement: null,
    querySelector(selector) {
      if (selector === '#app') return app;
      if (selector === '#toast') return toast;
      if (selector === '#tag-input') return tagInput;
      if(selector.startsWith('#memory-tag-input-'))return memoryTagInputs[selector.slice('#memory-tag-input-'.length)]||null;
      if(selector==='[data-action="memory-save"]')return app.innerHTML.includes('data-action="memory-save"')?actionElement('memory-save'):null;
      if(selector==='[data-memory-field="confirmedSingleCharacter"]')return app.innerHTML.includes('data-memory-field="confirmedSingleCharacter"')?{get checked(){return domProperties.get('memory-confirmed')??/data-memory-field="confirmedSingleCharacter"\s+checked/.test(app.innerHTML);},set checked(value){domProperties.set('memory-confirmed',value);}}:null;
      if (selector === '#search') return searchInput;
      if (selector === '.modal-body') return app.innerHTML.includes('class="modal-body"') ? modalBody : null;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const httpResponse = (payload, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => structuredClone(payload) });
  async function fetchMock(url, options = {}) {
    const payload = options.body === undefined || url.startsWith('/api/files?') ? undefined : JSON.parse(options.body);
    requests.push({ url, method: options.method || 'GET', payload });
    if (url === '/api/state') return httpResponse(state);
    if(url.startsWith('/api/characters/templates?')){
      const parsed=new URL(url,'http://localhost'),accountId=parsed.searchParams.get('accountId'),mode=parsed.searchParams.get('mode');
      const response={mode,accountId,pixivUserId:state.accounts.find(account=>account.id===accountId)?.pixivUserId,templates:templateCatalogs.get(accountId)||[],historyCount:6,unresolvedWorks:[]};
      if(!deferTemplateReads)return httpResponse(response);
      return new Promise(resolve=>templatePending.push({settled:false,succeed(result={}){if(this.settled)return;this.settled=true;resolve(httpResponse({...response,...result}));}}));
    }
    if(url==='/api/characters/resolve'){
      const response={...payload,pixivUserId:state.accounts.find(account=>account.id===payload.accountId)?.pixivUserId,status:'not-found',gameTags:[],characterTags:[],tags:[],source:'none',message:'未找到明确角色'};
      if(!deferCharacterResolves)return httpResponse(response);
      return new Promise(resolve=>{const deferred={settled:false,payload,succeed(result){if(this.settled)return;this.settled=true;resolve(httpResponse({...response,...result}));},fail(message){if(this.settled)return;this.settled=true;resolve(httpResponse({error:message},false));}};characterPending.push(deferred);});
    }
    if(url.startsWith('/api/tags/pool')){
      const parsed=new URL(url,'http://localhost'),accountId=payload?.accountId||parsed.searchParams.get('accountId'),mode=payload?.mode||parsed.searchParams.get('mode')||state.mode;
      const pool=()=>({mode,accountId,pixivUserId:state.accounts.find(account=>account.id===accountId)?.pixivUserId,tags:tagPools.get(mode+':'+accountId)||[],checkedAt:null,source:'manual',cached:true});
      if((options.method||'GET')==='GET'&&!deferPoolReads)return httpResponse(pool());
      return new Promise(resolve=>{
        const deferred={settled:false,payload,url,accountId,mode,
          succeed(result){if(this.settled)return;this.settled=true;let current=pool();if(payload?.addTags)current.tags=[...new Set([...current.tags,...payload.addTags])];if(payload?.removeTags)current.tags=current.tags.filter(tag=>!payload.removeTags.includes(tag));current={...current,...result};tagPools.set(mode+':'+accountId,current.tags);resolve(httpResponse(current));},
          fail(message){if(this.settled)return;this.settled=true;resolve(httpResponse({error:message},false));},
        };poolPending.push(deferred);
      });
    }
    if (url === '/api/mode') {state.mode=payload.mode;state.settings.mode=payload.mode;state.settings.demo=payload.mode==='demo';return httpResponse(state);}
    if (url === '/api/jobs/bulk-delete') return new Promise(resolve=>{
      const deferred={settled:false,payload,
        succeed(){if(this.settled)return;this.settled=true;state.jobs=state.jobs.filter(job=>!payload.jobIds.includes(job.id));resolve(httpResponse({...state,deletedJobIds:payload.jobIds}));},
        fail(message){if(this.settled)return;this.settled=true;resolve(httpResponse({error:message},false));},
      };deletePending.push(deferred);
    });
    if (url === '/api/characters') return httpResponse({mode:state.mode,characters});
    if (url.startsWith('/api/characters/') && options.method === 'DELETE') {
      const parsed = new URL(url,'http://localhost');assert.equal(parsed.searchParams.get('mode'),state.mode);
      characters=characters.filter(character=>character.id!==decodeURIComponent(parsed.pathname.split('/').at(-1)));
      return httpResponse({mode:state.mode,characters});
    }
    if (url === '/api/characters/remember') return new Promise(resolve=>{
      const deferred={settled:false,payload,
        succeed(character={id:payload.characterId||'remembered-robin',englishName:'Robin',gameTags:payload.gameTags,characterTags:payload.characterTags,sampleCount:1,updatedAt:state.now,samples:[]}) {if(this.settled)return;this.settled=true;characters=[...characters.filter(item=>item.id!==character.id),character];resolve(httpResponse({mode:payload.mode,character,characters}));},
        fail(message){if(this.settled)return;this.settled=true;resolve(httpResponse({error:message},false));},
      };memoryPending.push(deferred);
    });
    if (url === '/api/pixiv/sync') return new Promise(resolve => {
      const deferred = { settled: false,
        succeed(report = {startedAt:state.now,completedAt:state.now,succeeded:1,failed:0,skipped:0,accounts:[]}) { if(this.settled)return;this.settled=true;state.pixivSync=report;resolve(httpResponse(state)); },
        fail(message) { if(this.settled)return;this.settled=true;resolve(httpResponse({error:message},false)); },
      };
      syncPending.push(deferred);
    });
    if (url === '/api/queue/start') return new Promise(resolve => {
      queuePending.push({settled:false,
        succeed(report={running:true,startedAt:state.now,completedAt:null,source:'manual',reserved:0,published:0,failed:0,needsReview:0,remaining:20,errors:[]}){if(this.settled)return;this.settled=true;state.queueRun=report;resolve(httpResponse(state));},
        fail(message){if(this.settled)return;this.settled=true;resolve(httpResponse({error:message},false));},
      });
    });
    if (url.startsWith('/api/files?')) return httpResponse({file:{id:'upload-'+requests.length,name:decodeURIComponent(url.split('=')[1]),mime:'image/png',size:100,url:'/files/test-upload'}});
    if (url === '/api/jobs') { const job={...state.jobs[10],...payload,id:'created-'+requests.length};state.jobs.push(job);state.createdJobId=job.id;return httpResponse(state); }
    if(url.startsWith('/api/jobs/')&&options.method==='PATCH'){const id=url.split('/').at(-1),job=state.jobs.find(item=>item.id===id);if(!job)throw new Error('Unknown test job');Object.assign(job,payload);return httpResponse(state);}
    if (url === '/api/settings') { state.settings = { ...state.settings, ...payload }; return httpResponse(state); }
    if (browserRoutes && url === '/api/browser/discover') return httpResponse({ accounts: [{ candidateId: 'candidate', pixivUserId: state.accounts[0].pixivUserId, name: state.accounts[0].name, premium: true }], message: '已检测到 1 个账号。' });
    if (browserRoutes && url === `/api/accounts/${state.accounts[0].id}/browser`) {
      assert.equal(payload.candidateId, 'candidate'); state.accounts[0].browser = { targetId: 'A'.repeat(32), postingEnabled: false };
      state.connectorConfigured = true; return httpResponse(state);
    }
    if (browserRoutes && url === `/api/accounts/${state.accounts[0].id}/browser-posting`) {
      state.accounts[0].browser.postingEnabled = payload.enabled; return httpResponse(state);
    }
    if (url === '/api/tags/suggest') {
      return new Promise((resolve, reject) => {
        const deferred = { settled: false, payload,
          succeed(result = {}) { if (this.settled) return; this.settled = true; resolve(httpResponse({ source: 'local', mode: 'live', demo: false, stale: false, candidates: [], warnings: [], unmapped: [], analyzedFiles: [], ...result })); },
          fail(message) { if (this.settled) return; this.settled = true; resolve(httpResponse({ error: message }, false)); },
          reject(message) { if (this.settled) return; this.settled = true; reject(new Error(message)); },
        };
        pending.push(deferred);
      });
    }
    throw new Error(`Unexpected frontend request: ${url}`);
  }
  const context = vm.createContext({ document, fetch: fetchMock, structuredClone, URL, Blob, console, Date: BrowserDate,
    setInterval(callback,delay){intervals.set(delay,callback);return delay;}, clearInterval(id){intervals.delete(id);}, setTimeout(callback,delay){const id=++timerSequence;if(delay===700)nameTimers.set(id,callback);return id;}, clearTimeout(id){nameTimers.delete(id);},
  });
  // An async wrapper adapts browser top-level await without modifying app logic.
  await vm.runInContext(`(async () => {\n${appSource}\n})()`, context, { filename: sourcePath });
  assert.ok(app.innerHTML.includes('class="shell"'), 'Actual app boot must render the workspace.');

  function actionElement(action) {
    const tag = [...app.innerHTML.matchAll(/<(?:button|input|img)\b[^>]*>/g)].map(match => match[0]).find(markup => markup.includes(`data-action="${action}"`));
    assert.ok(tag, `Rendered action must exist: ${action}`);
    const element = { dataset: { action }, get disabled(){return domProperties.get('disabled:'+action)??/\sdisabled(?:\s|>|=)/.test(tag);},set disabled(value){domProperties.set('disabled:'+action,value);}, closest(selector) { return selector === '[data-action]' ? this : null; } };
    return element;
  }
  function dispatchClick(element) {
    const event = { target: element, preventDefault() {} };
    const result = Promise.all((handlers.get('click') || []).map(listener => listener(event)));
    eventPromises.push(result);
    return result;
  }
  const click = action => dispatchClick(actionElement(action));
  const change = async (dataset, value, extra={}) => {
    await Promise.all((handlers.get('change')||[]).map(fn=>fn({target:{dataset,value,type:'text',...extra}})));
    // Commit helpers advance the short debounce; input helpers leave it pending
    // so immediate-save and rapid typing tests can drive the real timer boundary.
    if(dataset.field==='title'||dataset.memoryField==='englishName'){const timers=[...nameTimers.values()];nameTimers.clear();for(const callback of timers)callback();await flush();}
  };
  const input = (dataset,value,extra={}) => Promise.all((handlers.get('input')||[]).map(fn=>fn({target:{dataset,value,type:'text',...extra}})));
  const search = value => Promise.all((handlers.get('input')||[]).map(fn=>fn({target:{id:'search',value,selectionStart:value.length}})));
  const poolSearch = value => Promise.all((handlers.get('input')||[]).map(fn=>fn({target:{id:'tag-pool-query',value,selectionStart:value.length}})));
  const typeTag = async value => {tagInput.value=value;for(const fn of handlers.get('keydown')||[])await fn({target:{id:'tag-input',dataset:{}},key:'Enter',preventDefault(){}});};
  const inputMemoryTag=async(key,value)=>{const target=memoryTagInputs[key];target.value=value;for(const fn of handlers.get('input')||[])await fn({target});};
  const pressMemoryKey=async(field,key,isComposing=false)=>{for(const fn of handlers.get('keydown')||[])await fn({target:memoryTagInputs[field],key,isComposing,preventDefault(){}});};
  const pressMemoryEnter=(key,isComposing=false)=>pressMemoryKey(key,'Enter',isComposing);
  const composeMemoryTag=async(key,type,value)=>{const target=memoryTagInputs[key];if(value!==undefined)target.value=value;for(const fn of handlers.get(type)||[])await fn({target});};
  const typeMemoryTag=async(key,value)=>{await inputMemoryTag(key,value);await pressMemoryEnter(key);};
  const memoryTags=key=>[...(app.innerHTML.match(new RegExp(`<div[^>]*data-memory-tags="${key}"[^>]*>([\\s\\S]*?)<input\\b`))?.[1]||'').matchAll(/<span class="tag">([^<]*)<button/g)].map(match=>match[1]);
  const pendingMemoryTag=key=>memoryTagInputs[key].value;
  const editorTags = () => [...(app.innerHTML.match(/<div class="tag-editor">([\s\S]*?)<input id="tag-input"/)?.[1]||'').matchAll(/<span class="tag">([^<]*)<button/g)].map(match=>match[1]);
  const first = state.jobs[10], second = state.jobs[11];
  async function openFirst() { await click('nav:works'); await click('filter:queued'); await click(`edit:${first.id}`); }
  t.after(async () => { for (const item of [...pending,...syncPending,...queuePending,...memoryPending,...deletePending,...poolPending,...characterPending,...templatePending]) item.succeed(); await Promise.allSettled(eventPromises); });
  return { app, toast, requests, pending, syncPending, queuePending, memoryPending, deletePending, poolPending, characterPending, click, change, input, search, poolSearch, typeTag, inputMemoryTag, pressMemoryKey, pressMemoryEnter, composeMemoryTag, typeMemoryTag, memoryTags, pendingMemoryTag, editorTags, actionElement, dispatchClick, openFirst, first, second,
    async runInterval(delay){await intervals.get(delay)?.();await flush();},
    async imageError(target){for(const callback of handlers.get('error')||[])await callback({target});},
    deferCharacterResolves(value=true){deferCharacterResolves=value;},
    setTemplates(templates,accountId=state.accounts[0].id){templateCatalogs.set(accountId,structuredClone(templates));},
    deferTemplateReads(value=true){deferTemplateReads=value;},templatePending,
    async runNameTimers(){const timers=[...nameTimers.values()];nameTimers.clear();for(const callback of timers)callback();await flush();},
    setTagPool(tags,accountId=state.accounts[0].id,mode=state.mode){tagPools.set(mode+':'+accountId,structuredClone(tags));},
    deferPoolReads(value=true){deferPoolReads=value;},
    setCharacters(value){characters=structuredClone(value);},
    get state() { return state; },
    advanceTime(ms) { clock += ms; state.now = new Date(clock).toISOString(); },
    hasDialog: () => app.innerHTML.includes('role="dialog"'),
  };
}

test('work tabs keep the requested order and start at drafts on navigation and mode changes', async t => {
 const b=await browserFixture(t);
 const tabs=()=>[...b.app.innerHTML.matchAll(/data-action="filter:([^"]+)"[^>]*role="tab"[^>]*aria-selected="([^"]+)"/g)].map(match=>[match[1],match[2]]);
 assert.deepEqual(tabs(),[['draft','true'],['queued','false'],['reserved','false'],['published','false']]);
 assert.doesNotMatch(b.app.innerHTML,/data-action="filter:all"|data-action="edit:demo-work-/);
 await b.click('nav:works');
 assert.match(b.app.innerHTML,/data-action="filter:draft"[^>]*>待预约<b>0<\/b>/);
 assert.doesNotMatch(b.app.innerHTML,/全部状态/);
 await b.click('filter:queued');assert.equal(tabs()[1][1],'true');
 await b.click('nav:overview');assert.equal(tabs()[0][1],'true');
 await b.click('nav:works');await b.click('filter:published');
 await b.click('nav:settings');await b.click('switch-demo');await b.click('nav:works');
 assert.equal(tabs()[0][1],'true');assert.equal(b.state.mode,'demo');
});

const historyRobin={id:'history:robin',englishName:'Robin',aliases:['Robin','知更鸟','ロビン'],gameTags:['HonkaiStarRail','崩壊スターレイル'],characterTags:['ロビン(スターレイル)'],baseTags:['女の子'],conditionalTags:['水着'],orderedTags:['HonkaiStarRail','ロビン(スターレイル)','R-18','崩壊スターレイル','女の子'],sourceArtworkIds:['101','102'],sampleCount:2};
const historyResult=(template=historyRobin,orderedTags=template.orderedTags)=>({status:'resolved',template,orderedTags,optionalTags:['水着'],identity:{englishName:template.englishName},gameTags:template.gameTags,characterTags:template.characterTags,source:'pixiv-history-template'});
const accountRuanMei={...historyRobin,id:'account-style:ruanmei',source:'account-style',identitySource:'user-memory',englishName:'RuanMei',aliases:['阮梅','Ruan Mei'],characterTags:['阮梅'],orderedTags:['HonkaiStarRail','崩壊スターレイル','阮梅','女の子'],sourceArtworkIds:[],formatSourceArtworkIds:['101','102'],sampleCount:0};
async function uploadForTemplate(b,result={recognition:{title:'',rating:'all',sexualContent:false},memoryAnalysisId:'analysis-template'}){
 await b.change({},'',{id:'editor-files',files:[{name:'template.png',size:100,type:'image/png'}]});await flush();
 if(result){b.pending.at(-1).succeed(result);await flush();}
}

test('the character catalog expands beyond eight entries and searches every Chinese and English alias without truncation',async t=>{
 const b=await browserFixture(t),templates=[...Array.from({length:8},(_,index)=>({...historyRobin,id:`history:${index}`,englishName:`History${index}`})),accountRuanMei,{...accountRuanMei,id:'account-style:sparxie',englishName:'Sparxie',identitySource:'verified-tag-library',aliases:['火花'],characterTags:['火花']},...Array.from({length:25},(_,index)=>({...historyRobin,id:`extra:${index}`,englishName:`Extra${index}`}))].map(item=>({...item,aliases:[...item.aliases,'星铁角色']}));
 b.setTemplates(templates);await b.click('new-work');await flush();
 assert.match(b.app.innerHTML,/共 35 个角色/);assert.match(b.app.innerHTML,/显示 8 \/ 35 个角色/);assert.doesNotMatch(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);
 await b.click('character-show-all');assert.match(b.app.innerHTML,/显示 35 \/ 35 个角色/);assert.match(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);assert.match(b.app.innerHTML,/data-action="character-template:account-style:sparxie"/);
 await b.click('character-show-all');assert.match(b.app.innerHTML,/显示 8 \/ 35 个角色/);
 await b.input({},'阮梅',{id:'character-query'});assert.match(b.app.innerHTML,/找到 1 个角色，共 35 个/);assert.match(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);assert.doesNotMatch(b.app.innerHTML,/data-action="character-template:history:0"/);
 await b.input({},'sparxie',{id:'character-query'});assert.match(b.app.innerHTML,/data-action="character-template:account-style:sparxie"/);
 await b.input({},'星铁角色',{id:'character-query'});assert.match(b.app.innerHTML,/找到 35 个角色，共 35 个/);assert.equal([...b.app.innerHTML.matchAll(/data-action="character-template:/g)].length,35);assert.match(b.app.innerHTML,/data-action="character-template:extra:24"/);
 assert.equal(b.characterPending.length,0,'Browsing the full catalog before upload never applies a role.');
});

test('supplementary roles state their identity source and reuse account formatting without inventing character history',async t=>{
 const b=await browserFixture(t);b.setTemplates([accountRuanMei,{...accountRuanMei,id:'common',englishName:'Common',identitySource:'account-common-tags'},{...accountRuanMei,id:'verified',englishName:'Sparxie',identitySource:'verified-tag-library'}]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 assert.match(b.app.innerHTML,/角色记忆 · 沿用本账号格式/);assert.match(b.app.innerHTML,/常用角色 · 沿用本账号格式/);assert.match(b.app.innerHTML,/已核实角色 · 沿用本账号格式/);assert.doesNotMatch(b.app.innerHTML,/0 件历史作品|1 件作品|1 件参考作品/);
 const choice=b.click('character-template:account-style:ruanmei');await flush();b.characterPending[0].succeed(historyResult(accountRuanMei));await choice;
 assert.deepEqual(b.editorTags(),accountRuanMei.orderedTags);assert.match(b.app.innerHTML,/data-field="title" value="RuanMei"/);assert.match(b.app.innerHTML,/角色标签来自角色记忆/);assert.match(b.app.innerHTML,/同游戏其他角色的历史投稿/);assert.doesNotMatch(b.app.innerHTML,/件参考作品/);
});
test('one historical role choice uses exact account tag spelling and order without creating character memory',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin,{...historyRobin,id:'mona',englishName:'Mona',aliases:['莫娜']}]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 await b.input({},'知更鸟',{id:'character-query'});
 assert.match(b.app.innerHTML,/data-action="character-template:history:robin"/);assert.doesNotMatch(b.app.innerHTML,/data-action="character-template:mona"/);
 const choice=b.click('character-template:history:robin');await flush();
 assert.equal(b.characterPending[0].payload.templateId,'history:robin');assert.equal(b.characterPending[0].payload.analysisId,'analysis-template');assert.equal(b.characterPending[0].payload.rating,'all');
 b.characterPending[0].succeed(historyResult());await choice;
 assert.deepEqual(b.editorTags(),['HonkaiStarRail','ロビン(スターレイル)','崩壊スターレイル','女の子']);
 assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);assert.match(b.app.innerHTML,/2 件参考作品/);
 assert.match(b.app.innerHTML,/<details class="tag-adjustments" data-tag-adjustments ><summary>调整标签与角色记忆/);
 assert.equal(b.requests.filter(item=>item.url==='/api/characters/remember').length,0);assert.equal(b.pending.length,1);
});
test('automatic historical template uses the same precise order instead of general game rating character sorting',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);await b.click('new-work');await flush();
 await uploadForTemplate(b,{...historyResult(),accountId:b.state.accounts[0].id,pixivUserId:b.state.accounts[0].pixivUserId,recognition:{title:'Robin',rating:'r18',sexualContent:null},automaticTags:historyRobin.orderedTags.map(tag=>({tag}))});
 assert.deepEqual(b.editorTags(),historyRobin.orderedTags);assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);
 assert.match(b.app.innerHTML,/历史标签格式与顺序/);assert.equal(b.characterPending.length,0);
});
test('choosing a historical role during recognition survives its late unknown identity and uses the finished analysis',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b,null);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await choice;
 b.pending[0].succeed({recognition:{title:'Wrong guess',rating:'r18',sexualContent:null},memoryAnalysisId:'new-analysis',automaticTags:['错误角色','杂项']});await flush();
 assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);assert.equal(b.characterPending.length,2);assert.equal(b.characterPending[1].payload.analysisId,'new-analysis');assert.equal(b.characterPending[1].payload.rating,'r18');
 b.characterPending[1].succeed(historyResult());await flush();assert.deepEqual(b.editorTags(),historyRobin.orderedTags);
 assert.equal(b.editorTags().includes('错误角色'),false);assert.equal(b.requests.filter(item=>item.url==='/api/characters/remember').length,0);
});

test('late image analysis refresh keeps an expanded character search until the user chooses its next role',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin,accountRuanMei]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b,null);
 const firstChoice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await firstChoice;
 await b.click('character-picker-toggle');await b.input({},'阮梅',{id:'character-query'});
 b.pending[0].succeed({recognition:{title:'',rating:'r18',sexualContent:null},memoryAnalysisId:'finished-analysis',automaticTags:[]});await flush();
 assert.equal(b.characterPending.length,2);assert.equal(b.characterPending[1].payload.templateId,historyRobin.id);assert.match(b.app.innerHTML,/id="character-query" value="阮梅"/);assert.match(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);assert.doesNotMatch(b.app.innerHTML,/data-action="character-template:history:robin"/);
 b.characterPending[1].succeed(historyResult());await flush();assert.match(b.app.innerHTML,/id="character-query" value="阮梅"/);assert.match(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);
 const nextChoice=b.click('character-template:account-style:ruanmei');await flush();b.characterPending[2].succeed(historyResult(accountRuanMei));await nextChoice;
 assert.match(b.app.innerHTML,/data-field="title" value="RuanMei"/);assert.doesNotMatch(b.app.innerHTML,/id="character-query"/);await b.click('character-picker-toggle');assert.match(b.app.innerHTML,/id="character-query" value=""/);
});
test('manual tag edits made during a template lookup stay intact and do not get overwritten by the result',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();await b.typeTag('保留这项');b.characterPending[0].succeed(historyResult());await choice;
 assert.deepEqual(b.editorTags(),['保留这项']);assert.match(b.app.innerHTML,/标签已被你修改，保留当前结果/);
});
test('rating change reuses historical placement, respects manually removed template tags and save awaits resolution',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await choice;
 await b.click('remove-tag:3');await b.typeTag('手动标签');await b.change({field:'content.rating'},'r18');await flush();
 assert.deepEqual(b.editorTags(),['HonkaiStarRail','ロビン(スターレイル)','R-18','崩壊スターレイル','手动标签']);
 const save=b.click('save-draft');await flush();assert.equal(b.requests.filter(item=>item.url==='/api/jobs').length,0);
 b.characterPending[1].succeed(historyResult());await save;
 assert.deepEqual(b.requests.findLast(item=>item.url==='/api/jobs').payload.tags,['HonkaiStarRail','ロビン(スターレイル)','R-18','崩壊スターレイル','手动标签']);
});
test('switching accounts reuses the chosen character with only the new account historical format and retains hand added tags',async t=>{
 const b=await browserFixture(t),other={...historyRobin,id:'other-robin',gameTags:['崩坏星穹铁道','崩壊:スターレイル'],orderedTags:['崩坏星穹铁道','崩壊:スターレイル','R-18','ロビン(スターレイル)','女の子']};
 b.setTemplates([historyRobin]);b.setTemplates([other],b.state.accounts[1].id);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await choice;await b.typeTag('手动保留');
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();assert.deepEqual(b.editorTags(),['手动保留']);assert.equal(b.characterPending[1].payload.templateId,'other-robin');
 b.characterPending[1].succeed(historyResult(other));await flush();assert.deepEqual(b.editorTags(),['崩坏星穹铁道','崩壊:スターレイル','ロビン(スターレイル)','女の子','手动保留']);
 b.pending.at(-1).succeed({recognition:{title:'',rating:'all',sexualContent:false}});await flush();b.characterPending.at(-1).succeed(historyResult(other));await flush();
 assert.deepEqual(b.editorTags(),['崩坏星穹铁道','崩壊:スターレイル','ロビン(スターレイル)','女の子','手动保留']);
});
test('late historical role and catalog responses cannot affect a changed account or closed editor',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();await b.change({field:'accountId'},b.state.accounts[1].id);await flush();b.characterPending[0].succeed(historyResult());await choice;
 assert.deepEqual(b.editorTags(),[]);assert.doesNotMatch(b.app.innerHTML,/2 件参考作品/);
 await b.click('close-modal');b.deferTemplateReads();await b.click('new-work');await flush();await b.click('close-modal');b.templatePending[0].succeed({templates:[historyRobin]});await flush();assert.equal(b.hasDialog(),false);
});
test('multiple image or known multiple character inputs cannot apply a single character template',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b,null);
 const choice=b.click('character-template:history:robin');await flush();
 b.pending[0].succeed({recognition:{title:'',rating:'all',perFile:[{multiple:true}]},automaticTags:['複数人']});await flush();b.characterPending[0].succeed(historyResult());await choice;
 assert.equal(b.editorTags().includes('ロビン(スターレイル)'),false);assert.match(b.app.innerHTML,/data-field="title" value=""/);assert.equal(b.actionElement('character-template:history:robin').disabled,true);
});
test('historical aliases preserve exact case and underscores and removing one does not remove its sibling',async t=>{
 const b=await browserFixture(t),template={...historyRobin,gameTags:['HonkaiStarRail','Honkai_Star_Rail'],orderedTags:['HonkaiStarRail','Honkai_Star_Rail','ロビン(スターレイル)','女の子']};
 b.setTemplates([template]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult(template));await choice;assert.deepEqual(b.editorTags(),template.orderedTags);
 await b.click('remove-tag:0');await b.change({field:'content.rating'},'r18');await flush();b.characterPending[1].succeed(historyResult(template));await flush();
 assert.deepEqual(b.editorTags(),['Honkai_Star_Rail','R-18','ロビン(スターレイル)','女の子']);
});
test('template resolution sends only explicitly added scene tags and optional chips follow their historical position',async t=>{
 const b=await browserFixture(t),template={...historyRobin,orderedTags:['HonkaiStarRail','水着','ロビン(スターレイル)','崩壊スターレイル','女の子']};
 b.setTemplates([template]);b.deferCharacterResolves();await b.click('new-work');await flush();
 await uploadForTemplate(b,{recognition:{title:'',rating:'all',sexualContent:false},automaticTags:['おへそ'],candidates:[{tag:'おへそ',tagRole:'scene',modelScore:.75}],memoryAnalysisId:'model-id'});
 const choice=b.click('character-template:history:robin');await flush();assert.deepEqual(b.characterPending[0].payload.sceneTags,[]);
 b.characterPending[0].succeed(historyResult(template,template.orderedTags.filter(tag=>tag!=='水着')));await choice;await b.click('template-optional:0');
 assert.deepEqual(b.editorTags(),template.orderedTags);await b.change({field:'content.rating'},'r18');await flush();assert.deepEqual(b.characterPending[1].payload.sceneTags,['水着']);
 b.characterPending[1].succeed(historyResult(template));await flush();
});
test('a native upload picker prevents late catalog rendering until its selected files are captured',async t=>{
 const b=await browserFixture(t);b.deferTemplateReads();await b.click('new-work');await flush();
 const target={id:'editor-files',closest(selector){return selector==='#editor-drop'?this:null;}};await b.dispatchClick(target);
 const before=b.app.innerHTML;b.templatePending[0].succeed({templates:[historyRobin]});await flush();assert.equal(b.app.innerHTML,before);
 await uploadForTemplate(b);assert.match(b.app.innerHTML,/data-action="character-template:history:robin"/);assert.equal(b.pending.length,1);
});
test('saving a selected template also waits for a newer rating lookup started while save was pending',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();const save=b.click('save-draft');await flush();
 await b.change({field:'content.rating'},'r18');await flush();assert.equal(b.characterPending.length,2);
 b.characterPending[0].succeed(historyResult());await choice;await flush();assert.equal(b.requests.filter(item=>item.url==='/api/jobs').length,0);
 b.characterPending[1].succeed(historyResult());await save;assert.deepEqual(b.requests.findLast(item=>item.url==='/api/jobs').payload.tags,historyRobin.orderedTags);
});
const historyMona={...historyRobin,id:'history:mona',englishName:'Mona',aliases:['莫娜','Mona'],gameTags:['原神'],characterTags:['モナ(原神)'],orderedTags:['原神','モナ(原神)','女の子']};
test('saved template metadata restores ownership so changing a reopened draft character never retains old core tags',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin,historyMona]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await choice;await b.click('remove-tag:3');await b.typeTag('手动保留');await b.click('save-draft');
 const saved=b.state.jobs.find(job=>job.id===b.state.createdJobId);assert.deepEqual(saved.tagTemplate.ownedTags,['HonkaiStarRail','ロビン(スターレイル)','崩壊スターレイル']);assert.deepEqual(saved.tagTemplate.removedTags,['女の子']);
 await b.click('edit:'+saved.id);await flush();assert.match(b.app.innerHTML,/已恢复这份草稿的角色模板/);await b.click('character-picker-toggle');
 const replacement=b.click('character-template:history:mona');await flush();b.characterPending[1].succeed(historyResult(historyMona));await replacement;
 assert.deepEqual(b.editorTags(),['原神','モナ(原神)','女の子','手动保留']);await b.click('save-draft');
 assert.equal(b.requests.findLast(item=>item.method==='PATCH'&&item.url.startsWith('/api/jobs/')).payload.tagTemplate.englishName,'Mona');
});
test('legacy exact core is conservatively recovered while ambiguous legacy tags are replaced in one choice with undo',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin,historyMona]);b.deferCharacterResolves();b.first.title='Robin';b.first.tags=['HonkaiStarRail','ロビン(スターレイル)','崩壊スターレイル','手动保留'];await b.click('refresh');await b.openFirst();await flush();
 assert.match(b.app.innerHTML,/完全一致的游戏与角色标签/);await b.click('character-picker-toggle');const choice=b.click('character-template:history:mona');await flush();b.characterPending[0].succeed(historyResult(historyMona));await choice;assert.deepEqual(b.editorTags(),['原神','モナ(原神)','女の子','手动保留']);
 await b.click('close-modal');b.first.title='旧标题';b.first.tags=['未知游戏','未知角色','手工'];await b.click('refresh');await b.openFirst();await flush();assert.match(b.app.innerHTML,/选择角色会重建整组标签/);
 const replacement=b.click('character-template:history:mona');await flush();b.characterPending[1].succeed(historyResult(historyMona));await replacement;assert.deepEqual(b.editorTags(),['原神','モナ(原神)','女の子']);
 await b.click('template-undo');assert.deepEqual(b.editorTags(),['未知游戏','未知角色','手工']);assert.match(b.app.innerHTML,/data-field="title" value="旧标题"/);
});
test('cross-account same-name templates require a unique matching game or character and never choose the first ambiguous result',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.setTemplates([{...historyRobin,id:'robin-one'},{...historyRobin,id:'robin-two',gameTags:['另一个游戏']}],b.state.accounts[1].id);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await choice;const previous=b.editorTags();
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();assert.equal(b.characterPending.length,1);assert.deepEqual(b.editorTags(),previous);assert.match(b.app.innerHTML,/多个同名角色模板/);
 assert.match(b.app.innerHTML,/data-action="character-template:robin-one"/);assert.match(b.app.innerHTML,/data-action="character-template:robin-two"/);
});
test('a save started before switching accounts never saves an empty or unfinished new-account draft',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();const save=b.click('save-draft');await flush();b.deferTemplateReads();await b.change({field:'accountId'},b.state.accounts[1].id);await flush();
 b.characterPending[0].succeed(historyResult());await choice;await save;assert.equal(b.requests.filter(item=>item.url==='/api/jobs').length,0);assert.match(b.app.innerHTML,/投稿账号已经改变/);
});
test('a late automatic template cannot replace a manually typed character or redirect its pending name lookup',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin,historyMona]);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b,null);await b.change({field:'title'},'Robin');
 b.pending[0].succeed({...historyResult(historyMona),accountId:b.state.accounts[0].id,pixivUserId:b.state.accounts[0].pixivUserId,recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:historyMona.orderedTags});await flush();
 assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);assert.equal(b.characterPending[0].payload.name,'Robin');assert.equal(b.editorTags().includes('モナ(原神)'),false);
 b.characterPending[0].succeed(historyResult());await flush();assert.deepEqual(b.editorTags(),['HonkaiStarRail','ロビン(スターレイル)','崩壊スターレイル','女の子']);
});
test('typing a new character while the switched account catalog loads cancels the old role reapply intent',async t=>{
 const b=await browserFixture(t);b.setTemplates([historyRobin]);b.setTemplates([historyRobin,historyMona],b.state.accounts[1].id);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult());await choice;b.deferTemplateReads();await b.change({field:'accountId'},b.state.accounts[1].id);await flush();await b.change({field:'title'},'Mona');
 b.templatePending[0].succeed();await flush();assert.equal(b.characterPending.length,1);b.pending.at(-1).succeed({recognition:{title:'Robin',rating:'all',sexualContent:false}});await flush();
 assert.equal(b.characterPending.at(-1).payload.name,'Mona');b.characterPending.at(-1).succeed(historyResult(historyMona));await flush();assert.match(b.app.innerHTML,/data-field="title" value="Mona"/);assert.deepEqual(b.editorTags(),historyMona.orderedTags);
});
test('a shared bare character name cannot automatically connect templates from explicitly different games',async t=>{
 const b=await browserFixture(t),source={...historyRobin,gameTags:['HonkaiStarRail'],characterTags:['Robin'],orderedTags:['HonkaiStarRail','Robin','女の子']},other={...source,id:'fire-emblem-robin',gameTags:['FireEmblem'],orderedTags:['FireEmblem','Robin','女の子']};
 b.setTemplates([source]);b.setTemplates([other],b.state.accounts[1].id);b.deferCharacterResolves();await b.click('new-work');await flush();await uploadForTemplate(b);
 const choice=b.click('character-template:history:robin');await flush();b.characterPending[0].succeed(historyResult(source));await choice;
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();assert.equal(b.characterPending.length,1);assert.deepEqual(b.editorTags(),source.orderedTags);assert.match(b.app.innerHTML,/尚无可以唯一对应的角色模板/);assert.match(b.app.innerHTML,/data-action="character-template:fire-emblem-robin"/);
});

test('tab counts follow account and search while exceptional statuses remain separate and reachable', async t => {
 const b=await browserFixture(t);
 const template=b.state.jobs[10];
 b.state.jobs=['draft','queued','reserved','published','uploading','needs_review','failed','cancelled'].map((status,i)=>({...structuredClone(template),id:'status-'+status,title:`Shared ${status}`,status,canDeleteLocally:['draft','queued','cancelled'].includes(status)}));
 b.state.jobs.push({...structuredClone(template),id:'other-account-draft',accountId:b.state.accounts[1].id,status:'draft',title:'Other draft'});
 await b.click('refresh');
 assert.match(b.app.innerHTML,/data-action="filter:draft"[^>]*>待预约<b>2<\/b>/);
 assert.match(b.app.innerHTML,/data-action="filter:reserved"[^>]*>已预约<b>1<\/b>/);
 assert.doesNotMatch(b.app.innerHTML,/data-action="edit:status-uploading"/);
 await b.click('attention');
 for(const status of ['uploading','needs_review','failed'])assert.ok(b.app.innerHTML.includes(`data-action="edit:status-${status}"`));
 assert.doesNotMatch(b.app.innerHTML,/data-action="edit:status-draft"/);
 await b.change({},'cancelled',{id:'status-filter'});assert.match(b.app.innerHTML,/data-action="edit:status-cancelled"/);
 await b.click('filter:draft');await b.change({},b.state.accounts[0].id,{id:'account-filter'});
 assert.match(b.app.innerHTML,/data-action="filter:draft"[^>]*>待预约<b>1<\/b>/);
 await b.search('reserved');
 assert.match(b.app.innerHTML,/data-action="filter:draft"[^>]*>待预约<b>0<\/b>/);
 assert.match(b.app.innerHTML,/data-action="filter:reserved"[^>]*>已预约<b>1<\/b>/);
 assert.match(b.app.innerHTML,/没有找到匹配作品/);
 await b.click('filter:reserved');assert.match(b.app.innerHTML,/data-action="edit:status-reserved"/);
 await b.change({},b.state.accounts[1].id,{id:'account-filter'});
 assert.match(b.app.innerHTML,/data-action="filter:reserved"[^>]*>已预约<b>0<\/b>/);
});

test('bulk deletion confirms exact escaped titles then sends one request and removes only selected local records', async t => {
 const b=await browserFixture(t);
 b.first.title='<script>Robin</script>';await b.click('refresh');await b.click('nav:works');await b.click('filter:queued');
 assert.equal(b.actionElement('delete-selected').disabled,true);
 await b.change({jobCheck:b.first.id},'',{checked:true});await b.change({jobCheck:b.second.id},'',{checked:true});
 await b.click('delete-selected');
 assert.match(b.app.innerHTML,/删除这 2 件作品？/);
 assert.match(b.app.innerHTML,/&lt;script&gt;Robin&lt;\/script&gt;/);
 assert.doesNotMatch(b.app.innerHTML,/<script>Robin/);
 assert.ok(b.app.innerHTML.includes(b.second.title));
 assert.match(b.app.innerHTML,/原始图片、角色记忆和 Pixiv 上的作品都会保留/);
 assert.equal(b.deletePending.length,0);
 await b.click('close-modal');assert.equal(b.deletePending.length,0);
 await b.click('delete-selected');
 const button=b.actionElement('delete-works-confirm'),run=b.dispatchClick(button);await flush();
 assert.equal(b.actionElement('delete-works-confirm').disabled,true);
 await b.dispatchClick(button);assert.equal(b.deletePending.length,1);
 assert.deepEqual(b.deletePending[0].payload,{mode:'live',jobIds:[b.first.id,b.second.id]});
 const before=b.state.jobs.length;b.deletePending[0].succeed();await run;
 assert.equal(b.state.jobs.length,before-2);assert.equal(b.hasDialog(),false);
 assert.equal(b.actionElement('delete-selected').disabled,true);
 assert.match(b.toast.textContent,/已删除 2 件本地作品记录/);
 assert.equal(b.requests.filter(r=>r.url==='/api/jobs/bulk-delete').length,1);
 assert.equal(b.requests.some(r=>r.method==='DELETE'&&r.url.startsWith('/api/jobs/')),false);
});

test('bulk deletion preserves the whole selection on atomic failure and blocks remote or newly changed statuses', async t => {
 const b=await browserFixture(t);await b.click('nav:works');await b.click('filter:queued');
 await b.change({jobCheck:b.first.id},'',{checked:true});await b.change({jobCheck:b.second.id},'',{checked:true});
 await b.click('delete-selected');const count=b.state.jobs.length;
 const run=b.click('delete-works-confirm');await flush();b.deletePending[0].fail('作品状态已变化，本次没有删除任何作品。');await run;
 assert.equal(b.state.jobs.length,count);assert.equal(b.hasDialog(),true);
 assert.match(b.app.innerHTML,/role="alert">作品状态已变化/);
 assert.match(b.app.innerHTML,/已选择 2 件作品/);
 await b.click('close-modal');await b.click('delete-selected');
 b.first.canDeleteLocally=false;b.first.deleteBlockedReason='已提交到 Pixiv，请保留记录。';await b.click('refresh');
 await b.click('delete-works-confirm');assert.equal(b.deletePending.length,1);
 assert.match(b.app.innerHTML,/部分作品状态已经变化/);
 await b.click('close-modal');assert.equal(b.actionElement('delete-selected').disabled,true);
 await b.click('filter:reserved');await b.click('select-page');
 assert.equal(b.actionElement('delete-selected').disabled,true);
 assert.match(b.app.innerHTML,/作品已经提交到 Pixiv/);
});

test('selection clears across filter account query and mode changes and is pruned after refresh', async t => {
 const b=await browserFixture(t);await b.click('nav:works');await b.click('filter:queued');
 const selectFirst=()=>b.change({jobCheck:b.first.id},'',{checked:true});
 const emptySelection=()=>assert.equal(b.actionElement('delete-selected').disabled,true);
 await selectFirst();await b.click('filter:reserved');await b.click('filter:queued');emptySelection();
 await selectFirst();await b.change({},'draft',{id:'status-filter'});await b.click('filter:queued');emptySelection();
 await selectFirst();await b.change({},b.state.accounts[1].id,{id:'account-filter'});await b.change({},'all',{id:'account-filter'});emptySelection();
 await selectFirst();await b.search('next');await b.search('');emptySelection();
 await selectFirst();await b.click('nav:settings');await b.click('switch-demo');await b.click('nav:works');await b.click('filter:queued');emptySelection();
 await selectFirst();b.first.status='reserved';b.first.canDeleteLocally=false;await b.click('refresh');emptySelection();
 assert.doesNotMatch(b.app.innerHTML,new RegExp(`data-job-check="${b.first.id}"`));
});

test('card view supports page selection and deletion remains explicit across pages', async t => {
 const b=await browserFixture(t);await b.click('nav:works');await b.click('filter:queued');await b.click('view-grid');
 await b.click('select-page');assert.match(b.app.innerHTML,/已选择 12 件作品/);
 await b.click('next-page');assert.match(b.app.innerHTML,/已选择 12 件作品/);
 await b.click('select-page');assert.match(b.app.innerHTML,/已选择 20 件作品/);
 await b.click('delete-selected');assert.match(b.app.innerHTML,/删除这 20 件作品？/);
 assert.equal((b.app.innerHTML.match(/<li><strong>/g)||[]).length,20);
 await b.click('close-modal');await b.click('clear-selection');
 assert.equal(b.actionElement('delete-selected').disabled,true);
});

test('reservation retry is offered only for confirmed local failures in list, card and detail views', async t => {
 const b=await browserFixture(t),base={...structuredClone(b.first),status:'failed',uploadOutcome:'not_uploaded',remoteId:undefined,canDeleteLocally:true};
 const cases=[
  ['eligible',{},true],['legacy',{canDeleteLocally:undefined},true],
  ['unknown',{uploadOutcome:undefined},false],['remote',{remoteId:'pixiv-reservation'},false],
  ['conflict',{canDeleteLocally:false},false],['uncertain',{status:'needs_review'},false],['uploading',{status:'uploading'},false],
 ];
 b.state.jobs=cases.map(([id,overrides])=>({...structuredClone(base),id,...overrides}));
 await b.click('refresh');await b.click('nav:works');await b.click('attention');
 const offered=()=>[...b.app.innerHTML.matchAll(/data-action="retry-job:([^"]+)"/g)].map(match=>match[1]).sort();
 assert.deepEqual(offered(),['eligible','legacy']);
 await b.click('view-grid');assert.deepEqual(offered(),['eligible','legacy']);
 await b.click('edit:eligible');await flush();
 assert.match(b.app.innerHTML,/data-action="enqueue"[^>]*>[\s\S]*?重新预约<\/button>/);
 await b.click('close-modal');await b.click('edit:unknown');await flush();
 assert.doesNotMatch(b.app.innerHTML,/data-action="enqueue"/);
 assert.equal(b.requests.some(request=>request.method==='PATCH'),false);
});

test('retrying a future reservation only requeues that work and retains all posting metadata', async t => {
 const b=await browserFixture(t);
 Object.assign(b.first,{status:'failed',uploadOutcome:'not_uploaded',canDeleteLocally:true,scheduledAt:'2026-10-06T00:00:00.000Z',
  title:'Robin',caption:'保留原说明',tags:['HonkaiStarRail','崩壊スターレイル','ロビン(スターレイル)','女の子'],tagsConfirmed:true,
  tagTemplate:{id:'history:robin',accountId:b.first.accountId,englishName:'Robin'},lastError:'时间菜单未能选择。'});
 const original=structuredClone(b.first);
 await b.click('refresh');await b.click('nav:works');await b.click('attention');await b.click(`retry-job:${b.first.id}`);
 const writes=b.requests.filter(request=>request.method!=='GET');
 assert.deepEqual(writes,[{url:`/api/jobs/${b.first.id}`,method:'PATCH',payload:{status:'queued'}}]);
 assert.equal(b.first.status,'queued');
 for(const field of ['accountId','title','caption','tags','tagsConfirmed','files','content','scheduledAt','timezone','tagTemplate'])assert.deepEqual(b.first[field],original[field],field);
 assert.equal(b.requests.some(request=>request.url==='/api/queue/start'),false);
 assert.equal(b.hasDialog(),false);assert.match(b.toast.textContent,/待补位/);assert.match(b.toast.textContent,/开始预约/);
 assert.doesNotMatch(b.app.innerHTML,new RegExp(`data-action="retry-job:${b.first.id}"`));
});

test('expired or missing retry schedules open scheduling without changing the saved work', async t => {
 for(const [scheduledAt,message]of[['2026-10-03T00:00:00.000Z',/原预约时间已过期/],['',/请先设置预约日期与时间/]]){
  const b=await browserFixture(t);
  Object.assign(b.first,{status:'failed',uploadOutcome:'not_uploaded',canDeleteLocally:true,scheduledAt});
  const original=structuredClone(b.first);
  await b.click('refresh');await b.click('nav:works');await b.click('attention');await b.click(`retry-job:${b.first.id}`);await flush();
  assert.equal(b.hasDialog(),true);assert.match(b.app.innerHTML,/data-field="scheduleDate"/);assert.match(b.app.innerHTML,/data-field="scheduleTime"/);
  assert.match(b.app.innerHTML,message);assert.match(b.app.innerHTML,/data-action="enqueue"[^>]*>[\s\S]*?重新预约<\/button>/);
  assert.deepEqual(b.first,original);assert.equal(b.requests.some(request=>request.method==='PATCH'||request.url==='/api/queue/start'),false);
 }
});

test('reservation retry controls stay disabled while a queue run or Pixiv sync is active', async t => {
 const b=await browserFixture(t);Object.assign(b.first,{status:'failed',uploadOutcome:'not_uploaded',canDeleteLocally:true});
 b.state.queueRun={running:true,startedAt:NOW,completedAt:null,source:'automatic'};
 await b.click('refresh');await b.click('nav:works');await b.click('attention');
 assert.equal(b.actionElement(`retry-job:${b.first.id}`).disabled,true);await b.click(`retry-job:${b.first.id}`);
 await b.click(`edit:${b.first.id}`);await flush();assert.equal(b.actionElement('enqueue').disabled,true);
 await b.click('close-modal');b.state.queueRun.running=false;await b.click('nav:overview');await b.click('refresh');
 const syncing=b.click('sync-pixiv');await flush();await b.click('attention');
 assert.equal(b.actionElement(`retry-job:${b.first.id}`).disabled,true);await b.click(`retry-job:${b.first.id}`);
 assert.equal(b.requests.some(request=>request.method==='PATCH'),false);
 b.syncPending[0].succeed();await syncing;assert.equal(b.actionElement(`retry-job:${b.first.id}`).disabled,false);
});

test('dashboard sync prevents duplicate requests, permits navigation and refreshes confirmed state', async t => {
 const b=await browserFixture(t);
 const button=b.actionElement('sync-pixiv');
 const run=b.dispatchClick(button);await flush();
 assert.equal(b.actionElement('sync-pixiv').disabled,true);
 assert.match(b.app.innerHTML,/正在同步…/);
 await b.dispatchClick(button);await flush();
 assert.equal(b.syncPending.length,1);
 await b.click('new-work');await b.change({field:'title'},'Keep unsaved work');
 b.state.accounts[0].remote.total=7;
 b.state.jobs[0].status='published';
 b.syncPending[0].succeed({startedAt:NOW,completedAt:NOW,succeeded:1,failed:0,skipped:0,accounts:[{accountId:b.state.accounts[0].id,name:'Test Account',status:'success',message:'已核对预约列表和作品状态。'}]});
 await run;
 assert.match(b.app.innerHTML,/data-field="title" value="Keep unsaved work"/);
 await b.click('close-modal');
 assert.equal(b.actionElement('sync-pixiv').disabled,false);
 assert.match(b.app.innerHTML,/已占用 7 个名额/);
 const totalRemote=b.state.accounts.reduce((sum,a)=>sum+(a.remote?.total||0),0);
 assert.ok(b.app.innerHTML.includes(`<div class="stat-label">Pixiv 预约中</div><div class="stat-value">${totalRemote}<small>件</small>`),'Dashboard capacity includes reservations created outside this app.');
 assert.match(b.app.innerHTML,/最近同步/);
 assert.match(b.app.innerHTML,/成功 1 个 · 失败 0 个 · 未连接 0 个/);
 assert.match(b.toast.textContent,/已同步 1 个账号/);
 assert.equal(b.requests.some(r=>r.url==='/api/queue/tick'),false);
});

test('start reservations is one explicit action, prevents duplicate starts and leaves navigation available',async t=>{
 const b=await browserFixture(t),button=b.actionElement('start-queue');
 assert.match(b.app.innerHTML,/自动每 6 小时检查；开始预约可立即执行一轮/);
 const starting=b.dispatchClick(button);await flush();
 assert.equal(b.actionElement('start-queue').disabled,true);assert.equal(b.actionElement('sync-pixiv').disabled,true);
 assert.match(b.app.innerHTML,/正在预约…/);assert.equal(b.hasDialog(),false);
 await b.dispatchClick(button);assert.equal(b.queuePending.length,1);
 await b.click('nav:activity');assert.match(b.app.innerHTML,/执行记录/);assert.equal(b.actionElement('start-queue').disabled,true);
 b.queuePending[0].succeed();await starting;
 assert.equal(b.actionElement('start-queue').disabled,true);
 assert.equal(b.requests.filter(request=>request.url==='/api/queue/start').length,1);
 assert.equal(b.requests.some(request=>request.url.includes('browser-posting')),false);
 assert.doesNotMatch(b.toast.textContent,/预约成功/);
});

test('reservation progress polls only local state and reports actual mixed results without overwriting editor input',async t=>{
 const b=await browserFixture(t);const starting=b.click('start-queue');await flush();b.queuePending[0].succeed();await starting;
 const before=b.requests.length;await b.runInterval(60000);assert.equal(b.requests.length,before);
 await b.runInterval(3000);assert.equal(b.requests.at(-1).url,'/api/state');
 await b.click('new-work');await b.change({field:'title'},'Keep this draft');const editor=b.app.innerHTML;
 b.state.queueRun={...b.state.queueRun,running:false,completedAt:NOW,reserved:2,published:1,failed:1,needsReview:1,remaining:3,message:'预约检查完成，有作品需要处理。',errors:[{accountId:b.state.accounts[0].id,message:'<script>需重新连接</script>'}]};
 await b.runInterval(3000);
 assert.equal(b.app.innerHTML,editor,'Polling must not replace the actively edited form DOM.');
 assert.match(b.toast.textContent,/有作品需要处理/);
 await b.click('close-modal');assert.equal(b.actionElement('start-queue').disabled,false);
 assert.match(b.app.innerHTML,/新增预约 2 件 · 确认发布 1 件 · 失败 1 件 · 需核对 1 件 · 仍待补位 3 件/);
 assert.match(b.app.innerHTML,/&lt;script&gt;需重新连接&lt;\/script&gt;/);
 const after=b.requests.length;await b.runInterval(3000);assert.equal(b.requests.length,after);
 assert.equal(b.requests.some(request=>request.url==='/api/queue/tick'||request.url==='/api/pixiv/sync'),false);
});

test('reservation start errors allow retry and completed no-op states never claim successful uploads',async t=>{
 const b=await browserFixture(t);let starting=b.click('start-queue');await flush();b.queuePending[0].fail('连接尚未就绪');await starting;
 assert.match(b.app.innerHTML,/启动结果尚未确认：连接尚未就绪/);assert.equal(b.actionElement('start-queue').disabled,false);
 b.state.settings.queuePaused=true;await b.click('refresh');
 starting=b.click('start-queue');await flush();b.queuePending[1].succeed({running:false,startedAt:NOW,completedAt:NOW,source:'manual',reserved:0,published:0,failed:0,needsReview:0,remaining:20,message:'队列已暂停，本轮未提交预约。',errors:[]});await starting;
 assert.match(b.app.innerHTML,/队列已暂停，本轮未提交预约/);assert.match(b.toast.textContent,/本轮未提交预约/);
 assert.doesNotMatch(b.app.innerHTML,/启动结果尚未确认/);
 starting=b.click('start-queue');await flush();b.queuePending[2].succeed({running:false,startedAt:NOW,completedAt:NOW,source:'manual',reserved:0,published:0,failed:0,needsReview:0,remaining:0,message:'当前没有待补位作品。',errors:[]});await starting;
 assert.match(b.toast.textContent,/当前没有待补位作品/);
});

test('a running reservation round survives page refresh and the live start button is absent in demo',async t=>{
 const b=await browserFixture(t);b.state.queueRun={running:true,startedAt:NOW,source:'automatic',completedAt:null};await b.click('refresh');
 assert.equal(b.actionElement('start-queue').disabled,true);assert.match(b.app.innerHTML,/正在核对发布状态/);
 await b.click('nav:settings');assert.match(b.app.innerHTML,/自动每 6 小时检查/);assert.doesNotMatch(b.app.innerHTML,/每分钟检查/);
 await b.click('switch-demo');await b.click('nav:overview');assert.doesNotMatch(b.app.innerHTML,/data-action="start-queue"/);
 const before=b.requests.length;await b.runInterval(3000);assert.equal(b.requests.length,before);
});

test('calendar entries identify their account independently of status and the account filter keeps matching colors',async t=>{
 const b=await browserFixture(t),[first,second]=b.state.accounts;
 first.name='Example Alpha';first.avatarColor='#8765aa';second.name='Example Beta';second.avatarColor='#d28565';
 b.state.jobs=[{...b.first,id:'calendar-first',accountId:first.id,status:'reserved',title:'Same title',scheduledAt:NOW},{...b.second,id:'calendar-second',accountId:second.id,status:'reserved',title:'Same title',scheduledAt:NOW}];
 await b.click('refresh');await b.click('nav:calendar');
 const events=[...b.app.innerHTML.matchAll(/<button class="calendar-event[\s\S]*?<\/button>/g)].map(match=>match[0]);
 assert.equal(events.length,2);assert.match(events[0],/--account-color:#8765aa/);assert.match(events[0],/Example Alpha/);
 assert.match(events[1],/--account-color:#d28565/);assert.match(events[1],/Example Beta/);assert.match(events[1],/已预约/);
 assert.match(b.app.innerHTML,/aria-label="日历账号图例"/);
 await b.change({},second.id,{id:'account-filter'});
 assert.match(b.app.innerHTML,/data-action="edit:calendar-second"/);assert.doesNotMatch(b.app.innerHTML,/data-action="edit:calendar-first"/);
});

test('accounts sharing the actual default avatar color get stable distinct calendar colors without replacing a unique custom color',async t=>{
 const b=await browserFixture(t),[first,second,third]=b.state.accounts;
 first.avatarColor='#899880';second.avatarColor='#899880';third.avatarColor='#8765aa';
 b.state.jobs=[first,second,third].map((account,index)=>({...b.first,id:'color-event-'+index,accountId:account.id,status:'reserved',title:'Same title',scheduledAt:NOW}));
 const eventColors=()=>Object.fromEntries([...b.app.innerHTML.matchAll(/<button class="calendar-event[^>]*style="--account-color:(#[0-9a-f]{6})" data-action="edit:([^"\s]+)"/g)].map(match=>[match[2],match[1]]));
 await b.click('refresh');await b.click('nav:calendar');const original=eventColors();
 assert.equal(Object.keys(original).length,3);assert.notEqual(original['color-event-0'],original['color-event-1']);
 assert.notEqual(original['color-event-0'],'#899880');assert.notEqual(original['color-event-1'],'#899880');
 assert.equal(original['color-event-2'],'#8765aa');assert.equal(new Set(Object.values(original)).size,3);
 b.state.accounts.reverse();await b.click('refresh');assert.deepEqual(eventColors(),original);
 await b.change({},second.id,{id:'account-filter'});assert.deepEqual(eventColors(),{'color-event-1':original['color-event-1']});
});

test('Pixiv account avatars use approved sources and fall back to initials when an image fails',async t=>{
 const b=await browserFixture(t),first=b.state.accounts[0];first.avatarUrl=`/api/accounts/${first.id}/avatar`;
 await b.click('refresh');await b.click('nav:accounts');
 assert.match(b.app.innerHTML,new RegExp(`data-account-avatar src="/api/accounts/${first.id}/avatar" alt="" referrerpolicy="no-referrer"`));
 assert.match(b.app.innerHTML,/<span class="avatar-lg"[^>]*><span aria-hidden="true">[^<]+<\/span><img/);
 const failedImage={dataset:{accountAvatar:''},hidden:false};await b.imageError(failedImage);assert.equal(failedImage.hidden,true);
 first.avatarUrl='https://malicious.example/avatar.png';await b.click('refresh');assert.doesNotMatch(b.app.innerHTML,/malicious.example/);
 first.avatarUrl='javascript:alert(1)';await b.click('refresh');assert.doesNotMatch(b.app.innerHTML,/javascript:/);
 first.avatarUrl='https://i.pximg.net.example/avatar.png';await b.click('refresh');assert.doesNotMatch(b.app.innerHTML,/i.pximg.net.example/);
});

test('dashboard sync displays partial failures and can retry a failed request', async t => {
 const b=await browserFixture(t);
 let run=b.click('sync-pixiv');await flush();
 b.syncPending[0].fail('Chrome 暂时无法连接');await run;
 assert.match(b.app.innerHTML,/同步未完成：Chrome 暂时无法连接/);
 assert.equal(b.actionElement('sync-pixiv').disabled,false);
 run=b.click('sync-pixiv');await flush();
 b.syncPending[1].succeed({startedAt:NOW,completedAt:NOW,succeeded:1,failed:1,skipped:1,accounts:[
  {accountId:'a',name:'Good',status:'success',message:'预约列表已更新'},
  {accountId:'b',name:'<script>bad</script>',status:'error',message:'请重新连接 Chrome'},
  {accountId:'c',name:'Unbound',status:'skipped',message:'此账号尚未连接 Chrome'},
 ]});await run;
 assert.match(b.app.innerHTML,/成功 1 个 · 失败 1 个 · 未连接 1 个/);
 assert.match(b.app.innerHTML,/请重新连接 Chrome/);
 assert.match(b.app.innerHTML,/&lt;script&gt;bad&lt;\/script&gt;/);
 assert.doesNotMatch(b.app.innerHTML,/Chrome 暂时无法连接/);
 assert.match(b.toast.textContent,/1 个失败/);
});

test('a persisted interrupted sync is shown as incomplete after reloading', async t => {
 const b=await browserFixture(t);
 b.state.pixivSync={startedAt:NOW,completedAt:null,succeeded:0,failed:0,skipped:0,accounts:[]};
 await b.click('refresh');
 assert.match(b.app.innerHTML,/上次同步未完成，请重新同步。/);
 assert.doesNotMatch(b.app.innerHTML,/最近同步/);
 assert.equal(b.actionElement('sync-pixiv').disabled,false);
});

test('demo dashboard disables real Pixiv sync', async t => {
 const b=await browserFixture(t);
 b.state.mode='demo';b.state.settings.demo=true;
 await b.click('refresh');
 assert.equal(b.actionElement('sync-pixiv').disabled,true);
 await b.click('sync-pixiv');
 assert.equal(b.syncPending.length,0);
 assert.doesNotMatch(b.app.innerHTML,/aria-label="Pixiv 同步状态"/);
});

test('pending recognition does not block closing, navigation or pausing the queue', async t => {
  const browser = await browserFixture(t);
  await browser.openFirst();
  const analysisClick = browser.click('suggest-tags');
  await flush(); assert.equal(browser.pending.length, 1);
  await browser.click('close-modal');
  assert.equal(browser.hasDialog(), false, 'Close must work before recognition resolves.');
  await browser.click('nav:settings');
  await browser.click('pause-queue');
  assert.equal(browser.state.settings.queuePaused, true);
  assert.equal(browser.requests.filter(request => request.url === '/api/settings').length, 1);
  const screen = browser.app.innerHTML, previousToast = browser.toast.textContent;
  browser.pending[0].succeed({ candidates: [{ tag: 'OLD_RESULT_SHOULD_BE_DISCARDED', modelScore: .9 }] });
  await analysisClick; await flush();
  assert.equal(browser.hasDialog(), false);
  assert.equal(browser.app.innerHTML, screen, 'A discarded result must not navigate or open a dialog.');
  assert.equal(browser.toast.textContent, previousToast);
});

test('old successful recognition cannot populate or display an error in a new editor', async t => {
  const browser = await browserFixture(t);
  await browser.openFirst();
  const oldRequest = browser.click('suggest-tags'); await flush();
  await browser.click('close-modal'); await browser.click(`edit:${browser.second.id}`); await flush();
  assert.equal(browser.hasDialog(), true);
  assert.ok(browser.app.innerHTML.includes(`value="${browser.second.title}"`));
  const freshEditor = browser.app.innerHTML, previousToast = browser.toast.textContent;
  browser.pending[0].succeed({ candidates: [{ tag: 'OLD_SUCCESS_TAG', modelScore: .8 }], warnings: ['OLD_WARNING'] });
  await oldRequest; await flush();
  assert.equal(browser.app.innerHTML, freshEditor);
  assert.equal(browser.toast.textContent, previousToast);
});

test('old failed recognition cannot overwrite a new editor or show its obsolete error', async t => {
  const browser = await browserFixture(t);
  await browser.openFirst();
  const oldRequest = browser.click('suggest-tags'); await flush();
  await browser.click('close-modal'); await browser.click(`edit:${browser.second.id}`); await flush();
  const freshEditor = browser.app.innerHTML, previousToast = browser.toast.textContent;
  browser.pending[0].fail('OLD_WORKER_ERROR_MUST_NOT_REACH_NEW_EDITOR');
  await oldRequest; await flush();
  assert.equal(browser.app.innerHTML, freshEditor);
  assert.equal(browser.toast.textContent, previousToast);
});

test('two queued clicks in the same editor send only one recognition request', async t => {
  const browser = await browserFixture(t);
  await browser.openFirst();
  // Retain the initial control to cover queued clicks before its disabled redraw.
  const button = browser.actionElement('suggest-tags');
  const firstClick = browser.dispatchClick(button); await flush();
  const secondClick = browser.dispatchClick(button); await flush();
  assert.equal(browser.requests.filter(request => request.url === '/api/tags/suggest').length, 1);
  assert.equal(browser.pending.length, 1);
  browser.pending[0].succeed({ candidates: [{ tag: 'CURRENT_RESULT', modelScore: .8 }], analyzedFiles: [{ id: browser.first.files[0].id }] });
  await Promise.all([firstClick, secondClick]); await flush();
  assert.ok(browser.app.innerHTML.includes('CURRENT_RESULT'), 'The current request must still render normally.');
  assert.equal(browser.hasDialog(), true);
});

test('Chrome discovery binds the existing account and posting requires its own confirmation', async t => {
  const browser = await browserFixture(t, true);
  await browser.click('nav:accounts');
  await browser.click('browser-discover');
  assert.match(browser.app.innerHTML, /绑定此账号/);
  await browser.click('browser-bind:candidate');
  assert.equal(browser.state.accounts[0].browser.postingEnabled, false);
  assert.match(browser.app.innerHTML, /仅连接与同步/);
  assert.equal(browser.requests.filter(r => r.url.endsWith('/browser-posting')).length, 0);
  await browser.click(`browser-posting:${browser.state.accounts[0].id}`);
  assert.match(browser.app.innerHTML, /开启这个账号的真实投稿/);
  assert.equal(browser.requests.filter(r => r.url.endsWith('/browser-posting')).length, 0);
  await browser.click('confirm-action');
  assert.equal(browser.state.accounts[0].browser.postingEnabled, true);
  assert.equal(browser.requests.filter(r => r.url.endsWith('/browser-posting')).length, 1);
});

test('upload automatically analyzes once, fills title/rating and protects edits made while recognition runs', async t=>{
 const b=await browserFixture(t);
 await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'filename-must-not-be-title.png',size:100,type:'image/png'}]});
 await flush();assert.equal(b.pending.length,1);
 assert.ok(!b.app.innerHTML.includes('value="filename-must-not-be-title"'));
 b.pending[0].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false,titleReason:'单角色'}});await flush();
 assert.ok(b.app.innerHTML.includes('data-field="title" value="Mona"'));
 await b.click('editor-tab:options');
 assert.match(b.app.innerHTML,/data-field="content.aiGenerated" value="true" checked/);
 assert.match(b.app.innerHTML,/data-field="content.rating" value="all" checked/);
 assert.doesNotMatch(b.app.innerHTML,/data-field="content.(?:tools|contestTag|imageResponse|allowImageResponse)"/);
 await b.change({},'',{id:'editor-files',files:[{name:'two.png',size:100,type:'image/png'}]});await flush();
 assert.equal(b.pending.length,2);
 await b.change({field:'title'},'My title');
 await b.change({field:'content.rating'},'r18');
 b.pending[1].succeed({recognition:{title:'',rating:'all',sexualContent:false,titleReason:'多图'}});await flush();
 assert.match(b.app.innerHTML,/data-field="content.rating" value="r18" checked/);
 await b.click('editor-tab:basic');assert.match(b.app.innerHTML,/data-field="title" value="My title"/);
});

test('multiple uploads leave auto-title empty; changed images discard old results and analyze the new batch',async t=>{
 const b=await browserFixture(t);await b.click('new-work');
 const file=name=>({name,size:100,type:'image/png'});
 await b.change({},'',{id:'editor-files',files:[file('one.png')]});await flush();
 await b.change({},'',{id:'editor-files',files:[file('two.png')]});await flush();
 assert.equal(b.pending.length,1);
 b.pending[0].succeed({recognition:{title:'Old Name',rating:'all',sexualContent:false}});await flush();
 assert.equal(b.pending.length,2);
 assert.equal(b.pending[1].payload.draft.files.length,2);
 b.pending[1].succeed({recognition:{title:'',rating:'r18',sexualContent:null,titleReason:'多张图片，标题留空'}});await flush();
 assert.match(b.app.innerHTML,/data-field="title" value=""/);
 assert.doesNotMatch(b.app.innerHTML,/value="Old Name"/);
});

test('schedule has separate Japan date/time, Beijing preview and account defaults',async t=>{
 const b=await browserFixture(t);
 b.state.accounts[0].defaultPostingTime='11:00';b.state.accounts[1].defaultPostingTime='09:00';
 await b.click('refresh');await b.click('new-work');await b.click('editor-tab:schedule');
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-05"/);
 assert.match(b.app.innerHTML,/<option value="11:00" selected/);
 assert.match(b.app.innerHTML,/2026-10-05 10:00 · UTC\+8/);
 assert.doesNotMatch(b.app.innerHTML,/data-field="timezone"|datetime-local/);
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();
 assert.match(b.app.innerHTML,/<option value="09:00" selected/);
 await b.change({field:'scheduleTime'},'13:30');
 assert.match(b.app.innerHTML,/2026-10-05 12:30 · UTC\+8/);
 await b.change({field:'accountId'},b.state.accounts[0].id);await flush();
 assert.match(b.app.innerHTML,/<option value="13:30" selected/);
});

test('early morning defaults to the same Japan date with the matching Beijing time',async t=>{
 const b=await browserFixture(t,false,'2026-10-12T17:00:00.000Z');
 b.state.accounts[0].defaultPostingTime='09:00';b.state.accounts[1].defaultPostingTime='11:00';
 await b.click('refresh');await b.click('new-work');await b.click('editor-tab:schedule');
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-13"/);
 assert.match(b.app.innerHTML,/<option value="09:00" selected/);
 assert.match(b.app.innerHTML,/2026-10-13 08:00 · UTC\+8/);
 await b.change({field:'accountId'},b.state.accounts[1].id);
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-13"/);
 assert.match(b.app.innerHTML,/2026-10-13 10:00 · UTC\+8/);
});

test('an open page uses elapsed time when choosing defaults, but preserves a manual date',async t=>{
 const b=await browserFixture(t,false,'2026-10-12T23:59:59.999Z');
 b.state.accounts[0].defaultPostingTime='09:00';b.state.accounts[1].defaultPostingTime='11:00';
 await b.click('refresh');await b.click('new-work');await b.click('editor-tab:schedule');
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-13"/);
 b.advanceTime(1); // No refresh: still-open page must recognize the exact slot boundary.
 await b.change({field:'accountId'},b.state.accounts[1].id);
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-13"/);
 await b.change({field:'accountId'},b.state.accounts[0].id);
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-14"/);
 await b.change({field:'scheduleDate'},'2026-10-20');
 await b.change({field:'accountId'},b.state.accounts[1].id);
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-20"/);
 assert.match(b.app.innerHTML,/<option value="09:00" selected/);
 await b.click('close-modal');await b.click('new-work');await b.click('editor-tab:schedule');
 assert.match(b.app.innerHTML,/data-field="scheduleDate" value="2026-10-14"/);
});


test('upload applies ordered automatic tags without a second click and leaves confirmation unchecked',async t=>{
 const b=await browserFixture(t);await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 b.pending[0].succeed({recognition:{title:'Mona',rating:'r18',sexualContent:null},automaticTags:['原神','R-18','モナ(原神)','水着','おへそ'],candidates:[
  {tag:'原神',tagRole:'game'},{tag:'R-18',tagRole:'rating'},{tag:'モナ(原神)',tagRole:'character'},{tag:'水着',tagRole:'scene'},{tag:'おへそ',tagRole:'scene'},
 ]});await flush();
 assert.deepEqual(b.editorTags(),['原神','R-18','モナ(原神)','水着','おへそ']);
 assert.match(b.app.innerHTML,/data-field="title" value="Mona"/);
 assert.match(b.app.innerHTML,/已自动填写 5 个标签/);
 assert.match(b.app.innerHTML,/data-field="tagsConfirmed"\s*>/);
 assert.equal(b.pending.length,1);
});

test('manual tag edits made during recognition survive automatic results and deliberate reanalysis',async t=>{
 const b=await browserFixture(t);await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 await b.typeTag('手动保留');
 b.pending[0].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:['原神','モナ(原神)']});await flush();
 assert.deepEqual(b.editorTags(),['手动保留']);assert.match(b.app.innerHTML,/已保留你填写的标签/);
 const rerun=b.click('suggest-tags');await flush();
 b.pending[1].succeed({automaticTags:['原神','新标签']});await rerun;
 assert.deepEqual(b.editorTags(),['手动保留']);
});

test('saved tags, title and manually chosen rating are preserved on reanalysis',async t=>{
 const b=await browserFixture(t);await b.openFirst();
 const original=[...b.first.tags],title=b.first.title,rating=b.first.content.rating;
 const run=b.click('suggest-tags');await flush();
 b.pending[0].succeed({recognition:{title:'Different',rating:'r18g',sexualContent:null},automaticTags:['替换标签']});await run;
 assert.deepEqual(b.editorTags(),original);
 assert.ok(b.app.innerHTML.includes(`data-field="title" value="${title}"`));
 await b.click('editor-tab:options');assert.ok(b.app.innerHTML.includes(`data-field="content.rating" value="${rating}" checked`));
});

test('automatic rating tag follows effective manual rating, keeps game first and enforces ten tags',async t=>{
 const b=await browserFixture(t);await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 await b.change({field:'content.rating'},'all');
 const tags=['原神','R-18','モナ(原神)',...Array.from({length:10},(_,i)=>'画面'+i)];
 b.pending[0].succeed({recognition:{title:'Mona',rating:'r18',sexualContent:null},automaticTags:tags,candidates:tags.map(tag=>({tag,tagRole:tag==='原神'?'game':tag==='モナ(原神)'?'character':'scene'}))});await flush();
 assert.equal(b.editorTags().length,10);assert.equal(b.editorTags().includes('R-18'),false);
 assert.deepEqual(b.editorTags().slice(0,2),['原神','モナ(原神)']);
 await b.change({field:'content.rating'},'r18');
 assert.equal(b.editorTags().length,10);assert.deepEqual(b.editorTags().slice(0,3),['原神','R-18','モナ(原神)']);
 await b.change({field:'content.rating'},'r18g');
 assert.deepEqual(b.editorTags().slice(0,3),['原神','R-18G','モナ(原神)']);
 await b.change({field:'content.rating'},'all');assert.equal(b.editorTags().some(tag=>/^R-18/.test(tag)),false);
});

test('new image selection replaces untouched automatic tags and multi-image title stays empty',async t=>{
 const b=await browserFixture(t);await b.click('new-work');const file=name=>({name,size:100,type:'image/png'});
 await b.change({},'',{id:'editor-files',files:[file('one.png')]});await flush();
 b.pending[0].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:['原神','モナ(原神)']});await flush();
 await b.change({},'',{id:'editor-files',files:[file('two.png')]});await flush();
 assert.deepEqual(b.editorTags(),[]);
 b.pending[1].succeed({recognition:{title:'',rating:'all',sexualContent:false},automaticTags:['原神','集合絵']});await flush();
 assert.deepEqual(b.editorTags(),['原神','集合絵']);assert.match(b.app.innerHTML,/data-field="title" value=""/);
 await b.click('file-remove:1');await flush();
 assert.deepEqual(b.editorTags(),[]);
 b.pending[2].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:['原神','モナ(原神)']});await flush();
 assert.deepEqual(b.editorTags(),['原神','モナ(原神)']);
});

test('account changes discard prior automatic results and apply only current-account tags',async t=>{
 const b=await browserFixture(t);await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 await b.change({field:'accountId'},b.state.accounts[1].id);
 b.pending[0].succeed({recognition:{title:'Old title',rating:'all',sexualContent:false},automaticTags:['旧账号标签']});await flush();
 assert.deepEqual(b.editorTags(),[]);assert.equal(b.pending.length,2);
 assert.equal(b.pending[1].payload.draft.accountId,b.state.accounts[1].id);
 b.pending[1].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:['新账号标签']});await flush();
 assert.deepEqual(b.editorTags(),['新账号标签']);assert.doesNotMatch(b.app.innerHTML,/Old title/);
});

test('batch import saves recognized title, rating and ordered tags as an unconfirmed draft',async t=>{
 const b=await browserFixture(t);await b.click('import');
 await b.change({},'',{id:'import-files',files:[{name:'one.png',size:100,type:'image/png'}]});
 const run=b.click('import-save');await flush();assert.equal(b.pending.length,1);
 b.pending[0].succeed({recognition:{title:'Mona',rating:'r18',sexualContent:null},automaticTags:['原神','R-18','モナ(原神)','水着'],candidates:[{tag:'原神',tagRole:'game'}]});await run;
 const saved=b.requests.find(request=>request.url==='/api/jobs').payload;
 assert.equal(saved.title,'Mona');assert.equal(saved.content.rating,'r18');
 assert.deepEqual(saved.tags,['原神','R-18','モナ(原神)','水着']);assert.equal(saved.tagsConfirmed,false);assert.equal(saved.status,'draft');
 assert.equal(b.requests.some(request=>request.url.includes('upload')||request.url==='/api/queue/tick'),false);
});


test('reordering images during automatic recognition keeps one inference and saves the chosen image order',async t=>{
 const b=await browserFixture(t);await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'first.png',size:100,type:'image/png'},{name:'second.png',size:100,type:'image/png'}]});await flush();
 assert.equal(b.pending.length,1);
 const originalOrder=b.pending[0].payload.draft.files.map(file=>file.id);
 await b.click('file-up:1');
 b.pending[0].succeed({recognition:{title:'',rating:'r18',sexualContent:null},automaticTags:['原神','R-18','モナ(原神)','集合絵'],candidates:[{tag:'原神',tagRole:'game'}]});await flush();
 assert.equal(b.pending.length,1,'Moving a preview must not start another image inference.');
 assert.deepEqual(b.editorTags(),['原神','R-18','モナ(原神)','集合絵']);
 assert.match(b.app.innerHTML,/data-field="title" value=""/);
 await b.click('save-draft');
 const saved=b.requests.find(request=>request.url==='/api/jobs').payload;
 assert.deepEqual(saved.files.map(file=>file.id),originalOrder.toReversed());
 assert.equal(saved.content.rating,'r18');assert.equal(saved.title,'');
 assert.deepEqual(saved.tags,['原神','R-18','モナ(原神)','集合絵']);
});

async function unknownCharacterEditor(b,recognition={}) {
 await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'unknown.png',size:100,type:'image/png'}]});await flush();
 b.pending[0].succeed({memoryAnalysisId:'analysis-current',recognition:{title:'',rating:'all',sexualContent:false,perFile:[{multiple:false,single:true}],memory:{candidates:[]},...recognition},automaticTags:[]});await flush();
}

test('editing a title and saving a draft never implicitly remembers a character',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);
 await b.change({field:'title'},'Robin');await b.click('save-draft');
 assert.equal(b.requests.find(request=>request.url==='/api/jobs').payload.title,'Robin');
 assert.equal(b.memoryPending.length,0);assert.equal(b.requests.some(request=>request.url==='/api/characters/remember'),false);
 assert.equal(b.pending.length,1,'One upload still performs one analysis.');
});

test('explicit single-character confirmation remembers only the analyzed image and refreshes its suggestions',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);
 await b.change({field:'title'},'robin');await b.click('memory-open');
 assert.match(b.app.innerHTML,/data-memory-field="englishName" value="robin"/);
 assert.equal(b.actionElement('memory-save').disabled,true);await b.click('memory-save');assert.equal(b.memoryPending.length,0);
 await b.typeMemoryTag('gameTags','HonkaiStarRail, 崩壊:スターレイル');
 await b.typeMemoryTag('characterTags','ロビン(スターレイル)');
 await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 const run=b.click('memory-save');await flush();assert.equal(b.memoryPending.length,1);
 const payload=b.memoryPending[0].payload;assert.equal(payload.mode,'live');assert.equal(payload.analysisId,'analysis-current');
 assert.equal(payload.confirmedSingleCharacter,true);assert.equal(payload.characterId,undefined);
 assert.deepEqual(payload.gameTags,['HonkaiStarRail','崩壊:スターレイル']);assert.equal(payload.draft.files.length,1);
 b.memoryPending[0].succeed();await flush();assert.equal(b.pending.length,2);
 b.pending[1].succeed({memoryAnalysisId:'analysis-remembered',recognition:{title:'Robin',rating:'all',sexualContent:false,perFile:[{multiple:false,single:true}],memory:{exact:{id:'remembered-robin',englishName:'Robin'},candidates:[]}},automaticTags:['HonkaiStarRail','ロビン(スターレイル)']});await run;
 assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);assert.match(b.app.innerHTML,/已按你确认的记忆识别为 Robin/);
 assert.deepEqual(b.editorTags(),['HonkaiStarRail','ロビン(スターレイル)']);
 assert.equal(b.requests.some(request=>request.url==='/api/jobs'),false,'Learning does not save or post a job.');
});

test('saving character memory refreshes the catalog while late catalog and recognition responses preserve newer edits',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'RuanMei');await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});b.deferTemplateReads();
 const saving=b.click('memory-save');await flush();b.memoryPending[0].succeed({id:'ruanmei-memory',englishName:'RuanMei',gameTags:accountRuanMei.gameTags,characterTags:accountRuanMei.characterTags});await flush();
 assert.equal(b.templatePending.length,1,'A successful memory save refreshes the active account catalog.');assert.equal(b.pending.length,2);
 await b.change({field:'title'},'My custom title');await b.typeTag('手动保留');b.templatePending[0].succeed({templates:[accountRuanMei]});await flush();
 assert.match(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);assert.match(b.app.innerHTML,/data-field="title" value="My custom title"/);assert.deepEqual(b.editorTags(),['手动保留']);
 b.pending[1].succeed({recognition:{title:'RuanMei',rating:'all',sexualContent:false},automaticTags:accountRuanMei.orderedTags});await saving;
 assert.match(b.app.innerHTML,/data-field="title" value="My custom title"/);assert.deepEqual(b.editorTags(),['手动保留']);
});

test('a catalog refreshed after memory save cannot leak roles into a different account',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'RuanMei');await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});b.deferTemplateReads();
 const saving=b.click('memory-save');await flush();b.memoryPending[0].succeed({id:'ruanmei-memory',englishName:'RuanMei',gameTags:accountRuanMei.gameTags,characterTags:accountRuanMei.characterTags});await flush();
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();b.templatePending[0].succeed({templates:[accountRuanMei]});await flush();assert.doesNotMatch(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);
 b.templatePending[1].succeed({templates:[]});b.pending[1].succeed({recognition:{title:'RuanMei',rating:'all',sexualContent:false},automaticTags:accountRuanMei.orderedTags});await saving;await flush();assert.doesNotMatch(b.app.innerHTML,/data-action="character-template:account-style:ruanmei"/);
});

test('similar character candidates need explicit confirmation and do not claim a probability',async t=>{
 const b=await browserFixture(t);const candidate={id:'robin-known',englishName:'Robin',gameTags:['HonkaiStarRail'],characterTags:['ロビン(スターレイル)'],sampleCount:2,similarity:.987};
 await unknownCharacterEditor(b,{memory:{candidates:[candidate]}});
 assert.match(b.app.innerHTML,/可能是 Robin/);assert.doesNotMatch(b.app.innerHTML,/98.7|99%/);assert.match(b.app.innerHTML,/data-field="title" value=""/);
 assert.equal(b.actionElement('memory-candidate:0').disabled,true);await b.click('memory-candidate:0');assert.equal(b.memoryPending.length,0);
 await b.change({memoryCandidateConfirm:''},'',{type:'checkbox',checked:true});
 const run=b.click('memory-candidate:0');await flush();assert.equal(b.memoryPending[0].payload.characterId,'robin-known');
 assert.deepEqual(b.memoryPending[0].payload.characterTags,['ロビン(スターレイル)']);
 b.memoryPending[0].succeed();await flush();b.pending[1].succeed({recognition:{title:'Robin',rating:'all',sexualContent:false},automaticTags:[]});await run;
 assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);
});

test('character memory is unavailable for known multiple characters and multiple uploaded images',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b,{perFile:[{multiple:true,single:false}]});
 assert.doesNotMatch(b.app.innerHTML,/data-action="memory-open"/);
 await b.change({},'',{id:'editor-files',files:[{name:'second.png',size:100,type:'image/png'}]});await flush();
 b.pending[1].succeed({memoryAnalysisId:'invalid-multi-result',recognition:{title:'',perFile:[{single:true,multiple:false},{single:true,multiple:false}]}});await flush();
 assert.doesNotMatch(b.app.innerHTML,/data-action="memory-open"/);
});

test('a late memory response cannot fill a replacement image and its queued analysis runs once',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);
 await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 const run=b.click('memory-save');await flush();
 await b.click('file-remove:0');await b.change({},'',{id:'editor-files',files:[{name:'replacement.png',size:100,type:'image/png'}]});await flush();
 assert.equal(b.pending.length,1,'The replacement waits for the existing save to finish.');
 b.memoryPending[0].succeed();await run;await flush();
 assert.equal(b.pending.length,2);assert.equal(b.pending[1].payload.draft.files[0].name,'replacement.png');
 b.pending[1].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:['原神']});await flush();
 assert.match(b.app.innerHTML,/data-field="title" value="Mona"/);assert.doesNotMatch(b.app.innerHTML,/已记住 Robin/);
 assert.equal(b.memoryPending[0].payload.draft.files[0].name,'unknown.png');
});

test('a failed memory write shows a retryable error while preserving manually edited title and tags',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');
 await b.change({memoryField:'englishName'},'Robin');await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 const failed=b.click('memory-save');await flush();b.memoryPending[0].fail('本次识图记录已过期，请重新分析');await failed;
 assert.match(b.app.innerHTML,/本次识图记录已过期，请重新分析/);assert.equal(b.actionElement('memory-save').disabled,false);
 const run=b.click('memory-save');await flush();await b.change({field:'title'},'My custom title');await b.typeTag('手动标签');
 b.memoryPending[1].succeed();await flush();b.pending[1].succeed({recognition:{title:'Robin',rating:'all',sexualContent:false},automaticTags:['新标签']});await run;
 assert.match(b.app.innerHTML,/data-field="title" value="My custom title"/);assert.deepEqual(b.editorTags(),['手动标签']);
});

test('settings loads character memory lazily and explicitly deletes within the current mode',async t=>{
 const b=await browserFixture(t);b.setCharacters([{id:'memory-id',englishName:'Robin',gameTags:['HonkaiStarRail'],characterTags:['ロビン(スターレイル)'],sampleCount:3,updatedAt:NOW}]);
 assert.equal(b.requests.some(request=>request.url==='/api/characters'),false);
 await b.click('nav:settings');await b.click('memory-manage');assert.match(b.app.innerHTML,/已记忆 3 张/);
 await b.click('memory-delete:memory-id');assert.equal(b.requests.some(request=>request.method==='DELETE'),false);
 await b.click('memory-delete-confirm:memory-id');
 assert.equal(b.requests.find(request=>request.method==='DELETE').url,'/api/characters/memory-id?mode=live');
 assert.match(b.app.innerHTML,/还没有角色记忆/);assert.equal(b.requests.some(request=>request.url==='/api/jobs'),false);
});

test('the account tag pool loads on an empty editor and chips add manual tags without starting recognition',async t=>{
 const b=await browserFixture(t);b.setTagPool(['原神','魅惑のふともも','おへそ']);await b.click('new-work');await flush();
 assert.match(b.app.innerHTML,/常用标签池/);assert.match(b.app.innerHTML,/魅惑のふともも/);
 assert.equal(b.requests.filter(request=>request.url.startsWith('/api/tags/pool?')).length,1);
 assert.equal(b.requests.some(request=>request.url==='/api/tags/pool/sync'),false);
 await b.click('tag-pool-tag:1');await b.click('tag-pool-tag:1');
 assert.deepEqual(b.editorTags(),['魅惑のふともも']);assert.equal(b.actionElement('tag-pool-tag:1').disabled,true);
 assert.equal(b.pending.length,0);assert.match(b.app.innerHTML,/data-field="tagsConfirmed"\s*>/);
 for(let i=0;i<9;i++)await b.typeTag('手动'+i);
 await b.click('tag-pool-tag:2');assert.equal(b.editorTags().length,10);assert.match(b.toast.textContent,/最多 10 个标签/);
});

test('pool tag clicks survive late automatic suggestions and the pool survives upload and closed suggestions',async t=>{
 const b=await browserFixture(t);b.setTagPool(['原神','おへそ']);await b.click('new-work');await flush();
 await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 assert.match(b.app.innerHTML,/data-action="tag-pool-tag:1"/);await b.click('tag-pool-tag:1');
 b.pending[0].succeed({recognition:{title:'Mona',rating:'all',sexualContent:false},automaticTags:['原神','モナ(原神)']});await flush();
 assert.deepEqual(b.editorTags(),['おへそ']);assert.match(b.app.innerHTML,/已保留你填写的标签/);
 await b.change({},'local',{id:'tag-provider'});assert.match(b.app.innerHTML,/data-action="tag-pool-tag:1"/);
 assert.equal(b.pending.length,1);
});

test('tag pool sync failure preserves cached chips and a retry refreshes only the same account',async t=>{
 const b=await browserFixture(t);b.setTagPool(['常用旧标签']);await b.click('new-work');await flush();
 const fail=b.click('tag-pool-sync');await flush();assert.equal(b.poolPending[0].payload.mode,'live');
 b.poolPending[0].fail('Chrome 暂时未连接');await fail;
 assert.match(b.app.innerHTML,/Chrome 暂时未连接/);assert.match(b.app.innerHTML,/常用旧标签/);
 assert.equal(b.actionElement('tag-pool-sync').disabled,false);
 const retry=b.click('tag-pool-sync');await flush();b.poolPending[1].succeed({tags:['常用新标签'],checkedAt:NOW,cached:false,source:'pixiv'});await retry;
 assert.match(b.app.innerHTML,/常用新标签/);assert.doesNotMatch(b.app.innerHTML,/Chrome 暂时未连接|常用旧标签/);
 assert.equal(b.pending.length,0);
});

test('account changes drop stale pool reads and sync responses while cached pools remain independent',async t=>{
 const b=await browserFixture(t);b.deferPoolReads();await b.click('new-work');await flush();
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();
 assert.equal(b.poolPending.length,2);b.poolPending[1].succeed({tags:['第二账号标签']});await flush();b.poolPending[0].succeed({tags:['过期第一账号标签']});await flush();
 assert.match(b.app.innerHTML,/第二账号标签/);assert.doesNotMatch(b.app.innerHTML,/过期第一账号标签/);
 const syncing=b.click('tag-pool-sync');await flush();
 await b.change({field:'accountId'},b.state.accounts[0].id);await flush();b.poolPending[3].succeed({tags:['第一账号当前标签']});await flush();
 b.poolPending[2].succeed({tags:['第二账号晚到结果']});await syncing;
 assert.match(b.app.innerHTML,/第一账号当前标签/);assert.doesNotMatch(b.app.innerHTML,/第二账号晚到结果|第二账号标签/);
 assert.equal(b.pending.length,0);
});

test('pool add and remove are explicit local actions and filter retains original chip indices',async t=>{
 const b=await browserFixture(t);b.setTagPool(Array.from({length:35},(_,index)=>`常用${index}`));await b.click('new-work');await flush();
 assert.doesNotMatch(b.app.innerHTML,/data-action="tag-pool-tag:34"/);await b.click('tag-pool-expand');assert.match(b.app.innerHTML,/data-action="tag-pool-tag:34"/);
 await b.poolSearch('常用34');await b.click('tag-pool-tag:34');assert.deepEqual(b.editorTags(),['常用34']);
 await b.typeTag('新增标签');const adding=b.click('tag-pool-add-current');await flush();
 assert.deepEqual(b.poolPending[0].payload.addTags,['常用34','新增标签']);b.poolPending[0].succeed();await adding;
 await b.poolSearch('新增');assert.match(b.app.innerHTML,/data-action="tag-pool-tag:35"/);await b.click('tag-pool-manage');
 const removing=b.click('tag-pool-remove:35');await flush();assert.deepEqual(b.poolPending[1].payload.removeTags,['新增标签']);b.poolPending[1].succeed();await removing;
 assert.doesNotMatch(b.app.innerHTML,/data-action="tag-pool-tag:35"/);assert.deepEqual(b.editorTags(),['常用34','新增标签']);assert.equal(b.pending.length,0);
});

test('a recognition result can refresh the pool but cannot undo a later explicit pool edit',async t=>{
 const b=await browserFixture(t);b.setTagPool(['原神']);await b.click('new-work');await flush();
 await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 const pool={mode:'live',accountId:b.state.accounts[0].id,pixivUserId:b.state.accounts[0].pixivUserId,tags:['原神','おへそ'],checkedAt:NOW};
 b.pending[0].succeed({tagPool:pool,automaticTags:[]});await flush();assert.match(b.app.innerHTML,/data-action="tag-pool-tag:1"/);
 const reanalyze=b.click('suggest-tags');await flush();await b.typeTag('我的标签');const adding=b.click('tag-pool-add-current');await flush();b.poolPending[0].succeed({tags:['原神','我的标签']});await adding;
 b.pending[1].succeed({tagPool:{...pool,tags:['过期标签']},automaticTags:[]});await reanalyze;
 assert.match(b.app.innerHTML,/我的标签/);assert.doesNotMatch(b.app.innerHTML,/过期标签/);
});

test('late pool responses cannot reopen a closed modal or populate a different workspace',async t=>{
 const b=await browserFixture(t);b.deferPoolReads();await b.click('new-work');await flush();await b.click('close-modal');
 b.poolPending[0].succeed({tags:['不应显示']});await flush();assert.equal(b.hasDialog(),false);
 await b.click('new-work');await flush();await b.click('nav:settings');await b.click('switch-demo');await b.click('nav:overview');await b.click('new-work');await flush();
 b.poolPending[2].succeed({tags:['演示常用']});await flush();b.poolPending[1].succeed({tags:['真实晚到']});await flush();
 assert.match(b.app.innerHTML,/演示常用/);assert.doesNotMatch(b.app.innerHTML,/真实晚到/);
});

test('cached Pixiv matches are labeled as saved evidence rather than a fresh lookup',async t=>{
 const b=await browserFixture(t);await b.openFirst();const run=b.click('suggest-tags');await flush();
 b.pending[0].succeed({tagSearch:{source:'pixiv-cache'},candidates:[{tag:'おへそ',preferred:true,source:'pixiv-cache',verified:true,existing:true,freshVerified:false,modelScore:.91}],automaticTags:[]});await run;
 assert.match(b.app.innerHTML,/常用 · 已缓存/);assert.match(b.app.innerHTML,/本次使用此前保存的 Pixiv 标签记录/);
 assert.doesNotMatch(b.app.innerHTML,/已匹配 Pixiv 全站标签；账号常用且相关的标签优先/);
});

test('static mappings remain explicitly unverified in the suggestion interface',async t=>{
 const b=await browserFixture(t);await b.openFirst();const run=b.click('suggest-tags');await flush();
 b.pending[0].succeed({candidates:[{tag:'笑顔',source:'static_mapping',verified:false,existing:false,evidence:[],modelScore:.91}],automaticTags:[]});await run;
 assert.match(b.app.innerHTML,/未核实候选来自静态词表/);
 assert.match(b.app.innerHTML,/未核实/);
 assert.doesNotMatch(b.app.innerHTML,/常用 · 已缓存/);
});

test('pool selection and manual input treat case width spaces and underscores as the same tag',async t=>{
 const b=await browserFixture(t);b.setTagPool(['GenshinImpact','HonkaiStarRail']);await b.click('new-work');await flush();
 const queuedPoolClick=b.actionElement('tag-pool-tag:0');
 await b.typeTag('ｇｅｎｓｈｉｎ_ｉｍｐａｃｔ');assert.equal(b.actionElement('tag-pool-tag:0').disabled,true);
 await b.dispatchClick(queuedPoolClick);assert.deepEqual(b.editorTags(),['ｇｅｎｓｈｉｎ_ｉｍｐａｃｔ']);
 await b.typeTag('Genshin Impact');assert.deepEqual(b.editorTags(),['ｇｅｎｓｈｉｎ_ｉｍｐａｃｔ']);assert.equal(b.toast.textContent,'这个标签已经添加。');
 await b.click('tag-pool-tag:1');await b.typeTag('honkai_star_rail');
 assert.deepEqual(b.editorTags(),['ｇｅｎｓｈｉｎ_ｉｍｐａｃｔ','HonkaiStarRail']);assert.equal(b.pending.length,0);
});

const robinResolution={status:'resolved',gameTags:['HonkaiStarRail','崩壊スターレイル'],characterTags:['ロビン(スターレイル)'],tags:['HonkaiStarRail','崩壊スターレイル','ロビン(スターレイル)'],source:'pixiv-cache'};

test('a manually typed character name is debounced once and prepends game then character without another image analysis',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);
 await b.typeTag('R-18');await b.typeTag('おへそ');
 await b.input({field:'title'},'R');await b.input({field:'title'},'Rob');await b.input({field:'title'},'Robin');
 assert.equal(b.characterPending.length,0);await b.runNameTimers();assert.equal(b.characterPending.length,1);
 assert.equal(b.characterPending[0].payload.name,'Robin');await b.change({field:'title'},'Robin');assert.equal(b.characterPending.length,1);
 b.characterPending[0].succeed(robinResolution);await flush();
 assert.deepEqual(b.editorTags(),['HonkaiStarRail','崩壊スターレイル','ロビン(スターレイル)','R-18','おへそ']);
 assert.match(b.app.innerHTML,/data-field="tagsConfirmed"\s*>/);assert.match(b.app.innerHTML,/data-field="title" value="Robin"/);
 assert.equal(b.pending.length,1);assert.equal(b.memoryPending.length,0);
 await b.click('editor-tab:options');assert.match(b.app.innerHTML,/data-field="content.rating" value="all" checked/);
});

test('changing a resolved character replaces only its inserted core tags and preserves other tags',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.typeTag('手动保留');
 await b.change({field:'title'},'Robin');b.characterPending[0].succeed(robinResolution);await flush();
 await b.change({field:'title'},'Mona');b.characterPending[1].succeed({status:'resolved',gameTags:['GenshinImpact','原神'],characterTags:['モナ(原神)']});await flush();
 assert.deepEqual(b.editorTags(),['GenshinImpact','原神','モナ(原神)','手动保留']);
 assert.equal(b.pending.length,1);assert.equal(b.memoryPending.length,0);
});

test('character core insertion deduplicates equivalent names and retains age tags within the ten tag limit',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);
 await b.typeTag('honkai_star_rail');for(let index=0;index<8;index++)await b.typeTag('场景'+index);await b.typeTag('R-18');
 await b.change({field:'title'},'Robin');b.characterPending[0].succeed(robinResolution);await flush();
 assert.equal(b.editorTags().length,10);assert.deepEqual(b.editorTags().slice(0,3),robinResolution.tags);assert.equal(b.editorTags().at(-1),'R-18');
 assert.equal(b.editorTags().filter(tag=>/honkai/i.test(tag)).length,1);assert.match(b.app.innerHTML,/已保留分级并缩减末尾画面标签/);
});

test('manual edits while a name lookup is pending are protected and retry uses the updated tags',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);
 await b.change({field:'title'},'Robin');await b.typeTag('手动保留');b.characterPending[0].succeed(robinResolution);await flush();
 assert.deepEqual(b.editorTags(),['手动保留']);assert.match(b.app.innerHTML,/已保留你的修改/);
 await b.click('character-resolve:title');b.characterPending[1].succeed(robinResolution);await flush();
 assert.deepEqual(b.editorTags(),[...robinResolution.tags,'手动保留']);assert.equal(b.pending.length,1);
});

test('a late character result cannot apply after the name account image or modal changes',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);
 await b.change({field:'title'},'Robin');await b.change({field:'title'},'Mona');
 b.characterPending[0].succeed(robinResolution);await flush();assert.deepEqual(b.editorTags(),[]);
 await b.change({field:'accountId'},b.state.accounts[1].id);await flush();b.characterPending[1].succeed({status:'resolved',gameTags:['原神'],characterTags:['モナ(原神)']});await flush();assert.deepEqual(b.editorTags(),[]);
 b.pending[1].succeed({recognition:{title:'',rating:'all',perFile:[{single:true,multiple:false}]},automaticTags:[]});await flush();
 await b.change({field:'title'},'Robin');await b.click('file-remove:0');b.characterPending[2].succeed(robinResolution);await flush();assert.deepEqual(b.editorTags(),[]);
 await b.change({},'',{id:'editor-files',files:[{name:'next.png',size:100,type:'image/png'}]});await flush();b.pending[2].succeed({recognition:{title:'',perFile:[{single:true,multiple:false}]},automaticTags:[]});await flush();
 await b.change({field:'title'},'Robin');await b.click('close-modal');b.characterPending[3].succeed(robinResolution);await flush();assert.equal(b.hasDialog(),false);
});

test('memory name matching fills untouched fields and never saves a memory implicitly',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.click('memory-open');
 await b.change({memoryField:'englishName'},'Robin');await b.typeMemoryTag('gameTags','我的游戏标签');
 b.characterPending[0].succeed(robinResolution);await flush();
 assert.deepEqual(b.memoryTags('gameTags'),['我的游戏标签']);assert.deepEqual(b.memoryTags('characterTags'),['ロビン(スターレイル)']);
 assert.deepEqual(b.editorTags(),robinResolution.tags);assert.equal(b.memoryPending.length,0);assert.equal(b.actionElement('memory-save').disabled,true);
 await b.change({memoryField:'englishName'},'Mona');b.characterPending[1].succeed({status:'resolved',gameTags:['原神'],characterTags:['モナ(原神)']});await flush();
 assert.deepEqual(b.memoryTags('gameTags'),['我的游戏标签']);assert.deepEqual(b.memoryTags('characterTags'),['モナ(原神)']);
 assert.deepEqual(b.editorTags(),['原神','モナ(原神)']);assert.equal(b.pending.length,1);
});

test('ambiguous and unknown character names show guidance without guessing tags',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.typeTag('手动保留');
 await b.change({field:'title'},'Robin');b.characterPending[0].succeed({status:'ambiguous',message:'同名角色不止一个，请填写完整名称'});await flush();
 assert.deepEqual(b.editorTags(),['手动保留']);assert.match(b.app.innerHTML,/同名角色不止一个/);
 await b.change({field:'title'},'Unknown');b.characterPending[1].succeed();await flush();assert.deepEqual(b.editorTags(),['手动保留']);assert.match(b.app.innerHTML,/未找到明确角色/);
 await b.click('character-resolve:title');b.characterPending[2].fail('暂时无法读取');await flush();assert.match(b.app.innerHTML,/角色标签匹配未完成：暂时无法读取/);
});

test('automatic titles do not trigger name lookup and a manually typed name waits for image analysis',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await b.click('new-work');
 await b.change({},'',{id:'editor-files',files:[{name:'first.png',size:100,type:'image/png'}]});await flush();
 await b.change({field:'title'},'Robin');assert.equal(b.characterPending.length,0);
 b.pending[0].succeed({recognition:{title:'',rating:'all',perFile:[{multiple:false,single:true}]},automaticTags:[]});await flush();assert.equal(b.characterPending.length,1);
 b.characterPending[0].succeed(robinResolution);await flush();
 await b.click('close-modal');await b.click('new-work');await b.change({},'',{id:'editor-files',files:[{name:'second.png',size:100,type:'image/png'}]});await flush();
 b.pending[1].succeed({recognition:{title:'Mona',rating:'all',perFile:[{multiple:false,single:true}]},automaticTags:['原神']});await flush();await b.runNameTimers();assert.equal(b.characterPending.length,1);
});

test('known multiple characters and multiple uploaded images do not resolve a manual title',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b,{perFile:[{multiple:true,single:false}]});
 await b.change({field:'title'},'Robin');await b.runNameTimers();assert.equal(b.characterPending.length,0);
 await b.change({},'',{id:'editor-files',files:[{name:'second.png',size:100,type:'image/png'}]});await flush();b.pending[1].succeed({recognition:{title:'',perFile:[{multiple:false,single:true},{multiple:false,single:true}]},automaticTags:[]});await flush();
 await b.change({field:'title'},'Robin');await b.runNameTimers();assert.equal(b.characterPending.length,0);
});

test('saving during the typing delay flushes and awaits character matching before sending the draft',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.input({field:'title'},'Robin');
 const saving=b.click('save-draft');await flush();assert.equal(b.characterPending.length,1);assert.equal(b.requests.some(request=>request.url==='/api/jobs'),false);
 b.characterPending[0].succeed(robinResolution);await saving;
 const saved=b.requests.find(request=>request.url==='/api/jobs').payload;assert.equal(saved.title,'Robin');assert.deepEqual(saved.tags,robinResolution.tags);assert.equal(saved.tagsConfirmed,false);
 assert.equal(b.memoryPending.length,0);
});

test('enqueue waits for a running lookup and carries the resolved tags without silently confirming them',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.change({field:'title'},'Robin');
 const saving=b.click('enqueue');await flush();assert.equal(b.characterPending.length,1);assert.equal(b.requests.some(request=>request.url==='/api/jobs'),false);
 b.characterPending[0].succeed(robinResolution);await saving;const saved=b.requests.find(request=>request.url==='/api/jobs').payload;
 assert.deepEqual(saved.tags,robinResolution.tags);assert.equal(saved.status,'queued');assert.equal(saved.tagsConfirmed,false);
});

test('changing a resolved name to unknown or blank removes only automatically inserted identity tags',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.typeTag('HonkaiStarRail');await b.typeTag('おへそ');
 await b.change({field:'title'},'Robin');b.characterPending[0].succeed(robinResolution);await flush();
 await b.change({field:'title'},'Unknown');assert.deepEqual(b.editorTags(),['HonkaiStarRail','おへそ']);b.characterPending[1].succeed();await flush();assert.deepEqual(b.editorTags(),['HonkaiStarRail','おへそ']);
 await b.change({field:'title'},'Robin');b.characterPending[2].succeed(robinResolution);await flush();await b.input({field:'title'},'');
 assert.deepEqual(b.editorTags(),['HonkaiStarRail','おへそ']);assert.match(b.app.innerHTML,/data-field="tagsConfirmed"\s*>/);
});

test('unknown replacement in memory clears automatically filled identity fields and revokes confirmation',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.click('memory-open');
 await b.change({memoryField:'englishName'},'Robin');b.characterPending[0].succeed(robinResolution);await flush();await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 await b.change({memoryField:'englishName'},'Unknown');b.characterPending[1].succeed();await flush();
 assert.deepEqual(b.memoryTags('gameTags'),[]);assert.deepEqual(b.memoryTags('characterTags'),[]);
 assert.equal(b.actionElement('memory-save').disabled,true);assert.deepEqual(b.editorTags(),[]);assert.equal(b.memoryPending.length,0);
});

test('the newest manually edited character source supersedes a pending lookup from the other input',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.change({field:'title'},'Robin');await b.click('memory-open');
 await b.change({memoryField:'englishName'},'Mona');b.characterPending[0].succeed(robinResolution);await flush();assert.deepEqual(b.editorTags(),[]);
 b.characterPending[1].succeed({status:'resolved',gameTags:['原神'],characterTags:['モナ(原神)']});await flush();assert.deepEqual(b.editorTags(),['原神','モナ(原神)']);
});

test('correcting an automatically recognized character removes its automatic identity tags but retains scene tags',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await b.click('new-work');await b.change({},'',{id:'editor-files',files:[{name:'one.png',size:100,type:'image/png'}]});await flush();
 b.pending[0].succeed({recognition:{title:'Mona',rating:'r18',perFile:[{multiple:false,single:true}]},automaticTags:['原神','R-18','モナ(原神)','おへそ'],candidates:[{tag:'原神',tagRole:'game'},{tag:'モナ(原神)',tagRole:'character'},{tag:'おへそ',tagRole:'scene'}]});await flush();
 await b.change({field:'title'},'Robin');b.characterPending[0].succeed(robinResolution);await flush();assert.deepEqual(b.editorTags(),[...robinResolution.tags,'R-18','おへそ']);
 await b.change({field:'content.rating'},'r18g');await b.click('editor-tab:basic');assert.deepEqual(b.editorTags(),[...robinResolution.tags,'R-18G','おへそ']);
});

test('resolved identity aliases appear as separate memory chips in both tag fields',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 b.characterPending[0].succeed(robinResolution);await flush();
 assert.deepEqual(b.memoryTags('gameTags'),['HonkaiStarRail','崩壊スターレイル']);assert.deepEqual(b.memoryTags('characterTags'),['ロビン(スターレイル)']);
 assert.equal(b.pendingMemoryTag('gameTags'),'');assert.equal(b.pendingMemoryTag('characterTags'),'');assert.equal(b.memoryPending.length,0);
});

test('memory chips accept multi-tag paste, normalize duplicate aliases and revoke confirmation on edits',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');
 await b.typeMemoryTag('gameTags','GenshinImpact，原神、Genshin_Impact\nＧＥＮＳＨＩＮＩＭＰＡＣＴ');
 assert.deepEqual(b.memoryTags('gameTags'),['GenshinImpact','原神']);
 await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});assert.equal(b.actionElement('memory-save').disabled,false);
 await b.inputMemoryTag('characterTags','モナ(原神),Mona');assert.equal(b.actionElement('memory-save').disabled,true);
 await b.click('memory-tag-add:characterTags');assert.deepEqual(b.memoryTags('characterTags'),['モナ(原神)','Mona']);
 await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});await b.click('memory-tag-remove:gameTags:0');
 assert.deepEqual(b.memoryTags('gameTags'),['原神']);assert.deepEqual(b.memoryTags('characterTags'),['モナ(原神)','Mona']);assert.equal(b.actionElement('memory-save').disabled,true);
});

test('memory chip validation keeps the existing chips and pending input instead of truncating',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');
 await b.typeMemoryTag('gameTags','一,二,三,四');assert.deepEqual(b.memoryTags('gameTags'),['一','二','三','四']);
 await b.typeMemoryTag('gameTags','五');assert.deepEqual(b.memoryTags('gameTags'),['一','二','三','四']);assert.equal(b.pendingMemoryTag('gameTags'),'五');assert.match(b.app.innerHTML,/4/);
 await b.inputMemoryTag('gameTags','Honkai Star Rail');await b.click('memory-tag-add:gameTags');
 assert.deepEqual(b.memoryTags('gameTags'),['一','二','三','四']);assert.equal(b.pendingMemoryTag('gameTags'),'Honkai Star Rail');assert.equal(b.memoryPending.length,0);
 await b.click('memory-tag-remove:gameTags:3');await b.inputMemoryTag('gameTags','');await b.typeMemoryTag('gameTags','五');
 assert.deepEqual(b.memoryTags('gameTags'),['一','二','三','五']);
});

test('confirming and saving flushes both pending memory tag inputs into array payloads',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 await b.inputMemoryTag('gameTags','HonkaiStarRail,崩壊スターレイル');await b.inputMemoryTag('characterTags','ロビン(スターレイル)');
 await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});const saving=b.click('memory-save');await flush();
 assert.equal(b.memoryPending.length,1);assert.deepEqual(b.memoryPending[0].payload.gameTags,['HonkaiStarRail','崩壊スターレイル']);assert.deepEqual(b.memoryPending[0].payload.characterTags,['ロビン(スターレイル)']);
 assert.equal(b.memoryPending[0].payload.confirmedSingleCharacter,true);b.memoryPending[0].succeed();await flush();b.pending[1].succeed({recognition:{title:'Robin',rating:'all'},automaticTags:[]});await saving;
});

test('invalid pending memory tags stop save and preserve the unsaved name and inputs',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 await b.inputMemoryTag('gameTags','一,二,三,四,五');await b.inputMemoryTag('characterTags','ロビン(スターレイル)');await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 await b.click('memory-save');assert.equal(b.memoryPending.length,0);assert.equal(b.pendingMemoryTag('gameTags'),'一,二,三,四,五');assert.equal(b.pendingMemoryTag('characterTags'),'ロビン(スターレイル)');
 assert.match(b.app.innerHTML,/data-memory-field="englishName" value="Robin"/);assert.equal(b.pending.length,1);
});

test('typing an uncommitted memory tag protects that field against late automatic identity results',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 await b.inputMemoryTag('gameTags','我的待填游戏');b.characterPending[0].succeed(robinResolution);await flush();
 assert.deepEqual(b.memoryTags('gameTags'),[]);assert.equal(b.pendingMemoryTag('gameTags'),'我的待填游戏');assert.deepEqual(b.memoryTags('characterTags'),['ロビン(スターレイル)']);
 await b.pressMemoryEnter('gameTags');assert.deepEqual(b.memoryTags('gameTags'),['我的待填游戏']);assert.equal(b.memoryPending.length,0);
});

test('Enter while composing a memory tag does not create a chip or submit memory',async t=>{
 const b=await browserFixture(t);await unknownCharacterEditor(b);await b.click('memory-open');await b.inputMemoryTag('gameTags','原神');
 await b.pressMemoryEnter('gameTags',true);assert.deepEqual(b.memoryTags('gameTags'),[]);assert.equal(b.memoryPending.length,0);
 await b.pressMemoryEnter('gameTags',false);assert.deepEqual(b.memoryTags('gameTags'),['原神']);assert.equal(b.memoryPending.length,0);
 await b.typeMemoryTag('gameTags',' Honkai Star Rail ');assert.deepEqual(b.memoryTags('gameTags'),['原神','Honkai Star Rail']);
});

test('a late name result waits to redraw until composition ends and Escape keeps the memory editor open',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 await b.composeMemoryTag('gameTags','compositionstart');await b.inputMemoryTag('gameTags','yuan');const composingHtml=b.app.innerHTML;
 b.characterPending[0].succeed(robinResolution);await flush();
 assert.equal(b.app.innerHTML,composingHtml,'A late automatic match must not replace the input DOM while IME is composing.');
 await b.pressMemoryKey('gameTags','Escape');await b.pressMemoryEnter('gameTags');assert.equal(b.hasDialog(),true);assert.deepEqual(b.memoryTags('gameTags'),[]);
 await b.composeMemoryTag('gameTags','compositionend','原神');
 assert.equal(b.pendingMemoryTag('gameTags'),'原神');assert.deepEqual(b.memoryTags('characterTags'),['ロビン(スターレイル)']);assert.deepEqual(b.memoryTags('gameTags'),[]);
 await b.pressMemoryEnter('gameTags');assert.deepEqual(b.memoryTags('gameTags'),['原神']);assert.equal(b.memoryPending.length,0);
});

test('memory save includes text entered and reconfirmed while it waits for character matching',async t=>{
 const b=await browserFixture(t);b.deferCharacterResolves();await unknownCharacterEditor(b);await b.click('memory-open');await b.change({memoryField:'englishName'},'Robin');
 await b.inputMemoryTag('gameTags','HonkaiStarRail');await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 const saving=b.click('memory-save');await flush();assert.equal(b.memoryPending.length,0);
 await b.inputMemoryTag('gameTags','崩壊スターレイル');await b.inputMemoryTag('characterTags','ロビン(スターレイル)');await b.change({memoryField:'confirmedSingleCharacter'},'',{type:'checkbox',checked:true});
 b.characterPending[0].succeed(robinResolution);await flush();
 assert.equal(b.memoryPending.length,1);assert.deepEqual(b.memoryPending[0].payload.gameTags,['HonkaiStarRail','崩壊スターレイル']);assert.deepEqual(b.memoryPending[0].payload.characterTags,['ロビン(スターレイル)']);assert.equal(b.memoryPending[0].payload.confirmedSingleCharacter,true);
 b.memoryPending[0].succeed();await flush();b.pending[1].succeed({recognition:{title:'Robin',rating:'all'},automaticTags:[]});await saving;
});
