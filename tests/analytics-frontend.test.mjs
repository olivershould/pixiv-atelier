import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createDemoState} from '../server/seed.mjs';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const NOW='2026-10-15T04:00:00.000Z';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function report(overrides={}){
 return {generatedAt:NOW,summary:{workCount:3,sampledWorkCount:1,missingWorkCount:2,lateWorkCount:1},rows:[
  {id:'123',artworkId:'123',name:'Example work',accountId:'demo-main',publishedAt:'2026-10-15T01:00:00Z',observedAt:NOW,targetAt:'2026-10-15T03:30:00Z',latenessMs:1800000,lateCount:1,status:'recorded',workCount:1,sampleCount:1,missingCount:0,total:1200,average:1200,growth:4.25,metrics:{views:1200,bookmarks:300,likes:150,bookmarkRate:.25},growthMetrics:{views:4.25,bookmarks:2,likes:1},growthEligible:true,baselineAt:'2026-10-15T01:00:00Z',intervalHours:3},
  {id:'124',name:'Missing work',accountId:'demo-main',status:'missing',total:null,average:null,growth:null,targetAt:'2026-10-15T03:00:00Z'},
  {id:'125',name:'Pending work',accountId:'demo-main',status:'pending',total:null,average:null,growth:null,targetAt:'2026-10-15T09:00:00Z'},
 ],accounts:[],pagination:{total:3,offset:0,limit:25},...overrides};
}
async function fixture({timezone}={}){
 let state={...createDemoState(new Date(NOW)),mode:'live',now:NOW,connectorConfigured:true};
 state.settings={...state.settings,mode:'live',demo:false,...(timezone?{timezone}:{})};
 let response=report(),status={running:false,completedAt:NOW,nextRegularAt:'2026-10-15T10:00:00Z',errors:[]},deferReports=false,collectError='',reportError='';
 const requests=[],pending=[],handlers=new Map(),timers=new Map(),intervals=new Map();let timerId=0;
 let html='',rankingScroll=null;
 const app={get innerHTML(){return html;},set innerHTML(value){html=value;rankingScroll=/<section class="panel analytics-ranking/.test(value)?{scrollLeft:0}:null;},addEventListener(type,callback){const list=handlers.get(type)||[];list.push(callback);handlers.set(type,list);}};
 const toast={textContent:'',classList:{add(){},remove(){}}};
 const document={querySelector(selector){return selector==='#app'?app:selector==='#toast'?toast:selector==='.analytics-ranking .analytics-table-scroll'?rankingScroll:null;},querySelectorAll(){return [];}};
 const http=(data,ok=true)=>({ok,json:async()=>structuredClone(data)});
 const fetch=async(url,options={})=>{
  const payload=options.body?JSON.parse(options.body):undefined;requests.push({url,method:options.method||'GET',payload});
  if(url==='/api/state')return http(state);
  if(url==='/api/mode'){state.mode=payload.mode;state.settings.mode=payload.mode;return http(state);}
  if(url==='/api/analytics/status')return http(status);
  if(url==='/api/analytics/collect'){if(collectError)return http({error:collectError},false);status={...status,running:true,completedAt:null};return http(status);}
  if(url.startsWith('/api/analytics?')){
   if(reportError)return http({error:reportError},false);
   if(deferReports)return new Promise(resolve=>pending.push({resolve:value=>resolve(http(value))}));
   return http(response);
  }
  throw new Error('Unexpected request '+url);
 };
 const context=vm.createContext({document,fetch,structuredClone,URL,Blob,Date,console,setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);},setInterval(callback,delay){intervals.set(delay,callback);return delay;},clearInterval(delay){intervals.delete(delay);}});
 await vm.runInContext(`(async()=>{${source}\n})()`,context);
 const click=async action=>{
  const tag=[...app.innerHTML.matchAll(/<button\b[^>]*>/g)].map(match=>match[0]).find(tag=>tag.includes(`data-action="${action}"`));assert.ok(tag,'Rendered button '+action);
  const target={dataset:{action},disabled:/\sdisabled(?:\s|>|=)/.test(tag),closest(selector){return selector==='[data-action]'?this:null;}};
  await Promise.all((handlers.get('click')||[]).map(callback=>callback({target,preventDefault(){}})));
 };
 const filter=(field,value)=>Promise.all((handlers.get('change')||[]).map(callback=>callback({target:{dataset:{analyticsFilter:field},value,type:'select-one'}})));
 return {app,toast,requests,pending,click,filter,get state(){return state;},get rankingScroll(){return rankingScroll;},setReport(value){response=value;},setStatus(value){status=value;},deferReports(value=true){deferReports=value;},failCollect(message){collectError=message;},failReport(message){reportError=message;},
  async interval(delay){await intervals.get(delay)?.();await flush();},
  async imageError(target){for(const callback of handlers.get('error')||[])await callback({target});},
  async input(value){for(const callback of handlers.get('input')||[])await callback({target:{id:'analytics-query',value,dataset:{}}});},
  async compose(type,value){for(const callback of handlers.get(type)||[])await callback({target:{id:'analytics-query',value,dataset:{}}});},
  async runSearchTimer(){for(const [id,timer]of timers){if(timer.delay===300){timers.delete(id);timer.callback();}}await flush();},
  async search(value){await this.input(value);await this.runSearchTimer();},
 };
}

