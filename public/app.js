const paths = {
 layers:'m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 image:'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M3 16l5-5 5 5 3-3 5 5 M15 7h.01',
 calendar:'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M7 3v4 M17 3v4 M3 11h18 M7 15h2 M13 15h2',
 users:'M8 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M2 21v-3a6 6 0 0 1 12 0v3 M16 4a4 4 0 0 1 0 7 M18 15a5 5 0 0 1 4 5v1',
 clock:'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 7v5l3 2',
 settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M10 2h4l1 3 3-1 3 3-1 3 2 1v3l-3 1 1 3-3 3-3-1-1 2h-3l-1-3-3 1-3-3 1-3-2-1v-3l3-1-1-3 3-3 3 1 1-2z',
 plus:'M12 5v14 M5 12h14', arrow:'M5 12h14 M14 7l5 5-5 5', left:'m14 6-6 6 6 6', right:'m10 6 6 6-6 6',
 check:'m5 12 4 4L19 6', checkCircle:'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z m-4 9 3 3 5-6',
 upload:'M12 16V3 m-5 5 5-5 5 5 M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
 sparkle:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z M21 2v4 M19 4h4',
 search:'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14z m5 12 6 6',
 more:'M5 12h.01 M12 12h.01 M19 12h.01', close:'m6 6 12 12 M6 18 18 6',
 pause:'M8 5v14 M16 5v14', play:'m7 4 14 8-14 8V4z', refresh:'M20 8a8 8 0 0 0-14-3L3 8 M3 3v5h5 M4 16a8 8 0 0 0 14 3l3-3 M21 21v-5h-5',
 list:'M9 5h12 M9 12h12 M9 19h12 M3 5h.01 M3 12h.01 M3 19h.01',
 shield:'m12 2 9 4v6c0 5-5 8-9 10-4-2-9-5-9-10V6l9-4z m-4 10 3 3 5-6',
 link:'m10 13 4-4 M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M15 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
 info:'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 11v6 M12 7h.01',
 download:'M12 3v13 m-5-5 5 5 5-5 M4 16v5h16v-5', trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M9 10v7 M15 10v7',
 folder:'M3 6h7l2 2h9v12H3V6z', external:'M14 3h7v7 M21 3l-9 9 M10 3H3v18h18v-7', up:'m6 14 6-6 6 6', down:'m6 10 6 6 6-6'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.image}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const safeUrl = value => typeof value === 'string' && /^\/(?:files\/|art-)\w[\w./-]*$/.test(value) && !value.includes('..') ? value : '/art-1.svg';
const labels = {draft:'待预约',queued:'待补位',uploading:'上传确认中',reserved:'已预约',published:'已发布',failed:'失败',needs_review:'待处理',cancelled:'已取消'};
const workTabs = ['draft','queued','reserved','published'];
const zoneLabels = {'Asia/Shanghai':'北京时间 · UTC+8','Asia/Tokyo':'日本时间 · UTC+9','UTC':'协调世界时 · UTC'};
const views = {overview:['工作台','grid'],works:['作品管理','image'],calendar:['预约日历','calendar'],analytics:['数据统计','layers'],accounts:['账号管理','users'],activity:['执行记录','clock'],settings:['设置','settings']};
let state;
let clockReceivedAt = Date.now();
let ui = {view:'overview',filter:'draft',account:'all',query:'',grid:false,page:1,selected:new Set(),modal:null,month:null};
let inFlight = false;
let toastTimer;
let pixivSyncing = false;
let pixivSyncError = '';
let queueStarting = false;
let queueStartError = '';
let queuePolling = false;
let queueNotifiedRun = '';
let analytics = {accountId:'all',days:'all',dailyDays:'30',point:'current',group:'work',metric:'views',sort:'total',query:'',page:1,tableScrollLeft:0,tableScrollReset:false,report:null,status:null,loading:false,starting:false,polling:false,error:'',request:0,mode:null};
let analyticsSearchTimer;
const dedicatedBrowserUi={pending:null,errors:{}};
const app = document.querySelector('#app');