test('statistics opens on demand, distinguishes missing and late samples, and links only Pixiv artworks',async()=>{
 const b=await fixture();assert.equal(b.requests.some(r=>r.url.startsWith('/api/analytics')),false);
 await b.click('nav:analytics');await b.filter('point','6h');
 assert.match(b.app.innerHTML,/数据统计/);assert.match(b.app.innerHTML,/href="https:\/\/www.pixiv.net\/artworks\/123"/);
 assert.match(b.app.innerHTML,/1,200/);assert.match(b.app.innerHTML,/4.25/);assert.match(b.app.innerHTML,/迟到采样 · 0.5 小时/);
 assert.match(b.app.innerHTML,/缺少该时间点记录/);assert.match(b.app.innerHTML,/尚未到采样时间/);
 const missing=b.app.innerHTML.match(/<tr><td class="analytics-rank">2<\/td>[\s\S]*?<\/tr>/)?.[0];
 assert.equal((missing.match(/class="analytics-value">—/g)||[]).length,3);assert.match(missing,/class="analytics-value analytics-ratio">—/);
 assert.match(b.app.innerHTML,/发布至采样 3 小时/);assert.match(b.app.innerHTML,/统计账号/);
 assert.match(b.app.innerHTML,/发布 2026年10月15日 09:00/);
});

test('all filters reach the report endpoint and group rankings expose effective denominators',async()=>{
 const b=await fixture();await b.click('nav:analytics');
 b.setReport(report({rows:[{id:'char:sample',name:'Example character',workCount:10,sampleCount:4,missingCount:6,growthSampleCount:3,total:400,average:100,growth:2.25,metrics:{views:400,bookmarks:200,likes:80,bookmarkRate:.5},averageMetrics:{views:100,bookmarks:50,likes:20},growthMetrics:{views:2.25,bookmarks:1.25,likes:.5},metricSampleCounts:{views:4,bookmarks:4,likes:4,bookmarkRate:4},growthMetricSampleCounts:{views:3,bookmarks:3,likes:3},lateCount:2,growthEligibleWorkCount:5,historicalWorkCount:5}]}));
 await b.filter('accountId',b.state.accounts[0].id);await b.filter('group','character');await b.filter('point','24h');await b.click('analytics-metric:bookmarks');await b.filter('sort','average');
 const query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('accountId'),b.state.accounts[0].id);assert.equal(query.get('group'),'character');assert.equal(query.get('point'),'24h');assert.equal(query.get('metric'),'bookmarks');assert.equal(query.get('sort'),'average');
 assert.match(b.app.innerHTML,/4 \/ 10 件有效/);assert.match(b.app.innerHTML,/缺失 6 · 新作品增长样本 3/);assert.match(b.app.innerHTML,/>50<small>4 \/ 10 件有效/);assert.match(b.app.innerHTML,/2 件迟到采样/);
 await b.filter('sort','growth');assert.match(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,/sort=growth/);
 await b.filter('group','tag');assert.match(b.app.innerHTML,/标签排行/);
});

test('statistics search requests a server-wide query rather than filtering only the visible page',async()=>{
 const b=await fixture();await b.click('nav:analytics');await b.search('Example tag & name');
 const query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('query'),'Example tag & name');assert.equal(query.get('offset'),'0');assert.equal(query.get('limit'),'25');
});

test('ranking horizontal scroll survives automatic refresh and temporary loading but resets for a new workspace',async()=>{
 const b=await fixture();await b.click('nav:analytics');
 b.rankingScroll.scrollLeft=430;const before=b.rankingScroll;await b.interval(60000);
 assert.notEqual(b.rankingScroll,before,'Refresh rebuilds the table container.');assert.equal(b.rankingScroll.scrollLeft,430);
 b.rankingScroll.scrollLeft=510;b.deferReports();const filtering=b.filter('days','30');await flush();
 assert.equal(b.rankingScroll,null,'The report is temporarily absent while loading.');
 b.pending[0].resolve(report());await filtering;assert.equal(b.rankingScroll.scrollLeft,510);
 b.deferReports(false);b.failReport('unavailable');await b.click('refresh');assert.equal(b.rankingScroll,null);
 b.failReport('');await b.click('analytics-reload');assert.equal(b.rankingScroll.scrollLeft,510);
 b.state.mode='demo';b.state.settings.mode='demo';await b.click('refresh');assert.equal(b.rankingScroll.scrollLeft,0,'A workspace reset must not recapture the old table offset.');
});

test('manual collection targets the selected account once and polling performs only reads',async()=>{
 const b=await fixture();await b.click('nav:analytics');await b.filter('accountId',b.state.accounts[0].id);
 await b.click('analytics-collect');assert.match(b.app.innerHTML,/正在采集…/);await b.click('analytics-collect');
 assert.equal(b.requests.filter(r=>r.url==='/api/analytics/collect').length,1);
 assert.deepEqual(b.requests.find(r=>r.url==='/api/analytics/collect').payload,{accountId:b.state.accounts[0].id});
 b.setStatus({running:false,completedAt:NOW,errors:[]});await b.interval(4000);
 assert.match(b.toast.textContent,/数据采集完成/);assert.match(b.app.innerHTML,/>更新数据<\/button>/);
 assert.equal(b.requests.filter(r=>r.method!=='GET').length,1,'Data collection does not start posting or mutate works.');
});

test('account history keeps unavailable follower counts distinct and does not invent a trend',async()=>{
 const b=await fixture();b.setReport(report({accounts:[{accountId:b.state.accounts[0].id,latest:{observedAt:NOW,views:2000,followers:null},history:[{observedAt:'2026-10-14T16:00:00Z',views:1000,followers:10},{observedAt:'2026-10-14T22:00:00Z',views:1500,followers:null},{observedAt:NOW,views:2000,followers:null}]}]}));
 await b.click('nav:analytics');assert.match(b.app.innerHTML,/账号总浏览量/);assert.match(b.app.innerHTML,/<span>粉丝数<\/span><strong>—<\/strong>/);
 assert.match(b.app.innerHTML,/粉丝数趋势需要至少两次有效记录/);assert.match(b.app.innerHTML,/总浏览量趋势，3 次有效观测/);assert.match(b.app.innerHTML,/查看账号采样记录（3 次）/);
});

const followerSource={followerCount:{seriesId:'pixiv-followers-page-total-v1'}};
const followerCard=html=>html.match(/<div><span>粉丝数<\/span>[\s\S]*?<\/div>/)?.[0]||'';
const accountObservation=(at,followers,sources,views=1000)=>({observedAt:at,followers,views,...(sources?{sources}: {})});

test('account selection and the four account metrics appear before every ranking control and summary',async()=>{
 const b=await fixture(),accountId=b.state.accounts[0].id;
 b.setReport(report({accounts:[{accountId,latest:accountObservation(NOW,25,followerSource,12345),totals:{views:11111,bookmarks:987,likes:432,workCount:100,metricCounts:{views:100,bookmarks:98,likes:95},observedAt:NOW},history:[]}]}));
 await b.click('nav:analytics');const html=b.app.innerHTML;
 const positions=['data-analytics-filter="accountId"','aria-label="账号总览"','class="analytics-group-tabs"','data-analytics-filter="days"','class="stats analytics-summary"','class="panel analytics-ranking'].map(value=>html.indexOf(value));
 assert.ok(positions.every(index=>index>=0));assert.deepEqual(positions,[...positions].sort((a,b)=>a-b));
 assert.equal((html.match(/data-analytics-filter="accountId"/g)||[]).length,1);
 const overview=html.slice(positions[1],positions[2]);
 const metrics=['账号总浏览量','总收藏数','总点赞数','粉丝数'].map(label=>overview.indexOf('<span>'+label+'</span>'));
 assert.ok(metrics.every(index=>index>=0));assert.deepEqual(metrics,[...metrics].sort((a,b)=>a-b));
 assert.match(overview,/<span>账号总浏览量<\/span><strong>12,345<\/strong>/);assert.doesNotMatch(overview,/>11,111</);
 assert.match(overview,/<span>总收藏数<\/span><strong>987<\/strong>/);assert.match(overview,/98 \/ 100 件有效/);
 assert.match(overview,/<span>总点赞数<\/span><strong>432<\/strong>/);assert.match(overview,/95 \/ 100 件有效/);
 assert.match(overview,/<span>粉丝数<\/span><strong>25<\/strong>/);assert.match(overview,/不受下方排行筛选影响/);
});

test('account overviews remain separate, honor account selection, and retain all-work totals under ranking filters',async()=>{
 const b=await fixture(),[first,second]=b.state.accounts;
 const accounts=[{accountId:first.id,latest:accountObservation(NOW,22,followerSource,3000),totals:{views:2500,bookmarks:650,likes:430,workCount:100,metricCounts:{views:100,bookmarks:100,likes:100}},history:[]},{accountId:second.id,latest:accountObservation(NOW,44,followerSource,6000),totals:{views:5500,bookmarks:850,likes:630,workCount:200,metricCounts:{views:200,bookmarks:200,likes:200}},history:[]}];
 b.setReport(report({accounts}));await b.click('nav:analytics');
 const overview=()=>b.app.innerHTML.slice(b.app.innerHTML.indexOf('aria-label="账号总览"'),b.app.innerHTML.indexOf('class="analytics-group-tabs"'));
 assert.equal((overview().match(/data-analytics-account=/g)||[]).length,2);
 await b.filter('accountId',first.id);assert.equal((overview().match(/data-analytics-account=/g)||[]).length,1);assert.ok(overview().includes(`data-analytics-account="${first.id}"`));assert.ok(!overview().includes(`data-analytics-account="${second.id}"`));
 b.setReport(report({accounts,summary:{workCount:1,sampledWorkCount:1},rows:[{id:'1',name:'Filtered work',total:2}]}));
 await b.filter('days','30');await b.click('analytics-group:character');await b.filter('point','6h');await b.click('analytics-metric:likes');await b.search('filtered');
 assert.match(overview(),/<span>账号总浏览量<\/span><strong>3,000<\/strong>/);assert.match(overview(),/<span>总收藏数<\/span><strong>650<\/strong>/);assert.match(overview(),/<span>总点赞数<\/span><strong>430<\/strong>/);assert.match(overview(),/100 \/ 100 件有效/);
 const query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('days'),'30');assert.equal(query.get('accountId'),first.id);assert.equal(query.get('group'),'character');
 await b.filter('accountId','all');assert.equal((overview().match(/data-analytics-account=/g)||[]).length,2);
});

test('account totals preserve valid zero values, fall back only to supplied totals, and keep missing values unavailable',async()=>{
 const b=await fixture(),accountId=b.state.accounts[0].id;
 b.setReport(report({accounts:[{accountId,latest:accountObservation(NOW,null,undefined,null),totals:{views:456,bookmarks:0,likes:null,workCount:3,metricCounts:{views:2,bookmarks:2,likes:0}},history:[]}]}));await b.click('nav:analytics');
 assert.match(b.app.innerHTML,/<span>账号总浏览量<\/span><strong>456<\/strong><small[^>]*>作品最新有效记录合计 · 2 \/ 3 件有效/);
 assert.match(b.app.innerHTML,/<span>总收藏数<\/span><strong>0<\/strong>/);assert.match(b.app.innerHTML,/<span>总点赞数<\/span><strong>—<\/strong>/);assert.match(followerCard(b.app.innerHTML),/<strong>—<\/strong>/);
 b.setReport(report({accounts:[{accountId,latest:{views:0},history:[]}]}));await b.click('nav:analytics');
 assert.match(b.app.innerHTML,/<span>账号总浏览量<\/span><strong>0<\/strong>/);assert.match(b.app.innerHTML,/<span>总收藏数<\/span><strong>—<\/strong>/);assert.match(b.app.innerHTML,/<span>总点赞数<\/span><strong>—<\/strong>/);
 b.setReport(report({accounts:[{accountId,latest:{},history:[]}]}));await b.click('nav:analytics');assert.match(b.app.innerHTML,/<span>账号总浏览量<\/span><strong>—<\/strong>/);
});

const dailyMetric=(delta,status='complete',extra={})=>({delta,status,startValue:100,endValue:typeof delta==='number'?100+delta:null,startAt:'2026-10-14T15:00:00Z',endAt:NOW,...extra});
const dailyRow=(date,metrics,isToday=false)=>({date,isToday,metrics});
const dailyTable=html=>html.match(/<details class="analytics-daily"[\s\S]*?<\/details>/)?.[0]||'';