async function api(url, data, method = 'POST') {
  const response = await fetch(url, { method, headers:data === undefined ? {} : {'Content-Type':'application/json'}, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || result.message || '操作没有完成，请稍后再试。'); error.details = result.details; throw error; }
  if (result.now && result.settings && Array.isArray(result.accounts)) clockReceivedAt = Date.now();
  return result;
}
function toast(text) { clearTimeout(toastTimer); const box=document.querySelector('#toast'); box.textContent=text;box.classList.add('visible');toastTimer=setTimeout(()=>box.classList.remove('visible'),4500); }
function now() {
  if (!state?.now) return new Date().toISOString();
  if (state.mode === 'demo') return state.now;
  return new Date(Date.parse(state.now) + Math.max(0, Date.now() - clockReceivedAt)).toISOString();
}
function zone() { return state?.settings?.timezone || 'Asia/Shanghai'; }
function parts(value, timeZone=zone()) { const date=new Date(value); if(!Number.isFinite(+date)) return null; return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value])); }
function dateKey(value,timeZone=zone()) { const p=parts(value,timeZone);return p?`${p.year}-${p.month}-${p.day}`:''; }
function wall(value,timeZone=zone()) { const p=parts(value,timeZone);return p?`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`:''; }
function toIso(value,timeZone) {
  if(!value) return '';
  const target=Date.parse(value+':00Z'); if(!Number.isFinite(target)) throw new Error('请选择有效的预约日期。');
  let guess=target;
  for(let n=0;n<3;n++){const p=parts(guess,timeZone);const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);guess+=target-represented;}
  if(wall(guess,timeZone)!==value) throw new Error('该时间在所选时区不存在，请重新选择。');
  return new Date(guess).toISOString();
}
function dateText(value,compact=false) { const p=parts(value);return p?(compact?`${p.month}/${p.day} ${p.hour}:${p.minute}`:`${p.month}月${p.day}日 ${p.hour}:${p.minute}`):'尚未安排'; }
function accountFor(job) { return state.accounts.find(a=>a.id===job.accountId); }
function normalizedAccountColor(account){const color=account?.avatarColor?.toLowerCase()||'';return /^#[0-9a-f]{6}$/.test(color)?color:/^#[0-9a-f]{3}$/.test(color)?'#'+[...color.slice(1)].map(char=>char+char).join(''):'#9a89bf';}
function accountColor(account){
 if(!account)return '#9a89bf';
 const palette=['#7863b5','#b86a45','#3c8a84','#ad6587','#627fae','#939343','#af744f','#748e55','#93679d','#467f9f','#a85d63','#677c52'];
 const accounts=[...(state?.accounts||[])].sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0),counts=new Map(),assigned=new Map(),used=new Set();
 for(const item of accounts){const color=normalizedAccountColor(item);counts.set(color,(counts.get(color)||0)+1);}
 // Existing distinct custom colors keep their meaning across every view.
 for(const item of accounts){const color=normalizedAccountColor(item);if(counts.get(color)===1&&!['#899880','#9a89bf'].includes(color)){assigned.set(item.id,color);used.add(color);}}
 for(const item of accounts){
  if(assigned.has(item.id))continue;
  let hash=2166136261;for(const char of String(item.id))hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
  let offset=0,color;
  do{color=offset<palette.length?palette[(hash+offset)%palette.length]:'#'+[0,8,16].map(shift=>(70+(((hash+Math.imul(offset,2654435761))>>>shift)&255)%120).toString(16).padStart(2,'0')).join('');offset++;}while(used.has(color));
  assigned.set(item.id,color);used.add(color);
 }
 return assigned.get(account.id)||normalizedAccountColor(account);
}
function accountAvatarUrl(account) {
 const value=account?.avatarUrl;
 if(typeof value!=='string')return '';
 if(/^\/api\/accounts\/[a-z0-9-]+\/avatar(?:\?v=[a-z0-9-]+)?$/i.test(value))return value;
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='i.pximg.net'&&!url.port&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
function avatar(account,size='') {const name=account?.name||'未选账号',color=accountColor(account),url=accountAvatarUrl(account);return `<span class="${size==='large'?'avatar-lg':'avatar-dot'}" style="background:${color}22;color:${color}"><span aria-hidden="true">${escape(name.slice(0,1))}</span>${url?`<img data-account-avatar src="${escape(url)}" alt="" referrerpolicy="no-referrer" loading="lazy">`:''}</span>`;}
function badge(status) { return `<span class="badge ${escape(status)}">${labels[status]||escape(status)}</span>`; }
function btn(action,label,ico='',cls='',extra='') { return `<button type="button" data-action="${action}" class="${cls}" ${extra}>${ico?icon(ico):''}${label}</button>`; }
function option(value,label,selected) { return `<option value="${escape(value)}" ${String(value)===String(selected)?'selected':''}>${escape(label)}</option>`; }
function accountOptions(selected,all=false) {return `${all?option('all','全部账号',selected):option('','选择投稿账号',selected)}${state.accounts.map(a=>option(a.id,a.name,selected)).join('')}`;}
function banner() { return state.mode==='demo' ? `<div class="banner"><div>${icon('sparkle')}<strong>正在探索演示工作台</strong> · 30 件示例作品已分三天排期，可推进时间体验自动补位。</div>${btn('switch-live','使用我的账号','arrow')}</div>` : (!state.connectorConfigured ? `<div class="banner warning"><div>${icon('info')}<strong>本地工作台已就绪</strong> · 草稿和排期会保存在这台电脑。请在账号管理中为各账号登录专用 Chrome，再按账号开启投稿。</div>${btn('nav:accounts','管理登录','arrow')}</div>`:''); }
function counts(jobs=state.jobs) {return {total:jobs.filter(j=>j.status!=='cancelled').length,queued:jobs.filter(j=>j.status==='queued').length,reserved:jobs.filter(j=>j.status==='reserved').length,published:jobs.filter(j=>j.status==='published').length,draft:jobs.filter(j=>j.status==='draft').length,attention:jobs.filter(j=>['failed','needs_review','uploading'].includes(j.status)).length}; }
function scopedJobs() {return state.jobs.filter(j=>ui.account==='all'||j.accountId===ui.account).filter(j=>!ui.query||`${j.title} ${j.tags.join(' ')}`.toLowerCase().includes(ui.query.toLowerCase()));}
function filteredJobs() {return scopedJobs().filter(j=>ui.filter==='attention'?['failed','needs_review','uploading'].includes(j.status):j.status===ui.filter).sort((a,b)=>(Date.parse(a.scheduledAt)||Infinity)-(Date.parse(b.scheduledAt)||Infinity)||a.createdAt.localeCompare(b.createdAt));}
function pruneSelection() {const visible=new Set(filteredJobs().map(j=>j.id));for(const id of ui.selected)if(!visible.has(id))ui.selected.delete(id);}
function selectedJobs() {return state.jobs.filter(j=>ui.selected.has(j.id));}
function empty(text='还没有作品',detail='把新的灵感放进来，为它安排一个出场时间。',action='new-work') {return `<div class="empty">${icon('image')}<h3>${text}</h3>${detail}${action?`<br>${btn(action,'添加作品','plus','small')}`:''}</div>`;}
function shell() { const c=counts();return `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-icon">${icon('layers')}</div><div><strong>画序</strong><small>ATELIER FOR PIXIV</small></div></div><div class="nav-label">创作空间</div><nav class="nav" aria-label="主要导航">${Object.entries(views).map(([key,[name,ico]])=>btn(`nav:${key}`,`<span>${name}</span>${key==='works'?`<b class="count">${c.total}</b>`:''}`,ico,ui.view===key?'active':'',`aria-label="${name}"`)).join('')}</nav><div class="sidebar-bottom"><div class="service-card"><strong><i class="status-dot ${state.settings.queuePaused?'warn':''}"></i>${state.mode==='demo'?'演示执行服务':state.connectorConfigured?'本地执行服务':'本地草稿服务'}</strong><p>${state.settings.queuePaused?'队列已暂停，排期仍被保存':state.mode==='demo'?'演示模式 · 不会向 Pixiv 投稿':state.connectorConfigured?'持续运行 · 请保持电脑在线':'已启动 · 投稿连接尚未配置'}</p></div><div class="sidebar-foot"><span class="mini-avatar">本</span><span>本地工作空间</span>${icon('shield')}</div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span> <strong>${views[ui.view][0]}</strong></div><div class="top-actions"><span class="timezone">${zoneLabels[zone()]||escape(zone())}</span><span class="mode-pill">${state.mode==='demo'?'DEMO · 演示':'LOCAL · 本机'}</span>${btn('refresh','', 'refresh','icon-only ghost','aria-label="刷新工作台"')}</div></header><div class="content">${renderView()}</div></main></div>${renderModal()}`; }
function heading(title,subtitle,actions='',eyebrow='YOUR CREATIVE WORKSPACE') {return `<div class="heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;}
function pixivSyncButton() {
  return btn('sync-pixiv',pixivSyncing?'正在同步…':'同步 Pixiv 状态','refresh','',`${pixivSyncing||queueIsRunning()||state.mode==='demo'?'disabled':''} aria-busy="${pixivSyncing}" title="${state.mode==='demo'?'切换到真实工作空间后同步':'核对所有已连接账号的预约名额和作品状态'}"`);
}
function queueIsRunning(){return queueStarting||state?.queueRun?.running===true;}
function queueStartButton(){return state.mode==='demo'?'':btn('start-queue',queueIsRunning()?'正在预约…':'开始预约','play','primary',`${queueIsRunning()||pixivSyncing?'disabled':''} aria-busy="${queueIsRunning()}" title="立即核对发布状态并为待补位作品提交预约；暂停的队列和账号不会提交"`);}
function queueRunSummary(report){return `新增预约 ${report.reserved||0} 件 · 确认发布 ${report.published||0} 件 · 失败 ${report.failed||0} 件 · 需核对 ${report.needsReview||0} 件 · 仍待补位 ${report.remaining||0} 件`;}
function queueRunPanel(){
 if(state.mode==='demo')return '';
 const report=state.queueRun,running=queueIsRunning(),unfinished=report?.startedAt&&!report.completedAt&&!running;
 const attention=Boolean(queueStartError||unfinished||report?.failed||report?.needsReview||report?.errors?.length);
 const message=queueStartError?'启动结果尚未确认：'+queueStartError:running?'正在核对发布状态和预约名额，并行准备待补位作品。':unfinished?'上次预约检查未完成，请刷新状态核对。':report?.completedAt?report.message||'本轮预约检查已结束。':state.settings.queuePaused?'队列已暂停，恢复后可开始预约。':'点击开始预约，立即处理已加入队列的作品。';
 return `<section class="pixiv-sync queue-run${attention?' has-error':''}" aria-label="预约执行状态"><div class="pixiv-sync-message" role="status" aria-live="polite">${icon(running?'refresh':attention?'info':report?.completedAt?'checkCircle':'clock')}<span>${escape(message)}</span></div><p class="queue-run-rule">自动每 6 小时检查；开始预约可立即执行一轮。自动执行需在账号管理中开启投稿，暂停状态仍然有效。</p><p class="queue-run-rule">最多同时准备 2 件作品；同账号依次确认预约，不同账号可同时提交。成功后自动关闭应用本次新开的投稿页；失败或待核对页面保留，原有标签页不变。</p>${report?.completedAt?`<p class="queue-run-summary">${report.source==='automatic'?'最近自动检查':'最近手动预约'} ${dateText(report.completedAt)} · ${escape(queueRunSummary(report))}</p>`:''}${report?.errors?.length?`<details><summary>查看需要处理的情况</summary><ul>${report.errors.map(error=>`<li><strong>${escape(state.accounts.find(account=>account.id===error.accountId)?.name||'预约队列')}</strong><span class="sync-error">${escape(error.message)}</span></li>`).join('')}</ul></details>`:''}</section>`;
}
function pixivSyncPanel() {
  if(state.mode==='demo')return '';
  const report=state.pixivSync;
  const pendingPublications=state.jobs.filter(publicationNeedsReview).length;
  const unfinished=report&&!report.completedAt;
  const attention=Boolean(pixivSyncError||unfinished||report?.failed);
  const summary=report?`成功 ${report.succeeded} 个 · 失败 ${report.failed} 个 · 未连接 ${report.skipped} 个`:'';
  const message=pixivSyncing?'正在核对各账号的 Pixiv 状态，请稍候。':pixivSyncError?'同步未完成：'+pixivSyncError:unfinished?'上次同步未完成，请重新同步。':report?`最近同步 ${dateText(report.completedAt)} · ${summary}`:'同步已连接账号的预约列表、占用名额及可确认的作品状态。';
  return `<section class="pixiv-sync${attention?' has-error':''}" aria-label="Pixiv 同步状态"><div class="pixiv-sync-message" role="status" aria-live="polite">${icon(pixivSyncing?'refresh':attention||!report?.succeeded?'info':'checkCircle')}<span>${escape(message)}</span></div>${pendingPublications?`<p class="queue-run-rule">${pendingPublications} 件远端作品待核实。每 6 小时自动核实，也可点击「同步 Pixiv 状态」立即核实，不会投稿。请保持本地服务运行和账号登录。</p>`:''}${!pixivSyncing&&report?.accounts?.length?`<details><summary>${unfinished||pixivSyncError?'查看上次已返回的账号结果':'查看账号同步结果'}</summary><ul>${report.accounts.map(a=>`<li><strong>${escape(a.name)}</strong><span class="sync-${a.status==='error'?'error':a.status==='success'?'success':'skipped'}">${a.status==='success'?'已同步':a.status==='error'?'失败':'未连接'}</span><span>${escape(a.message)}</span></li>`).join('')}</ul></details>`:''}</section>`;
}
function stats() {const c=counts();return `<div class="stats">${[
['待发布作品',c.queued+c.reserved,'件',`${c.queued} 件等待补位 · ${c.reserved} 件已占预约名额`,'image'],
['Pixiv 预约中',state.accounts.reduce((total,a)=>total+(Number.isInteger(a.remote?.total)?a.remote.total:0),0),'件',state.accounts.some(a=>!a.remote?.syncOk)?'部分账号尚未同步成功，显示已有记录':'含各账号在 Pixiv 站内创建的预约','calendar'],
['已发布作品',c.published,'件',state.mode==='demo'?'仅统计当前演示中的确认结果':'仅统计远端已确认发布的作品','checkCircle'],
['管理中的账号',state.accounts.length,'个',`${state.accounts.filter(a=>a.connected).length} 个${state.mode==='demo'?'演示连接':'已连接'} · ${c.attention} 件作品待处理`,'users']
].map(([label,value,unit,foot,ico])=>`<div class="stat"><div class="stat-icon">${icon(ico)}</div><div class="stat-label">${label}</div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></div>`).join('')}</div>`;}
function queuePanel(full=false) {
 const list=filteredJobs(),c=counts(scopedJobs()),selected=selectedJobs(),blocked=selected.find(j=>j.canDeleteLocally!==true);
 const pageSize=full?12:6,totalPages=Math.max(1,Math.ceil(list.length/pageSize));ui.page=Math.min(ui.page,totalPages);
 const slice=list.slice((ui.page-1)*pageSize,ui.page*pageSize);
 const descriptions={draft:'草稿尚未加入预约队列，完善内容后即可预约。',queued:'已设定好投稿内容，在本机等待预约名额、预约窗口或账号恢复可用。',reserved:'已在 Pixiv 确认预约成功的作品。',published:'已确认发布的作品。',attention:'失败且确认未上传的作品可重新预约；其他作品可打开详情核对。',failed:'确认未上传的失败作品可重新预约；原时间已过期时请先调整排期。'};
 return `<section class="panel"><div class="panel-title"><h2>${full?'我的作品':'投稿队列'}<span>YOUR CREATIVE QUEUE</span></h2>${!full?`<div class="queue-panel-actions"><select id="account-filter" class="form-input select-filter" aria-label="投稿队列账号">${accountOptions(ui.account,true)}</select>${btn('nav:works','管理作品','arrow','ghost small')}</div>`:btn('import','批量导入','upload','small')}</div><div class="filters"><div class="tabs" role="tablist" aria-label="作品状态">${workTabs.map(key=>btn(`filter:${key}`,`${labels[key]}<b>${c[key]}</b>`,'',ui.filter===key?'active':'',`role="tab" aria-selected="${ui.filter===key}"`)).join('')}</div><div class="search">${icon('search')}<input id="search" aria-label="搜索作品" placeholder="搜索作品或标签" value="${escape(ui.query)}"></div></div><div class="queue-context"><span>${descriptions[ui.filter]||labels[ui.filter]||''}</span>${c.attention?btn('attention',`需核对 ${c.attention} 件`,'info','ghost small'):''}</div>${full||ui.selected.size?`<div class="batch-bar"><span>${ui.selected.size?`已选择 ${ui.selected.size} 件作品`:'勾选作品后可批量操作'}</span>${full&&ui.grid?btn('select-page','选择本页','','small',!slice.length?'disabled':''):''}${btn('batch','批量排期','calendar','small',!selected.length||selected.some(isLocked)?'disabled':'')}${btn('delete-selected','删除所选','trash','danger small',`aria-label="删除所选作品" ${!selected.length||blocked?'disabled':''}`)}${ui.selected.size?btn('clear-selection','取消选择','','ghost small'):''}${blocked?`<p class="batch-delete-note">${escape(blocked.deleteBlockedReason||'所选作品包含已提交或结果待核实的记录，请先核对状态。')}</p>`:''}</div>`:''}${!list.length?empty(ui.query?'没有找到匹配作品':'这里还没有作品',ui.query?'试试其他标题或标签。':'添加图片，保存草稿或安排预约。',ui.query?'':'new-work'):ui.grid&&full?`<div class="work-grid">${slice.map(card).join('')}</div>`:table(slice)}<div class="table-footer"><span>共 ${list.length} 件作品${list.length?` · ${(ui.page-1)*pageSize+1}–${Math.min(ui.page*pageSize,list.length)}`:''}</span><div>${btn('prev-page','','left','small',`aria-label="上一页" ${ui.page<=1?'disabled':''}`)} <span>${ui.page} / ${totalPages}</span> ${btn('next-page','','right','small',`aria-label="下一页" ${ui.page>=totalPages?'disabled':''}`)}</div></div></section>`;
}
function table(jobs) {return `<table class="work-table"><thead><tr><th><input type="checkbox" data-action="select-page" aria-label="选择当前页作品" ${jobs.length&&jobs.every(j=>ui.selected.has(j.id))?'checked':''}></th><th>作品</th><th>投稿账号</th><th>计划发布时间</th><th>状态</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr><td><input type="checkbox" data-job-check="${j.id}" aria-label="选择 ${escape(j.title)}" ${ui.selected.has(j.id)?'checked':''}></td><td><div class="work-cell"><img src="${safeUrl(j.files[0]?.url)}" alt="" loading="lazy"><div class="work-info"><button class="work-title ghost" style="padding:0;max-width:100%;display:block" data-action="edit:${j.id}">${escape(j.title||'未命名作品')}</button><div class="work-meta">${j.content.aiGenerated?'<span class="ai-pill">AI</span>':''}<span>${j.content.type==='manga'?'漫画':'插画'}</span><span>·</span><span>${j.files.length} 张</span><span>·</span><span>${j.content.rating==='all'?'全年龄':j.content.rating?.toUpperCase()||'待分级'}</span></div></div></div></td><td><span class="account-inline">${avatar(accountFor(j))}${escape(accountFor(j)?.name||'未选账号')}</span></td><td><div class="date-main">${dateText(j.scheduledAt,true)}</div><div class="date-sub">${j.scheduledAt?(j.timezone==='Asia/Tokyo'?'日本时间已换算':'工作台时间'):''}</div></td><td><div class="work-status-actions">${badge(j.status)}${retryReservationButton(j)}</div></td><td>${btn(`edit:${j.id}`,'','more','row-action',`aria-label="编辑 ${escape(j.title)}"`)}</td></tr>`).join('')}</tbody></table>`;}
function card(j) {return `<article class="art-card"><input class="card-check" type="checkbox" data-job-check="${j.id}" aria-label="选择 ${escape(j.title)}" ${ui.selected.has(j.id)?'checked':''}><img class="art-image" src="${safeUrl(j.files[0]?.url)}" alt="${escape(j.title)}" data-action="edit:${j.id}"><div class="art-card-body"><h3>${escape(j.title||'未命名作品')}</h3><div class="date-sub">${dateText(j.scheduledAt,true)}</div><div class="card-footer"><span class="account-inline">${avatar(accountFor(j))}${escape(accountFor(j)?.name||'未选账号')}</span>${badge(j.status)}</div>${retryReservationButton(j)}</div></article>`;}
function slotsPanel() {return `<section class="panel"><div class="panel-title"><h2>滚动预约 ${icon('refresh')}</h2>${btn('go-settings','运行规则','','ghost small')}</div>${state.accounts.slice(0,3).map(a=>`<div class="slot-account"><div class="slot-head"><span class="account-inline">${avatar(a)}${escape(a.name)}</span><b>${a.remote?.total||0} / 10</b></div><div class="slots" aria-label="${escape(a.name)} 已占用 ${a.remote?.total||0} 个名额">${Array.from({length:10},(_,i)=>`<div class="slot ${i<(a.remote?.total||0)?'filled':''}"></div>`).join('')}</div><div class="slot-caption">${a.paused?'账号队列已暂停':!a.connected?'等待连接账号':state.jobs.filter(j=>j.accountId===a.id&&j.status==='queued').length?`${state.jobs.filter(j=>j.accountId===a.id&&j.status==='queued').length} 件待补位 · 按预约时间安排补位`:'暂无等待中的作品'}</div></div>`).join('')}<div class="rolling-note"><strong>每一次发布，都让下一份创作就位。</strong>确认发布 → 释放名额 → 自动补位<br>超过一周的排期会留在本地等待。</div></section>`;}
function activityPreview() {return `<section class="panel"><div class="panel-title"><h2>最近动态</h2>${btn('nav:activity','全部记录','arrow','ghost small')}</div><div class="activity">${state.logs.slice(0,3).map(l=>`<div class="activity-item">${escape(l.message)}<time>${dateText(l.at)}</time></div>`).join('')||'<div class="activity-item">这里会记录每一次预约、发布和异常。</div>'}</div></section>`;}
function renderView() {
 switch(ui.view) {
 case 'overview':return heading('让创作，按时与世界见面。','整理你的作品，安排下一次相遇。每个账号，每一份灵感，都井然有序。',queueStartButton()+pixivSyncButton()+btn('import','批量导入','upload')+btn('new-work','新建投稿','plus'))+banner()+queueRunPanel()+pixivSyncPanel()+stats()+`<div class="dashboard-grid"><div>${queuePanel()}<p class="native-footer">专注创作，剩下的交给画序。 &nbsp; · &nbsp; 本地工作空间</p></div><aside class="side-stack">${slotsPanel()}${activityPreview()}<div class="tip"><h3>${icon('sparkle')} 给创作留一点从容</h3><p>先准备好作品与标签，再一次安排未来的发布节奏。关掉网页后，请保持本地服务运行。</p></div></aside></div>`;
 case 'works':return heading('每一份创作，都值得被看见。','图片、标签与排期，集中整理。先保存草稿，再从容发布。',btn('new-work','新建投稿','plus','primary'),'YOUR ARTWORK LIBRARY')+banner()+`<div class="section-toolbar"><div class="toolbar-left"><select id="account-filter" class="form-input select-filter" aria-label="按账号筛选">${accountOptions(ui.account,true)}</select><select id="status-filter" class="form-input select-filter" aria-label="按状态筛选">${[...workTabs.map(key=>[key,labels[key]]),['attention','需要核对'],...['uploading','needs_review','failed','cancelled'].map(key=>[key,labels[key]])].map(([key,name])=>option(key,name,ui.filter)).join('')}</select></div><div class="view-switch">${btn('view-list','','list',!ui.grid?'active':'','aria-label="列表视图"')}${btn('view-grid','','grid',ui.grid?'active':'','aria-label="卡片视图"')}</div></div>${queuePanel(true)}`;
 case 'calendar':return renderCalendar();
 case 'analytics':return renderAnalytics();
 case 'accounts':return renderAccounts();
 case 'activity':return heading('每一步，都有迹可循。','查看预约同步、补位结果，以及需要你处理的情况。',state.mode==='demo'?btn('tick','检查队列','refresh'):queueStartButton(),'EXECUTION LOG')+banner()+queueRunPanel()+`<section class="panel"><div class="panel-title"><h2>执行记录 <span>${state.logs.length} 条</span></h2>${state.mode==='demo'?btn('advance','推进到下一批','play','small'):''}</div><div class="activity activity-full">${state.logs.map(l=>`<div class="activity-item">${escape(l.message)}<time>${dateText(l.at)}${l.demo?' · 演示事件':''}</time></div>`).join('')||empty('暂无执行记录','加入预约队列后，操作和结果会显示在这里。','')}</div></section>`;
 case 'settings':return renderSettings();
 }
}
const analyticsPointLabels={current:'截至目前','6h':'发布后 6 小时','12h':'发布后 12 小时','24h':'发布后 24 小时','7d':'发布后 7 天'};
const analyticsMetricLabels={views:'浏览',bookmarks:'收藏',likes:'点赞',bookmarkRate:'收藏浏览比'};
const analyticsCountMetrics=['views','bookmarks','likes'];
const analyticsMetricNouns={views:'浏览量',bookmarks:'收藏数',likes:'点赞数',bookmarkRate:'收藏浏览比'};
const analyticsIntervalLabels={'6h':'0–6 小时','12h':'6–12 小时','24h':'12–24 小时','7d':'24 小时–7 天'};
function analyticsPublicationDate(value){const p=parts(value);return p?`${p.year}年${p.month}月${p.day}日 ${p.hour}:${p.minute}`:'发布时间未知';}
function analyticsNumber(value,digits=0){return typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(value):'—';}
function analyticsRun(){return analytics.status?.run||analytics.status?.collection||analytics.status||{};}
function analyticsRunning(){return analytics.starting||analyticsRun().running===true;}
function analyticsQuery(){return Object.entries({accountId:analytics.accountId,days:analytics.days,dailyDays:analytics.dailyDays,point:analytics.point,group:analytics.group,metric:analytics.metric,sort:analytics.sort,query:analytics.query,limit:25,offset:(analytics.page-1)*25}).map(([key,value])=>`${key}=${encodeURIComponent(value)}`).join('&');}
function resetAnalytics(){analytics.request++;Object.assign(analytics,{accountId:'all',days:'all',dailyDays:'30',page:1,query:'',tableScrollLeft:0,tableScrollReset:true,report:null,status:null,error:'',loading:false,starting:false,composing:false,mode:state.mode});clearTimeout(analyticsSearchTimer);}
async function loadAnalytics({quiet=false,status=true}={}){
 if(analytics.mode!==state.mode)resetAnalytics();
 const request=++analytics.request,mode=state.mode,query=analyticsQuery();
 analytics.loading=true;analytics.error='';if(!quiet)analytics.report=null;if(!quiet&&ui.view==='analytics')render();
 try{
  const results=await Promise.allSettled([api('/api/analytics?'+query,undefined,'GET'),...(status?[api('/api/analytics/status',undefined,'GET')]:[])]);
  if(request!==analytics.request||mode!==state.mode)return;
  if(results[0].status==='rejected')throw results[0].reason;
  analytics.report=results[0].value;
  if(status&&results[1]?.status==='fulfilled')analytics.status=results[1].value;
  else if(status&&results[1]?.status==='rejected')analytics.error='统计已读取，采集状态暂时无法读取：'+results[1].reason.message;
 }catch(error){if(request===analytics.request&&mode===state.mode){analytics.report=null;analytics.error=error.message;}}
 finally{if(request===analytics.request&&mode===state.mode){analytics.loading=false;if(ui.view==='analytics')render();}}
}
async function startAnalyticsCollection(){
 if(analyticsRunning()||state.mode!=='live')return;
 const mode=state.mode;analytics.starting=true;analytics.error='';render();
 try{
  const result=await api('/api/analytics/collect',{accountId:analytics.accountId});
  if(state.mode!==mode)return;
  analytics.status=result.status||result;
  toast(analyticsRun().running?'已开始读取 Pixiv 数据，采集完成后会更新统计。':'本次数据采集已完成。');
  await loadAnalytics({quiet:true});
 }catch(error){if(state.mode===mode)analytics.error='数据采集未完成：'+error.message;}
 finally{if(state.mode===mode){analytics.starting=false;if(ui.view==='analytics')render();}}
}
function analyticsSelect(field,label,choices){return `<label class="analytics-filter"><span>${label}</span><select class="form-input select-filter" data-analytics-filter="${field}" aria-label="${label}">${choices.map(([key,name])=>option(key,name,analytics[field])).join('')}</select></label>`;}
function analyticsCollectionPanel(){
 const run=analyticsRun(),errors=run.errors||[],next=analytics.status?.nextRegularAt||run.nextRegularAt,completed=run.completedAt||analytics.status?.lastCompletedAt;
 const message=analyticsRunning()?'正在读取作品和账号数据，请保持 Chrome 登录。':completed?`最近采集：${dateText(completed)}${run.message?' · '+run.message:''}`:'尚未完成数据采集，点击「更新数据」建立第一份记录。';
 return `<section class="pixiv-sync analytics-collection${analytics.error||errors.length?' has-error':''}" aria-label="数据采集状态"><div class="pixiv-sync-message" role="status" aria-live="polite">${icon(analyticsRunning()?'refresh':errors.length?'info':'clock')}<span>${escape(message)}</span></div><p class="queue-run-rule">作品与账号每 6 小时记录；作品发布后 6 小时、12 小时、24 小时和 7 天另存一次。${next?`下次定时采集：${dateText(next)}。`:''}</p>${analytics.error?`<p class="analytics-error" role="alert">${escape(analytics.error)} ${btn('analytics-reload','重新读取','','small')}</p>`:''}${errors.length?`<details><summary>查看采集异常（${errors.length}）</summary><ul>${errors.map(error=>`<li><strong>${escape(state.accounts.find(a=>a.id===error.accountId)?.name||'数据采集')}</strong><span class="sync-error">${escape(error.message||error)}</span></li>`).join('')}</ul></details>`:''}</section>`;
}
function analyticsSummary(report){
 const s=report.summary||{},values=[['作品总数',s.workCount,'当前账号范围内的已发布作品'],['有效记录',s.sampledWorkCount,'当前时间点、排序指标有值的作品'],['等待采样',s.pendingWorkCount,'未到目标时间，或正在等待本次采集'],['未取得记录',s.missingWorkCount,'缺少观测或指标，不作为 0'],['迟到采样',s.lateWorkCount,'保留实际采样时间，不伪造历史值']];
 return `<div class="stats analytics-summary">${values.map(([label,value,note])=>`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${analyticsNumber(value)}<small>件</small></div><div class="stat-foot">${note}</div></div>`).join('')}</div>`;
}
function analyticsSparkline(history,key,label){
 const valid=history.map((item,index)=>({value:item[key],at:Date.parse(item.observedAt),index})).filter(item=>typeof item.value==='number'&&Number.isFinite(item.value)&&Number.isFinite(item.at));
 if(valid.length<2)return `<div class="analytics-chart-empty">${label}趋势需要至少两次有效记录</div>`;
 const min=Math.min(...valid.map(p=>p.value)),max=Math.max(...valid.map(p=>p.value)),start=Math.min(...valid.map(p=>p.at)),end=Math.max(...valid.map(p=>p.at));
 const point=p=>`${(8+((p.at-start)/(end-start||1))*284).toFixed(2)},${(62-(p.value-min)/(max-min||1)*48).toFixed(2)}`;
 const segments=[];let segment=[];
 for(const p of valid){if(segment.length&&p.index!==segment.at(-1).index+1){segments.push(segment);segment=[];}segment.push(p);}if(segment.length)segments.push(segment);
 return `<svg class="analytics-sparkline" viewBox="0 0 300 78" role="img" aria-label="${escape(label)}趋势，${valid.length} 次有效观测，最低 ${analyticsNumber(min)}，最高 ${analyticsNumber(max)}"><path class="analytics-chart-axis" d="M8 64H292"/>${segments.map(points=>points.length>1?`<polyline points="${points.map(point).join(' ')}"/>`:'' ).join('')}${valid.map(p=>{const[x,y]=point(p).split(',');return `<circle cx="${x}" cy="${y}" r="2.5"><title>${escape(dateText(history[p.index].observedAt))} · ${analyticsNumber(p.value)}</title></circle>`;}).join('')}</svg>`;
}
function analyticsFollowerSeries(record){return record?.sources?.followerCount?.seriesId==='pixiv-followers-page-total-v1';}
function analyticsFollowerValue(record){return analyticsFollowerSeries(record)?record.followers:null;}
function analyticsBeijingTime(value){if(!value)return '';const p=parts(value,'Asia/Shanghai');return p?`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`:'';}
function analyticsDailyValue(metric){return ['complete','partial'].includes(metric?.status)&&typeof metric?.delta==='number'&&Number.isFinite(metric.delta)?metric.delta:null;}
function analyticsDailyNumber(metric){const value=analyticsDailyValue(metric);return value>0?'+'+analyticsNumber(value):analyticsNumber(value);}
function analyticsDailyTrace(metric){
 const start=analyticsBeijingTime(metric?.startAt),end=analyticsBeijingTime(metric?.endAt);
 return `${metric?.status==='partial'?'首个可比记录起；':''}${start?'起点 '+start+'（'+analyticsNumber(metric.startValue)+'）':'缺少起点基准'}${end?'；终点 '+end+'（'+analyticsNumber(metric.endValue)+'）':''} · 北京时间`;
}
function analyticsDailyMissing(metric){
 const reasons={previous_day_missing:'缺少前一日基准',no_observation:'当日未取得记录',metric_missing:'本次采样该项未取得',unsupported_source:'粉丝来源不符合当前口径',incomplete_snapshot:'当轮作品数据未采集完整',first_observation_only:'仅一次记录，尚无增量基准',scope_changed:'作品范围变化，无法比较',source_changed:'数据来源变化，无法比较',observation_span:'采样跨时过长，无法按日比较',invalid_interval:'采样时间无法比较'};
 return reasons[metric?.reason]||'缺少记录或前一日基准';
}
function analyticsTodayDelta(record,key){
 const metric=record.daily?.today?.metrics?.[key],value=analyticsDailyValue(metric),partial=metric?.status==='partial',label=partial?'今日已记录':key==='followers'?'今日净增':'今日增量';
 const note=value===null?analyticsDailyMissing(metric):partial?'首个可比记录起，非完整日增量':metric?.endAt?'截至 '+analyticsBeijingTime(metric.endAt):'截至最新采样';
 return `<p class="analytics-today-delta ${value===null?'missing':value>0?'positive':value<0?'negative':'unchanged'}" title="${escape(analyticsDailyTrace(metric))}"><span>${label} <b>${analyticsDailyNumber(metric)}</b></span><small>${escape(note)}${value!==null&&!partial?' · 北京时间':''}</small></p>`;
}
function analyticsDailyTable(record){
 const rows=[...(record.daily?.rows||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
 return `<details class="analytics-daily"><summary>每日增量（北京时间）<span>最近 ${analytics.dailyDays} 天</span></summary><p class="analytics-note">当天末次采样减前一天末次采样；今天截至最新采样。首日仅有当天基准时标为「首个可比记录起」，缺失日期不补算。</p><div class="analytics-table-scroll"><table class="analytics-table analytics-daily-table"><thead><tr><th>日期</th><th>浏览增量</th><th>收藏增量</th><th>点赞增量</th><th>粉丝净增</th></tr></thead><tbody>${rows.map(row=>`<tr data-analytics-day="${escape(row.date)}"><td>${escape(row.date)}${row.isToday?'<small>今天 · 截至采样</small>':''}</td>${['views','bookmarks','likes','followers'].map(key=>{const metric=row.metrics?.[key],value=analyticsDailyValue(metric);return `<td class="analytics-daily-value ${value===null?'missing':value>0?'positive':value<0?'negative':'unchanged'}" title="${escape(analyticsDailyTrace(metric))}">${analyticsDailyNumber(metric)}<small>${value===null?escape(analyticsDailyMissing(metric)):metric.status==='partial'?'首个可比记录起 · 非完整日增量':row.isToday?'截至采样':'末次采样差值'}</small></td>`;}).join('')}</tr>`).join('')||'<tr><td colspan="5" class="analytics-empty">尚无每日增量记录。完成多次采集后，可查看实际变化。</td></tr>'}</tbody></table></div></details>`;
}
function analyticsAccounts(report){
 const accounts=(report?.accounts||[]).filter(record=>analytics.accountId==='all'||record.accountId===analytics.accountId);
 const overviewTitle=`<div class="analytics-overview-heading"><h2>账号总览</h2><span class="analytics-note">全部作品的最新记录；不受下方排行筛选影响。</span>${analyticsSelect('dailyDays','每日增量范围',[['7','最近 7 天'],['30','最近 30 天'],['90','最近 90 天'],['365','最近一年']])}</div>`;
 if(!accounts.length)return `<section class="analytics-overview" aria-label="账号总览">${overviewTitle}<div class="panel analytics-account-empty">${analytics.loading?'正在读取账号数据…':'尚无账号数据，完成采集后将在这里显示。'}</div></section>`;
 return `<section class="analytics-overview" aria-label="账号总览">${overviewTitle}<div class="analytics-accounts">${accounts.map(record=>{
  const account=state.accounts.find(a=>a.id===record.accountId),latest=record.latest||{},totals=record.totals||{},history=[...(record.history||[])].sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
  const officialViews=typeof latest.views==='number'&&Number.isFinite(latest.views),observedAt=latest.observedAt||totals.observedAt;
  const totalNote=metric=>`<small class="analytics-note analytics-total-note">作品最新有效记录合计${Number.isInteger(totals.metricCounts?.[metric])&&Number.isInteger(totals.workCount)?` · ${analyticsNumber(totals.metricCounts[metric])} / ${analyticsNumber(totals.workCount)} 件有效`:''}</small>`;
  return `<section class="panel analytics-account" data-analytics-account="${escape(record.accountId)}"><div class="panel-title"><h2>${avatar(account)}${escape(account?.name||'已移除账号')}</h2><span class="analytics-note">${observedAt?dateText(observedAt):'尚无记录'}</span></div><div class="analytics-account-metrics"><div><span>账号总浏览量</span><strong>${analyticsNumber(officialViews?latest.views:totals.views)}</strong>${officialViews?'<small class="analytics-note">Pixiv 账号总览</small>':totalNote('views')}${analyticsTodayDelta(record,'views')}${officialViews?analyticsSparkline(history,'views','总浏览量'):''}</div><div><span>总收藏数</span><strong>${analyticsNumber(totals.bookmarks)}</strong>${totalNote('bookmarks')}${analyticsTodayDelta(record,'bookmarks')}</div><div><span>总点赞数</span><strong>${analyticsNumber(totals.likes)}</strong>${totalNote('likes')}${analyticsTodayDelta(record,'likes')}</div><div><span>粉丝数</span><strong>${analyticsNumber(analyticsFollowerValue(latest))}</strong><small class="analytics-note">粉丝页面</small>${analyticsTodayDelta(record,'followers')}${analyticsSparkline(history.map(item=>({...item,followers:analyticsFollowerValue(item)})),'followers','粉丝数')}</div></div>${analyticsDailyTable(record)}<p class="analytics-note analytics-enabled">${record.enabledAt?'新作品增长统计启用：'+escape(dateText(record.enabledAt)):'首次成功采集后开始记录新作品增长'}</p><details class="analytics-history"><summary>查看账号采样记录（${history.length} 次）</summary><div class="analytics-table-scroll"><table class="analytics-table"><thead><tr><th>实际采样时间</th><th>总浏览量</th><th>粉丝数</th></tr></thead><tbody>${history.slice().reverse().map(row=>`<tr><td>${escape(dateText(row.observedAt))}</td><td>${analyticsNumber(row.views)}</td><td>${analyticsNumber(row.followers)}<small>${typeof row.followers!=='number'||!Number.isFinite(row.followers)?'未取得':analyticsFollowerSeries(row)?'粉丝页面':'旧口径（不参与趋势）'}</small></td></tr>`).join('')||'<tr><td colspan="3">尚无记录</td></tr>'}</tbody></table></div></details></section>`;
 }).join('')}</div></section>`;
}
function analyticsWorkUrl(row){const id=String(row.artworkId||row.id||'');if(/^\d+$/.test(id))return 'https://www.pixiv.net/artworks/'+id;try{const url=new URL(row.url);return url.protocol==='https:'&&url.hostname==='www.pixiv.net'&&/^\/artworks\/\d+$/.test(url.pathname)&&!url.username&&!url.password&&!url.port?url.href:'';}catch{return '';}}
function analyticsThumbnailUrl(row){const value=row?.thumbnailUrl;return typeof value==='string'&&/^\/api\/analytics\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/works\/\d+\/thumbnail(?:\?v=[0-9a-f]{12})?$/.test(value)?value:'';}
function analyticsRowName(row,group){
 const work=group==='work'||group==='interval',url=work?analyticsWorkUrl(row):'',account=state.accounts.find(a=>a.id===row.accountId),thumbnail=work?analyticsThumbnailUrl(row):'';
 const title=url?`<a target="_blank" rel="noopener noreferrer" href="${escape(url)}">${escape(row.name||row.title||'未命名作品')}${icon('external')}</a>`:`<strong>${escape(row.name||row.title||'未命名')}</strong>`;
 if(!work)return title+`<small>${analyticsNumber(row.workCount)} 件作品</small>`;
 return `<div class="analytics-work-identity"><span class="analytics-thumb" aria-hidden="true">${icon('image')}${thumbnail?`<img data-analytics-thumbnail src="${escape(thumbnail)}" width="44" height="52" loading="lazy" decoding="async" alt="">`:''}</span><div>${title}<small>${escape(account?.name||'已移除账号')}${row.publishedAt?' · 发布 '+escape(analyticsPublicationDate(row.publishedAt)):''}</small></div></div>`;
}
function analyticsSampling(row){
 if(analytics.group!=='work')return `<span>${analyticsNumber(row.sampleCount)} / ${analyticsNumber(row.workCount)} 件有效</span><small>缺失 ${analyticsNumber(row.missingCount)}${analytics.point!=='current'&&analytics.metric!=='bookmarkRate'?' · 新作品增长样本 '+analyticsNumber(row.growthSampleCount):''}</small>${analytics.point!=='current'&&Number.isInteger(row.growthEligibleWorkCount)?`<small>合格新作品 ${analyticsNumber(row.growthEligibleWorkCount)} · 历史作品 ${analyticsNumber(row.historicalWorkCount)}</small>`:''}${row.observedAt?`<small>最近采样 ${escape(dateText(row.observedAt))}</small>`:''}${row.lateCount?`<small class="analytics-late">${analyticsNumber(row.lateCount)} 件迟到采样</small>`:''}`;
 const pending=row.status==='pending',missing=row.status==='missing'||!row.observedAt;
 if(pending||missing)return `<span class="analytics-missing">${pending?(Date.parse(row.targetAt)>Date.parse(now())?'尚未到采样时间':'已到时间，等待采样'):row.missingReason==='unknown_publication_time'?'发布时间未知':row.missingReason==='missed_window'?'已错过采样时间':'缺少该时间点记录'}</span>${row.targetAt?`<small>目标 ${escape(dateText(row.targetAt))}</small>`:''}`;
 const late=row.latenessMs>0||row.lateCount>0,lateHours=row.latenessMs/3600000;
 return `<span>实际 ${escape(dateText(row.observedAt))}</span>${row.total===null?'<small class="analytics-missing">排序指标尚未取得</small>':''}${row.targetAt?`<small>目标 ${escape(dateText(row.targetAt))}</small>`:''}${late?`<small class="analytics-late">迟到采样${Number.isFinite(lateHours)&&lateHours>0?' · '+analyticsNumber(lateHours,1)+' 小时':''}</small>`:''}${analytics.point!=='current'&&row.growthEligible&&row.intervalHours>0?`<small>发布至采样 ${analyticsNumber(row.intervalHours,2)} 小时</small>`:''}`;
}
function analyticsGrowthUnavailable(row){
 if(row.growthExcludedReason==='published_before_enabled')return '历史作品不参与增长';
 if(row.growthExcludedReason==='unknown_publication_time')return '发布时间不明，未参与增长';
 if(row.growthExcludedReason==='analytics_not_enabled')return '等待首次成功采集启用统计';
 if(row.status==='pending')return '等待固定时间点采样';
 if(row.status==='missing')return '缺少固定时间点记录';
 if(row.growthEligible===false)return '未纳入新作品增长';
 return analytics.group==='work'?'缺少该指标的有效采样':'尚无有效新作品样本';
}
function analyticsRatio(row){const value=row.metrics?.bookmarkRate,views=row.metrics?.views,bookmarks=row.metrics?.bookmarks;return typeof value==='number'&&Number.isFinite(value)&&typeof views==='number'&&Number.isFinite(views)&&views>0&&typeof bookmarks==='number'&&Number.isFinite(bookmarks)?value:null;}
function analyticsPercent(value){return typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('zh-CN',{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(value):'—';}
function analyticsSigned(value){return typeof value==='number'&&value>0?'+'+analyticsNumber(value,2):analyticsNumber(value,2);}
function analyticsSortLabel(metric=analytics.metric){
 if(metric==='bookmarkRate')return analytics.group==='interval'?'节点收藏浏览比':'收藏浏览比';
 const noun=analyticsMetricNouns[metric],grouped=['character','tag'].includes(analytics.group);
 if(analytics.group==='interval')return (analytics.sort==='growth'?'每小时新增':'区间新增')+noun;
 if(analytics.sort==='average')return '平均'+noun;
 if(analytics.sort==='growth')return (grouped?'平均':'')+'每小时'+analyticsMetricLabels[metric]+'增长';
 return noun+(grouped?'合计':'');
}
function analyticsMetricHeader(metric){
 const ratio=metric==='bookmarkRate',grouped=['character','tag'].includes(analytics.group),interval=analytics.group==='interval';
 const label=ratio?(interval?'节点收藏浏览比':'收藏浏览比'):grouped?analyticsSortLabel(metric):analyticsMetricNouns[metric];
 const note=ratio?'累计收藏 ÷ 累计浏览':interval?'区间新增 / 每小时':!grouped&&analytics.point!=='current'?'累计 / 每小时增长':'';
 return '<th class="analytics-metric-heading" aria-sort="'+(analytics.metric===metric?'descending':'none')+'">'+btn('analytics-metric:'+metric,label+(analytics.metric===metric?' ↓':''),'','ghost small','title="按'+escape(analyticsSortLabel(metric))+'排序"')+(note?'<small>'+note+'</small>':'')+'</th>';
}
function analyticsMetricCell(row,metric){
 const grouped=['character','tag'].includes(analytics.group),interval=analytics.group==='interval';
 if(metric==='bookmarkRate')return '<td class="analytics-value analytics-ratio">'+analyticsPercent(analyticsRatio(row))+(grouped?'<small>配对 '+analyticsNumber(row.metricSampleCounts?.bookmarkRate)+' / '+analyticsNumber(row.workCount)+' 件有效</small>':interval?'<small>终点累计比值</small>':'')+'</td>';
 if(interval){const delta=row.deltaMetrics?.[metric],growth=row.growthMetrics?.[metric];return '<td class="analytics-value">'+analyticsSigned(delta)+'<small>每小时 '+analyticsSigned(growth)+'</small>'+(typeof delta==='number'&&delta<0?'<small>数据减少，不列增长名次</small>':'')+'</td>';}
 if(grouped){const kind=analytics.sort==='average'?'averageMetrics':analytics.sort==='growth'?'growthMetrics':'metrics',count=analytics.sort==='growth'?row.growthMetricSampleCounts?.[metric]:row.metricSampleCounts?.[metric];return '<td class="analytics-value">'+analyticsNumber(row[kind]?.[metric],analytics.sort==='total'?0:2)+'<small>'+analyticsNumber(count)+' / '+analyticsNumber(row.workCount)+' 件有效'+(analytics.sort==='growth'?'新作品':'')+'</small></td>';}
 return '<td class="analytics-value">'+analyticsNumber(row.metrics?.[metric])+(analytics.point!=='current'?'<small>每小时增长 '+analyticsNumber(row.growthMetrics?.[metric],2)+'</small>':'')+'</td>';
}
function analyticsIntervalSampling(row){
 const start=row.fromObservedAt||row.intervalStartAt,end=row.toObservedAt||row.intervalEndAt,estimated=row.baselineKind==='publication_zero_estimate';
 const reasons={start_milestone_missing:'起点采样记录缺失',end_milestone_missing:'终点采样记录缺失',start_metric_missing:'起点的排序指标未取得',end_metric_missing:'终点的排序指标未取得',start_milestone_pending:'等待起点节点采样',end_milestone_pending:'等待终点节点采样',invalid_interval:'两端采样时间无法比较'};
 const hasInterval=analyticsCountMetrics.some(key=>typeof row.growthMetrics?.[key]==='number'&&Number.isFinite(row.growthMetrics[key]));
 if(!hasInterval)return '<span class="analytics-missing">'+(reasons[row.missingReason]||(row.samplingBlockedReason==='publication_time_unverified'?'等待核实发布时间':row.growthExcludedReason==='published_before_enabled'?'历史作品不参与增长':row.status==='pending'?'等待区间节点采样':'缺少相邻节点或指标记录'))+'</span>'+(estimated?'<small>起点按发布时为 0 估算</small>':row.fromObservedAt?'<small>起点 '+escape(dateText(row.fromObservedAt))+'</small>':'')+(row.toObservedAt?'<small>终点 '+escape(dateText(row.toObservedAt))+'</small>':'')+(row.targetAt?'<small>目标 '+escape(dateText(row.targetAt))+'</small>':'');
 return '<span>起点 '+(estimated?'按 0 估算':start?escape(dateText(start)):'—')+'</span><small>终点 '+(end?escape(dateText(end)):'—')+'</small><small>实际间隔 '+analyticsNumber(row.intervalHours,2)+' 小时</small>'+(estimated?'<small class="analytics-late">0–6 小时以发布时点'+(start?' '+escape(dateText(start)):'')+'为起点，起点按 0 估算</small>':'');
}
function analyticsIntervalRanking(report){
 const rows=report.rows||[],page=report.pagination||{},total=page.total??rows.length,totalPages=Math.max(1,Math.ceil(total/25)),ratio=analytics.metric==='bookmarkRate';
 return '<section class="panel analytics-ranking analytics-ranking-interval" aria-busy="'+analytics.loading+'"><div class="panel-title"><h2>分时段增长 <span>'+analyticsIntervalLabels[analytics.point]+' · 按'+analyticsSortLabel()+'排序</span></h2><span class="analytics-note">共 '+total+' 件</span></div><div class="analytics-table-scroll"><table class="analytics-table"><thead><tr><th>'+(ratio?'排名':'增长名次')+'</th><th>作品</th>'+Object.keys(analyticsMetricLabels).map(analyticsMetricHeader).join('')+'<th>两端采样记录</th></tr></thead><tbody>'+rows.map((row,index)=>{const growth=row.growthMetrics?.[analytics.metric],ranked=ratio?analyticsRatio(row)!==null:typeof growth==='number'&&growth>0;return '<tr><td class="analytics-rank">'+(ranked?(analytics.page-1)*25+index+1:'—')+'</td><td class="analytics-name">'+analyticsRowName(row,'interval')+'</td>'+Object.keys(analyticsMetricLabels).map(metric=>analyticsMetricCell(row,metric)).join('')+'<td class="analytics-sampling">'+analyticsIntervalSampling(row)+'</td></tr>';}).join('')+(rows.length?'':'<tr><td colspan="7" class="analytics-empty">尚无符合筛选的分时段增长记录。需要新作品到达区间节点并完成实际采样。</td></tr>')+'</tbody></table></div><div class="table-footer"><span>'+(ratio?'节点收藏浏览比取终点累计值，不能当作区间新增比':'缺少节点不补算；只有正增长显示增长名次')+'</span><div>'+btn('analytics-page:prev','','left','small','aria-label="统计上一页" '+(analytics.page<=1||analytics.loading?'disabled':''))+' <span>'+analytics.page+' / '+totalPages+'</span> '+btn('analytics-page:next','','right','small','aria-label="统计下一页" '+(analytics.page>=totalPages||analytics.loading?'disabled':''))+'</div></div></section>';
}
function analyticsRanking(report){
 if(analytics.group==='interval')return analyticsIntervalRanking(report);
 const rows=report.rows||[],group=analytics.group,grouped=group!=='work',groupName={work:'作品',character:'角色',tag:'标签'}[group],page=report.pagination||{},total=page.total??rows.length,totalPages=Math.max(1,Math.ceil(total/25));
 return '<section class="panel analytics-ranking analytics-ranking-'+group+'" aria-busy="'+analytics.loading+'"><div class="panel-title"><h2>'+groupName+'排行 <span>'+analyticsPointLabels[analytics.point]+' · 按'+analyticsSortLabel()+'排序</span></h2><span class="analytics-note">'+(analytics.loading?'正在读取…':'共 '+total+' '+(group==='work'?'件':'项'))+'</span></div><div class="analytics-table-scroll"><table class="analytics-table"><thead><tr><th>排名</th><th>'+groupName+'</th>'+Object.keys(analyticsMetricLabels).map(analyticsMetricHeader).join('')+'<th>'+(group==='work'?'采样记录':'样本覆盖')+'</th></tr></thead><tbody>'+rows.map((row,index)=>'<tr><td class="analytics-rank">'+((analytics.page-1)*25+index+1)+'</td><td class="analytics-name">'+analyticsRowName(row,group)+'</td>'+Object.keys(analyticsMetricLabels).map(metric=>analyticsMetricCell(row,metric)).join('')+'<td class="analytics-sampling">'+analyticsSampling(row)+(group==='work'&&analytics.point!=='current'&&row.growthEligible===false&&row.growthExcludedReason!=='ratio_not_defined'?'<small>'+analyticsGrowthUnavailable(row)+'</small>':'')+'</td></tr>').join('')+(rows.length?'':'<tr><td colspan="7" class="analytics-empty">'+(analytics.loading?'正在读取统计…':analytics.query?'没有匹配的作品、角色或标签。':'尚无可展示数据。完成采集后，记录会显示在这里。')+'</td></tr>')+'</tbody></table></div><div class="table-footer"><span>— 表示尚无数据'+(grouped?'，不计入平均值':'')+'；浏览为 0 或缺失时，收藏浏览比显示 —</span><div>'+btn('analytics-page:prev','','left','small','aria-label="统计上一页" '+(analytics.page<=1||analytics.loading?'disabled':''))+' <span>'+analytics.page+' / '+totalPages+'</span> '+btn('analytics-page:next','','right','small','aria-label="统计下一页" '+(analytics.page>=totalPages||analytics.loading?'disabled':''))+'</div></div></section>';
}
function renderAnalytics(){
 const report=analytics.mode===state.mode?analytics.report:null;
 const interval=analytics.group==='interval',grouped=['character','tag'].includes(analytics.group),ratio=analytics.metric==='bookmarkRate',choices=interval?[['growth','每小时新增最快'],['total',ratio?'节点比值最高':'区间新增最多']]:[['total',ratio?'比值最高':grouped?'合计最高':'累计值最高'],...(grouped?[['average','每作品平均最高']]:[]),...(analytics.point==='current'?[]:[['growth','每小时增长最快']])];
 return heading('看见作品的每一步成长。','比较作品、角色与标签的表现，让每次创作都有数据可参考。',btn('analytics-collect',analyticsRunning()?'正在采集…':'更新数据','refresh','primary',`${analyticsRunning()||state.mode==='demo'?'disabled':''} aria-busy="${analyticsRunning()}"`) ,'YOUR ARTWORK INSIGHTS')+(state.mode==='demo'?'<div class="banner">当前为演示空间，真实账号数据请在真实工作空间查看。</div>':'')+`<section class="panel analytics-account-picker" aria-label="选择统计账号">${analyticsSelect('accountId','统计账号',[['all','全部账号'],...state.accounts.map(a=>[a.id,a.name])])}<p class="analytics-note">选择需要显示的账号；全部账号会分别展示各自的数据。</p></section>`+analyticsAccounts(report)+analyticsCollectionPanel()+`<section class="panel analytics-controls"><div class="analytics-group-tabs" role="tablist" aria-label="统计排行类型">${[['work','作品排行'],['character','角色排行'],['tag','标签排行'],['interval','分时段增长']].map(([key,label])=>btn('analytics-group:'+key,label,'',analytics.group===key?'active':'',`role="tab" aria-selected="${analytics.group===key}"`)).join('')}</div><div class="analytics-filters">${analyticsSelect('point',interval?'增长区间':'比较时间点',Object.entries(interval?analyticsIntervalLabels:analyticsPointLabels))}${analyticsSelect('days','作品发布时间',[['all','全部作品'],['30','30天内'],['90','90天内'],['180','180天内'],['365','一年内']])}${analyticsSelect('sort','排序方式',choices)}</div><div class="analytics-query-row"><div class="search">${icon('search')}<input id="analytics-query" aria-label="搜索统计作品、角色或标签" placeholder="搜索作品、角色或标签" value="${escape(analytics.query)}"></div><span class="analytics-note">${report?.generatedAt?'报告读取于 '+dateText(report.generatedAt):'记录保存在本机'}</span></div><p class="analytics-note analytics-average-note">${interval?'各列显示区间新增与每小时新增；每小时新增 = 区间新增 ÷ 两端实际采样间隔。节点收藏浏览比使用终点累计收藏 ÷ 终点累计浏览，不能当作新增比。':grouped?'平均浏览量、收藏数、点赞数 = 该'+(analytics.group==='character'?'角色':'标签')+'所属作品的各项合计 ÷ 对应有效作品数。收藏浏览比仅使用浏览与收藏均有记录且浏览大于 0 的配对作品：收藏合计 ÷ 浏览合计，不取单件比值的平均。':'各列同时显示每件作品的浏览量、收藏数和点赞数；固定时间点附每小时增长。收藏浏览比 = 收藏数 ÷ 浏览量。'} 点击列标题切换排序；浏览为 0 或缺失时不计算比值。</p><p class="analytics-note analytics-growth-note">增长排行仅比较启用统计后发布的新作品。${interval?'0–6 小时的起点按发布时为 0 估算；其余区间需要相邻两个真实节点。缺失不补算，负值保留，仅正增长显示增长名次。':analytics.point==='current'?'请选择发布后 6 小时、12 小时、24 小时或 7 天；截至目前保留全部作品的普通排行。':'以当前节点累计数 ÷ 发布至实际采样小时数计算，再按有效新作品平均。历史作品不参与增长排名。'}</p></section>`+(report?analyticsSummary(report)+analyticsRanking(report):`<section class="panel">${empty(analytics.loading?'正在读取数据':'尚无统计记录',analytics.error?'读取失败，可点击上方「重新读取」。':'点击「更新数据」读取账号和已发布作品的表现。','')}</section>`)+`<details class="analytics-method"><summary>统计与增长如何计算</summary><p>合计只累加有值的作品；平均值按当前指标的有效作品数计算。增长排行仅统计各账号首次成功采集后发布的新作品，历史作品不参与。作品、角色和标签的固定节点增长使用该节点累计数除以发布至实际采样的小时数，再按有效新作品取平均。分时段增长单独使用相邻两个节点的新增量除以实际间隔小时；0–6 小时的起点按发布时为 0 估算，其他区间必须有两端真实记录。增长样本数与普通排行样本数分别列出；截至目前不提供增长排序。</p><p>各时间点保存实际采样值；错过的时间点会标为缺失或迟到，不以今天的数据当作过去的准时数据。当前排行使用最近一次观测；每日增量按北京时间显示，其余时间按工作台时区显示。</p><p>角色只统计已明确关联的角色；标签保留原始拼写。同一作品可计入多个角色或标签，因此不同分组的合计不能直接相加作为账号总量。</p></details>`;
}
function calendarEvent(job){
 const account=accountFor(job),name=account?.name||'未选账号',color=accountColor(account);
 return `<button class="calendar-event ${escape(job.status)}" style="--account-color:${color}" data-action="edit:${escape(job.id)}" title="${escape(name)} · ${escape(job.title)} · ${dateText(job.scheduledAt)} · ${labels[job.status]||escape(job.status)}"><span class="calendar-event-account">${avatar(account)}<span>${escape(name)}</span></span><span class="calendar-event-title">${wall(job.scheduledAt).slice(11)} ${escape(job.title||'未命名作品')}</span><span class="calendar-event-status">${labels[job.status]||escape(job.status)}</span></button>`;
}
function renderCalendar() {
 if(!ui.month)ui.month=dateKey(now()).slice(0,7);
 const [year,month]=ui.month.split('-').map(Number),first=new Date(Date.UTC(year,month-1,1)),start=+first-((first.getUTCDay()+6)%7)*86400000;
 return heading('把未来的发布，安排妥当。','每条排期显示投稿账号，账号颜色保持一致。日历按工作台时区显示。',btn('new-work','新建投稿','plus','primary'),'YOUR PUBLISHING RHYTHM')+banner()+`<section class="panel"><div class="panel-title"><div class="calendar-head">${btn('month-prev','','left','icon-only ghost','aria-label="上个月"')}<strong>${year} 年 ${month} 月</strong>${btn('month-next','','right','icon-only ghost','aria-label="下个月"')}${btn('month-today','今天','','small')}</div><select id="account-filter" class="form-input select-filter" aria-label="日历账号">${accountOptions(ui.account,true)}</select></div><div class="calendar-account-legend" aria-label="日历账号图例">${state.accounts.filter(account=>ui.account==='all'||account.id===ui.account).map(account=>`<span class="account-inline" style="--account-color:${accountColor(account)}">${avatar(account)}${escape(account.name)}</span>`).join('')}</div><div class="calendar-week">${['周一','周二','周三','周四','周五','周六','周日'].map(x=>`<span>${x}</span>`).join('')}</div><div class="calendar">${Array.from({length:42},(_,i)=>{const day=new Date(start+i*86400000),key=day.toISOString().slice(0,10);const jobs=state.jobs.filter(job=>dateKey(job.scheduledAt)===key&&job.status!=='cancelled'&&(ui.account==='all'||job.accountId===ui.account));return `<div class="calendar-day ${day.getUTCMonth()!==month-1?'outside':''} ${key===dateKey(now())?'today':''}"><span class="day-number">${day.getUTCDate()}</span>${jobs.slice(0,3).map(calendarEvent).join('')}${jobs.length>3?btn(`day:${key}`,`另有 ${jobs.length-3} 件作品`,'','day-more ghost'):''}</div>`;}).join('')}</div></section>`;
}
function dedicatedBrowserReady(account){return account?.browser?.mode==='dedicated'&&account.connected&&!account.browser.loginPending;}
function accountBrowserControls(account){
 const dedicated=account.browser?.mode==='dedicated',ready=dedicatedBrowserReady(account),pending=dedicatedBrowserUi.pending?.accountId===account.id?dedicatedBrowserUi.pending.action:'',busy=Boolean(pending),error=dedicatedBrowserUi.errors[account.id];
 const status=dedicated?(ready?'已核对 Pixiv '+escape(account.pixivUserId):'请登录 Pixiv '+escape(account.pixivUserId)+'，再确认身份。'):account.browser?'现有 Chrome · 已绑定 Pixiv '+escape(account.pixivUserId):'为这个账号使用独立的专用 Chrome，首次需要登录一次。';
 const mode=dedicated&&account.browser.runtimeMode?(account.browser.runtimeMode==='headless'?'后台':'登录窗口'):'';
 const dedicatedActions=dedicated?btn('browser-dedicated-open:'+account.id,pending==='open'?'正在打开…':'打开登录窗口','external','small',busy?'disabled':'')+btn('browser-dedicated-verify:'+account.id,pending==='verify'?'正在核对…':'确认已登录','checkCircle','small',busy?'disabled':'')+btn('browser-dedicated-background:'+account.id,pending==='background'?'正在转入后台…':'转到后台','play','small',busy||!ready?'disabled':''):btn('browser-dedicated-open:'+account.id,pending==='open'?'正在打开…':'使用专用 Chrome','external','small primary',busy?'disabled':'');
 const sharedActions=account.browser?btn('browser-sync:'+account.id,'同步预约','refresh','small',busy||dedicated&&!ready?'disabled':'')+btn('browser-posting:'+account.id,account.browser.postingEnabled?'关闭投稿':'开启投稿',account.browser.postingEnabled?'pause':'play','small',busy||dedicated&&!ready&&!account.browser.postingEnabled?'disabled':''):'';
 return '<div class="browser-account-note"><p>'+status+'</p>'+(account.browser?'<p>'+(account.browser.postingEnabled?'浏览器投稿已开启':'仅连接与同步')+(mode?' · 上次运行方式：'+mode:'')+'</p>':'')+(dedicated&&!ready?'<small>身份核对完成前不会投稿；账号资料、历史和排期保持不变。</small>':'')+(error?'<p class="field-error" role="alert">'+escape(error)+'</p>':account.remote?.error?'<p class="field-error">'+escape(account.remote.error)+'</p>':'')+(account.remote?.syncedAt?'<small>上次核对：'+dateText(account.remote.syncedAt)+'</small>':'')+'</div><div class="account-actions account-browser-actions" aria-busy="'+busy+'">'+dedicatedActions+(!dedicated?btn('browser-discover:'+account.id,account.browser?'重新绑定现有 Chrome':'连接现有 Chrome','link','small',busy?'disabled':''):'')+sharedActions+'</div>';
}
function renderAccounts() {
 return heading('多个账号，一个创作空间。','每个账号独立管理预约名额、排期和连接状态。',(state.mode==='live'?btn('browser-discover','连接现有 Chrome','link','ghost'):'')+btn('add-account','添加账号','plus','primary'),'YOUR CONNECTED ACCOUNTS')+banner()+(state.mode==='live'?'<section class="panel dedicated-browser-guide"><strong>每个账号登录一次，之后在后台运行。</strong><p>打开专用 Chrome 登录窗口，登录对应的 Pixiv 账号，点击「确认已登录」，再「转到后台」。转到后台会关闭该账号的专用登录窗口并保留登录状态。</p><p>日常 Chrome 窗口不受影响；后续无需批准日常 Chrome 的远程调试连接。登录过期时，重新打开登录窗口即可。</p><small>迁移前已开启的投稿会在原账号身份核对成功后恢复；原来未开启的不会自动开启。</small></section>':'')+'<div class="accounts-grid">'+state.accounts.map(a=>{
  const dedicated=a.browser?.mode==='dedicated',ready=dedicated?dedicatedBrowserReady(a):a.connected;
  return '<article class="panel account-card"><div class="account-card-top">'+avatar(a,'large')+'<div><h3>'+escape(a.name)+'</h3><p>'+escape(a.pixivUserId||'尚未填写 Pixiv ID')+'</p></div>'+(a.premium?'<span class="premium">PREMIUM</span>':'')+'</div><span class="badge '+(ready?'published':'needs_review')+'">'+(state.mode==='demo'?'演示连接':dedicated?'专用 Chrome · '+(ready?'已连接':'待登录'):a.connected?'现有 Chrome · 已连接':'待连接')+'</span><div class="account-details"><div><label>Pixiv 预约名额</label><strong>'+(a.remote?.total||0)+' <small>/ 10</small></strong></div><div><label>本地等待作品</label><strong>'+state.jobs.filter(j=>j.accountId===a.id&&j.status==='queued').length+'</strong></div></div><div class="slots">'+Array.from({length:10},(_,i)=>'<div class="slot '+(i<(a.remote?.total||0)?'filled':'')+'"></div>').join('')+'</div>'+(state.mode==='live'?accountBrowserControls(a):'')+'<div class="account-actions">'+btn('account-edit:'+a.id,'账号设置','settings','small')+btn('account-pause:'+a.id,a.paused?'恢复队列':'暂停队列',a.paused?'play':'pause','small')+btn('account-remove:'+a.id,'','trash','small icon-only','aria-label="移除 '+escape(a.name)+'"')+'</div></article>';
 }).join('')+'<button class="add-account" data-action="add-account">'+icon('plus')+'添加一个创作账号<small>添加后可打开专用 Chrome 登录对应账号</small></button></div>';
}
function renderSettings() {return heading('为你的创作，设定合适的节奏。','本地保存，明确确认。真实连接能力会在此显示。','','WORKSPACE PREFERENCES')+`<div class="settings-grid"><div class="panel setting-panel"><h2>工作空间</h2><p>演示数据与真实工作空间分开保存，可以随时切换。</p><div class="setting-row"><div><strong>演示模式</strong><p>使用 30 件示例作品体验滚动预约。</p></div><button class="toggle ${state.mode==='demo'?'on':''}" data-action="${state.mode==='demo'?'switch-live':'switch-demo'}" role="switch" aria-checked="${state.mode==='demo'}" aria-label="切换演示模式"></button></div><div class="setting-row"><div><strong>工作台时区</strong><p>用于日历与列表显示。投稿预约固定为日本时间。</p></div><select id="setting-timezone" class="form-input">${Object.entries(zoneLabels).map(([key,label])=>option(key,label,zone())).join('')}</select></div><div class="setting-row"><div><strong>滚动预约</strong><p>自动每 6 小时检查；开始预约可立即执行一轮。发布确认后自动释放名额并补位。最多同时准备 2 件作品；同账号依次确认预约，不同账号可同时提交。</p></div><button class="toggle ${!state.settings.queuePaused?'on':''}" data-action="pause-queue" role="switch" aria-checked="${!state.settings.queuePaused}" aria-label="滚动预约开关"></button></div><div class="setting-row"><div><strong>投稿页面</strong><p>确认预约成功后，只关闭应用本次新开的投稿页。失败或待核对时保留页面，原有标签页保持不变。</p></div></div><div class="setting-row"><div><strong>角色记忆</strong><p>共用你确认的角色名与图片特征；演示和真实空间分别保存。</p></div>${btn('memory-manage','管理记忆','users','small')}</div><div class="setting-row"><div><strong>数据备份</strong><p>导出账号资料与投稿表单；不包含图片和登录凭据。</p></div>${btn('export','导出记录','download','small')}</div>${state.mode==='demo'?`<div class="setting-row"><div><strong>体验下一次自动补位</strong><p>推进演示时钟，并模拟远端发布确认。</p></div>${btn('advance','推进时间','play','small')}</div><div class="setting-row"><div><strong>重置演示工作台</strong><p>恢复最初的 30 件示例作品。</p></div>${btn('reset-demo','重置演示','refresh','small')}</div>`:''}</div><div class="side-stack"><div class="panel setting-panel"><h2>真实连接状态</h2><p>${state.connectorConfigured?'已配置账号浏览器连接。每次投稿前核对账号和预约名额。':'在账号管理中使用专用 Chrome，分别登录每个 Pixiv 账号，再转到后台运行。'}</p><div class="capability-list"><span>${icon('checkCircle')}图片与草稿：保存在本机</span><span>${icon('checkCircle')}多账号、排期、滚动队列：已实现</span><span>${icon(state.connectorConfigured?'link':'info')}Pixiv 账号连接：${state.connectorConfigured?'已配置，按账号单独开启投稿':'等待连接 Chrome'}</span><span>${icon(state.tagger?.available?'checkCircle':'info')}本地图像识别：${state.tagger?.available?'已就绪':'尚未就绪'}</span><span>${icon('shield')}Pixiv 全站标签搜索 · 当前账号常用标签优先</span><span>${icon('info')}支持基础投稿选项与三种分级；问卷不纳入本版</span></div><div class="setting-row"><div><strong>专用 Chrome 登录</strong><p>每个账号首次独立登录并确认身份，再转到后台。登录过期时重新登录；也兼容现有 Chrome 连接。</p></div>${btn('nav:accounts','账号管理','users','small')}</div><p class="help">当前浏览器自动填写基础投稿选项、图片、标签与预约时间。系列、关联作品、使用工具、成人内容属性及自定义缩略图尚需手动设置；应用会在上传前提示。</p><div class="setting-row"><div><strong>检查本地识图</strong><p>${escape(state.tagger?.message||'在本机识别角色与分级，再通过已登录的 Chrome 匹配标签。')}</p></div>${btn('check-tagger','检查状态','refresh','small')}</div><table class="policy-table"><tr><td>每个账号的远端预约上限</td><td>10 件 · Premium</td></tr><tr><td>远端预约窗口</td><td>未来 7 天</td></tr><tr><td>预约时间选择</td><td>整点 / 半点</td></tr><tr><td>本地长期队列</td><td>不受 10 件限制</td></tr></table></div><div class="panel setting-panel"><h2>官方规则参考</h2><p>当前支持插画与漫画。小说和动图不在这一版中。</p><ul class="source-list"><li><a target="_blank" rel="noreferrer" href="https://www.pixiv.help/hc/ja/articles/115003430413">预约投稿规则 ${icon('external')}</a></li><li><a target="_blank" rel="noreferrer" href="https://www.pixiv.help/hc/ja/articles/235584588">插画投稿与图片限制 ${icon('external')}</a></li><li><a target="_blank" rel="noreferrer" href="https://www.pixiv.help/hc/ja/articles/235645927">作品公开范围 ${icon('external')}</a></li></ul></div></div></div>`;}

function postingTime(a={}) {return a.defaultPostingTime || '09:00';}
function nextSchedule(accountId) {
  const a=state.accounts.find(a=>a.id===accountId), current=Date.parse(now());
  const date=new Date(current+9*3600000).toISOString().slice(0,10);
  const candidate=Date.parse(`${date}T${postingTime(a)}:00+09:00`);
  return new Date(candidate>current?candidate:candidate+86400000).toISOString();
}
function timeOptions(value) {return Array.from({length:48},(_,i)=>{const time=String(Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00');return option(time,time+' JST',value);}).join('');}
function draftNew() {const accountId=ui.account!=='all'?ui.account:state.accounts[0]?.id||'';return {accountId,title:'',caption:'',tags:[],tagsConfirmed:false,files:[],status:'draft',scheduledAt:nextSchedule(accountId),timezone:'Asia/Tokyo',content:{type:'illust',aiGenerated:true,rating:null,visibility:'public',original:false,sexualContent:null,allowTagEdit:true,allowComments:true,allowCollection:true,adultAttributes:[],tools:[],seriesId:'',imageResponse:'',allowImageResponse:false,contestTag:'',poll:{question:'',answers:[]},thumbnail:{page:1,x:.5,y:.5}}};}

function isLocked(j) {return ['uploading','reserved','published'].includes(j.status)||(j.status==='needs_review'&&j.reviewReason!=='schedule_expired')||(j.status==='failed'&&!canRetryReservation(j));}
function field(label,content,help='') {const match=content.match(/data-field="([^"]+)"/);const id=match?`field-${match[1].replaceAll('.','-')}`:null;if(id)content=content.replace(/<(input|select|textarea) /,`<$1 id="${id}" `);return `<div class="field"><label ${id?`for="${id}"`:''}>${label}</label>${content}${help?`<p class="help">${help}</p>`:''}</div>`;}
function input(name,value,placeholder='',extra='') {return `<input data-field="${name}" value="${escape(value)}" placeholder="${escape(placeholder)}" ${extra}>`;}
function checkField(name,checked,label) {return `<label class="checkbox-line"><input type="checkbox" data-field="${name}" ${checked?'checked':''}>${label}</label>`;}
function radio(name,value,selected,label) {return `<label class="radio-option"><input type="radio" name="${name}" data-field="${name}" value="${value}" ${String(value)===String(selected)?'checked':''}>${label}</label>`;}
function memoryEligible(m) {return m?.kind==='editor'&&!isLocked(m.draft)&&m.draft.files.length===1&&m.analysis?.source==='local'&&Boolean(m.analysis.memoryAnalysisId)&&m.suggestionSignature===fileSelectionSignature(m.draft)&&!m.recognition?.perFile?.some(file=>file.multiple);}
function memoryInput(label,key,value,placeholder,maxLength=256) {return `<div class="field"><label for="memory-${key}">${label}</label><input id="memory-${key}" data-memory-field="${key}" value="${escape(value)}" placeholder="${escape(placeholder)}" maxlength="${maxLength}"></div>`;}
function memoryTagEditor(m,label,key,placeholder) {
 const tags=m.memoryForm[key]||[],pending=m.memoryTagInputs?.[key]||'';
 return `<div class="field memory-tag-field"><label for="memory-tag-input-${key}">${label}<span>${tags.length} / 4</span></label><div class="tag-editor memory-tag-editor" data-memory-tags="${key}">${tags.map((tag,index)=>`<span class="tag">${escape(tag)}${btn(`memory-tag-remove:${key}:${index}`,'','close','',`aria-label="移除${label} ${escape(tag)}"`)}</span>`).join('')}<input id="memory-tag-input-${key}" data-memory-tag-input="${key}" value="${escape(pending)}" placeholder="${escape(placeholder)}" aria-label="添加${label}">${btn(`memory-tag-add:${key}`,'添加','','small memory-tag-add',`aria-label="添加到${label}"`)}</div></div>`;
}
function renderCharacterMemory(m) {
 if(!memoryEligible(m))return '';
 const exact=m.recognition?.memory?.exact, candidates=m.recognition?.memory?.candidates||[], form=m.memoryForm;
 const busy=m.memorySaving||m.suggesting||m.uploading;
 return `<section class="character-memory" aria-label="角色记忆"><div class="character-memory-head"><strong>${icon('users')}角色记忆</strong>${btn('memory-open',form?'重新填写':exact?'更正角色':'记住此角色','','small',busy?'disabled':'')}</div>${exact?`<p class="help" role="status">已按你确认的记忆识别为 ${escape(exact.englishName)}。</p>`:'<p class="help">识别不出或认错时，填写角色英文名并确认。本机保存，两个账号共用；不会仅凭修改标题自动记忆。</p>'}${m.memoryError?`<p class="field-error" role="alert">${escape(m.memoryError)}</p>`:''}${m.memoryMessage?`<p class="help" role="status">${escape(m.memoryMessage)}</p>`:''}${form?`<fieldset class="memory-fields" ${busy?'disabled':''}>${memoryInput('角色英文名','englishName',form.englishName,'例如 Robin',32)}${renderNameResolution(m,'memory')}${memoryTagEditor(m,'所属游戏标签','gameTags','输入游戏标签，按回车添加')}${memoryTagEditor(m,'角色标签','characterTags','输入角色标签，按回车添加')}<p class="help">每类可选填 4 个标签。输入后按回车或点击添加，也可用逗号一次粘贴多个标签。这里只记录角色身份；每张新图的分级与画面标签仍重新识别。</p><label class="checkbox-line"><input type="checkbox" data-memory-field="confirmedSingleCharacter" ${form.confirmedSingleCharacter?'checked':''}>我确认图中只有这一个角色，以上名称就是该角色</label><div class="memory-actions">${btn('memory-cancel','收起','','ghost small',busy?'disabled':'')}${btn('memory-save',m.memorySaving?'正在记忆…':'确认并记住','check','small',busy||!form.confirmedSingleCharacter?'disabled':'')}</div></fieldset>`:candidates.length?`<div class="memory-candidates"><p class="help">以下只是外观相似的候选，请确认后再使用。</p><label class="checkbox-line"><input type="checkbox" data-memory-candidate-confirm ${m.memoryCandidateConfirmed?'checked':''} ${busy?'disabled':''}>我确认图中只有一个角色</label>${candidates.slice(0,3).map((candidate,i)=>`<div class="memory-candidate"><div><strong>可能是 ${escape(candidate.englishName)}</strong><p>${escape((candidate.gameTags||[]).join(' · '))}${candidate.sampleCount?` · 已记忆 ${Number(candidate.sampleCount)} 张`:''}</p></div>${btn(`memory-candidate:${i}`,'确认是此角色并记住','','small',busy||!m.memoryCandidateConfirmed?'disabled':'')}</div>`).join('')}</div>`:''}<p class="help">同图会沿用已确认的名称；新图的相似候选需要你确认。可在设置中删除记忆。</p></section>`;
}
function renderMemoryLibrary(m) {
 if(m.loading)return '<p class="modal-summary" role="status">正在读取本机角色记忆…</p>';
 const characters=m.characters||[];
 return `${m.error?`<p class="field-error" role="alert">${escape(m.error)}</p>`:''}<p class="modal-summary">${state.mode==='demo'?'演示空间':'真实工作空间'} · 两个账号共用角色记忆。图片特征与确认的角色名保存在本机，演示与真实数据分开保存。</p>${characters.length?`<div class="memory-library">${characters.map(character=>`<article class="memory-record"><div class="memory-record-head"><div><strong>${escape(character.englishName)}</strong><p>已记忆 ${Number(character.sampleCount)||0} 张 · ${escape(dateText(character.updatedAt))}</p></div>${btn(`memory-delete:${character.id}`,'删除记忆','trash','small',m.deleting?'disabled':'')}</div>${(character.gameTags||[]).length?`<p>游戏：${escape(character.gameTags.join(' · '))}</p>`:''}${(character.characterTags||[]).length?`<p>角色：${escape(character.characterTags.join(' · '))}</p>`:''}${m.deleteId===character.id?`<div class="memory-delete-confirm"><p>删除 ${escape(character.englishName)} 的全部角色记忆？已保存的作品与图片会保留。</p><div class="memory-actions">${btn('memory-delete-cancel','取消','','small',m.deleting?'disabled':'')}${btn(`memory-delete-confirm:${character.id}`,m.deleting?'正在删除…':'确认删除','','danger small',m.deleting?'disabled':'')}</div></div>`:''}</article>`).join('')}</div>`:'<p class="memory-empty">还没有角色记忆。上传单张图片并完成识图后，可在标题下方点击「记住此角色」。</p>'}`;
}
function renderModal() {
 const m=ui.modal;if(!m)return '';let title='',sub='',body='',footer='',wide=false;
 if(m.kind==='editor') {const d=m.draft;const c=d.content;const locked=isLocked(d);title=d.id?'作品详情':'新建投稿';sub=locked?'该作品已有远端记录，仅查看，避免重复投稿。':'添加作品、完善信息，为创作安排一个好时间。';wide=true;
 body=`${editorIssue(d)}${m.error?`<div class="field-error" role="alert">${escape(m.error)}</div>`:''}${locked?'<div class="read-only">已预约或待核实的作品暂不允许在本地覆盖。远端改期、取消和重新上传需由连接服务核实后处理。</div>':''}<div class="editor-layout"><div class="editor-media">${d.files.map((f,i)=>`<div class="media-preview"><img src="${safeUrl(f.url)}" alt="${escape(f.name)}"><div class="media-tools"><span>${i+1} / ${d.files.length}</span><div>${btn(`file-up:${i}`,'','up','',`aria-label="上移第 ${i+1} 张" ${locked||!i?'disabled':''}`)}${btn(`file-down:${i}`,'','down','',`aria-label="下移第 ${i+1} 张" ${locked||i===d.files.length-1?'disabled':''}`)}${btn(`file-remove:${i}`,'','close','',`aria-label="移除第 ${i+1} 张" ${locked?'disabled':''}`)}</div></div></div>`).join('')}${!locked?`<label class="upload-zone" id="editor-drop">${icon('upload')}<strong>${d.files.length?'继续添加图片':'把作品拖到这里'}</strong>或点击选择图片<small>JPG / PNG / 静态 GIF<br>每张不超过 32 MB<br>最多 200 张 · 合计 200 MB</small><input type="file" id="editor-files" accept="image/png,image/jpeg,image/gif" multiple aria-label="上传作品图片" ${m.uploading?'disabled':''}></label>`:''}<p>多张图片属于同一件作品。<br>使用箭头调整显示顺序。</p></div><div class="editor-form"><div class="editor-tabs" role="tablist">${[['basic','作品信息'],['options','投稿选项'],['schedule','预约发布']].map(([key,label])=>btn(`editor-tab:${key}`,label,'',m.tab===key?'active':'',`role="tab" aria-selected="${m.tab===key}"`)).join('')}</div><fieldset ${locked?'disabled':''} style="border:0;padding:0;margin:0;min-width:0">${m.tab==='basic'?basicForm(d):m.tab==='options'?optionsForm(d):scheduleForm(d)}</fieldset></div></div>`;
 footer=`<span class="footer-note">${m.uploading?'正在保存图片，请稍候…':m.suggesting?'正在自动识图与匹配标签…':state.mode==='demo'?'演示作品不会上传至 Pixiv':'文件与草稿保存在本机'}</span>${d.id&&!locked?btn('cancel-job','取消此作品','','danger small'):''}${btn('close-modal',locked?'关闭':'暂不保存')}${d.id&&state.mode==='live'?btn(`browser-preflight:${d.id}`,'检查浏览器','link'):''}${d.id&&state.mode==='live'&&d.idempotencyKey&&['reserved','needs_review','uploading'].includes(d.status)?btn(`browser-reconcile:${d.id}`,'核对远端结果','refresh'):''}${!locked?btn('save-draft','保存草稿','','',m.suggesting||m.uploading||m.memorySaving?'disabled':''):''}${!locked?btn('enqueue',canRetryReservation(d)?'重新预约':d.status==='queued'?'保存预约':'加入预约队列','calendar','primary',m.suggesting||m.uploading||m.memorySaving||(canRetryReservation(d)&&(queueIsRunning()||pixivSyncing))?'disabled':''):''}`;
 } else if(m.kind==='memory-library') {title='角色记忆';sub='只记住你明确确认的角色，可以随时删除。';body=renderMemoryLibrary(m);footer=btn('close-modal','关闭')+btn('memory-refresh','刷新','refresh','',m.loading||m.deleting?'disabled':'');
 } else if(m.kind==='account') {const a=m.account;title=a.id?'账号设置':'添加投稿账号';sub='不同账号独立管理，不会混用预约名额。';body=`${m.error?`<div class="field-error">${escape(m.error)}</div>`:''}${field('账号备注名',input('name',a.name,'例如：青空工作室','maxlength="80"'))}${field('Pixiv 用户 ID',input('pixivUserId',a.pixivUserId,'填写数字用户 ID，不是邮箱'),'用于识别投稿账号，登录状态由本地连接服务验证。')}${field('默认投稿时间 · 日本时间',`<select data-field="defaultPostingTime">${timeOptions(postingTime(a))}</select>`,'默认选择从现在起最近的一次投稿时间；当天已到或已过则选次日，可为每件作品单独修改。')}${checkField('premium',a.premium,'此账号已开通 Pixiv Premium（连接后还会核实）')}<div class="schedule-explainer">${icon('shield')}此处只保存账号资料。添加资料不会自动登录 Pixiv，也不会读取浏览器中的密码。</div>`;footer=btn('close-modal','取消')+btn('save-account','保存账号','check','primary');
 } else if(m.kind==='import') {title='批量导入作品';sub='把一批创作整理好，再统一安排发布时间。';body=`${m.error?`<div class="field-error">${escape(m.error)}</div>`:''}${field('导入到账号',`<select data-import-field="accountId">${accountOptions(m.accountId)}</select>`)}<div class="import-choice">${btn('import-separate',`${icon('grid')}每张图一件作品<small>适合批量预约投稿</small>`,'',m.separate?'active':'')}${btn('import-together',`${icon('layers')}合为一件多图作品<small>适合漫画或同组插画</small>`,'',!m.separate?'active':'')}</div><label class="upload-zone">${icon('upload')}<strong>选择本机的图片文件</strong><small>JPG / PNG / 静态 GIF · 每张最多 32 MB</small><input type="file" id="import-files" accept="image/png,image/jpeg,image/gif" multiple></label><p class="modal-summary">${m.files?.length?`已选择 ${m.files.length} 张图片。导入后会保存为草稿，需确认标签和分级后才能预约。`:'不会自动投稿。图片上传和保存完成后，可在作品管理中批量排期。'}</p>`;footer=btn('close-modal','取消')+btn('import-save',m.busy?'正在导入…':'导入为草稿','upload','primary',m.busy?'disabled':'');
 } else if(m.kind==='batch') {title='批量安排发布时间';sub=`已选择 ${ui.selected.size} 件作品。仅本地草稿和未上传作品可以改期。`;body=`${m.error?`<div class="field-error">${escape(m.error)}</div>`:''}<div class="field-row">${field('开始日期',`<input type="date" data-batch-field="date" value="${m.date}">`)}${field('每日开始时间',`<input type="time" step="1800" data-batch-field="time" value="${m.time}">`)}</div><div class="field-row">${field('每天安排几件',`<input type="number" min="1" max="100" data-batch-field="perDay" value="${m.perDay}">`)}${field('作品之间的间隔',`<select data-batch-field="spacing">${[[0,'同一时间'],[30,'30 分钟'],[60,'1 小时'],[120,'2 小时']].map(([value,label])=>option(value,label,m.spacing)).join('')}</select>`)}</div>${field('预约时区','<input value="日本时间 · JST · UTC+9" readonly>')}${field('首件对应北京时间',`<input value="${m.date&&m.time?wall(toIso(m.date+'T'+m.time,'Asia/Tokyo'),'Asia/Shanghai').replace('T',' '):''}" readonly>`)}<div class="schedule-explainer">排期会保存到每件作品。草稿仍保持草稿，完成标签与分级确认后可加入队列。超过 7 天的作品会等待预约窗口。</div>`;footer=btn('close-modal','取消')+btn('save-batch','保存排期','calendar','primary');
 } else if(m.kind==='delete-works') {title=`删除这 ${m.jobs.length} 件作品？`;sub=`${m.mode==='demo'?'演示空间':'真实工作空间'} · 删除本地作品记录`;body=`${m.error?`<p class="field-error" role="alert">${escape(m.error)}</p>`:''}<p class="modal-summary">将从本地作品列表及待补位队列移除以下 ${m.jobs.length} 件作品。删除后无法在这里恢复；原始图片、角色记忆和 Pixiv 上的作品都会保留。</p><ul class="delete-work-list">${m.jobs.map(j=>`<li><strong>${escape(j.title||'未命名作品')}</strong><span>${escape(j.accountName)} · ${labels[j.status]||escape(j.status)}</span></li>`).join('')}</ul>`;footer=btn('close-modal','取消','','',m.busy?'disabled':'')+btn('delete-works-confirm',m.busy?'正在删除…':`确认删除 ${m.jobs.length} 件`,'trash','danger',m.busy?'disabled':'');
 } else if(m.kind==='browser') {title='连接现有 Chrome';sub='选择实际登录的 Pixiv 账号。Google 账号名称不作为绑定依据。';body=`${m.error?`<div class="field-error">${escape(m.error)}</div>`:''}<p class="modal-summary">${escape(m.result.message)}</p>${m.result.accounts.map(a=>`<div class="setting-row"><div><strong>${escape(a.name||'Pixiv 用户')}</strong><p>Pixiv ID ${escape(a.pixivUserId)} · ${a.premium?'Premium':'普通账号'}</p></div>${btn(`browser-bind:${a.candidateId}`,'绑定此账号','link','small')}</div>`).join('')}<p class="help">绑定后先同步账号和预约记录。只有单独开启该账号的投稿后，队列才会上传作品。Chrome 重新启动后可能需要再次允许连接。</p>`;footer=btn('close-modal','关闭')+btn(`browser-discover:${m.accountId||''}`,'重新检测','refresh');
 } else if(m.kind==='reconcile') {title='核对远端结果';sub='只关联核实过的记录，不会重新上传作品。';const a=state.accounts.find(a=>a.id===m.job.accountId);body=`${m.error?`<p class="field-error">${escape(m.error)}</p>`:''}<p>${escape(m.job.title)}</p>${field('对应的远端预约',`<select data-reconcile-field="remoteId">${option('','请选择预约，或填写下面的作品链接',m.remoteId)}${(a.remote?.reservations||[]).filter(r=>r.status==='reserved').map(r=>option(r.remoteId,`${r.title||r.remoteId} · ${dateText(r.scheduledAt)}`,m.remoteId)).join('')}</select>`)}${m.job.remoteId?`<label class="checkbox-line"><input type="checkbox" data-reconcile-field="adoptRemoteSchedule" ${m.adoptRemoteSchedule?'checked':''}>采用 Pixiv 当前排期更新本地记录（仅限已关联的同一预约）</label>`:''}${field('已经发布的 Pixiv 作品链接',`<input data-reconcile-field="artworkUrl" value="${escape(m.artworkUrl)}" placeholder="https://www.pixiv.net/artworks/…">`)}<p class="help">请先在 Pixiv 确认这是同一件作品。应用还会核对所属账号、标题及图片数量；预约记录会另外核对时间。</p>`;footer=btn('close-modal','取消')+btn('browser-reconcile-save','核对并关联','check','primary');
 } else if(m.kind==='preflight') {title='投稿前检查';body=`<p class="modal-summary">${escape(m.result.name)} · Pixiv ${escape(m.result.pixivUserId)}<br>已预约 ${m.result.reserved} / 10 件</p>${m.result.issues.length?m.result.issues.map(x=>`<p class="field-error">${escape(x)}</p>`).join(''):'<p>浏览器账号、Premium 和预约名额检查通过。提交时还会核对实际表单。</p>'}`;footer=btn('close-modal','关闭');
 } else if(m.kind==='confirm') {title=m.title;body=`<p class="modal-summary">${escape(m.message)}</p>`;footer=btn('close-modal','取消')+btn('confirm-action',m.label||'确认','','primary');
 } else if(m.kind==='day') {title=m.date+' 的排期';sub=`共 ${m.jobs.length} 件作品`;body=m.jobs.map(j=>`<div class="setting-row"><div><strong>${escape(j.title)}</strong><p>${dateText(j.scheduledAt)} · ${escape(accountFor(j)?.name||'')}</p></div>${btn(`edit:${j.id}`,'查看','','small')}</div>`).join('');footer=btn('close-modal','关闭');}
 return `<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal-header"><div><h2 id="dialog-title">${title}</h2><p>${sub}</p></div>${btn('close-modal','','close','icon-only ghost','aria-label="关闭窗口"')}</div><div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></section></div>`;
}
function basicForm(d) {const m=ui.modal;return `<div class="field-row">${field('投稿账号',`<select data-field="accountId">${accountOptions(d.accountId)}</select>`)}${field('作品类型',`<select data-field="content.type">${option('illust','插画',d.content.type)}${option('manga','漫画',d.content.type)}</select>`)}</div>${renderCharacterPicker(m)}${field('标题',input('title',d.title,'选角色后自动填写；也可输入角色名','maxlength="32"'),'单图单角色填写英文名；多图或多个角色请留空。')}${renderNameResolution(m,'title')}${field('作品说明',`<textarea data-field="caption" maxlength="3000" placeholder="分享创作想法，或写一段作品介绍。">${escape(d.caption)}</textarea>`)}<div class="field"><label>作品标签 <span>${d.tags.length} / 10</span></label><div class="tag-editor">${d.tags.map((t,i)=>`<span class="tag">${escape(t)}${btn(`remove-tag:${i}`,'','close','',`aria-label="移除标签 ${escape(t)}"`)}</span>`).join('')}<input id="tag-input" placeholder="输入标签，按回车添加" maxlength="64" aria-label="添加标签"></div><p class="help">${m.selectedTemplate?'已沿用此账号历史投稿的标签写法与顺序，画面标签按当前图片补充。':m.characterCoreTags?.length?'已加入游戏和角色标签，请检查并确认。':'上传图片并选择角色后，将按此账号的历史投稿填写标签。'}</p><details class="tag-adjustments" data-tag-adjustments ${m.tagAdjustmentsOpen?'open':''}><summary>调整标签与角色记忆</summary>${renderCharacterMemory(m)}${renderTagPool(m,d)}${m.recognition?`<p class="help">${escape(m.recognition.titleReason)} · ${escape(m.recognition.message)}</p>`:''}${renderSuggestions(m,d)}${state.mode==='live'?`<div class="tag-search"><div class="field-row"><input id="pixiv-tag-query" data-field="tagSearchQuery" value="${escape(m.draft.tagSearchQuery||'')}" placeholder="搜索 Pixiv 全站标签" aria-label="搜索 Pixiv 全站标签">${btn('search-tags',m.searching?'搜索中…':'搜索标签','search','small',m.searching?'disabled':'')}</div>${m.tagSearchError?`<p class="help">${escape(m.tagSearchError)}</p>`:''}<div class="suggestion-list">${(m.searchResults||[]).map((c,i)=>btn(`search-tag:${i}`,escape(c.tag)+(c.preferred?' · 常用':''),'','suggestion')).join('')}</div></div>`:''}</details>${checkField('tagsConfirmed',d.tagsConfirmed,'我已检查并确认这些标签符合图片内容')}</div>`;}

// Recognition concerns the image set; presentation order must not invalidate an in-flight result.
function fileSelectionSignature(draft) {return JSON.stringify({accountId:draft.accountId,files:draft.files.map(file=>({id:file.id,size:file.size,mime:file.mime})).sort((a,b)=>a.id.localeCompare(b.id))});}
function clearSuggestions(modal) {modal.candidates=null;modal.chosen=new Set();modal.analysis=null;modal.suggestionSignature=null;modal.recognition=null;modal.searchResults=[];modal.autoTagsMessage='';modal.memoryForm=null;modal.memoryError='';modal.memoryMessage='';modal.memoryCandidateConfirmed=false;}
const normalizedTag = value => value.normalize('NFKC').toLowerCase().replace(/[\s_]/g,'');
const hasTag = (tags,tag) => tags.some(existing=>normalizedTag(existing)===normalizedTag(tag));
function nameResolutionEligible(m) {return m?.kind==='editor'&&ui.modal===m&&!isLocked(m.draft)&&m.draft.files.length===1&&!m.recognition?.perFile?.some(file=>file.multiple);}
function tagStrings(tags=[]) {return tags.reduce((out,item)=>{const tag=typeof item==='string'?item:item?.tag;return typeof tag==='string'&&tag.trim()&&!out.includes(tag.trim())?[...out,tag.trim()]:out;},[]);}
function alignTemplateRating(tags,rating,template) {
 const ordered=tagStrings(tags),label=rating==='r18'?'R-18':rating==='r18g'?'R-18G':null,oldPosition=ordered.findIndex(isRatingTag),clean=ordered.filter(tag=>!isRatingTag(tag));
 if(!label)return clean.slice(0,10);
 const history=tagStrings(template?.orderedTags||[]),anchor=history.findIndex(isRatingTag);
 let position=oldPosition;
 if(position<0&&anchor>=0){position=0;for(const tag of history.slice(0,anchor)){const index=clean.indexOf(tag);if(index>=0)position=index+1;}}
 if(position<0){position=0;for(let i=0;i<clean.length;i++)if(hasTag(template?.gameTags||[],clean[i]))position=i+1;}
 clean.splice(Math.min(position,9),0,label);return clean.slice(0,10);
}
function insertTemplateTag(m,tag) {
 const history=tagStrings(m.selectedTemplate?.orderedTags||[]),position=history.indexOf(tag);
 let index=m.draft.tags.length;if(position>=0){for(const following of history.slice(position+1)){const existing=m.draft.tags.indexOf(following);if(existing>=0){index=existing;break;}}}
 m.draft.tags.splice(index,0,tag);manualTagsChanged(m);
}
function templateScopeMatches(m,result) {const account=state.accounts.find(item=>item.id===m.draft.accountId);return result?.mode===state.mode&&result.accountId===m.draft.accountId&&(!account?.pixivUserId||result.pixivUserId===account.pixivUserId);}
function syncTemplateMetadata(m) {
 const template=m.selectedTemplate,account=state.accounts.find(item=>item.id===m.draft.accountId);
 if(!template||!account||!m.templateOwnedTags){delete m.draft.tagTemplate;return;}
 m.draft.tagTemplate={id:template.id,accountId:account.id,pixivUserId:account.pixivUserId,englishName:template.englishName,gameTags:tagStrings(template.gameTags),characterTags:tagStrings(template.characterTags),ownedTags:tagStrings(m.templateOwnedTags).filter(tag=>m.draft.tags.includes(tag)),removedTags:tagStrings(m.templateRemovedTags||[])};
}
function restoreTemplateMetadata(m) {
 const metadata=m.draft.tagTemplate,account=state.accounts.find(item=>item.id===m.draft.accountId);
 if(!metadata||metadata.accountId!==account?.id||metadata.pixivUserId!==account?.pixivUserId||!metadata.id||!metadata.englishName||!Array.isArray(metadata.ownedTags)||!Array.isArray(metadata.gameTags)||!Array.isArray(metadata.characterTags)){delete m.draft.tagTemplate;return false;}
 m.selectedTemplate=structuredClone(metadata);m.templateOwnedTags=tagStrings(metadata.ownedTags).filter(tag=>m.draft.tags.includes(tag));m.templateRemovedTags=tagStrings(metadata.removedTags||[]);m.autoAppliedTags=[...m.templateOwnedTags];m.templateSelectionOrigin='restored';m.automaticTagsApplied=true;
 m.autoTagRoles={...Object.fromEntries(metadata.gameTags.map(tag=>[tag,'game'])),...Object.fromEntries(metadata.characterTags.map(tag=>[tag,'character']))};m.templateMessage='已恢复这份草稿的角色模板，保留你之前的标签修改。';return true;
}
function recoverLegacyTemplate(m) {
 if(!m.draft.id||m.draft.tagTemplate||m.selectedTemplate||!m.draft.tags.length)return;
 if(m.legacyTemplateAccountId&&m.legacyTemplateAccountId!==m.draft.accountId){m.legacyTemplateUnresolved=true;return;}
 const matches=(m.templateCatalog?.templates||[]).filter(template=>template.gameTags?.length&&template.characterTags?.length&&[...template.gameTags,...template.characterTags].every(tag=>m.draft.tags.includes(tag)));
 if(matches.length===1){const template=matches[0];m.selectedTemplate=structuredClone(template);m.templateOwnedTags=tagStrings([...template.gameTags,...template.characterTags]);m.templateRemovedTags=[];m.templateSelectionOrigin='restored';m.autoAppliedTags=[...m.templateOwnedTags];m.automaticTagsApplied=true;m.legacyTemplateUnresolved=false;syncTemplateMetadata(m);m.templateMessage='已按完全一致的游戏与角色标签识别旧草稿；其他标签保持原样。';}
 else {m.legacyTemplateUnresolved=true;m.legacyTemplateAccountId=m.draft.accountId;m.templateMessage='此旧草稿没有标签来源记录，选择角色会重建整组标签；替换后可以撤销。';}
}
function relatedTemplate(template,identity) {
 const keys=values=>tagStrings(values).map(normalizedTag),games=keys(identity.gameTags),characters=keys(identity.characterTags);
 const sameGame=(template.gameTags||[]).some(tag=>games.includes(normalizedTag(tag)));
 // Different account aliases can still share a game-qualified character tag;
 // a bare name alone cannot establish that two different games are the same.
 const sameScopedCharacter=(template.characterTags||[]).some(tag=>{const key=normalizedTag(tag);return /\([^()]+\)/.test(key)&&characters.includes(key);});
 return normalizedTag(template.englishName||'')===normalizedTag(identity.englishName||'')&&(sameGame||sameScopedCharacter);
}
function templateSceneTags(m) {const identity=[...(m.selectedTemplate?.gameTags||[]),...(m.selectedTemplate?.characterTags||[])],automatic=tagStrings([...(m.autoAppliedTags||[]),...(m.templateOwnedTags||[])]);return tagStrings(m.draft.tags).filter(tag=>!isRatingTag(tag)&&!identity.includes(tag)&&!automatic.includes(tag)&&!['game','character'].includes(m.autoTagRoles?.[tag]));}
function clearTemplate(m,{catalog=false}={}) {
 if(catalog&&m.selectedTemplate){m.templateReapplyIdentity={englishName:m.selectedTemplate.englishName,gameTags:tagStrings(m.selectedTemplate.gameTags),characterTags:tagStrings(m.selectedTemplate.characterTags),title:m.draft.title,titleRevision:m.titleRevision||0,nameGeneration:m.characterNameGeneration||0};m.templateAwaitingAccountChoice=true;}
 if(!catalog){m.templateReapplyIdentity=null;m.templateAwaitingAccountChoice=false;}
 m.templateSequence=(m.templateSequence||0)+1;m.templateLoading=false;m.templatePromise=null;m.templateMessage='';
 const owned=m.templateOwnedTags||[];if(!catalog)m.draft.tags=m.draft.tags.filter(tag=>!owned.includes(tag));m.templateOwnedTags=catalog?owned:[];m.selectedTemplate=null;m.templateOptionalTags=[];m.templateSelectionOrigin=null;
 if(catalog){m.templateListSequence=(m.templateListSequence||0)+1;m.templateCatalog=null;m.templateListLoading=false;m.templateListError='';m.characterQuery='';m.characterShowAll=false;}
 m.templateRemovedTags=[];delete m.draft.tagTemplate;m.draft.tagsConfirmed=false;
}
async function loadCharacterTemplates(m,{refreshOnly=false}={}) {
 if(ui.modal!==m||m?.kind!=='editor')return;
 const mode=state.mode,accountId=m.draft.accountId,sequence=(m.templateListSequence||0)+1;m.templateListSequence=sequence;m.templateListLoading=true;m.templateListError='';
 const current=()=>ui.modal===m&&state.mode===mode&&m.draft.accountId===accountId&&m.templateListSequence===sequence;
 try{if(accountId){const result=await api(`/api/characters/templates?mode=${encodeURIComponent(mode)}&accountId=${encodeURIComponent(accountId)}`,undefined,'GET');if(current()&&templateScopeMatches(m,result))m.templateCatalog=result;}}
 catch(error){if(current())m.templateListError='角色目录暂未读到：'+error.message;}
 finally{if(current()){
  m.templateListLoading=false;
  if(m.selectedTemplate){const template=m.templateCatalog?.templates?.find(item=>item.id===m.selectedTemplate.id);if(template)m.selectedTemplate=structuredClone(template);}
  if(!refreshOnly){
   if(m.templateReapplyIdentity&&!m.selectedTemplate){const identity=m.templateReapplyIdentity;m.templateReapplyIdentity=null;const unchanged=m.draft.title===identity.title&&(m.titleRevision||0)===identity.titleRevision&&(m.characterNameGeneration||0)===identity.nameGeneration;const matches=unchanged?(m.templateCatalog?.templates||[]).filter(item=>relatedTemplate(item,identity)):[];if(unchanged&&matches.length===1)void selectCharacterTemplate(m,matches[0].id,{preserveTitle:true});else if(unchanged){m.characterPickerOpen=true;m.characterQuery=identity.englishName;m.templateMessage=matches.length>1?'此账号有多个同名角色模板，请选择对应游戏的角色。':'此账号尚无可以唯一对应的角色模板，请选择角色。';}}
   else recoverLegacyTemplate(m);
  }
  renderAfterNameResolution(m);
 }}
}
function templateIdentitySource(template) {return ({'user-memory':'角色记忆','account-common-tags':'常用角色','verified-tag-library':'已核实角色'})[template.identitySource]||'补充角色';}
function templateSourceSummary(template) {return template.source==='account-style'?`${templateIdentitySource(template)} · 沿用本账号格式`:`${template.sampleCount||template.sourceArtworkIds?.length||0} 件历史作品`;}
function templateAppliedMessage(template,accountName) {return template.source==='account-style'?`角色标签来自${templateIdentitySource(template)}；格式与顺序沿用 ${accountName} 同游戏其他角色的历史投稿。`:`沿用 ${accountName} 的历史标签格式与顺序 · ${template.sampleCount||template.sourceArtworkIds?.length||0} 件参考作品`;}
function applyHistoryTemplate(m,result,{manual=false,preserveTitle=false}={}) {
 const template=result.template;if(!template||!Array.isArray(result.orderedTags))return false;
 const original=m.draft.tags,owned=tagStrings([...(m.templateOwnedTags||[]),...(m.autoAppliedTags||[]),...(m.characterInsertedTags||[])]),manualTags=original.filter(tag=>!owned.includes(tag)&&!isRatingTag(tag));
 const generated=alignTemplateRating(result.orderedTags,m.draft.content.rating,template).filter(tag=>isRatingTag(tag)||!(m.templateRemovedTags||[]).includes(tag)),extras=manualTags.filter(tag=>!generated.includes(tag));
 const required=tagStrings([...(template.gameTags||[]),...(template.characterTags||[])]);
 for(let index=generated.length-1;generated.length+extras.length>10&&index>=0;index--)if(!isRatingTag(generated[index])&&!required.includes(generated[index]))generated.splice(index,1);
 if(generated.length+extras.length>10){m.templateMessage='角色模板与手动标签合计超过 10 个，请移除不需要的标签后重新选择角色。';return false;}
 const tags=tagStrings([...generated,...extras]);
 m.selectedTemplate=structuredClone(template);m.templateOwnedTags=generated.filter(tag=>!manualTags.includes(tag));m.templateOptionalTags=tagStrings(result.optionalTags||[]);m.templateSelectionOrigin=manual?'manual':m.templateSelectionOrigin||'automatic';
 m.characterInsertedTags=[];m.characterCoreTags=[];m.characterCoreRoles={};m.characterCoreName='';m.automaticCharacterTags=[];
 m.autoAppliedTags=[...m.templateOwnedTags];m.autoTagRoles={...Object.fromEntries((template.gameTags||[]).map(tag=>[tag,'game'])),...Object.fromEntries((template.characterTags||[]).map(tag=>[tag,'character']))};
 m.draft.tags=tags;m.draft.tagsConfirmed=false;m.automaticTagsApplied=true;
 if(!preserveTitle){m.draft.title=result.identity?.englishName||template.englishName||m.draft.title;if(manual)m.titleRevision=(m.titleRevision||0)+1;}
 m.templateMessage=templateAppliedMessage(template,state.accounts.find(account=>account.id===m.draft.accountId)?.name||'当前账号');
 m.legacyTemplateUnresolved=false;m.templateAwaitingAccountChoice=false;syncTemplateMetadata(m);
 return true;
}
async function selectCharacterTemplate(m,templateId,{refresh=false,preserveTitle=false}={}) {
 if(!nameResolutionEligible(m))return;
 const template=(m.templateCatalog?.templates||[]).find(item=>item.id===templateId)||(m.selectedTemplate?.id===templateId?m.selectedTemplate:null);if(!template)return;
 if(!refresh&&m.legacyTemplateUnresolved){m.templateUndo={mode:state.mode,signature:fileSelectionSignature(m.draft),title:m.draft.title,tags:[...m.draft.tags]};m.draft.tags=[];m.legacyTemplateUnresolved=false;}
 invalidateNameResolutions(m);
 const mode=state.mode,accountId=m.draft.accountId,signature=fileSelectionSignature(m.draft),sequence=(m.templateSequence||0)+1,tagsRevision=m.tagsRevision||0,rating=m.draft.content.rating;
 m.templateSequence=sequence;m.templateLoading=true;m.templateMessage='正在套用此账号的标签格式…';
 if(!refresh&&!preserveTitle){m.characterPickerOpen=false;m.characterQuery='';}
 if(!refresh){const owned=tagStrings([...(m.templateOwnedTags||[]),...(m.autoAppliedTags||[]),...(m.characterInsertedTags||[])]);m.draft.tags=m.draft.tags.filter(tag=>!owned.includes(tag));m.templateRemovedTags=[];m.templateOwnedTags=[];m.selectedTemplate=structuredClone(template);m.templateSelectionOrigin='manual';if(!preserveTitle)m.draft.title=template.englishName;m.titleRevision=(m.titleRevision||0)+1;m.draft.tagsConfirmed=false;}
 const current=()=>ui.modal===m&&state.mode===mode&&m.draft.accountId===accountId&&fileSelectionSignature(m.draft)===signature&&m.templateSequence===sequence&&nameResolutionEligible(m)&&m.draft.content.rating===rating;
 renderAfterNameResolution(m);
 const promise=(async()=>{try{
  const result=await api('/api/characters/resolve',{mode,accountId,name:template.englishName,templateId,rating,sceneTags:templateSceneTags(m),...(m.analysis?.memoryAnalysisId?{analysisId:m.analysis.memoryAnalysisId}:{})});
  if(!current()||!templateScopeMatches(m,result))return;
  if(result.status!=='resolved'||result.template?.id!==templateId){m.templateMessage=result.message||'这个角色模板暂不可用，请重新选择。';return;}
  if((m.tagsRevision||0)!==tagsRevision){m.templateMessage='标签已被你修改，保留当前结果。需要时可重新选择角色套用模板。';return;}
  applyHistoryTemplate(m,result,{manual:true,preserveTitle:preserveTitle||refresh});
 }catch(error){if(current())m.templateMessage='套用标签格式未完成：'+error.message;}
 finally{if(m.templateSequence===sequence){m.templateLoading=false;m.templatePromise=null;if(m.templateMessage==='正在套用此账号的标签格式…')m.templateMessage='当前内容已更新，可重新选择角色套用模板。';if(ui.modal===m)renderAfterNameResolution(m);}}})();
 m.templatePromise=promise;return promise;
}
function renderCharacterPicker(m) {
 const templates=m.templateCatalog?.templates||[],query=normalizedTag(m.characterQuery||''),matches=templates.filter(item=>!query||[item.englishName,...(item.aliases||[]),...(item.characterTags||[])].some(value=>normalizedTag(value).includes(query)));
 const enabled=nameResolutionEligible(m),selected=m.selectedTemplate,expanded=!selected||m.characterPickerOpen,canUndo=m.templateUndo?.mode===state.mode&&m.templateUndo?.signature===fileSelectionSignature(m.draft),visible=query||m.characterShowAll?matches:matches.slice(0,8);
 return `<section class="character-picker" aria-label="选择投稿角色"><div class="character-picker-head"><strong>${selected?escape(selected.englishName):'选择角色'}</strong>${selected?btn('character-picker-toggle',expanded?'收起选择':'更换角色','','ghost small'):''}<span>${escape(state.accounts.find(account=>account.id===m.draft.accountId)?.name||'当前账号')} · 共 ${templates.length} 个角色</span></div>${expanded?`<input id="character-query" value="${escape(m.characterQuery||'')}" placeholder="搜索全部角色，支持中文或英文名" aria-label="搜索角色" ${templates.length?'':'disabled'}><div class="character-picker-list">${visible.map(item=>btn(`character-template:${item.id}`,`<span>${escape(item.englishName)}<small>${escape((item.gameTags||[]).join(' · '))}</small><small class="character-source">${escape(templateSourceSummary(item))}</small></span>`,'',`character-choice${selected?.id===item.id?' selected':''}`,enabled?'':'disabled')).join('')}</div><div class="character-picker-count"><span>${query?`找到 ${matches.length} 个角色，共 ${templates.length} 个`:`显示 ${visible.length} / ${templates.length} 个角色`}</span>${!query&&templates.length>8?btn('character-show-all',m.characterShowAll?'收起':`展开全部 ${templates.length} 个角色`,'','ghost small'):''}</div>`:''}<p class="help" role="status">${escape(m.templateLoading?'正在套用此账号的标签格式…':m.templateMessage||m.templateListError||(!enabled?'上传单张、单角色图片后，只需选择一次角色。':m.templateListLoading?'正在读取本机角色目录…':!templates.length?'还没有可用角色。同步 Pixiv 或保存角色记忆后会补充目录，也可在标题中填写角色名。':query&&!matches.length?'未找到这个角色，可在标题中填写名字继续匹配。':'选择一次，自动填写英文标题和此账号惯用的整组标签；分级仍按当前图片。'))}</p>${canUndo?btn('template-undo','撤销本次替换','','ghost small'):''}${m.templateListError?btn('character-template-retry','重新读取','','ghost small'):''}${m.templateOptionalTags?.length?`<div class="character-optional"><span>可选画面标签</span>${m.templateOptionalTags.filter(tag=>!hasTag(m.draft.tags,tag)).map((tag,index)=>btn(`template-optional:${index}`,escape(tag),'plus','ghost small')).join('')}</div>`:''}</section>`;
}
function nameResolutionText(m,source) {return String(source==='memory'?m.memoryForm?.englishName||'':m.draft.title||'').trim();}
function nameResolutionState(m,source) {m.characterResolutions??={};return m.characterResolutions[source]??={sequence:0};}
function isNameResolving(m) {return Object.values(m.characterResolutions||{}).some(result=>result.waiting||result.loading||result.pending);}
function clearOwnedCharacterTags(m,name) {
 const changedCore=m.characterCoreName&&normalizedTag(name)!==normalizedTag(m.characterCoreName),changedAutomatic=m.automaticCharacterTags?.length&&normalizedTag(name)!==normalizedTag(m.automaticCharacterName||'');
 if(!changedCore&&!changedAutomatic)return false;
 const owned=[...(changedCore?m.characterInsertedTags||[]:[]),...(changedAutomatic?m.automaticCharacterTags||[]:[])],tags=m.draft.tags.filter(tag=>!hasTag(owned,tag));
 m.characterInsertedTags=[];m.characterCoreTags=[];m.characterCoreRoles={};m.characterCoreName='';
 if(changedAutomatic){m.automaticCharacterTags=[];m.automaticCharacterName='';}
 if(tags.length!==m.draft.tags.length){m.draft.tags=tags;manualTagsChanged(m);}else m.draft.tagsConfirmed=false;
 return tags.length!==m.draft.tags.length||owned.length>0;
}
async function finishNameResolutions(m) {
 while(ui.modal===m&&(isNameResolving(m)||m.templatePromise)){
  if(m.suggesting||m.uploading||m.memorySaving)throw new Error('请等待识图与角色标签匹配完成后再保存。');
  if(m.templatePromise){await m.templatePromise;continue;}
  for(const source of ['title','memory']){const result=m.characterResolutions?.[source];if(result?.waiting||result?.pending)scheduleNameResolution(m,source,true);}
  const running=Object.values(m.characterResolutions||{}).filter(result=>result.loading&&result.promise).map(result=>result.promise);
  if(!running.length)break;await Promise.all(running);
 }
}
function renderNameResolution(m,source) {
 const result=m.characterResolutions?.[source];if(!result?.message&&!result?.loading)return '';
 return `<div class="character-resolution" role="status" aria-live="polite"><p class="help${result.error?' tag-warning':''}">${escape(result.loading?'正在匹配角色所属游戏和角色标签…':result.message)}</p>${!result.loading&&result.retry?btn(`character-resolve:${source}`,'重新匹配','','ghost small'):''}</div>`;
}
function renderAfterNameResolution(m) {
 if(ui.modal!==m)return;
 const focused=document.activeElement,fieldName=focused?.dataset?.field,memoryField=focused?.dataset?.memoryField,memoryTagField=focused?.dataset?.memoryTagInput;
 const selector=focused?.id==='character-query'?'#character-query':fieldName==='title'?'[data-field="title"]':memoryField==='englishName'?'[data-memory-field="englishName"]':['gameTags','characterTags'].includes(memoryTagField)?`#memory-tag-input-${memoryTagField}`:null;
 const selection=selector?[focused.selectionStart,focused.selectionEnd]:null;render();
 if(selector){const element=document.querySelector(selector);element?.focus();if(selection.every(Number.isInteger))element?.setSelectionRange(...selection);}
}
function invalidateNameResolutions(m) {
 for(const result of Object.values(m.characterResolutions||{})){clearTimeout(result.timer);result.sequence++;result.waiting=false;result.loading=false;result.pending=false;result.message='';result.lastKey=null;}
}
function scheduleNameResolution(m,source='title',immediate=false,force=false) {
 if(m?.kind!=='editor')return;
 const result=nameResolutionState(m,source),name=nameResolutionText(m,source),signature=fileSelectionSignature(m.draft),key=JSON.stringify([state.mode,signature,source,name]);
 clearTimeout(result.timer);result.waiting=false;
 if(m.activeCharacterInput?.source!==source||m.activeCharacterInput?.name!==name){
  m.activeCharacterInput={source,name};m.characterNameGeneration=(m.characterNameGeneration||0)+1;
  for(const [other,state] of Object.entries(m.characterResolutions||{}))if(other!==source){clearTimeout(state.timer);state.sequence++;state.waiting=false;state.loading=false;state.pending=false;state.message='';state.lastKey=null;}
 }
 if(m.templateReapplyIdentity||m.templateAwaitingAccountChoice){m.templateReapplyIdentity=null;m.templateAwaitingAccountChoice=false;clearTemplate(m);}
 if(m.selectedTemplate&&normalizedTag(name)!==normalizedTag(m.selectedTemplate.englishName||''))clearTemplate(m);
 let cleared=clearOwnedCharacterTags(m,name);
 if(result.requestedName!==name){
  result.lastKey=null;result.requestedName=name;m.draft.tagsConfirmed=false;
  if(source==='memory'&&m.memoryForm){
   for(const fieldName of ['gameTags','characterTags'])if(!(m.memoryFieldRevisions?.[fieldName]||0)&&JSON.stringify(m.memoryAutoFields?.[fieldName])===JSON.stringify(m.memoryForm[fieldName])){m.memoryForm[fieldName]=[];cleared=true;}
   m.memoryForm.confirmedSingleCharacter=false;
  }
 }
 if(!force&&(result.loading&&result.activeKey===key||result.lastKey===key))return;
 const sequence=++result.sequence;result.loading=false;result.message='';result.error=false;result.retry=false;result.pending=false;
 if(!name||!nameResolutionEligible(m)||(source==='memory'&&!m.memoryForm)){if(cleared)renderAfterNameResolution(m);return;}
 if(m.suggesting||m.uploading||m.memorySaving){result.pending=true;return;}
 const generation=m.characterNameGeneration;
 const run=()=>{result.waiting=false;result.timer=null;result.promise=resolveCharacterName(m,source,{result,name,signature,key,sequence,generation,mode:state.mode,accountId:m.draft.accountId,form:m.memoryForm});return result.promise;};
 if(immediate)run();else {result.waiting=true;result.timer=setTimeout(run,700);}
 if(cleared&&!immediate)renderAfterNameResolution(m);
}
function prependCharacterTags(m,result) {
 const unique=tags=>tags.reduce((list,tag)=>typeof tag==='string'&&tag.trim()&&!hasTag(list,tag.trim())?[...list,tag.trim()]:list,[]);
 const core=unique([...(result.gameTags||[]),...(result.characterTags||[])]).slice(0,10);
 if(!core.length)return false;
 const owned=m.characterInsertedTags||[],original=m.draft.tags;
 const rest=unique(original.filter(tag=>!hasTag(owned,tag)&&!hasTag(core,tag)));
 const limit=10-core.length,retained=[];
 for(let index=0;index<rest.length;index++){
  const remainingRatings=rest.slice(index+1).filter(isRatingTag).length;
  if(retained.length<limit&&(isRatingTag(rest[index])||retained.length+remainingRatings<limit))retained.push(rest[index]);
 }
 m.characterInsertedTags=core.filter(tag=>hasTag(owned,tag)||!hasTag(original,tag));m.characterCoreName=result.name;
 m.characterCoreTags=core;m.characterCoreRoles=Object.fromEntries(core.map(tag=>[tag,hasTag(result.gameTags||[],tag)?'game':'character']));
 m.autoTagRoles={...(m.autoTagRoles||{}),...m.characterCoreRoles};m.draft.tags=[...core,...retained];manualTagsChanged(m);
 return rest.length>retained.length;
}
function keepCharacterTagsFirst(m) {
 if(!m.characterCoreTags?.length)return;
 const core=m.characterCoreTags.filter(tag=>hasTag(m.draft.tags,tag));m.draft.tags=[...core,...m.draft.tags.filter(tag=>!hasTag(core,tag))].slice(0,10);
}
async function resolveCharacterName(m,source,request) {
 const {result,name,signature,key,sequence,generation,mode,accountId,form}=request,tagsRevision=m.tagsRevision||0;
 if(m.suggesting||m.uploading||m.memorySaving){if(result.sequence===sequence)result.pending=true;return;}
 const formRevisions={...(m.memoryFieldRevisions||{})};
 const current=()=>ui.modal===m&&state.mode===mode&&!m.suggesting&&!m.uploading&&!m.memorySaving&&m.characterNameGeneration===generation&&m.draft.accountId===accountId&&fileSelectionSignature(m.draft)===signature&&nameResolutionText(m,source)===name&&result.sequence===sequence&&nameResolutionEligible(m)&&(source!=='memory'||m.memoryForm===form);
 if(!current())return;
 result.loading=true;result.activeKey=key;renderAfterNameResolution(m);
 try{
  const resolved=await api('/api/characters/resolve',{mode,accountId,name,rating:m.draft.content.rating,sceneTags:templateSceneTags(m),...(m.analysis?.memoryAnalysisId?{analysisId:m.analysis.memoryAnalysisId}:{})});
  if(!current()||resolved.mode!==mode||resolved.accountId!==accountId||resolved.name!==name)return;
  const account=state.accounts.find(item=>item.id===accountId);if(account?.pixivUserId&&resolved.pixivUserId!==account.pixivUserId)return;
  result.lastKey=key;
  if(resolved.status!=='resolved'){result.message=resolved.message||(resolved.status==='ambiguous'?'这个名字对应多个角色，请填写更完整的角色名。':'暂未找到明确的游戏和角色标签，请补充完整角色名或手动选择。');result.retry=true;return;}
  if(source==='memory'&&m.memoryForm===form){
   for(const fieldName of ['gameTags','characterTags'])if(!(m.memoryFieldRevisions?.[fieldName]||0)&&!(formRevisions[fieldName]||0)){form[fieldName]=memoryTagValues(resolved[fieldName]);m.memoryAutoFields??={};m.memoryAutoFields[fieldName]=[...form[fieldName]];}
  }
  if((m.tagsRevision||0)!==tagsRevision){result.message='已找到对应标签；你刚刚修改了作品标签，已保留你的修改。可重新匹配后加入。';result.retry=true;return;}
  if(resolved.template&&Array.isArray(resolved.orderedTags)){applyHistoryTemplate(m,resolved,{manual:true});result.message=m.templateMessage;return;}
  const trimmed=prependCharacterTags(m,resolved);
  result.message='已将对应游戏和角色标签放在最前面，请检查确认。'+(trimmed?'作品最多 10 个标签，已保留分级并缩减末尾画面标签。':'');
 }catch(error){if(current()){result.error=true;result.retry=true;result.message='角色标签匹配未完成：'+error.message;}}
 finally{if(result.sequence===sequence){result.loading=false;if(current())renderAfterNameResolution(m);}}
}
function acceptTagPool(m,pool) {
 if(!pool||pool.mode!==state.mode||pool.accountId!==m.draft.accountId||!Array.isArray(pool.tags))return false;
 const account=state.accounts.find(item=>item.id===m.draft.accountId);
 if(account?.pixivUserId&&pool.pixivUserId!==account.pixivUserId)return false;
 m.tagPool={...pool,tags:[...new Set(pool.tags.filter(tag=>typeof tag==='string'&&tag.trim()).map(tag=>tag.trim()))]};
 m.tagPoolError='';return true;
}
async function loadTagPool(m) {
 if(ui.modal!==m||m?.kind!=='editor')return;
 const accountId=m.draft.accountId,requestedMode=state.mode,request=(m.tagPoolRequest||0)+1;m.tagPoolRequest=request;
 m.tagPoolLoading=true;m.tagPoolError='';render();
 const current=()=>ui.modal===m&&state.mode===requestedMode&&m.draft.accountId===accountId&&m.tagPoolRequest===request;
 try{if(accountId){const pool=await api(`/api/tags/pool?accountId=${encodeURIComponent(accountId)}&mode=${encodeURIComponent(requestedMode)}`,undefined,'GET');if(current())acceptTagPool(m,pool);}}
 catch(error){if(current())m.tagPoolError='读取常用标签失败：'+error.message;}
 finally{if(current()){m.tagPoolLoading=false;render();}}
}
async function updateTagPool(m,kind,tag) {
 if(m?.kind!=='editor'||ui.modal!==m||isLocked(m.draft)||m.tagPoolBusy)return;
 const accountId=m.draft.accountId,requestedMode=state.mode;if(!accountId)throw new Error('请先选择投稿账号。');
 const addTags=kind==='add'?[...m.draft.tags]:undefined;if(addTags&&!addTags.length)return;
 const request=(m.tagPoolRequest||0)+1;m.tagPoolRequest=request;m.tagPoolRevision=(m.tagPoolRevision||0)+1;
 m.tagPoolBusy=kind;m.tagPoolLoading=false;m.tagPoolError='';m.tagPoolMessage='';render();
 const current=()=>ui.modal===m&&state.mode===requestedMode&&m.draft.accountId===accountId&&m.tagPoolRequest===request;
 try{
  const pool=await api(kind==='sync'?'/api/tags/pool/sync':'/api/tags/pool',{mode:requestedMode,accountId,...(addTags?{addTags}:{}),...(kind==='remove'?{removeTags:[tag]}:{})});
  if(current()&&acceptTagPool(m,pool))m.tagPoolMessage=kind==='sync'?`已同步 ${pool.tags.length} 个常用标签。`:kind==='remove'?'已从此账号的常用标签池移除。':'已将当前作品标签加入此账号的常用标签池。';
 }catch(error){if(current())m.tagPoolError=(kind==='sync'?'同步未完成：':'保存未完成：')+error.message;}
 finally{if(current()){m.tagPoolBusy=false;render();}}
}
function resetTagPool(m) {m.tagPoolRequest=(m.tagPoolRequest||0)+1;m.tagPoolRevision=(m.tagPoolRevision||0)+1;m.tagPool=null;m.tagPoolLoading=false;m.tagPoolBusy=false;m.tagPoolError='';m.tagPoolMessage='';m.tagPoolQuery='';m.tagPoolExpanded=false;m.tagPoolManaging=false;}
function renderTagPool(m,d) {
 const account=state.accounts.find(item=>item.id===d.accountId),pool=m.tagPool?.accountId===d.accountId?m.tagPool:null,tags=pool?.tags||[];
 const query=(m.tagPoolQuery||'').trim().toLocaleLowerCase(),matches=tags.map((tag,index)=>({tag,index})).filter(item=>!query||item.tag.toLocaleLowerCase().includes(query));
 const visible=query||m.tagPoolExpanded?matches:matches.slice(0,30),busy=Boolean(m.tagPoolBusy);
 const status=m.tagPoolLoading?'正在读取本机常用标签…':m.tagPoolBusy==='sync'?'正在从 Pixiv 同步，请稍候…':m.tagPoolMessage||`${tags.length} 个常用标签${pool?.checkedAt?' · 最近同步 '+dateText(pool.checkedAt):' · 保存在本机'}`;
 return `<section class="tag-pool" aria-label="常用标签池"><div class="tag-pool-head"><div><strong>常用标签池</strong><span>${escape(account?.name||'请先选择账号')}</span></div><div class="tag-pool-actions">${state.mode==='live'?btn('tag-pool-sync',m.tagPoolBusy==='sync'?'同步中…':'从 Pixiv 同步','refresh','ghost small',busy||!d.accountId?'disabled':''):''}${btn('tag-pool-add-current','将当前标签加入常用','plus','ghost small',busy||!d.accountId||!d.tags.length?'disabled':'')}</div></div><p class="help" role="status" aria-live="polite">${escape(status)}</p><p class="help">点击标签即可加入作品；自动识图也会优先选择这个账号常用且符合画面的标签。</p>${m.tagPoolError?`<div class="tag-pool-error"><p class="help" role="alert">${escape(m.tagPoolError)}</p>${btn('tag-pool-retry','重新读取','','ghost small',busy?'disabled':'')}</div>`:''}${tags.length>12?`<input id="tag-pool-query" value="${escape(m.tagPoolQuery||'')}" placeholder="筛选常用标签" aria-label="筛选常用标签">`:''}<div class="tag-pool-list">${visible.map(({tag,index})=>{const selected=hasTag(d.tags,tag);return `<span class="tag-pool-item">${btn(`tag-pool-tag:${index}`,`${selected?icon('check'):''}${escape(tag)}`,'',`tag-pool-chip${selected?' selected':''}`,`aria-pressed="${selected}" ${selected?'disabled':''}`)}${m.tagPoolManaging?btn(`tag-pool-remove:${index}`,'','close','tag-pool-remove',`aria-label="从常用标签池移除 ${escape(tag)}" ${busy?'disabled':''}`):''}</span>`;}).join('')||`<p class="help">${query?'没有匹配的常用标签。':m.tagPoolLoading?'标签加载后会显示在这里。':state.mode==='live'?'还没有常用标签。可以从 Pixiv 同步，或将当前作品的标签加入常用。':'还没有常用标签，可将当前作品的标签加入常用。'}</p>`}</div>${tags.length?`<div class="tag-pool-foot">${!query&&matches.length>30?btn('tag-pool-expand',m.tagPoolExpanded?'收起':`展开全部 ${matches.length} 个`,'','ghost small'):''}${btn('tag-pool-manage',m.tagPoolManaging?'完成管理':'管理标签','','ghost small',busy?'disabled':'')}${m.tagPoolManaging?'<span>移除只影响本机标签池，不会修改 Pixiv。</span>':''}</div>`:''}</section>`;
}
function isRatingTag(tag) {return /^R-18G?$/i.test(tag);}
function alignRatingTag(tags,rating,roles={}) {
 const ordered=[...new Set(tags.filter(tag=>typeof tag==='string'&&tag.trim()).map(tag=>tag.trim()))].filter(tag=>!isRatingTag(tag));
 const label=rating==='r18'?'R-18':rating==='r18g'?'R-18G':null;
 if(label){let position=0;for(let i=0;i<ordered.length;i++)if(roles[ordered[i]]==='game')position=i+1;ordered.splice(Math.min(position,9),0,label);}
 return ordered.slice(0,10);
}
function automaticTagList(result,rating) {const roles=Object.fromEntries((result.candidates||[]).map(c=>[c.tag,c.tagRole]));const tags=tagStrings(result.orderedTags||result.automaticTags);return result.template?alignTemplateRating(tags,rating,result.template):alignRatingTag(tags,rating,roles);}
function clearAutomaticTags(m) {if(m.automaticTagsApplied&&!(m.tagsRevision||0)){m.draft.tags=[];m.automaticTagsApplied=false;m.autoTagRoles={};}}
function manualTagsChanged(m) {if(m.templateOwnedTags){m.templateRemovedTags=tagStrings([...(m.templateRemovedTags||[]),...m.templateOwnedTags.filter(tag=>!m.draft.tags.includes(tag))]).filter(tag=>!m.draft.tags.includes(tag));m.templateOwnedTags=m.templateOwnedTags.filter(tag=>m.draft.tags.includes(tag));}if(m.autoAppliedTags)m.autoAppliedTags=m.autoAppliedTags.filter(tag=>m.draft.tags.includes(tag));if(m.automaticCharacterTags)m.automaticCharacterTags=m.automaticCharacterTags.filter(tag=>hasTag(m.draft.tags,tag));if(m.characterInsertedTags)m.characterInsertedTags=m.characterInsertedTags.filter(tag=>hasTag(m.draft.tags,tag));m.tagsRevision=(m.tagsRevision||0)+1;m.draft.tagsConfirmed=false;m.autoTagsMessage='';syncTemplateMetadata(m);}
function applyAutomaticTags(m,result,requestedRevision) {
 if((!Array.isArray(result.automaticTags)&&!Array.isArray(result.orderedTags))||result.source==='demo'||m.templateSelectionOrigin==='manual'||m.templateAwaitingAccountChoice)return;
 if(requestedRevision!==0||(m.tagsRevision||0)!==0||(m.draft.tags.length&&!m.automaticTagsApplied)){m.autoTagsMessage='已保留你填写的标签，可从识图结果中补充。';return;}
 if(result.template&&(m.titleRevision||isNameResolving(m))){m.autoTagsMessage='已保留你填写的角色名，按该角色继续匹配历史标签。';return;}
 if(result.template&&nameResolutionEligible(m)&&templateScopeMatches(m,result)){applyHistoryTemplate(m,result);return;}
 if(result.template)return;
 m.draft.tags=automaticTagList(result,m.draft.content.rating);m.autoAppliedTags=[...m.draft.tags];m.draft.tagsConfirmed=false;m.automaticTagsApplied=true;
 m.autoTagRoles=Object.fromEntries((result.candidates||[]).map(c=>[c.tag,c.tagRole]));m.automaticCharacterTags=m.draft.tags.filter(tag=>['game','character'].includes(m.autoTagRoles[tag]));m.automaticCharacterName=result.recognition?.title||'';
 m.autoTagsMessage=m.draft.tags.length?`已自动填写 ${m.draft.tags.length} 个标签，按游戏、分级、角色、画面内容排序。`:'暂未找到足够可靠的标签，请从下方匹配结果中检查补充。';
}
function renderSuggestions(m,d) {
 const provider=m.tagProvider||(state.mode==='demo'?'demo':'local');
 const result=m.analysis;
 const candidates=m.candidates;
 const isDemo=m.suggestionSource==='demo';
 return `<div class="suggestions"><div class="suggestions-head"><span>${icon('sparkle')} 智能标签建议</span><div class="tagger-actions"><select id="tag-provider" aria-label="标签建议来源" ${m.suggesting?'disabled':''}>${state.mode==='demo'?option('demo','演示建议',provider):''}${option('local','识图与 Pixiv 匹配',provider)}</select>${btn('suggest-tags',m.suggesting?'正在识别…':'分析作品','sparkle','small',m.suggesting?'disabled':'')}</div></div>${candidates?`<div class="suggestion-list">${candidates.map((c,i)=>btn(`suggestion:${i}`,`${escape(c.tag)}<small>${isDemo?'示例':c.preferred?(c.freshVerified===false?'常用 · 已缓存':'常用'):c.freshVerified===false||c.source==='pixiv-cache'?'Pixiv 已缓存':result?.tagSearch?'全站匹配':'本地证据'}${!isDemo&&Number.isFinite(c.modelScore??c.confidence)?' · '+Math.round((c.modelScore??c.confidence)*100)+'分':''}</small>`,'',`suggestion ${m.chosen?.has(i)?'selected':''}`,`title="${escape(c.reason||'')}" aria-pressed="${m.chosen?.has(i)||false}"`)).join('')||'<p class="help">本次没有匹配到标签证据库中的标签，不会凭空推荐。</p>'}</div>${m.autoTagsMessage?`<p class="help" role="status">${escape(m.autoTagsMessage)}</p>`:''}${!isDemo&&candidates.length?`<p class="help">${result?.tagSearch?.source==='pixiv'?'已匹配 Pixiv 全站标签；账号常用且相关的标签优先。':result?.tagSearch?.source==='pixiv-cache'?'本次使用此前保存的 Pixiv 标签记录；账号常用且相关的标签优先，可同步后更新。':'当前为本地标签证据，连接 Chrome 后可匹配全站。'}</p>`:''}${result?.warnings?.length?`<p class="help tag-warning">${result.warnings.map(escape).join('<br>')}</p>`:''}${result?.unmapped?.length?`<details class="unmapped"><summary>识别到的其他概念（${result.unmapped.length}，尚无 Pixiv 来源证据）</summary><p>${result.unmapped.slice(0,24).map(item=>escape(item.name||item.concept||item.tag||item)).join(' · ')}</p><p>这些是模型词汇，不会自动成为投稿标签。</p></details>`:''}<div class="suggestions-foot"><span>${isDemo?'固定演示标签，不代表识图结果':`已在本机分析 ${result?.analyzedFiles?.length??d.files.length} 张图片 · 匹配标签时仅发送关键词`}</span>${btn('accept-tags','应用所选','','small',!m.chosen?.size?'disabled':'')}</div>`:`<p class="help">${provider==='demo'?'演示模式展示候选选择流程。切换“本地识图”可分析你实际上传的图片。':'上传后自动识别角色和分级，填写标题并筛选 Pixiv 标签。相关的常用标签优先，填写后仍可手动修改。'}</p>`}</div>`;
}

function publicationNeedsReview(job) {return job?.status==='needs_review'&&(Boolean(job.publicationCheck)||job.reviewReason==='reservation_missing_remotely');}
function publicationReviewReason(job) {
 const reasons={ambiguous_match:'找到多个相似作品，暂时无法确认对应哪一件。',baseline_missing:'缺少预约前的已发布作品记录，无法可靠区分新旧作品。',metadata_missing:'作品信息尚不完整，暂时无法核对是否为同一件作品。',published_index_unavailable:'暂时无法读取完整的已发布作品列表，将在下次核实时重试。',candidate_limit:'待比对作品过多，本次未能完成可靠核实。',candidate_read_failed:'部分候选作品读取失败，将在下次核实时重试。',no_unique_match:'暂未找到唯一匹配的已发布作品。',publication_evidence_missing:'用于区分同名作品的标签或年龄分级资料不完整，暂不能确认。',publication_evidence_mismatch:'Pixiv 作品的标签或年龄分级与投稿记录不一致，保留待核实。'};
 const reason=job.publicationCheck?.reason;
 return Object.hasOwn(reasons,reason)?reasons[reason]:'暂未取得足以确认发布的证据，保留待核实状态。';
}
function editorIssue(d) {
 if(publicationNeedsReview(d))return `<div class="field-error" role="status"><strong>发布状态待核实</strong><br>${escape(publicationReviewReason(d))}${Number.isFinite(Date.parse(d.publicationCheck?.checkedAt))?`<br>上次核实：${dateText(d.publicationCheck.checkedAt)}`:''}${state.mode==='live'?'<br>每 6 小时自动核实；也可在工作台点击「同步 Pixiv 状态」立即核实，不会投稿。':''}</div>`;
 if(!['needs_review','failed'].includes(d.status)||!(d.lastError||d.error))return '';
 return `<div class="field-error" role="status">${escape(d.lastError||d.error)}${d.reviewReason==='reservation_time_mismatch'?`<br>计划时间：${dateText(d.scheduledAt)} · 远端时间：${dateText(d.remoteScheduledAt)}`:''}</div>`;
}
function canRetryReservation(job) {return job?.status==='failed'&&job.uploadOutcome==='not_uploaded'&&!job.remoteId&&job.canDeleteLocally!==false;}
function retryReservationButton(job) {return canRetryReservation(job)?btn(`retry-job:${job.id}`,'重新预约','','small reservation-retry',`aria-label="重新预约 ${escape(job.title||'未命名作品')}" ${queueIsRunning()||pixivSyncing?'disabled':''}`):'';}
function openEditor(d,tab='basic',error='') {
 ui.modal={kind:'editor',draft:structuredClone(d),tab,error,tagsRevision:d.tags.length?1:0,titleRevision:d.title?1:0,ratingRevision:d.content.rating?1:0};
 restoreTemplateMetadata(ui.modal);render();void loadTagPool(ui.modal);void loadCharacterTemplates(ui.modal);
}
async function retryReservation(id) {
 const job=state.jobs.find(j=>j.id===id);
 if(!canRetryReservation(job))throw new Error('该作品当前不能重新预约，请刷新并核对作品状态。');
 if(queueIsRunning()||pixivSyncing)return toast('正在处理预约或同步状态，请完成后再重新预约。');
 const scheduledAt=Date.parse(job.scheduledAt);
 if(!Number.isFinite(scheduledAt)||scheduledAt<=Date.parse(now())){
  openEditor(job,'schedule',Number.isFinite(scheduledAt)?'原预约时间已过期，请调整日期与时间后点击“重新预约”。':'请先设置预约日期与时间，再点击“重新预约”。');return;
 }
 try{state=await api(`/api/jobs/${id}`,{status:'queued'},'PATCH');}
 catch(error){if(error.details)openEditor(job);throw error;}
 ui.selected.delete(id);render();toast('已重新加入待补位，将按队列规则预约；也可在工作台点击“开始预约”。');
}
function optionsForm(d) {const c=d.content;return `${field('AI 生成作品 · 必选',`<div class="radio-options">${radio('content.aiGenerated','false',c.aiGenerated,'否')}${radio('content.aiGenerated','true',c.aiGenerated,'是，AI 生成作品')}</div>`)}${field('年龄限制 · 必选',`<div class="radio-options">${radio('content.rating','all',c.rating,'全年龄')}${radio('content.rating','r18',c.rating,'R-18')}${radio('content.rating','r18g',c.rating,'R-18G')}</div>`)}${c.rating==='all'?`<div class="rating-child">${field('性描写 · 必选',`<div class="radio-options">${radio('content.sexualContent','false',c.sexualContent,'无')}${radio('content.sexualContent','true',c.sexualContent,'有（含有轻度描写）')}</div>`,'全年龄作品也需要明确确认是否含性相关或性暗示内容。')}</div>`:''}${['r18','r18g'].includes(c.rating)?`<div class="rating-child"><div class="field-label">作品属性 <span>可选 · 默认留空</span></div><div class="radio-options">${[['underage','未成年'],['furry','兽'],['bl','BL'],['gl','GL']].map(([key,label])=>`<label class="checkbox-line"><input type="checkbox" data-adult-attribute="${key}" ${(c.adultAttributes||[]).includes(key)?'checked':''}>${label}</label>`).join('')}</div></div>`:''}${checkField('content.original',c.original,'原创作品')}<div class="form-divider"></div>${field('公开范围',`<select data-field="content.visibility">${[['public','全体公开'],['logged_in','仅登录用户'],['mypixiv','仅好P友'],['private','非公开']].map(([key,label])=>option(key,label,c.visibility)).join('')}</select>`)}${checkField('content.allowTagEdit',c.allowTagEdit,'允许其他用户编辑标签')}${checkField('content.allowComments',c.allowComments,'允许评论和贴纸')}${checkField('content.allowCollection',c.allowCollection!==false,'允许他人将自己的作品添加至珍藏册')}${c.type==='manga'?field('漫画系列',input('content.seriesId',c.seriesId,'已有系列 ID（可选）')):''}<div class="form-divider"></div><div class="field-row">${field('缩略图使用第几张',input('content.thumbnail.page',c.thumbnail.page,'','type="number" min="1" max="200"'))}${field('缩略图焦点',`<select id="thumbnail-position">${[['center','居中'],['top','顶部'],['bottom','底部']].map(([k,l])=>option(k,l,c.thumbnail.y===0?'top':c.thumbnail.y===1?'bottom':'center')).join('')}</select>`,'最终裁切区域由远端页面确认。')}</div>`;}
function scheduleForm(d) {const selected=state.accounts.find(a=>a.id===d.accountId);const value=wall(d.scheduledAt,'Asia/Tokyo');return `<div class="field-row">${field('预约日期',`<input type="date" data-field="scheduleDate" value="${ui.modal.scheduleDate??value.slice(0,10)}">`)}${field('预约时间',`<select data-field="scheduleTime">${timeOptions(ui.modal.scheduleTime??value.slice(11,16))}</select>`)}</div>${field('预约时区','<input value="日本时间 · JST · UTC+9" readonly>')}${field('对应北京时间',`<input value="${d.scheduledAt?wall(d.scheduledAt,'Asia/Shanghai').replace('T',' ')+' · UTC+8':'请选择日期与时间'}" readonly>`)}<div class="schedule-explainer">${icon('calendar')}<strong>先排进本地队列，再自动补位。</strong><br>新投稿默认选择从现在起最近的一次账号默认投稿时间：日本时间当天尚未到点则选当天，已到或已过则选次日。未来一周内有预约名额时提交到 Pixiv；较远的排期保留在本地等待。</div><div class="setting-row"><div><strong>${escape(selected?.name||'请先选择账号')}</strong><p>默认 ${postingTime(selected)} JST · ${selected?.premium?'Premium':'需要 Premium 才能预约'}</p></div><span class="badge ${selected?.connected?'published':'needs_review'}">${selected?.remote?.total||0} / 10 名额</span></div><p class="help">尚未提交的队列需要电脑及本地服务保持运行。已在 Pixiv 确认的预约由 Pixiv 执行。</p>`;}

function render() {if(ui.view==='analytics'&&analytics.composing)return;const analyticsFocus=document.activeElement?.id==='analytics-query'?{start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;if(ui.modal?.filePickerOpen){ui.modal.filePickerRenderPending=true;return;}if(ui.modal?.characterQueryComposing){ui.modal.characterQueryRenderPending=true;return;}if(ui.modal?.memoryTagComposing){ui.modal.memoryTagRenderPending=true;return;}pruneSelection();const rankingScroll=ui.view==='analytics'?document.querySelector('.analytics-ranking .analytics-table-scroll'):null;if(rankingScroll&&!analytics.tableScrollReset)analytics.tableScrollLeft=rankingScroll.scrollLeft;const scroll=document.querySelector('.modal-body')?.scrollTop||0,uploadInput=ui.modal?.kind==='editor'?document.querySelector('#editor-files'):null;app.innerHTML=shell();if(ui.view==='analytics'){const nextRankingScroll=document.querySelector('.analytics-ranking .analytics-table-scroll');if(nextRankingScroll)nextRankingScroll.scrollLeft=analytics.tableScrollLeft;}analytics.tableScrollReset=false;const nextUpload=document.querySelector('#editor-files');if(uploadInput&&nextUpload&&ui.modal?.kind==='editor'&&uploadInput.replaceWith){uploadInput.disabled=nextUpload.disabled;nextUpload.replaceWith(uploadInput);}if(ui.modal)document.querySelector('.modal-body').scrollTop=scroll;if(analyticsFocus){const input=document.querySelector('#analytics-query');input?.focus();input?.setSelectionRange(analyticsFocus.start,analyticsFocus.end);}}
async function refresh(renderPage=true) {state=await api('/api/state',undefined,'GET');if(analytics.mode&&analytics.mode!==state.mode)resetAnalytics();if(renderPage)render();if(ui.view==='analytics'&&!analytics.loading)await loadAnalytics({quiet:true});}
async function mutate(url,data,method='POST') {const result=await api(url,data,method);state=result;if(analytics.mode&&analytics.mode!==state.mode)resetAnalytics();render();return result;}
function modalError(error) {if(ui.modal){const issues=Array.isArray(error.details)?error.details:error.details?.errors;ui.modal.error=issues?.map(e=>e.message).join(' ')||error.message;render();}toast(error.message);}
function setPath(object,key,value){const names=key.split('.');const last=names.pop();let dest=object;for(const name of names){dest[name]??={};dest=dest[name];}dest[last]=value;}
function handleField(target) {const m=ui.modal;if(!m)return;if(target.dataset.memoryTagInput){const key=target.dataset.memoryTagInput;if(memoryTagsEditable(m,key)&&m.memoryTagInputs?.[key]!==target.value){m.memoryTagInputs??={};m.memoryTagInputs[key]=target.value;markMemoryTagsEdited(m,key);const confirmation=document.querySelector('[data-memory-field="confirmedSingleCharacter"]'),save=document.querySelector('[data-action="memory-save"]');if(confirmation)confirmation.checked=false;if(save)save.disabled=true;}return;}if(target.dataset.memoryField){if(m.kind==='editor'&&m.memoryForm&&!m.memorySaving){const key=target.dataset.memoryField;m.memoryForm[key]=target.type==='checkbox'?target.checked:target.value;if(key==='englishName')scheduleNameResolution(m,'memory');}return;}if(Object.hasOwn(target.dataset,'memoryCandidateConfirm')){if(m.kind==='editor'&&!m.memorySaving)m.memoryCandidateConfirmed=target.checked;return;}if(target.dataset.reconcileField){m[target.dataset.reconcileField]=target.type==='checkbox'?target.checked:target.value;return;}if(target.dataset.adultAttribute&&m.kind==='editor'&&!isLocked(m.draft)){const current=new Set(m.draft.content.adultAttributes||[]);target.checked?current.add(target.dataset.adultAttribute):current.delete(target.dataset.adultAttribute);m.draft.content.adultAttributes=[...current];}const key=target.dataset.field;if(key) {let value=target.type==='checkbox'?target.checked:target.value;if(['content.aiGenerated','content.sexualContent'].includes(key))value=value==='true';if(key==='content.tools')value=value.split(/[,、，]/).map(s=>s.trim()).filter(Boolean);if(key==='content.poll.answers')value=value.split('\n');if(key==='content.thumbnail.page')value=Number(value);if(m.kind==='editor') {if(isLocked(m.draft))return;if(['scheduleDate','scheduleTime'].includes(key)){const old=wall(m.draft.scheduledAt,'Asia/Tokyo');m.scheduleDate??=old.slice(0,10);m.scheduleTime??=old.slice(11,16);m[key]=value;m.scheduleDirty=true;m.draft.timezone='Asia/Tokyo';try{m.draft.scheduledAt=toIso(`${m.scheduleDate}T${m.scheduleTime}`,'Asia/Tokyo');}catch{m.draft.scheduledAt='';}}else {if(key==='accountId'&&value!==m.draft.accountId&&m.draft.id&&!m.draft.tagTemplate&&!m.selectedTemplate&&m.draft.tags.length){m.legacyTemplateUnresolved=true;m.legacyTemplateAccountId=m.draft.accountId;}setPath(m.draft,key,value);if(key==='title'){m.titleRevision=(m.titleRevision||0)+1;scheduleNameResolution(m,'title');}if(['content.rating','content.sexualContent'].includes(key))m.ratingRevision=(m.ratingRevision||0)+1;if(key==='content.rating'&&m.selectedTemplate){const retained=m.draft.tags.filter(tag=>isRatingTag(tag)||!hasTag(m.templateOwnedTags||[],tag));const aligned=alignTemplateRating(m.draft.tags,value,m.selectedTemplate);for(const tag of retained)if(!isRatingTag(tag)&&!hasTag(aligned,tag)){const expendable=aligned.findLastIndex(item=>!isRatingTag(item)&&hasTag(m.templateOwnedTags||[],item)&&!hasTag([...(m.selectedTemplate.gameTags||[]),...(m.selectedTemplate.characterTags||[])],item));if(expendable>=0){aligned.splice(expendable,1);aligned.push(tag);}}m.draft.tags=aligned;m.draft.tagsConfirmed=false;void selectCharacterTemplate(m,m.selectedTemplate.id,{refresh:true,preserveTitle:true});}else if(key==='content.rating'&&m.automaticTagsApplied){m.draft.tags=alignRatingTag(m.draft.tags,value,m.autoTagRoles);keepCharacterTagsFirst(m);m.draft.tagsConfirmed=false;}if(key==='accountId'){clearTemplate(m,{catalog:true});if(!m.templateAwaitingAccountChoice)clearAutomaticTags(m);invalidateNameResolutions(m);}if(key==='accountId'&&!m.scheduleDirty&&!m.draft.id)m.draft.scheduledAt=nextSchedule(value);}}else if(m.kind==='account')setPath(m.account,key,value);}if(target.dataset.batchField)m[target.dataset.batchField]=target.type==='number'?Number(target.value):target.value;if(target.dataset.importField)m[target.dataset.importField]=target.value;}
function cleanDraft(d,status) {const result=structuredClone(d);result.tagTemplate=d.tagTemplate||null;result.status=status;result.timezone='Asia/Tokyo';result.content.poll.answers=result.content.poll.answers.map(x=>x.trim()).filter(Boolean);if(result.content.type!=='manga')result.content.seriesId='';if(result.content.rating==='all')result.content.adultAttributes=[];else result.content.sexualContent=null;return result;}
async function saveDraft(status,keep=false) {const m=ui.modal,requestedMode=state.mode,signature=fileSelectionSignature(m.draft);if(m.suggesting||m.uploading||m.memorySaving)throw new Error('识图、角色记忆或图片保存尚未完成，请稍候再保存。');await finishNameResolutions(m);if(ui.modal!==m)return;if(state.mode!==requestedMode||fileSelectionSignature(m.draft)!==signature)throw new Error('作品图片或投稿账号已经改变，请确认当前内容后重新保存。');if(m.suggesting||m.uploading||m.memorySaving||m.templateAwaitingAccountChoice)throw new Error('请等待识图完成，并选择当前账号对应的角色模板后再保存。');syncTemplateMetadata(m);const d=m.draft;const payload=cleanDraft(d,status);state=await api(d.id?`/api/jobs/${d.id}`:'/api/jobs',payload,d.id?'PATCH':'POST');const saved=state.jobs.find(j=>j.id===(d.id||state.createdJobId));if(keep){m.draft=structuredClone(saved);}else ui.modal=null;render();if(!keep)toast(status==='queued'?'已保存到预约队列。':'草稿已保存在本机。');return saved;}
async function uploadFile(file) {if(file.size>32*1024*1024)throw new Error(`${file.name} 超过 32 MB。`);if(!['image/jpeg','image/png','image/gif'].includes(file.type))throw new Error(`${file.name} 不是支持的图片格式。`);const response=await fetch(`/api/files?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':file.type},body:file});const data=await response.json();if(!response.ok)throw new Error(data.error||'图片上传失败。');return data.file;}
async function addFiles(files) {
 const m=ui.modal;if(m?.kind!=='editor'||isLocked(m.draft))return;if(inFlight)return toast('图片正在保存，请稍候。');
 inFlight=true;m.uploading=true;m.error='';invalidateNameResolutions(m);render();toast('正在保存图片，请稍候…');let completed=0;
 try{if(m.draft.files.length+files.length>200||m.draft.files.reduce((sum,f)=>sum+f.size,0)+files.reduce((sum,f)=>sum+f.size,0)>200*1024*1024)throw new Error('每件作品最多 200 张，合计不超过 200 MB。');for(const f of files){const uploaded=await uploadFile(f);if(!completed)clearTemplate(m);m.draft.files.push(uploaded);m.draft.tagsConfirmed=false;clearAutomaticTags(m);clearSuggestions(m);completed++;m.draft.title='';m.titleRevision=0;m.ratingRevision=0;m.draft.content.rating=null;m.draft.content.sexualContent=null;}toast('已添加 '+completed+' 张图片。');}
 finally{inFlight=false;m.uploading=false;if(ui.modal===m)render();if(completed&&ui.modal===m)void recognize(m,true);}
}
async function recognize(m,automatic=false) {
 if(m?.kind!=='editor'||m.uploading||isLocked(m.draft)||ui.modal!==m)return;
 if(m.memorySaving){if(automatic)m.pendingAuto=true;return;}
 if(m.suggesting){if(automatic)m.pendingAuto=true;return;}
 if(!m.draft.files.length){if(automatic)return;throw new Error('先添加图片，再获取标签建议。');}
 m.suggesting=true;m.error='';clearSuggestions(m);
 const signature=fileSelectionSignature(m.draft),requestedMode=state.mode,titleRevision=m.titleRevision||0,ratingRevision=m.ratingRevision||0,tagsRevision=m.tagsRevision||0,tagPoolRevision=m.tagPoolRevision||0;
 render();
 try {
  const result=await api('/api/tags/suggest',{draft:cleanDraft(m.draft,'draft'),provider:automatic?'local':m.tagProvider||(state.mode==='demo'?'demo':'local')});
  if(ui.modal!==m)return;
  if(result.stale||signature!==fileSelectionSignature(m.draft)||requestedMode!==state.mode){if(automatic)return;throw new Error('图片或工作空间发生变化，请重新分析。');}
  m.candidates=result.candidates;m.suggestionSource=result.source;m.suggestionSignature=signature;m.analysis=result;m.chosen=new Set();
  if(!m.tagPoolBusy&&(m.tagPoolRevision||0)===tagPoolRevision&&acceptTagPool(m,result.tagPool)){m.tagPoolRequest=(m.tagPoolRequest||0)+1;m.tagPoolLoading=false;}
  if(result.recognition){const r=result.recognition;if(titleRevision===0&&(m.titleRevision||0)===0)m.draft.title=r.title||'';if(ratingRevision===0&&(m.ratingRevision||0)===0){m.draft.content.rating=r.rating;m.draft.content.sexualContent=r.sexualContent;}m.recognition=r;}
  if(!nameResolutionEligible(m)&&m.selectedTemplate){clearTemplate(m);m.draft.title='';}
  applyAutomaticTags(m,result,tagsRevision);
  if(m.selectedTemplate&&m.templateSelectionOrigin==='manual'&&nameResolutionEligible(m)&&(m.tagsRevision||0)===tagsRevision){void selectCharacterTemplate(m,m.selectedTemplate.id,{refresh:true,preserveTitle:true});}
 } catch(error) {if(ui.modal===m){if(!automatic)throw error;m.error='自动识图未完成：'+error.message;}}
 finally {m.suggesting=false;if(ui.modal===m){render();if(m.pendingAuto){m.pendingAuto=false;void recognize(m,true);}else for(const source of ['title','memory'])if(m.characterResolutions?.[source]?.pending)scheduleNameResolution(m,source,true);}}
}
function addTag() {const input=document.querySelector('#tag-input');const value=input?.value.trim().replace(/^#/,'');const m=ui.modal;if(!value||!m||isLocked(m.draft))return;if(hasTag(m.draft.tags,value))return toast('这个标签已经添加。');if(m.draft.tags.length>=10)return toast('每件作品最多 10 个标签。');m.draft.tags.push(value);manualTagsChanged(m);render();document.querySelector('#tag-input')?.focus();}
function confirmModal(title,message,run,label='确认') {ui.modal={kind:'confirm',title,message,run,label};render();}
function openCharacterMemory(m) {
 if(!memoryEligible(m)||m.suggesting||m.uploading||m.memorySaving)return;
 const exact=m.recognition?.memory?.exact;
 const tagsFor=role=>m.draft.tags.filter(tag=>(m.analysis.candidates||[]).some(candidate=>candidate.tag===tag&&candidate.tagRole===role)||m.characterCoreRoles?.[tag]===role);
 m.memoryForm={englishName:m.draft.title||exact?.englishName||'',gameTags:memoryTagValues(exact?.gameTags||tagsFor('game').slice(0,4)),characterTags:memoryTagValues(exact?.characterTags||tagsFor('character').slice(0,4)),confirmedSingleCharacter:false};
 m.memoryTagInputs={gameTags:'',characterTags:''};m.memoryFieldRevisions={};m.memoryAutoFields={gameTags:[...m.memoryForm.gameTags],characterTags:[...m.memoryForm.characterTags]};if(m.characterResolutions?.memory){clearTimeout(m.characterResolutions.memory.timer);m.characterResolutions.memory.sequence++;m.characterResolutions.memory.loading=false;m.characterResolutions.memory.waiting=false;m.characterResolutions.memory.pending=false;m.characterResolutions.memory.lastKey=null;m.characterResolutions.memory.message='';}m.memoryError='';m.memoryMessage='';render();
}
function memoryTagValues(value) {
 const values=Array.isArray(value)?value:String(value||'').split(/[,，、\r\n]/),tags=[];
 for(const value of values){const tag=String(value).trim();if(!tag)continue;if(tag.length>64||/[\u0000-\u001f\u007f]/.test(tag))throw new Error('每个标签不超过 64 字，不能包含控制字符。');if(!hasTag(tags,tag))tags.push(tag);}
 if(tags.length>4)throw new Error('游戏标签和角色标签每类最多 4 个，请移除不需要的标签后再添加。');
 return tags;
}
function memoryTagsEditable(m,key) {return ['gameTags','characterTags'].includes(key)&&memoryEligible(m)&&m.memoryForm&&!m.memorySaving&&!m.suggesting&&!m.uploading;}
function markMemoryTagsEdited(m,key) {m.memoryFieldRevisions??={};m.memoryFieldRevisions[key]=(m.memoryFieldRevisions[key]||0)+1;m.memoryForm.confirmedSingleCharacter=false;m.memoryError='';}
function memoryTagsWithPending(m,key) {return memoryTagValues([...memoryTagValues(m.memoryForm[key]),...memoryTagValues(m.memoryTagInputs?.[key])]);}
function addMemoryTag(m,key) {
 if(!memoryTagsEditable(m,key)||!m.memoryTagInputs?.[key]?.trim())return;
 const tags=memoryTagsWithPending(m,key);m.memoryForm[key]=tags;m.memoryTagInputs[key]='';markMemoryTagsEdited(m,key);render();document.querySelector(`#memory-tag-input-${key}`)?.focus();
}
function removeMemoryTag(m,key,index) {
 if(!memoryTagsEditable(m,key)||!Number.isInteger(index)||index<0||index>=m.memoryForm[key].length)return;
 m.memoryForm[key]=m.memoryForm[key].filter((_,i)=>i!==index);markMemoryTagsEdited(m,key);render();document.querySelector(`#memory-tag-input-${key}`)?.focus();
}
function flushMemoryTags(m) {
 if(!m?.memoryForm)return;
 // Validate both fields first, so an invalid entry never discards the other input.
 const values=Object.fromEntries(['gameTags','characterTags'].map(key=>[key,memoryTagsWithPending(m,key)]));
 Object.assign(m.memoryForm,values);m.memoryTagInputs={gameTags:'',characterTags:''};
}
async function rememberCharacter(m,candidate) {
 if(m?.memorySaving)return;
 if(!candidate)flushMemoryTags(m);
 await finishNameResolutions(m);if(ui.modal!==m)return;
 if(!memoryEligible(m)||m.suggesting||m.uploading||m.memorySaving)throw new Error('请先完成这张图片的本地识图，再记住角色。');
 if(!candidate)flushMemoryTags(m);
 const form=candidate?{englishName:candidate.englishName,gameTags:[...(candidate.gameTags||[])],characterTags:[...(candidate.characterTags||[])],confirmedSingleCharacter:m.memoryCandidateConfirmed}:m.memoryForm;
 if(!form?.confirmedSingleCharacter)throw new Error('请先确认图中只有这一个角色。');
 const englishName=form.englishName.trim();if(!englishName)throw new Error('请填写角色英文名。');
 const requestedMode=state.mode,signature=fileSelectionSignature(m.draft),analysisId=m.analysis.memoryAnalysisId,titleRevision=m.titleRevision||0;
 const payload={mode:requestedMode,draft:cleanDraft(m.draft,'draft'),analysisId,englishName,gameTags:memoryTagValues(form.gameTags),characterTags:memoryTagValues(form.characterTags),confirmedSingleCharacter:true,...(candidate?{characterId:candidate.id}:{})};
 const current=()=>ui.modal===m&&state.mode===requestedMode&&fileSelectionSignature(m.draft)===signature&&m.analysis?.memoryAnalysisId===analysisId;
 let saved;
 m.memorySaving=true;m.memoryError='';m.memoryMessage='';render();
 try {
  const result=await api('/api/characters/remember',payload);
  if(!current()||result.mode!==requestedMode)return;
  saved=result.character;
  if(!saved?.englishName)throw new Error('角色记忆结果不完整，请重新分析后查看。');
  if((m.titleRevision||0)===titleRevision){m.draft.title=saved.englishName;m.titleRevision=titleRevision+1;}
  m.memoryForm=null;m.memoryCandidateConfirmed=false;
 }catch(error){if(current()){m.memoryError=error.message;toast(error.message);}}
 finally{m.memorySaving=false;if(ui.modal===m){render();if(m.pendingAuto){m.pendingAuto=false;void recognize(m,true);}}}
 if(saved&&current()){
  void loadCharacterTemplates(m,{refreshOnly:true});
  await recognize(m,true);
  if(ui.modal===m&&state.mode===requestedMode&&fileSelectionSignature(m.draft)===signature){m.memoryMessage=`已记住 ${saved.englishName}。同图会沿用此名称，新图的相似候选仍需确认。`;render();toast(`已在本机记住 ${saved.englishName}。`);}
 }
}
async function loadCharacterMemory(m) {
 if(ui.modal!==m||m.kind!=='memory-library'||m.loading||m.deleting)return;
 const requestedMode=state.mode;m.mode=requestedMode;m.loading=true;m.error='';render();
 try{const result=await api('/api/characters',undefined,'GET');if(ui.modal===m&&state.mode===requestedMode&&result.mode===requestedMode)m.characters=result.characters;}
 catch(error){if(ui.modal===m&&state.mode===requestedMode)m.error=error.message;}
 finally{m.loading=false;if(ui.modal===m&&state.mode===requestedMode)render();}
}
async function deleteCharacterMemory(m,id) {
 if(m?.kind!=='memory-library'||m.loading||m.deleting||m.mode!==state.mode||m.deleteId!==id)return;
 const requestedMode=state.mode;m.deleting=true;m.error='';render();
 try{const result=await api(`/api/characters/${encodeURIComponent(id)}?mode=${encodeURIComponent(requestedMode)}`,undefined,'DELETE');if(ui.modal===m&&state.mode===requestedMode&&result.mode===requestedMode){m.characters=result.characters;m.deleteId=null;toast('角色记忆已删除，作品与图片已保留。');}}
 catch(error){if(ui.modal===m&&state.mode===requestedMode)m.error=error.message;}
 finally{m.deleting=false;if(ui.modal===m&&state.mode===requestedMode)render();}
}
async function action(key) {
 const [name,id]=key.split(':');const m=ui.modal;
 if(name==='analytics-collect'){await startAnalyticsCollection();return;}
 if(name==='analytics-reload'){await loadAnalytics();return;}
 if(name==='analytics-group'){if(!['work','character','tag','interval'].includes(id))return;analytics.group=id;analytics.sort=analytics.metric==='bookmarkRate'?'total':id==='interval'?'growth':id==='work'?'total':'average';if(id==='interval')analytics.point='6h';analytics.page=1;await loadAnalytics({status:false});return;}
 if(name==='analytics-metric'){if(!Object.hasOwn(analyticsMetricLabels,id))return;analytics.metric=id;if(id==='bookmarkRate')analytics.sort='total';analytics.page=1;await loadAnalytics({status:false});return;}
 if(name==='analytics-sort'){if(!['total','average','growth'].includes(id))return;if(analytics.metric==='bookmarkRate'&&id!=='total')analytics.metric='views';analytics.sort=id==='average'&&['work','interval'].includes(analytics.group)?'total':id;if(id==='growth'&&analytics.point==='current')analytics.point='6h';analytics.page=1;await loadAnalytics({status:false});return;}
 if(name==='analytics-page'){analytics.page=Math.max(1,analytics.page+(id==='prev'?-1:1));await loadAnalytics({status:false});return;}
 if(name==='character-template'){await selectCharacterTemplate(m,key.slice('character-template:'.length));return;}
 if(name==='template-undo'){const previous=m.templateUndo;if(!previous||previous.mode!==state.mode||previous.signature!==fileSelectionSignature(m.draft))return;invalidateNameResolutions(m);clearTemplate(m);m.draft.tags=[...previous.tags];m.draft.title=previous.title;m.titleRevision=(m.titleRevision||0)+1;m.tagsRevision=(m.tagsRevision||0)+1;m.legacyTemplateUnresolved=true;m.templateAwaitingAccountChoice=false;m.templateUndo=null;m.templateMessage='已恢复替换前的标题和标签。此旧草稿没有标签来源记录，选择角色会重建整组标签。';render();return;}
 if(name==='character-template-retry'){await loadCharacterTemplates(m);return;}
 if(name==='character-picker-toggle'){m.characterPickerOpen=!m.characterPickerOpen;render();return;}
 if(name==='character-show-all'){m.characterShowAll=!m.characterShowAll;renderAfterNameResolution(m);return;}
 if(name==='template-optional'){const tag=m.templateOptionalTags.filter(tag=>!hasTag(m.draft.tags,tag))[Number(id)];if(!tag||isLocked(m.draft))return;if(m.draft.tags.length>=10)throw new Error('每件作品最多 10 个标签。');insertTemplateTag(m,tag);render();return;}
 if(name==='character-resolve'){scheduleNameResolution(m,id==='memory'?'memory':'title',true,true);return;}
 if(name==='tag-pool-sync'){await updateTagPool(m,'sync');return;}
 if(name==='tag-pool-add-current'){await updateTagPool(m,'add');return;}
 if(name==='tag-pool-remove'){const tag=m?.tagPool?.tags?.[Number(id)];if(tag)await updateTagPool(m,'remove',tag);return;}
 if(name==='tag-pool-retry'){if(!m?.tagPoolBusy)await loadTagPool(m);return;}
 if(name==='tag-pool-expand'){m.tagPoolExpanded=!m.tagPoolExpanded;render();return;}
 if(name==='tag-pool-manage'){m.tagPoolManaging=!m.tagPoolManaging;render();return;}
 if(name==='tag-pool-tag'){const tag=m?.tagPool?.tags?.[Number(id)];if(!tag||isLocked(m.draft)||hasTag(m.draft.tags,tag))return;if(m.draft.tags.length>=10){toast('每件作品最多 10 个标签，请先移除不需要的标签。');return;}m.draft.tags.push(tag);manualTagsChanged(m);render();return;}
 if(name==='memory-manage'){const library={kind:'memory-library',mode:state.mode,characters:[]};ui.modal=library;await loadCharacterMemory(library);return;}
 if(name==='memory-refresh'){await loadCharacterMemory(m);return;}
 if(name==='memory-open'){openCharacterMemory(m);return;}
 if(name==='memory-tag-add'){addMemoryTag(m,id);return;}
 if(name==='memory-tag-remove'){removeMemoryTag(m,id,Number(key.split(':')[2]));return;}
 if(name==='memory-cancel'){if(m?.kind==='editor'&&!m.memorySaving){m.memoryForm=null;m.memoryError='';render();}return;}
 if(name==='memory-save'){await rememberCharacter(m);return;}
 if(name==='memory-candidate'){const candidate=m.recognition?.memory?.candidates?.[Number(id)];if(candidate)await rememberCharacter(m,candidate);return;}
 if(name==='memory-delete'){if(m?.kind==='memory-library'&&!m.deleting&&!m.loading){m.deleteId=id;render();}return;}
 if(name==='memory-delete-cancel'){if(m?.kind==='memory-library'&&!m.deleting){m.deleteId=null;render();}return;}
 if(name==='memory-delete-confirm'){await deleteCharacterMemory(m,id);return;}
 if(name==='nav'){ui.view=id;ui.filter='draft';ui.page=1;ui.query='';ui.selected.clear();ui.modal=null;render();if(id==='analytics')await loadAnalytics();return;}
 if(name==='go-settings'){ui.view='settings';render();return;}
 if(name==='filter'){if(!workTabs.includes(id))return;ui.filter=id;ui.page=1;ui.selected.clear();render();return;}
 if(name==='attention'){ui.view='works';ui.filter='attention';ui.page=1;ui.selected.clear();render();return;}
 if(name==='new-work'){if(!state.accounts.length){ui.modal={kind:'account',account:{name:'',pixivUserId:'',timezone:zone(),premium:false}};toast('先添加一个投稿账号。');}else ui.modal={kind:'editor',draft:draftNew(),tab:'basic'};render();if(ui.modal.kind==='editor'){void loadTagPool(ui.modal);void loadCharacterTemplates(ui.modal);}return;}
 if(name==='edit'){const d=state.jobs.find(j=>j.id===id);if(d)openEditor(d);return;}
 if(name==='retry-job'){await retryReservation(id);return;}
 if(name==='close-modal'){ui.modal=null;render();return;}
 if(name==='editor-tab'){m.tab=id;render();return;}
 if(name==='save-draft'||name==='enqueue'){if(name==='enqueue'&&canRetryReservation(m.draft)&&(queueIsRunning()||pixivSyncing))return toast('正在处理预约或同步状态，请完成后再重新预约。');await saveDraft(name==='enqueue'?'queued':'draft');return;}
 if(name==='cancel-job'){const d=m.draft;confirmModal('取消这件作品？','作品会保留取消记录，图片文件仍保存在本机。已提交远端的作品不能直接在这里取消。',async()=>{state=await api(`/api/jobs/${d.id}`,undefined,'DELETE');ui.modal=null;render();toast('作品已取消。');},'确认取消');return;}
 if(name==='remove-tag'){if(isLocked(m.draft))return;m.draft.tags.splice(Number(id),1);manualTagsChanged(m);render();return;}
 if(name.startsWith('file-')){if(isLocked(m.draft))return;const index=Number(id),files=m.draft.files;if(name==='file-remove')files.splice(index,1);else{const next=index+(name==='file-up'?-1:1);if(next>=0&&next<files.length)[files[index],files[next]]=[files[next],files[index]];}m.draft.tagsConfirmed=false;clearSuggestions(m);if(name==='file-remove'){clearTemplate(m);invalidateNameResolutions(m);clearAutomaticTags(m);m.draft.title='';m.titleRevision=0;m.ratingRevision=0;m.draft.content.rating=null;m.draft.content.sexualContent=null;}render();if(name==='file-remove')void recognize(m,true);return;}
 if(name==='search-tags'){if(m.searching)return;const word=m.draft.tagSearchQuery?.trim();if(!word)throw new Error('请输入要搜索的标签。');m.searching=true;m.tagSearchError='';const accountId=m.draft.accountId;render();try{const r=await api('/api/tags/search',{accountId,word});if(ui.modal===m&&m.draft.accountId===accountId&&m.draft.tagSearchQuery?.trim()===word){m.searchResults=r.candidates;m.tagSearchError=r.candidates.length?'':'没有找到匹配标签，请换个词。';}}finally{m.searching=false;if(ui.modal===m)render();}return;}
 if(name==='search-tag'){const tag=m.searchResults?.[Number(id)]?.tag;if(tag&&!m.draft.tags.includes(tag)){if(m.draft.tags.length>=10)throw new Error('每件作品最多 10 个标签。');m.draft.tags.push(tag);manualTagsChanged(m);render();}return;}
 if(name==='suggest-tags'){await recognize(m,false);return;}
 if(name==='suggestion'){const i=Number(id);m.chosen.has(i)?m.chosen.delete(i):m.chosen.add(i);render();return;}
 if(name==='accept-tags'){if(m.suggestionSignature!==fileSelectionSignature(m.draft))throw new Error('图片已经变更，请重新分析后再应用建议。');const added=[...m.chosen].map(i=>m.candidates[i].tag);const tags=[...new Set([...m.draft.tags,...added])];if(tags.length>10)throw new Error('合并后超过 10 个标签，请减少选择。');m.draft.tags=tags;manualTagsChanged(m);m.candidates=null;render();toast('已加入所选标签，请检查后勾选确认。');return;}
 if(name==='refresh'){await refresh();toast('已刷新工作台。');return;}
 if(name==='start-queue'){
  if(queueIsRunning()||pixivSyncing)return;
  if(state.mode!=='live')return;
  queueStarting=true;queueStartError='';render();
  try{
   const result=await api('/api/queue/start',{});
   if(state.mode!==result.mode)return;
   state=result;
   const report=result.queueRun;
   if(report?.running)toast('已开始预约，请查看本轮执行结果。');
   else if(report?.completedAt){queueNotifiedRun=report.startedAt;toast(report.message||queueRunSummary(report));}
   else{queueStartError='服务尚未返回执行状态，请刷新核对。';toast(queueStartError);}
  }catch(error){queueStartError=error.message;if(state.mode==='live')toast('启动结果尚未确认，请刷新状态核对：'+error.message);}
  finally{queueStarting=false;render();}
  return;
 }
 if(name==='sync-pixiv'){
  if(pixivSyncing||queueIsRunning())return;
  if(state.mode!=='live'){toast('请切换到真实工作空间后同步 Pixiv。');return;}
  pixivSyncing=true;pixivSyncError='';render();
  try{
   const result=await api('/api/pixiv/sync',{});
   if(state.mode!==result.mode)return;
   state=result;
   const r=result.pixivSync;
   toast(r.failed?`同步结束：${r.succeeded} 个账号成功，${r.failed} 个失败，请查看同步结果。`:r.succeeded?`已同步 ${r.succeeded} 个账号的 Pixiv 状态。`:'暂无可同步的账号，请先在账号管理中连接 Chrome。');
  }catch(error){pixivSyncError=error.message;if(state.mode==='live')toast('同步未完成：'+error.message);}
  finally{pixivSyncing=false;render();}
  return;
 }
 if(['browser-dedicated-open','browser-dedicated-verify','browser-dedicated-background'].includes(name)){
  if(state.mode!=='live'||dedicatedBrowserUi.pending)return;const account=state.accounts.find(a=>a.id===id);if(!account)return;
  const operation=name.slice('browser-dedicated-'.length);if(operation!=='open'&&account.browser?.mode!=='dedicated')return;if(operation==='background'&&!dedicatedBrowserReady(account))return;
  dedicatedBrowserUi.pending={accountId:id,action:operation};delete dedicatedBrowserUi.errors[id];render();
  try{await mutate('/api/accounts/'+encodeURIComponent(id)+'/browser-dedicated/'+operation,{});toast(operation==='open'?'专用 Chrome 登录窗口已打开。请登录此账号后点击“确认已登录”。':operation==='verify'?'已核对账号身份。可点击“转到后台”继续运行。':'已转到后台，登录状态已保留。');}
  catch(error){try{await refresh();}catch{}dedicatedBrowserUi.errors[id]=error.message;}
  finally{dedicatedBrowserUi.pending=null;render();}return;
 }
 if(name==='browser-discover'){const pending={kind:'browser',accountId:id||'',result:{accounts:[],message:'正在识别 Chrome 中的 Pixiv 账号；若 Chrome 显示授权提示，请点击允许。'}};ui.modal=pending;render();try{pending.result=await api('/api/browser/discover',{});}catch(e){pending.result.message='连接未完成，处理提示后可重新检测。';throw e;}finally{if(ui.modal===pending)render();}return;}
 if(name==='browser-bind'){const c=m.result.accounts.find(a=>a.candidateId===id);if(!c)throw new Error('请重新检测 Chrome 账号。');let a=m.accountId?state.accounts.find(a=>a.id===m.accountId):state.accounts.find(a=>a.pixivUserId===c.pixivUserId);if(!a){state=await api('/api/accounts',{name:c.name||`Pixiv ${c.pixivUserId}`,pixivUserId:c.pixivUserId,timezone:zone()});a=state.accounts.find(a=>a.pixivUserId===c.pixivUserId);}state=await api(`/api/accounts/${a.id}/browser`,{candidateId:id});ui.modal=null;ui.view='accounts';render();toast('账号已绑定并同步。浏览器投稿尚未开启。');return;}
 if(name==='browser-sync'){try{await mutate(`/api/accounts/${id}/browser-sync`,{});toast('已核对账号与预约列表。');}catch(e){await refresh();throw e;}return;}
 if(name==='browser-posting'){const a=state.accounts.find(a=>a.id===id);if(a.browser.postingEnabled){await mutate(`/api/accounts/${id}/browser-posting`,{enabled:false});return;}confirmModal('开启这个账号的真实投稿？',`将使用 Chrome 中的 ${a.name}（Pixiv ${a.pixivUserId}）提交已加入队列的作品，并按排期预约。已通过真实预约测试。请确认队列内容；不支持的字段会在上传前拦截。`,async()=>{state=await api(`/api/accounts/${id}/browser-posting`,{enabled:true});ui.modal=null;render();toast('此账号的浏览器投稿已开启。');},'开启真实投稿');return;}
 if(name==='browser-reconcile'){const job=state.jobs.find(j=>j.id===id);await mutate(`/api/accounts/${job.accountId}/browser-sync`,{});ui.modal={kind:'reconcile',job,remoteId:'',artworkUrl:''};render();return;}
 if(name==='browser-reconcile-save'){if(Boolean(m.remoteId)===Boolean(m.artworkUrl))throw new Error('请选择一条预约记录，或填写一个作品链接。');state=await api(`/api/jobs/${m.job.id}/browser-reconcile`,{remoteId:m.remoteId,artworkUrl:m.artworkUrl,adoptRemoteSchedule:m.adoptRemoteSchedule===true});ui.modal=null;render();toast('已核对并关联远端结果。');return;}
 if(name==='browser-preflight'){ui.modal={kind:'preflight',result:await api(`/api/jobs/${id}/preflight`,{})};render();return;}
 if(name==='check-tagger'){state.tagger=await api('/api/tagger/status',undefined,'GET');render();toast(state.tagger.available?'本地识图已就绪。':state.tagger.message||'本地模型尚未就绪。');return;}
 if(name==='tick'){await mutate('/api/queue/tick',{});toast('队列检查完成，请查看执行记录。');return;}
 if(name==='advance'){await mutate('/api/demo/advance',{});toast('已推进演示时钟，确认发布并补充下一批预约。');return;}
 if(name==='pause-queue'){await mutate('/api/settings',{queuePaused:!state.settings.queuePaused},'PATCH');return;}
 if(name==='switch-live'||name==='switch-demo'){ui.modal=null;ui.selected.clear();ui.account='all';ui.page=1;ui.filter='draft';ui.query='';ui.month=null;await mutate('/api/mode',{mode:name==='switch-live'?'live':'demo'});return;}
 if(name==='reset-demo'){confirmModal('重置演示工作台？','这会清除演示空间中新增的作品和账号，恢复 30 件示例。真实工作空间不受影响。',async()=>{state=await api('/api/demo/reset',{});ui.modal=null;ui.selected.clear();ui.page=1;render();toast('演示已重置。');},'重置演示');return;}
 if(name==='add-account'||name==='account-edit'){ui.modal={kind:'account',account:name==='account-edit'?structuredClone(state.accounts.find(a=>a.id===id)):{name:'',pixivUserId:'',timezone:zone(),premium:false}};render();return;}
 if(name==='save-account'){const a=m.account;state=await api(a.id?`/api/accounts/${a.id}`:'/api/accounts',{name:a.name,pixivUserId:a.pixivUserId,timezone:'Asia/Tokyo',defaultPostingTime:postingTime(a),premium:a.premium},a.id?'PATCH':'POST');ui.modal=null;render();toast('账号资料已保存。');return;}
 if(name==='account-pause'){const a=state.accounts.find(x=>x.id===id);await mutate(`/api/accounts/${id}`,{paused:!a.paused},'PATCH');return;}
 if(name==='account-remove'){const a=state.accounts.find(x=>x.id===id);confirmModal('移除账号资料？',`将移除「${a.name}」的本地资料。有未完成作品时不能移除。`,async()=>{state=await api(`/api/accounts/${id}`,undefined,'DELETE');ui.modal=null;render();toast('账号资料已移除。');},'移除账号');return;}
 if(name==='confirm-action'){await m.run();return;}
 if(name==='prev-page'||name==='next-page'){ui.page+=name==='prev-page'?-1:1;render();return;}
 if(name==='view-list'||name==='view-grid'){ui.grid=name==='view-grid';render();return;}
 if(name==='clear-selection'){ui.selected.clear();render();return;}
 if(name==='delete-selected'){
  const jobs=selectedJobs();if(!jobs.length)throw new Error('请先勾选需要删除的作品。');
  const blocked=jobs.find(j=>j.canDeleteLocally!==true);if(blocked)throw new Error(blocked.deleteBlockedReason||'所选作品暂不能删除，请先核对状态。');
  ui.modal={kind:'delete-works',mode:state.mode,jobs:jobs.map(j=>({id:j.id,title:j.title,status:j.status,accountName:accountFor(j)?.name||'未选账号'})),busy:false};render();return;
 }
 if(name==='delete-works-confirm'){
  if(m?.kind!=='delete-works'||m.busy)return;
  if(state.mode!==m.mode)throw new Error('工作空间已经改变，请重新选择作品。');
  const jobs=m.jobs.map(item=>state.jobs.find(j=>j.id===item.id));
  if(jobs.some(j=>!j||j.canDeleteLocally!==true))throw new Error('部分作品状态已经变化，请关闭窗口并刷新后重新选择。');
  m.busy=true;m.error='';render();
  try{const result=await api('/api/jobs/bulk-delete',{mode:m.mode,jobIds:m.jobs.map(j=>j.id)});state=result;ui.selected.clear();ui.modal=null;render();toast(`已删除 ${result.deletedJobIds.length} 件本地作品记录。`);}
  finally{m.busy=false;if(ui.modal===m)render();}
  return;
 }
 if(name==='select-page'){const jobs=filteredJobs().slice((ui.page-1)*(ui.view==='works'?12:6),ui.page*(ui.view==='works'?12:6));const all=jobs.every(j=>ui.selected.has(j.id));jobs.forEach(j=>all?ui.selected.delete(j.id):ui.selected.add(j.id));render();return;}
 if(name==='month-prev'||name==='month-next'){const [y,mo]=ui.month.split('-').map(Number);ui.month=new Date(Date.UTC(y,mo-1+(name==='month-prev'?-1:1),1)).toISOString().slice(0,7);render();return;}
 if(name==='month-today'){ui.month=dateKey(now()).slice(0,7);render();return;}
 if(name==='day'){ui.modal={kind:'day',date:id,jobs:state.jobs.filter(j=>dateKey(j.scheduledAt)===id&&j.status!=='cancelled'&&(ui.account==='all'||j.accountId===ui.account))};render();return;}
 if(name==='import'){ui.modal={kind:'import',accountId:ui.account!=='all'?ui.account:state.accounts[0]?.id||'',separate:true,files:[]};render();return;}
 if(name==='import-separate'||name==='import-together'){m.separate=name==='import-separate';render();return;}
 if(name==='import-save'){if(!m.accountId)throw new Error('请选择导入账号。');if(!m.files.length)throw new Error('请选择图片。');m.busy=true;render();try{const groups=m.separate?m.files.map(f=>[f]):[m.files],importAccountId=m.accountId,importMode=state.mode;let done=0;for(const group of groups){const files=[];for(const f of group)files.push(await uploadFile(f));const d=draftNew();d.accountId=importAccountId;d.scheduledAt=nextSchedule(importAccountId);d.files=files;try{const r=await api('/api/tags/suggest',{draft:cleanDraft(d,'draft'),provider:'local'});if(r.stale)throw new Error('图片或工作空间发生变化，请重新分析。');if(state.mode===importMode){if(r.recognition){d.title=r.recognition.title||'';d.content.rating=r.recognition.rating;d.content.sexualContent=r.recognition.sexualContent;}if(Array.isArray(r.automaticTags)&&r.source!=='demo')d.tags=automaticTagList(r,d.content.rating);}}catch(e){m.analysisErrors=(m.analysisErrors||0)+1;}if(state.mode!==importMode)throw new Error('工作空间发生变化，请重新导入。');state=await api('/api/jobs',cleanDraft(d,'draft'));done++;m.files=m.files.filter(f=>!group.includes(f));}ui.modal=null;ui.view='works';ui.filter='draft';ui.page=1;render();toast(`已导入 ${done} 件草稿。${m.analysisErrors?'其中 '+m.analysisErrors+' 件识图未完成，可在作品中重新分析。':''}`);}finally{m.busy=false;if(ui.modal)render();}return;}
 if(name==='batch'){const selected=state.jobs.filter(j=>ui.selected.has(j.id));if(selected.some(isLocked))throw new Error('所选作品中含已提交或待核实作品，请只选择本地待上传作品。');ui.modal={kind:'batch',jobIds:[...ui.selected],date:wall(nextSchedule(selected[0]?.accountId),'Asia/Tokyo').slice(0,10),time:postingTime(state.accounts.find(a=>a.id===selected[0]?.accountId)),timezone:'Asia/Tokyo',perDay:10,spacing:0};render();return;}
 if(name==='save-batch'){const jobs=m.jobIds.map(id=>state.jobs.find(j=>j.id===id)).filter(Boolean);if(!Number.isInteger(Number(m.perDay))||m.perDay<1||m.perDay>100)throw new Error('每日件数需为 1–100。');const dates=m.plannedDates||jobs.map((j,i)=>{const base=Date.parse(`${m.date}T${m.time}:00Z`)+Math.floor(i/Number(m.perDay))*86400000+(i%Number(m.perDay))*Number(m.spacing)*60000;const value=new Date(base).toISOString().slice(0,16);const scheduledAt=toIso(value,m.timezone);if(Date.parse(scheduledAt)<=Date.parse(now())||!['00','30'].includes(value.slice(-2)))throw new Error('排期必须晚于当前时间，并使用整点或半点。');return scheduledAt;});m.plannedDates=dates;let done=0;for(const [i,j] of jobs.entries()){if(!ui.selected.has(j.id))continue;state=await api(`/api/jobs/${j.id}`,{scheduledAt:dates[i],timezone:m.timezone},'PATCH');ui.selected.delete(j.id);done++;}ui.modal=null;render();toast(`已为 ${done} 件作品更新排期。`);return;}
 if(name==='export'){const data={version:1,exportedAt:new Date().toISOString(),mode:state.mode,accounts:state.accounts.map(({id,name,pixivUserId,premium,timezone})=>({id,name,pixivUserId,premium,timezone})),jobs:state.jobs,settings:state.settings};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`画序-${state.mode}-${dateKey(new Date())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出记录；图片仍保存在本机。');return;}
}

app.addEventListener('click',async event=>{const button=event.target.closest('[data-action]');if(!button||button.disabled||inFlight)return;event.preventDefault();const locksUi=!['nav','analytics-group','analytics-collect','analytics-reload','analytics-sort','analytics-metric','analytics-page','suggest-tags','search-tags','sync-pixiv','start-queue','memory-save','memory-candidate','memory-manage','memory-refresh','memory-delete-confirm','tag-pool-sync','tag-pool-add-current','tag-pool-remove','tag-pool-retry','character-template','character-template-retry'].includes(button.dataset.action.split(':')[0]);if(locksUi)inFlight=true;try{await action(button.dataset.action);}catch(error){modalError(error);}finally{if(locksUi)inFlight=false;}});
app.addEventListener('error',event=>{if(Object.hasOwn(event.target.dataset||{},'accountAvatar')||Object.hasOwn(event.target.dataset||{},'analyticsThumbnail'))event.target.hidden=true;},true);
app.addEventListener('input',event=>{try{if(event.target.id==='analytics-query'){analytics.query=event.target.value;analytics.page=1;clearTimeout(analyticsSearchTimer);if(!analytics.composing)analyticsSearchTimer=setTimeout(()=>{void loadAnalytics({status:false});},300);return;}if(event.target.id==='character-query'&&ui.modal?.kind==='editor'){ui.modal.characterQuery=event.target.value;ui.modal.characterPickerOpen=true;if(!ui.modal.characterQueryComposing)renderAfterNameResolution(ui.modal);return;}if(event.target.id==='tag-pool-query'&&ui.modal?.kind==='editor'){const position=event.target.selectionStart;ui.modal.tagPoolQuery=event.target.value;render();const el=document.querySelector('#tag-pool-query');el?.focus();el?.setSelectionRange(position,position);return;}if(event.target.id==='search'){const position=event.target.selectionStart;ui.query=event.target.value;ui.page=1;ui.selected.clear();render();const el=document.querySelector('#search');el.focus();el.setSelectionRange(position,position);return;}handleField(event.target);}catch(error){modalError(error);}});
app.addEventListener('change',async event=>{const t=event.target;try{if(t.dataset.analyticsFilter){const field=t.dataset.analyticsFilter,allowed={accountId:['all',...state.accounts.map(a=>a.id)],days:['all','30','90','180','365'],dailyDays:['7','30','90','365'],point:Object.keys(analyticsPointLabels),group:['work','character','tag','interval'],sort:['total','average','growth']};if(!allowed[field]?.includes(t.value))return;analytics[field]=t.value;if(field==='sort'&&analytics.metric==='bookmarkRate'&&t.value!=='total')analytics.metric='views';if(field==='group'){analytics.sort=analytics.metric==='bookmarkRate'?'total':t.value==='interval'?'growth':t.value==='work'?'total':'average';if(t.value==='interval')analytics.point='6h';}if(analytics.group==='interval'&&analytics.point==='current')analytics.point='6h';if(['work','interval'].includes(analytics.group)&&analytics.sort==='average')analytics.sort='total';if(analytics.point==='current'&&analytics.sort==='growth'){if(field==='sort')analytics.point='6h';else analytics.sort=analytics.group==='work'?'total':'average';}if(field!=='dailyDays')analytics.page=1;await loadAnalytics({status:false});return;}if(t.dataset.jobCheck){t.checked?ui.selected.add(t.dataset.jobCheck):ui.selected.delete(t.dataset.jobCheck);render();return;}if(t.id==='account-filter'){ui.account=t.value;ui.page=1;ui.selected.clear();render();return;}if(t.id==='status-filter'){ui.filter=Object.hasOwn(labels,t.value)||t.value==='attention'?t.value:'draft';ui.page=1;ui.selected.clear();render();return;}if(t.id==='setting-timezone'){await mutate('/api/settings',{timezone:t.value},'PATCH');return;}if(t.id==='editor-files'){const selected=[...t.files];t.value='';if(ui.modal){ui.modal.filePickerOpen=false;ui.modal.filePickerRenderPending=false;}await addFiles(selected);return;}if(t.id==='import-files'){ui.modal.files=[...t.files];render();return;}if(t.id==='tag-provider'){ui.modal.tagProvider=t.value;clearSuggestions(ui.modal);render();return;}if(t.id==='thumbnail-position'){ui.modal.draft.content.thumbnail.y=t.value==='top'?0:t.value==='bottom'?1:.5;return;}handleField(t);if(['content.type','content.rating','scheduleDate','scheduleTime','accountId'].includes(t.dataset.field)||t.dataset.batchField||t.dataset.memoryField==='confirmedSingleCharacter'||Object.hasOwn(t.dataset,'memoryCandidateConfirm'))render();if(t.dataset.field==='accountId'&&ui.modal?.kind==='editor'){clearSuggestions(ui.modal);resetTagPool(ui.modal);render();void loadTagPool(ui.modal);void loadCharacterTemplates(ui.modal);void recognize(ui.modal,true);}}catch(error){modalError(error);}});
app.addEventListener('click',event=>{if(ui.modal?.kind==='editor'&&(event.target.id==='editor-files'||event.target.closest?.('#editor-drop')))ui.modal.filePickerOpen=true;},true);
app.addEventListener('cancel',event=>{if(event.target.id==='editor-files'&&ui.modal?.kind==='editor'){ui.modal.filePickerOpen=false;ui.modal.filePickerRenderPending=false;render();}},true);
app.addEventListener('toggle',event=>{if(Object.hasOwn(event.target.dataset||{},'tagAdjustments')&&ui.modal?.kind==='editor')ui.modal.tagAdjustmentsOpen=event.target.open;},true);
app.addEventListener('compositionstart',event=>{if(event.target.id==='analytics-query'){analytics.composing=true;clearTimeout(analyticsSearchTimer);return;}if(event.target.id==='character-query'&&ui.modal?.kind==='editor'){ui.modal.characterQueryComposing=true;return;}if(event.target.dataset.memoryTagInput&&ui.modal?.memoryForm)ui.modal.memoryTagComposing=true;});
app.addEventListener('compositionend',event=>{if(event.target.id==='analytics-query'){analytics.composing=false;analytics.query=event.target.value;analytics.page=1;clearTimeout(analyticsSearchTimer);analyticsSearchTimer=setTimeout(()=>{void loadAnalytics({status:false});},300);return;}const m=ui.modal;if(event.target.id==='character-query'&&m?.kind==='editor'){m.characterQueryComposing=false;m.characterQueryRenderPending=false;m.characterQuery=event.target.value;renderAfterNameResolution(m);return;}if(!event.target.dataset.memoryTagInput||!m?.memoryForm)return;m.memoryTagComposing=false;handleField(event.target);if(m.memoryTagRenderPending){m.memoryTagRenderPending=false;renderAfterNameResolution(m);}});
app.addEventListener('keydown',event=>{if(event.isComposing||event.keyCode===229||ui.modal?.memoryTagComposing||ui.modal?.characterQueryComposing)return;if(event.target.dataset.memoryTagInput&&event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();try{addMemoryTag(ui.modal,event.target.dataset.memoryTagInput);}catch(error){modalError(error);}return;}if(event.target.id==='tag-input'&&event.key==='Enter'){event.preventDefault();addTag();}if(event.key==='Escape'&&ui.modal&&!inFlight){ui.modal=null;render();}if(event.key==='Tab'&&ui.modal){const items=[...document.querySelectorAll('.modal button:not(:disabled),.modal input:not(:disabled),.modal textarea:not(:disabled),.modal select:not(:disabled),.modal a')].filter(x=>x.offsetParent!==null);if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}}});
app.addEventListener('dragover',event=>{const drop=event.target.closest('#editor-drop');if(drop){event.preventDefault();drop.classList.add('dragover');}});
app.addEventListener('dragleave',event=>event.target.closest('#editor-drop')?.classList.remove('dragover'));
app.addEventListener('drop',async event=>{const drop=event.target.closest('#editor-drop');if(drop){event.preventDefault();try{await addFiles([...event.dataTransfer.files]);}catch(error){modalError(error);}}});
try { await refresh(); } catch(error) { app.innerHTML=`<div class="error-page"><div class="brand-icon">${icon('layers')}</div><h1>本地工作台暂时无法连接</h1><p>请先启动画序的本地服务，再刷新这个页面。</p><p>${escape(error.message)}</p></div>`; }
setInterval(async()=>{if(!ui.modal&&!inFlight&&!pixivSyncing&&!queueIsRunning()&&state){try{await refresh();}catch{toast('本地服务连接中断，请检查服务是否仍在运行。');}}},60000);
setInterval(async()=>{
 if(queuePolling||queueStarting||state?.mode!=='live'||!state.queueRun?.running)return;
 queuePolling=true;
 try{
  const result=await api('/api/state',undefined,'GET');
  if(state.mode!==result.mode)return;
  state=result;queueStartError='';
  const report=result.queueRun;
  if(report?.completedAt&&!report.running&&queueNotifiedRun!==report.startedAt){queueNotifiedRun=report.startedAt;toast(report.message||queueRunSummary(report));}
  if(!ui.modal&&!inFlight)render();
 }catch(error){queueStartError='暂时无法读取执行结果：'+error.message;if(!ui.modal&&!inFlight)render();}
 finally{queuePolling=false;}
},3000);

setInterval(async()=>{
 if(analytics.polling||analytics.starting||state?.mode!=='live'||!analyticsRunning())return;
 analytics.polling=true;const mode=state.mode;
 try{const result=await api('/api/analytics/status',undefined,'GET');if(state.mode!==mode)return;analytics.status=result;if(!analyticsRun().running){await loadAnalytics({quiet:true,status:false});toast(analyticsRun().errors?.length?'数据采集结束，部分记录未取得，请查看采集异常。':'数据采集完成，统计已更新。');}else if(ui.view==='analytics'&&!inFlight)render();}
 catch(error){if(state.mode===mode){analytics.error='暂时无法读取采集状态：'+error.message;if(ui.view==='analytics')render();}}
 finally{analytics.polling=false;}
},4000);