test('daily increments show signed per-metric changes, partial first-day coverage and Beijing sample times',async()=>{
 const b=await fixture({timezone:'Asia/Tokyo'}),accountId=b.state.accounts[0].id;
 const today=dailyRow('2026-10-15',{views:dailyMetric(150),bookmarks:dailyMetric(20,'partial',{startAt:'2026-10-14T16:30:00Z'}),likes:dailyMetric(0),followers:dailyMetric(-2)},true);
 const previous=dailyRow('2026-10-14',{views:dailyMetric(70),bookmarks:dailyMetric(8),likes:dailyMetric(2),followers:dailyMetric(0)});
 b.setReport(report({accounts:[{accountId,latest:accountObservation(NOW,23,followerSource,5000),totals:{bookmarks:120,likes:100},daily:{timezone:'Asia/Shanghai',today,rows:[previous,today]},history:[]}]}));await b.click('nav:analytics');
 const html=b.app.innerHTML,metrics=html.slice(html.indexOf('class="analytics-account-metrics"'),html.indexOf('class="analytics-daily"'));
 assert.match(metrics,/今日增量 <b>\+150<\/b>/);assert.match(metrics,/今日已记录 <b>\+20<\/b>/);assert.match(metrics,/首个可比记录起，非完整日增量/);assert.match(metrics,/今日增量 <b>0<\/b>/);assert.match(metrics,/今日净增 <b>-2<\/b>/);
 assert.match(metrics,/截至 2026-10-15 12:00 · 北京时间/);assert.match(metrics,/首个可比记录起；起点 2026-10-15 00:30（100）/);assert.doesNotMatch(metrics,/2026-10-15 13:00|2026-10-15 01:30/);
 const table=dailyTable(html);assert.match(table,/<details class="analytics-daily">/);assert.match(table,/每日增量（北京时间）/);assert.match(table,/今天 · 截至采样/);assert.match(table,/首个可比记录起 · 非完整日增量/);
 assert.ok(table.indexOf('data-analytics-day="2026-10-15"')<table.indexOf('data-analytics-day="2026-10-14"'));assert.match(table,/>-2<small>/);assert.match(table,/>0<small>/);
});

test('daily missing baselines and missing days remain unavailable instead of zero or cross-day changes',async()=>{
 const b=await fixture(),accountId=b.state.accounts[0].id;
 const today=dailyRow('2026-10-15',{views:dailyMetric(null,'missing',{reason:'previous_day_missing',startAt:null}),bookmarks:dailyMetric(999,'missing',{reason:'scope_changed'}),likes:dailyMetric(null,'missing',{reason:'incomplete_snapshot'}),followers:dailyMetric(null,'missing',{reason:'unsupported_source'})},true);
 const skipped=dailyRow('2026-10-14',{}),older=dailyRow('2026-10-13',{views:dailyMetric(12)});
 b.setReport(report({accounts:[{accountId,latest:accountObservation(NOW,null,undefined,5000),totals:{bookmarks:500},daily:{timezone:'Asia/Shanghai',today,rows:[older,skipped,today]},history:[]}]}));await b.click('nav:analytics');
 const html=b.app.innerHTML,table=dailyTable(html),todayCells=table.match(/data-analytics-day="2026-10-15"[\s\S]*?<\/tr>/)?.[0]||'';
 assert.equal((todayCells.match(/>—<small>/g)||[]).length,4);assert.match(todayCells,/缺少前一日基准/);assert.doesNotMatch(todayCells,/>999<|>0<|>\+999</);
 assert.match(todayCells,/作品范围变化，无法比较/);assert.match(todayCells,/当轮作品数据未采集完整/);assert.match(todayCells,/粉丝来源不符合当前口径/);
 assert.match(html,/今日增量 <b>—<\/b>/);assert.match(html,/今日净增 <b>—<\/b>/);assert.doesNotMatch(table,/1970-/);
 const skippedCells=table.match(/data-analytics-day="2026-10-14"[\s\S]*?<\/tr>/)?.[0]||'';assert.equal((skippedCells.match(/>—<small>/g)||[]).length,4);
 b.setReport(report({accounts:[{accountId,daily:{today:dailyRow('2026-10-15',{views:dailyMetric(null,'missing',{reason:'first_observation_only'})},true),rows:[]}}]}));await b.click('nav:analytics');assert.match(b.app.innerHTML,/仅一次记录，尚无增量基准/);
});

test('daily range requests are independent of publication filters, account selection and ranking pagination',async()=>{
 const b=await fixture();b.setReport(report({pagination:{total:60,limit:25,offset:0}}));await b.click('nav:analytics');
 const query=()=>new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query().get('dailyDays'),'30');assert.match(b.app.innerHTML,/data-analytics-filter="dailyDays"/);
 await b.filter('accountId',b.state.accounts[0].id);await b.filter('days','180');await b.click('analytics-group:tag');await b.filter('point','24h');await b.click('analytics-page:next');
 for(const days of ['7','90','365','30']){
  await b.filter('dailyDays',days);const q=query();assert.equal(q.get('dailyDays'),days);assert.equal(q.get('days'),'180');assert.equal(q.get('accountId'),b.state.accounts[0].id);assert.equal(q.get('group'),'tag');assert.equal(q.get('point'),'24h');assert.equal(q.get('offset'),'25');
 }
 await b.filter('days','30');assert.equal(query().get('dailyDays'),'30');assert.equal(query().get('offset'),'0');
 const count=b.requests.length;await b.filter('dailyDays','all');assert.equal(b.requests.length,count,'Daily range has a separate allowed set.');
});

test('old follower observations remain in history but cannot join the followers-page series',async()=>{
 const b=await fixture(),history=[accountObservation('2026-10-14T16:00:00Z',900),accountObservation(NOW,12,followerSource)];
 b.setReport(report({accounts:[{accountId:b.state.accounts[0].id,latest:history.at(-1),history}]}));await b.click('nav:analytics');
 const card=followerCard(b.app.innerHTML);assert.match(card,/<strong>12<\/strong>/);assert.match(card,/粉丝页面/);assert.doesNotMatch(card,/<polyline/);
 assert.match(card,/粉丝数趋势需要至少两次有效记录/);assert.match(b.app.innerHTML,/>900<small>旧口径（不参与趋势）<\/small>/);
 assert.match(b.app.innerHTML,/总浏览量趋势，2 次有效观测/,'Views retain their existing series.');
});

test('two valid followers-page counts form a trend and zero remains a valid observation',async()=>{
 const b=await fixture(),history=[accountObservation('2026-10-14T22:00:00Z',8,followerSource),accountObservation(NOW,0,followerSource)];
 b.setReport(report({accounts:[{accountId:b.state.accounts[0].id,latest:history.at(-1),history}]}));await b.click('nav:analytics');
 const card=followerCard(b.app.innerHTML);assert.match(card,/<strong>0<\/strong>/);assert.match(card,/<polyline/);assert.equal((card.match(/<circle /g)||[]).length,2);
 assert.match(card,/粉丝数趋势，2 次有效观测，最低 0，最高 8/);assert.doesNotMatch(b.app.innerHTML,/旧口径（不参与趋势）/);
});

test('missing or incompatible follower records split the line instead of connecting across them',async()=>{
 const b=await fixture();
 for(const middle of [accountObservation('2026-10-14T22:00:00Z',null,followerSource),accountObservation('2026-10-14T22:00:00Z',999,{followerCount:{seriesId:'legacy-series'}})]){
  const history=[accountObservation('2026-10-14T16:00:00Z',10,followerSource),middle,accountObservation(NOW,20,followerSource)];
  b.setReport(report({accounts:[{accountId:b.state.accounts[0].id,latest:history.at(-1),history}]}));await b.click('nav:analytics');
  const card=followerCard(b.app.innerHTML);assert.match(card,/<strong>20<\/strong>/);assert.equal((card.match(/<circle /g)||[]).length,2);assert.doesNotMatch(card,/<polyline/);
  assert.match(card,/粉丝数趋势，2 次有效观测，最低 10，最高 20/);
 }
});

test('the current follower value never falls back to an earlier valid or legacy sample after failure',async()=>{
 const b=await fixture();
 for(const latest of [accountObservation(NOW,null,followerSource),accountObservation(NOW,1234),accountObservation(NOW,1234,{followerCount:{seriesId:'other-series'}})]){
  const history=[accountObservation('2026-10-14T16:00:00Z',888),accountObservation('2026-10-14T22:00:00Z',20,followerSource),latest];
  b.setReport(report({accounts:[{accountId:b.state.accounts[0].id,latest,history}]}));await b.click('nav:analytics');
  const card=followerCard(b.app.innerHTML);assert.match(card,/<strong>—<\/strong>/);assert.doesNotMatch(card,/<strong>(?:20|888|1,234|0)<\/strong>/);
  assert.match(b.app.innerHTML,/>888<small>旧口径（不参与趋势）<\/small>/);
 }
});

test('an unavailable follower value is labeled unavailable rather than legacy regardless of source',async()=>{
 const b=await fixture();
 for(const [followers,sources]of [[null,undefined],[undefined,undefined],[null,followerSource]]){
  const latest=accountObservation(NOW,followers,sources);
  b.setReport(report({accounts:[{accountId:b.state.accounts[0].id,latest,history:[latest]}]}));await b.click('nav:analytics');
  assert.match(b.app.innerHTML,/<td>—<small>未取得<\/small><\/td>/);assert.doesNotMatch(b.app.innerHTML,/旧口径（不参与趋势）/);
 }
});

test('a slower previous filter response cannot overwrite the latest report',async()=>{
 const b=await fixture();await b.click('nav:analytics');b.deferReports();
 const first=b.filter('point','6h');await flush();const second=b.filter('point','12h');await flush();
 b.pending[1].resolve(report({rows:[{id:'111',name:'Latest point',total:12,average:12,growth:null}]}));await second;
 b.pending[0].resolve(report({rows:[{id:'222',name:'Stale point',total:6,average:6,growth:null}]}));await first;
 assert.match(b.app.innerHTML,/Latest point/);assert.doesNotMatch(b.app.innerHTML,/Stale point/);
});

test('report and collection failures remain visible with a recovery action',async()=>{
 const b=await fixture();b.failReport('offline');await b.click('nav:analytics');assert.match(b.app.innerHTML,/offline/);assert.match(b.app.innerHTML,/data-action="analytics-reload"/);
 b.failReport('');await b.click('analytics-reload');assert.match(b.app.innerHTML,/Example work/);
 b.failCollect('Chrome disconnected');await b.click('analytics-collect');assert.match(b.app.innerHTML,/数据采集未完成：Chrome disconnected/);assert.match(b.app.innerHTML,/>更新数据<\/button>/);
});

test('metadata is escaped and untrusted artwork links are not rendered',async()=>{
 const b=await fixture();b.setReport(report({rows:[{id:'unsafe',name:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',total:null,average:null,growth:null,status:'missing'}]}));await b.click('nav:analytics');
 assert.match(b.app.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(b.app.innerHTML,/href="javascript:|<img src=x/);
});

test('pagination and sort choices load the appropriate page and reset after filtering',async()=>{
 const b=await fixture();b.setReport(report({pagination:{total:60,limit:25,offset:0}}));await b.click('nav:analytics');await b.click('analytics-page:next');
 assert.match(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,/offset=25/);
 await b.click('analytics-metric:likes');assert.match(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,/offset=0/);
});

test('Chinese input waits for composition to finish before requesting statistics',async()=>{
 const b=await fixture();await b.click('nav:analytics');const before=b.requests.length;
 await b.compose('compositionstart','');await b.input('角');await b.runSearchTimer();assert.equal(b.requests.length,before);
 await b.compose('compositionend','角色');await b.runSearchTimer();
 const query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('query'),'角色');
});

test('a report requested before switching workspaces never reveals the old data in demo',async()=>{
 const b=await fixture();b.deferReports();const opening=b.click('nav:analytics');await flush();
 await b.click('nav:settings');await b.click('switch-demo');
 b.pending[0].resolve(report({rows:[{id:'123',name:'Private former workspace',total:100}]}));await opening;
 b.deferReports(false);b.setReport(report({rows:[],accounts:[]}));await b.click('nav:analytics');
 assert.doesNotMatch(b.app.innerHTML,/Private former workspace/);assert.match(b.app.innerHTML,/当前为演示空间/);
 const posts=b.requests.filter(r=>r.url==='/api/analytics/collect').length;await b.click('analytics-collect');assert.equal(b.requests.filter(r=>r.url==='/api/analytics/collect').length,posts);
});

test('current ranking hides growth and changing from a fixed-age growth ranking resets the sort',async()=>{
 const b=await fixture();await b.click('nav:analytics');
 assert.doesNotMatch(b.app.innerHTML,/value="growth"|data-action="analytics-sort:growth"/);
 assert.match(b.app.innerHTML,/截至目前保留全部作品的普通排行/);
 await b.filter('point','12h');await b.filter('sort','growth');
 assert.match(b.app.innerHTML,/value="growth" selected/);assert.match(b.app.innerHTML,/按每小时浏览增长排序/);
 await b.filter('point','current');
 const query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('point'),'current');assert.equal(query.get('sort'),'total');
 assert.doesNotMatch(b.app.innerHTML,/value="growth"|data-action="analytics-sort:growth"/);
 // A stale native selection cannot send the invalid current/growth combination.
 await b.filter('sort','growth');
 const next=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(next.get('point'),'6h');assert.equal(next.get('sort'),'growth');
});

test('fixed-age tables explain why historical works cannot take part in growth',async()=>{
 const b=await fixture();b.setReport(report({rows:[{id:'123',name:'Historical work',status:'recorded',total:500,average:500,growth:null,metrics:{views:500,bookmarks:100,likes:40,bookmarkRate:.2},growthMetrics:{views:null,bookmarks:null,likes:null},growthEligible:false,growthExcludedReason:'published_before_enabled',observedAt:NOW}]}));
 await b.click('nav:analytics');await b.filter('point','24h');
 assert.match(b.app.innerHTML,/历史作品不参与增长/);assert.match(b.app.innerHTML,/>500<small>每小时增长 —/);
 assert.match(b.app.innerHTML,/累计数 ÷ 发布至实际采样小时数/);assert.doesNotMatch(b.app.innerHTML,/两次观测|以首次观测为基准/);
});

test('work ranking shows all four metrics and group tabs default to independent per-metric averages',async()=>{
 const b=await fixture();b.setReport(report({rows:[{id:'123',name:'Actual work',total:1234,average:98765,metrics:{views:1234,bookmarks:300,likes:250,bookmarkRate:.2431118},status:'recorded',observedAt:NOW}]}));await b.click('nav:analytics');
 assert.doesNotMatch(b.app.innerHTML,/data-analytics-filter="metric"|value="average"|98,765/);
 for(const key of ['views','bookmarks','likes','bookmarkRate'])assert.ok(b.app.innerHTML.includes('data-action="analytics-metric:'+key+'"'));
 assert.match(b.app.innerHTML,/>浏览量 ↓<\/button>/);assert.match(b.app.innerHTML,/>1,234<\/td>/);assert.match(b.app.innerHTML,/>300<\/td>/);assert.match(b.app.innerHTML,/>250<\/td>/);assert.match(b.app.innerHTML,/>24.31%<\/td>/);
 await b.filter('accountId',b.state.accounts[0].id);await b.filter('point','24h');await b.filter('days','90');
 b.setReport(report({rows:[{id:'luna',name:'Luna',workCount:5,sampleCount:4,missingCount:1,total:1200,average:300,growth:50,growthSampleCount:4,metrics:{views:1200,bookmarks:200,likes:90,bookmarkRate:.2},averageMetrics:{views:300,bookmarks:100,likes:30},growthMetrics:{views:50,bookmarks:8,likes:4},metricSampleCounts:{views:4,bookmarks:2,likes:3,bookmarkRate:2},growthMetricSampleCounts:{views:4,bookmarks:2,likes:2}}]}));
 await b.click('analytics-group:character');
 let query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('group'),'character');assert.equal(query.get('sort'),'average');assert.equal(query.get('accountId'),b.state.accounts[0].id);assert.equal(query.get('point'),'24h');assert.equal(query.get('days'),'90');
 assert.match(b.app.innerHTML,/该角色所属作品的各项合计 ÷ 对应有效作品数/);assert.match(b.app.innerHTML,/>平均浏览量 ↓<\/button>/);assert.match(b.app.innerHTML,/>300<small>4 \/ 5 件有效/);assert.match(b.app.innerHTML,/>100<small>2 \/ 5 件有效/);assert.match(b.app.innerHTML,/>30<small>3 \/ 5 件有效/);assert.match(b.app.innerHTML,/>20.00%<small>配对 2 \/ 5 件有效/);
 await b.click('analytics-metric:bookmarks');assert.match(b.app.innerHTML,/>平均收藏数 ↓<\/button>/);
 await b.filter('sort','total');assert.match(b.app.innerHTML,/>1,200<small>/);assert.match(b.app.innerHTML,/>200<small>/);
 await b.filter('sort','growth');assert.match(b.app.innerHTML,/>50<small>4 \/ 5 件有效新作品/);assert.match(b.app.innerHTML,/>8<small>2 \/ 5 件有效新作品/);assert.match(b.app.innerHTML,/平均每小时收藏增长/);
 await b.click('analytics-group:tag');query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;assert.equal(query.get('sort'),'average');assert.equal(query.get('group'),'tag');
 assert.match(b.app.innerHTML,/该标签所属作品/);assert.doesNotMatch(b.app.innerHTML,/analytics-thumb/);
 await b.click('analytics-group:work');assert.doesNotMatch(b.app.innerHTML,/value="average"/);assert.match(b.app.innerHTML,/>收藏数 ↓<\/button>/);
});

test('bookmark ratios format percentages, preserve real zero, and never invent unavailable denominators',async()=>{
 const b=await fixture();b.setReport(report({rows:[
  {id:'101',name:'Quarter',metrics:{views:400,bookmarks:100,likes:20,bookmarkRate:.25}},
  {id:'102',name:'Zero rate',metrics:{views:400,bookmarks:0,likes:0,bookmarkRate:0}},
  {id:'103',name:'Zero views',metrics:{views:0,bookmarks:10,likes:2,bookmarkRate:1}},
  {id:'104',name:'Unknown views',metrics:{views:null,bookmarks:10,likes:2,bookmarkRate:null}},
  {id:'105',name:'Unknown bookmarks',metrics:{views:400,bookmarks:null,likes:2,bookmarkRate:null}},
 ]}));await b.click('nav:analytics');
 const rates=[...b.app.innerHTML.matchAll(/class="analytics-value analytics-ratio">([^<]*)/g)].map(match=>match[1]);assert.deepEqual(rates,['25.00%','0.00%','—','—','—']);
 assert.doesNotMatch(b.app.innerHTML,/data-analytics-filter="metric"|aria-label="数据指标"/);
});

test('metric column sorting resets pagination and ratio sorting remains total across group and point changes',async()=>{
 const b=await fixture();b.setReport(report({pagination:{total:60,limit:25,offset:0}}));await b.click('nav:analytics');
 const query=()=>new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 await b.click('analytics-page:next');await b.click('analytics-metric:likes');assert.equal(query().get('metric'),'likes');assert.equal(query().get('sort'),'total');assert.equal(query().get('offset'),'0');
 await b.click('analytics-group:character');await b.filter('point','24h');await b.filter('sort','growth');await b.click('analytics-page:next');await b.click('analytics-metric:bookmarks');assert.equal(query().get('metric'),'bookmarks');assert.equal(query().get('sort'),'growth');assert.equal(query().get('offset'),'0');
 await b.click('analytics-metric:bookmarkRate');assert.equal(query().get('metric'),'bookmarkRate');assert.equal(query().get('sort'),'total');assert.match(b.app.innerHTML,/value="total" selected/);
 for(const group of ['tag','work','interval','character']){await b.click('analytics-group:'+group);assert.equal(query().get('metric'),'bookmarkRate');assert.equal(query().get('sort'),'total');assert.match(b.app.innerHTML,/value="total" selected/);}
 await b.filter('point','current');assert.equal(query().get('metric'),'bookmarkRate');assert.equal(query().get('sort'),'total');
 await b.filter('sort','average');assert.equal(query().get('metric'),'views');assert.equal(query().get('sort'),'average');
 await b.click('analytics-metric:bookmarkRate');await b.filter('sort','growth');assert.equal(query().get('metric'),'views');assert.equal(query().get('sort'),'growth');assert.equal(query().get('point'),'6h');
 const count=b.requests.length;await b.filter('metric','likes');assert.equal(b.requests.length,count,'Removed metric select cannot change statistics.');
});

test('interval ratio remains a cumulative endpoint ratio when the start node is unavailable',async()=>{
 const b=await fixture();b.setReport(report({rows:[{id:'123',name:'Endpoint only',metrics:{views:1000,bookmarks:250,likes:80,bookmarkRate:.25},deltaMetrics:{views:null,bookmarks:null,likes:null,bookmarkRate:.99},growthMetrics:{views:null,bookmarks:null,likes:null,bookmarkRate:.88},status:'missing',missingReason:'start_milestone_missing',toObservedAt:NOW,growthEligible:false,growthExcludedReason:'ratio_not_defined'}]}));
 await b.click('nav:analytics');await b.click('analytics-group:interval');await b.click('analytics-metric:bookmarkRate');
 assert.match(b.app.innerHTML,/节点收藏浏览比 ↓/);assert.match(b.app.innerHTML,/class="analytics-value analytics-ratio">25.00%<small>终点累计比值/);assert.doesNotMatch(b.app.innerHTML,/99.00%|88.00%/);
 assert.match(b.app.innerHTML,/class="analytics-rank">1<\/td>/);assert.match(b.app.innerHTML,/起点采样记录缺失/);assert.match(b.app.innerHTML,/不能当作区间新增比/);
 await b.click('analytics-group:work');await b.filter('point','24h');assert.doesNotMatch(b.app.innerHTML,/未纳入新作品增长/);
});

test('work thumbnails only use the local thumbnail route and lazy failures leave a placeholder',async()=>{
 const b=await fixture(),valid='/api/analytics/accounts/00000000-0000-4000-8000-000000000001/works/123/thumbnail?v=abcdef123456';
 b.setReport(report({rows:[{id:'123',name:'With preview',thumbnailUrl:valid,total:10},{id:'124',name:'No preview',thumbnailUrl:'https://example.invalid/private.jpg',total:5},{id:'125',name:'Wrong route',thumbnailUrl:'/api/analytics/accounts/00000000-0000-4000-8000-000000000001/works/125/thumbnail?v=abcdef123456&unsafe=1',total:2}]}));
 await b.click('nav:analytics');
 assert.equal((b.app.innerHTML.match(/data-analytics-thumbnail/g)||[]).length,1);assert.match(b.app.innerHTML,/width="44" height="52" loading="lazy" decoding="async"/);
 assert.match(b.app.innerHTML,/src="\/api\/analytics\/accounts\/00000000-0000-4000-8000-000000000001\/works\/123\/thumbnail\?v=abcdef123456"/);
 assert.doesNotMatch(b.app.innerHTML,/example.invalid|unsafe=1/);assert.equal((b.app.innerHTML.match(/class="analytics-thumb"/g)||[]).length,3);
 const target={dataset:{analyticsThumbnail:''},hidden:false};await b.imageError(target);assert.equal(target.hidden,true);
 await b.click('analytics-group:tag');assert.doesNotMatch(b.app.innerHTML,/data-analytics-thumbnail|class="analytics-thumb"/);
});

test('publication date filters apply to every ranking and reset pagination',async()=>{
 const b=await fixture();b.setReport(report({pagination:{total:60,limit:25,offset:0}}));await b.click('nav:analytics');
 for(const label of ['全部作品','30天内','90天内','180天内','一年内'])assert.ok(b.app.innerHTML.includes('>'+label+'</option>'));
 let query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;assert.equal(query.get('days'),'all');
 for(const [group,days]of [['work','30'],['character','90'],['tag','180'],['interval','365']]){
  await b.click('analytics-group:'+group);await b.click('analytics-page:next');await b.filter('days',days);
  query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
  assert.equal(query.get('group'),group);assert.equal(query.get('days'),days);assert.equal(query.get('offset'),'0');
 }
});

test('interval ranking uses adjacent-node delta and actual hours with an explicit zero estimate',async()=>{
 const b=await fixture();b.setReport(report({rows:[{id:'123',name:'First six hours',delta:120,growth:20,deltaMetrics:{views:120,bookmarks:30,likes:12},growthMetrics:{views:20,bookmarks:5,likes:2},metrics:{views:120,bookmarks:30,likes:12,bookmarkRate:.25},total:900,average:900,startValue:0,endValue:120,fromObservedAt:null,toObservedAt:NOW,intervalStartAt:'2026-10-14T22:00:00Z',intervalEndAt:NOW,intervalHours:6,baselineKind:'publication_zero_estimate',positiveGrowth:true,status:'recorded'}]}));
 await b.click('nav:analytics');await b.click('analytics-group:interval');
 const query=new URL(b.requests.filter(r=>r.url.startsWith('/api/analytics?')).at(-1).url,'http://local').searchParams;
 assert.equal(query.get('group'),'interval');assert.equal(query.get('point'),'6h');assert.equal(query.get('sort'),'growth');
 assert.match(b.app.innerHTML,/aria-label="增长区间"/);assert.doesNotMatch(b.app.innerHTML,/value="current"|data-action="analytics-sort:average"/);
 assert.match(b.app.innerHTML,/>浏览量 ↓<\/button>/);assert.match(b.app.innerHTML,/>\+120<small>每小时 \+20/);assert.match(b.app.innerHTML,/>\+30<small>每小时 \+5/);assert.match(b.app.innerHTML,/>25.00%<small>终点累计比值/);
 assert.match(b.app.innerHTML,/起点按 0 估算/);assert.match(b.app.innerHTML,/实际间隔 6 小时/);assert.doesNotMatch(b.app.innerHTML,/>900<\/td>/);
 b.setReport(report({rows:[{id:'124',name:'Next six hours',delta:30,growth:5,deltaMetrics:{views:30,bookmarks:6,likes:3},growthMetrics:{views:5,bookmarks:1,likes:.5},metrics:{views:150,bookmarks:36,likes:15,bookmarkRate:.24},startValue:120,endValue:150,fromObservedAt:'2026-10-14T22:00:00Z',toObservedAt:NOW,intervalHours:6,baselineKind:'adjacent_actual_nodes',positiveGrowth:true,status:'recorded'}]}));
 await b.filter('point','12h');assert.match(b.app.innerHTML,/6–12 小时 · 按每小时新增浏览量排序/);assert.match(b.app.innerHTML,/起点 10月15日 06:00/);assert.match(b.app.innerHTML,/终点 10月15日 12:00/);assert.match(b.app.innerHTML,/>\+30<small>每小时 \+5/);
});

test('negative and missing interval results are kept but never receive a positive growth rank',async()=>{
 const b=await fixture();b.setReport(report({rows:[{id:'123',name:'Reduced',delta:-6,growth:-1,deltaMetrics:{views:-6,bookmarks:0,likes:-1},growthMetrics:{views:-1,bookmarks:0,likes:-.2},metrics:{views:14,bookmarks:2,likes:1,bookmarkRate:2/14},startValue:20,endValue:14,fromObservedAt:'2026-10-14T22:00:00Z',toObservedAt:NOW,intervalHours:6,status:'recorded',positiveGrowth:false},{id:'124',name:'Missing endpoint',delta:null,growth:null,status:'missing'}]}));
 await b.click('nav:analytics');await b.click('analytics-group:interval');await b.filter('point','12h');
 assert.equal((b.app.innerHTML.match(/class="analytics-rank">—/g)||[]).length,2);assert.match(b.app.innerHTML,/>-6<small>每小时 -1/);assert.match(b.app.innerHTML,/数据减少，不列增长名次/);assert.match(b.app.innerHTML,/缺少相邻节点或指标记录/);
});

test('interval missing messages identify which endpoint or metric is unavailable',async()=>{
 const b=await fixture();
 b.setReport(report({rows:[{id:'123',name:'Missing start',delta:null,growth:null,status:'missing',missingReason:'start_milestone_missing'},{id:'124',name:'Waiting end',delta:null,growth:null,status:'pending',missingReason:'end_milestone_pending'},{id:'125',name:'Missing count',delta:null,growth:null,status:'missing',missingReason:'end_metric_missing'}]}));
 await b.click('nav:analytics');await b.click('analytics-group:interval');
 assert.match(b.app.innerHTML,/起点采样记录缺失/);assert.match(b.app.innerHTML,/等待终点节点采样/);assert.match(b.app.innerHTML,/终点的排序指标未取得/);
});
