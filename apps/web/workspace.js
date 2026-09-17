// Navigation is presentation only; every workspace endpoint enforces the same scope on the server.
let WS_CONTEXT = null;
let WS_SESSION = null;
let WS_VIEW = 'personal';
let WS_ROUTE_RUN = 0;
let WS_ACTIVATION = null;
const WS_ROLES = { employee: '员工', team_lead: '组长', dept_head: '部门负责人', admin: '管理员' };
const WS_STATUS = { confirmed: '已确认', pending_confirmation: '待确认', superseded: '历史版本', draft: '草稿', collecting: '收集中' };
function wsInvalidateIdentity() {
  ++WS_ROUTE_RUN; WS_CONTEXT = null; WS_SESSION = null; WS_ACTIVATION = null; WS_VIEW = 'personal';
  for(const dialog of document.querySelectorAll('dialog')) { dialog.close(); dialog.remove(); }
  document.body.classList.remove('menu-open');
  const userLabel = document.getElementById('workspace-user');
  if (userLabel) userLabel.textContent = '';
}
function wsApiPath(path) {
  if (!path.startsWith('/api/v1/workspace') && !path.startsWith('/api/v1/reporting')) return path;
  const url = new URL(path, location.origin);
  if (!url.searchParams.has('view')) url.searchParams.set('view', WS_VIEW);
  return url.pathname + url.search;
}
function wsMonday(value = crmDate()) { const d = new Date(`${value}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1)); return d.toISOString().slice(0,10); }
function wsLink(label, hash, cls = '') { const a = el('a', cls || 'ws-link', label); a.href = hash; return a; }
function wsQuery(values) { return new URLSearchParams(Object.entries(values).filter(([,v]) => v !== undefined && v !== null && v !== '')).toString(); }
function wsTabs(items, active) { const nav = el('nav', 'ws-tabs'); nav.setAttribute('aria-label', '页面栏目'); for (const [key,label,href] of items) { const a = wsLink(label, href, active === key ? 'active' : ''); if (active === key) a.setAttribute('aria-current','page'); nav.append(a); } return nav; }
function wsCell(value) { const td = el('td'); td.append(value instanceof Node ? value : document.createTextNode(value == null || value === '' ? '—' : String(value))); return td; }
function wsTable(headers, rows, empty = '暂无记录', keepHeader = false) {
  if (!rows.length && !keepHeader) return el('div', 'ws-empty', empty);
  const wrap = el('div','table-wrap ws-table'), tableNode = el('table'), head = el('thead'), tr = el('tr');
  for (const name of headers) { const th = el('th','',name); th.scope = 'col'; tr.append(th); } head.append(tr); tableNode.append(head);
  const body = el('tbody'); for (const row of rows) { const line = el('tr'); for (const [index,value] of row.entries()) {const cell=wsCell(value);cell.dataset.label=headers[index]||'';line.append(cell);} body.append(line); }
  if (!rows.length) { const line=el('tr'), cell=el('td','ws-empty-cell',empty); cell.colSpan=headers.length; line.append(cell); body.append(line); }
  tableNode.append(body); wrap.append(tableNode); return wrap;
}
function wsSummary(value, limit = 72) { const s = String(value || '暂无摘要'); return s.length > limit ? `${s.slice(0,limit)}…` : s; }
function wsName(id) { return WS_CONTEXT?.users?.find((u) => u.id === id)?.name || (WS_CONTEXT?.me?.id === id ? WS_CONTEXT.me.name : id ? '成员' : '未分配'); }
function wsAdmin() { return Boolean(WS_CONTEXT?.canAdmin && WS_VIEW === 'team'); }
function wsFilters(...inputs) { const row = el('div','ws-filters'); row.append(...inputs); return row; }
function wsPeopleFilter(value = '') { const select = crmSelect((WS_CONTEXT?.users || []).map((u) => [u.id,u.name]), value, '全部人员'); select.setAttribute('aria-label','筛选人员'); return select; }
function wsReadOnly(message = '当前视角没有此项管理权限。') { app.append(el('div','notice',message)); }
function wsRefresh() { return wsRoute(); }
function renderCompanies(hash = location.hash) { return wsCompanies(hash); }
function renderKnowledge(kind, id) { return wsKnowledge(kind, id); }

async function wsRoute() {
  if (typeof mwRoute === 'function') return mwRoute();
  const run = ++WS_ROUTE_RUN;
  let hash = location.hash || '#/workspace';
  if (hash.startsWith('#/access/')) return exchangeAccessGrant(hash);
  if (hash.startsWith('#/portal/')) {
    app.replaceChildren(el('p','muted','正在验证个人工作台入口…'));
    try {
      const result = await fetchJson('/api/v1/portal-grants/exchange', { method:'POST', body:JSON.stringify({token:decodeURIComponent(hash.slice(9))}) });
      sessionStorage.setItem(TOKEN_KEY,result.token); WS_CONTEXT = null; WS_VIEW = 'personal';
      if (result.user?.id) sessionStorage.setItem(`assistant_view_${result.user.id}`,'personal');
      history.replaceState(null,'','#/workspace'); return wsRoute();
    } catch { if(run === WS_ROUTE_RUN) showLogin('个人链接已使用、过期或失效。请在企微私聊日报助手重新发送“我的工作台”。'); return; }
  }
  if (!token()) return showLogin();
  const aliases = { '#/admin':'#/workspace', '#/daily':'#/records/daily', '#/weekly':'#/records/weekly', '#/items':'#/records/plans', '#/audit':'#/settings/logs', '#/governance':'#/settings/logs', '#/exports':'#/settings/exports', '#/templates':'#/knowledge/templates' };
  if (aliases[hash]) { hash = aliases[hash]; history.replaceState(null,'',hash); }
  if (!location.hash) history.replaceState(null,'',hash);
  app.replaceChildren(el('p','muted','正在加载工作空间…'));
  try {
    WS_SESSION = await fetchJson('/api/v1/session');
    if (run !== WS_ROUTE_RUN) return;
    document.body.classList.remove('logged-out');
    if (WS_SESSION.resourceScoped) {
      for (const a of document.querySelectorAll('.side-nav a')) a.hidden = true;
      document.getElementById('workspace-view').hidden = true;
      document.getElementById('workspace-user').textContent = '周报专属访问';
      if (hash.startsWith('#/report/')) { app.dataset.page = 'records'; return renderReport(hash); }
      app.replaceChildren(el('div','notice','这是单份周报的访问链接。完整工作台请在企微私聊发送“我的工作台”。')); return;
    }
    const saved = sessionStorage.getItem(`assistant_view_${WS_SESSION.userId}`);
    WS_VIEW = saved || (WS_SESSION.role === 'admin' ? 'team' : 'personal');
    if (!['team_lead','dept_head','admin'].includes(WS_SESSION.role)) WS_VIEW = 'personal';
    WS_CONTEXT = await fetchJson(`/api/v1/workspace?view=${WS_VIEW}`);
    if (run !== WS_ROUTE_RUN) return;
    const view = document.getElementById('workspace-view'); view.hidden = !WS_CONTEXT.canManageTeam; view.value = WS_VIEW;
    view.onchange = () => { WS_VIEW = view.value; sessionStorage.setItem(`assistant_view_${WS_SESSION.userId}`,WS_VIEW); if (location.hash === '#/workspace') void wsRoute(); else location.hash = '#/workspace'; };
    const displayName = WS_CONTEXT.me?.name || WS_SESSION.name || '后台管理员', roleName = WS_ROLES[WS_SESSION.role] || '成员';
    document.getElementById('workspace-user').textContent = displayName === roleName ? displayName : `${displayName} · ${roleName}`;
    document.getElementById('workspace-identity').textContent = WS_VIEW === 'team' ? '管理端 · 团队协同' : '员工端 · 我的工作';
    const name = hash.slice(2).split(/[/?]/)[0];
    const menuName = name === 'report' ? 'records' : name;
    const titles = { workspace: WS_VIEW === 'team' ? '管理工作台' : '我的工作台', companies:'企业管理', records:'工作记录', users:'人员管理', knowledge:'知识管理', settings:'系统设置' };
    headerTitle.textContent = titles[menuName] || '工作台'; app.dataset.page = menuName;
    for (const a of document.querySelectorAll('.side-nav a')) {
      a.hidden = (a.dataset.route === 'users' && WS_VIEW !== 'team') || (a.dataset.route === 'settings' && !wsAdmin());
      a.classList.toggle('active',a.dataset.route === menuName);
    }
    app.replaceChildren();
    if (name === 'companies') await wsCompanies(hash);
    else if (name === 'records') await wsRecords(hash);
    else if (name === 'users') await wsUsers(hash);
    else if (name === 'knowledge') await wsKnowledge();
    else if (name === 'settings') await wsSettings(hash);
    else if (name === 'report') await renderReport(hash);
    else await wsDashboard();
  } catch (error) { if (run === WS_ROUTE_RUN) handlePageError(error); }
}

async function wsDashboard() {
  const scope = WS_VIEW === 'team' ? '团队' : '我的';
  const [crm,daily,weekly] = await Promise.all([fetchJson(CRM_ROOT),fetchJson(`/api/v1/workspace/records?weekId=${wsMonday()}`),fetchJson(`/api/v1/workspace/weekly-reports?weekId=${wsMonday()}`)]);
  app.replaceChildren(pageHeading(WS_VIEW === 'team' ? '工作台' : '我的工作台', WS_CONTEXT.canManageTeam ? '团队业务概览与本人工作相互独立，可在左侧切换工作视角。' : '企业跟进、工作记录和反馈，在这里统一查看。'));
  const active = crm.companies.filter((c) => !c.archived), ids = new Set(active.map((c) => c.id));
  const stats = el('div','stats ws-dashboard-stats');
  stats.append(stat('负责 / 协作企业',`${active.length} 家`),stat('未结服务事项',`${crm.records.filter((r) => ids.has(r.companyId) && r.kind === 'service' && r.status !== 'resolved').length} 项`),stat('本周待确认日报',`${daily.reports.filter((r) => r.status === 'pending_confirmation').length} 份`),stat('本周已有周报',`${new Set(weekly.reports.map(r=>`${r.user_id}:${r.week_id}`)).size} 人`)); app.append(stats);
  const actions = el('div','ws-workbench-actions'); actions.append(wsLink('查看企业','#/companies','primary-button'),wsLink('查看工作记录','#/records','secondary-button'),wsLink('本周计划','#/records/plans','secondary-button')); app.append(actions);
  const layout = el('div','ws-dashboard-columns'), records = el('section','panel'), companies = el('section','panel');
  records.append(el('h3','','最近工作记录'),wsTable(['日期','人员','摘要','状态'],daily.reports.slice(0,8).map((r) => [r.report_date,r.user_name || wsName(r.user_id),wsLink(wsSummary(r.summary,35),`#/records/daily/${r.id}`),WS_STATUS[r.status] || r.status]),'本周暂无日报。可直接在企微私聊日报助手发送工作内容。'));
  companies.append(el('h3','','待跟进企业'),wsTable(['企业','下一步','计划日期'],active.filter((c) => c.nextAction || c.risk !== 'none').slice(0,8).map((c) => [wsLink(c.name,`#/companies/${c.id}`),wsSummary(c.nextAction || c.riskNote,38),c.nextDate]),'暂无待跟进标记。')); layout.append(records,companies); app.append(layout);
  app.append(el('p','muted','工作内容先形成待确认草稿，员工通过企微卡片确认后才正式入库。管理者也可以记录自己的工作。'));
  if(typeof rpAnalytics==='function') await rpAnalytics();
  if (wsAdmin() && WS_SESSION.demoMode) {
    const demo = el('div','notice warning'); demo.append(el('p','','本地演示：可打开虚构人员的专属入口，验证员工和兼岗组长的权限。'));
    const select = crmSelect(WS_CONTEXT.users.map((u) => [u.id,`${u.name} · ${WS_ROLES[u.role]}`]),'', '选择演示身份');
    const result = el('span'); demo.append(select,crmButton('生成演示入口',async () => {
      if (!select.value) return notify('请选择演示人员');
      try { const data = await fetchJson('/api/v1/demo/portal',{method:'POST',body:JSON.stringify({userId:select.value})}); const link = wsLink('在新标签打开该身份',data.route); link.target='_blank'; link.rel='noopener'; result.replaceChildren(link); } catch(error) { notify(error.message); }
    }),result); app.append(demo);
  }
}

async function wsCompanies(hash = location.hash) {
  const path = hash.split('?')[0].slice('#/companies'.length).split('/').filter(Boolean);
  if (path.length) return wsCompanyDetail(decodeURIComponent(path[0]),path[1] || 'overview');
  const [data,options] = await Promise.all([fetchJson(CRM_ROOT),fetchJson(`${CRM_ROOT}/options`)]);
  const actions = el('div','crm-inline-actions');
  if (options.permissions?.canConfigureStages) actions.append(crmButton('阶段配置',() => crmStageEditor(options,wsRefresh)));
  if (options.permissions?.canCreate) actions.append(crmButton('新增企业',() => crmCompanyEditor(null,options,(c) => { location.hash=`#/companies/${c.id}`; }),'primary-button'));
  app.replaceChildren(pageHeading(WS_VIEW === 'team' ? '企业管理' : '我的企业',WS_VIEW === 'team' ? '按企业查看负责人、项目进度和相关工作记录。' : '仅显示本人负责或明确协作的企业。',actions));
  if (data.companies.some((c) => c.isDemo)) app.append(el('p','notice warning','虚构演示数据仅供验证，不代表真实企业或招商成果。'));
  const search = crmInput('','search'); search.placeholder='搜索企业 / 简称 / 行业 / 园区'; search.setAttribute('aria-label','搜索企业');
  const owner = crmSelect(options.users.map((u) => [u.id,u.name]),'','全部负责人'); owner.setAttribute('aria-label','筛选负责人');
  const stage = crmSelect(options.stages.map((s) => [s.id,s.label]),'','全部招商阶段'); stage.setAttribute('aria-label','筛选招商阶段');
  const archived = crmSelect([['active','维护中'],['archived','已归档'],['all','全部档案']],'active'); archived.setAttribute('aria-label','筛选归档状态');
  const result=el('div'); app.append(wsFilters(search,owner,stage,archived),result);
  function refresh() {
    const q=search.value.trim().toLowerCase();
    const list=data.companies.filter((c) => (!q || [c.name,...(c.aliases||[]),c.industry,c.park].join(' ').toLowerCase().includes(q)) && (!owner.value || c.ownerId===owner.value) && (archived.value==='all' || c.archived===(archived.value==='archived')) && (!stage.value || data.records.some((r) => r.companyId===c.id && r.stageId===stage.value)));
    result.replaceChildren(el('p','ws-count',`共 ${list.length} 家企业`),wsTable(['企业名称','行业 / 园区','负责人 / 协作人','项目阶段','业务关系','最近跟进','操作'],list.map((c) => {
      const stages=[...new Set(data.records.filter((r) => r.companyId===c.id && r.kind==='project').map((r) => crmStage(options,r.stageId)))];
      const title=el('span'); title.append(wsLink(c.name,`#/companies/${c.id}`)); if(c.isDemo) title.append(el('small','ws-demo-tag','演示'));
      const people=[c.ownerName||crmOwner(options,c.ownerId),...(c.collaboratorNames||(c.collaboratorIds||[]).map((id) => crmOwner(options,id)))];
      return [title,[c.industry,c.park].filter(Boolean).join(' / '),people.join(' / '),stages.join('、')||'暂无项目',CRM_REL[c.relationship],c.lastFollowup,wsLink('相关工作记录',`#/records?companyId=${encodeURIComponent(c.id)}`)];
    }),'暂无匹配企业。可调整筛选，或由管理者分配负责/协作企业。'));
  }
  search.addEventListener('input',refresh); [owner,stage,archived].forEach((input) => input.addEventListener('change',refresh)); refresh();
}

async function wsCompanyDetail(id,tab) {
  const [data,options]=await Promise.all([fetchJson(`${CRM_ROOT}/companies/${encodeURIComponent(id)}`),fetchJson(`${CRM_ROOT}/options`)]);
  const c=data.company, permissions=data.permissions||{}, reload=wsRefresh;
  options.displayNames = Object.fromEntries([[c.ownerId,c.ownerName],...(c.collaboratorIds||[]).map((id,index)=>[id,c.collaboratorNames?.[index]])].filter(([id,name])=>id&&name));
  app.replaceChildren(wsLink('← 企业列表','#/companies','back'));
  const actions=el('div','crm-inline-actions');
  if(permissions.canEdit) actions.append(crmButton('编辑档案',() => crmCompanyEditor(c,{...options,permissions},reload)));
  if(permissions.canFollowup && !c.archived) actions.append(crmButton('记录跟进',() => crmFollowupEditor(c,data.records,options,reload),'primary-button'));
  app.append(pageHeading(c.name,`${c.industry||'行业待补'} · ${c.park||'园区待定'} · 负责人 ${crmOwner(options,c.ownerId)}`,actions));
  if(c.isDemo) app.append(el('p','notice warning','虚构演示企业，不代表实际招商成果。'));
  if(c.archived) app.append(el('p','notice','企业已归档，历史保留；恢复后可继续跟进。'));
  app.append(wsTabs([['overview','企业概况'],['projects','招商项目'],['services','服务事项'],['records','相关工作记录'],['timeline','跟进时间线'],['knowledge','关联知识']].map(([key,label]) => [key,label,`#/companies/${id}/${key}`]),tab));
  const section=el('section','ws-detail'); app.append(section);
  if(tab==='overview') {
    const fields=[['业务关系',CRM_REL[c.relationship]],['经营情况',CRM_OPERATING[c.operatingStatus]],['负责人',crmOwner(options,c.ownerId)],['协作人员',(c.collaboratorIds||[]).map((uid) => crmOwner(options,uid)).join('、')||'未设置'],['联系人',[c.contactName,c.contactRole,c.contactPhone].filter(Boolean).join(' · ')],['企业简称',(c.aliases||[]).join('、')],['目前情况',c.summary],['下一步',c.nextAction],['下次跟进',c.nextDate],['风险说明',c.riskNote],['最后更新',crmTime(c.updatedAt)]];
    section.append(wsDefinition(fields),el('p','muted',`档案 v${c.version} · 人工维护；参考资料不自动改变企业阶段。`));
  } else if(tab==='projects'||tab==='services') {
    const kind=tab==='projects'?'project':'service', label=kind==='project'?'招商项目':'服务事项';
    if(permissions.canEdit&&!c.archived) section.append(crmButton(`新增${label}`,() => crmRecordEditor(c,kind,null,options,reload),'primary-button'));
    section.append(wsTable(['事项','阶段 / 状态','负责人','下一步','计划日期','操作'],data.records.filter((r) => r.kind===kind).map((r) => [r.title,kind==='project'?crmStage(options,r.stageId):CRM_SERVICE[r.status],crmOwner(options,r.ownerId),wsSummary(r.nextAction||r.outcome),r.dueDate,crmButton('查看详情',() => wsRecordDialog(c,r,options,permissions,reload),'quiet-button')]),`暂无${label}。`));
  } else if(tab==='records') {
    const records=data.workRecords||{reports:[],weeklyReports:[]};
    section.append(el('p','muted','只显示有明确来源关联、且当前身份有权查看的工作记录；不会按企业名称猜测归属。'),wsLink('在工作记录中筛选',`#/records?companyId=${encodeURIComponent(id)}`));
    section.append(wsTable(['日期','人员','类型','内容'],[...(records.reports||[]).map((r)=>[r.report_date,r.user_name||wsName(r.user_id),'日报',wsLink(wsSummary(r.summary),`#/records/daily/${r.id}`)]),...(records.weeklyReports||[]).map((r)=>[r.week_id,r.user_name||wsName(r.user_id),'周报',wsLink(wsSummary(r.content),`#/records/weekly/${r.id}`)])],'暂无可见的关联记录。企业共享不自动开放其他员工的私人日报。'));
  } else if(tab==='timeline') {
    section.append(wsTable(['发生日期','类型','内容 / 原因','记录人','操作'],data.events.map((event)=>[event.occurred_on,CRM_EVENT_LABELS[event.kind]||'操作记录',wsSummary(event.content,100),event.actor_name||(event.actor_id==='demo-system'?'演示系统':'成员'),crmButton('查看详情',()=>wsInspect('跟进记录',crmEvent(event,options)),'quiet-button')]),'暂无跟进记录。'));
  } else if(tab==='knowledge') {
    if(permissions.canLinkKnowledge&&!c.archived) section.append(crmButton('关联知识资料',()=>wsLinkKnowledge(c,options,reload),'primary-button'));
    section.append(wsTable(['资料名称','关联版本','资料当前版本','关联时间','操作'],data.links.map((link)=>{const entry=JSON.parse(link.snapshot_json); const current=link.content_view==='current'; return [entry.title,`v${current?link.historical_version:entry.version}`,link.current_active?`v${link.current_version}`:'已停用',crmTime(link.created_at),crmButton(current?'查看当前资料':'查看历史快照',()=>wsInspect(`${entry.title} · ${current?'当前授权内容':'关联时快照'} v${entry.version}`,el('p','ws-prose',entry.content||entry.summary)),'quiet-button')];}),'暂无关联资料。'));
  }
}
function wsDefinition(fields) { const dl=el('dl','ws-definition'); for(const [name,value] of fields) dl.append(el('dt','',name),el('dd','',value||'未填写')); return dl; }
function wsInspect(title,content) {
  const dialog=el('dialog','crm-dialog ws-inspect'); const head=el('div','crm-modal-head'); head.append(el('h2','',title),crmButton('关闭',()=>dialog.close(),'quiet-button'));
  dialog.append(head,content); dialog.addEventListener('close',()=>dialog.remove(),{once:true}); document.body.append(dialog); dialog.showModal();
}
function wsRecordDialog(company,record,options,permissions,done) {
  const content=el('div'); content.append(wsDefinition([['事项',record.title],['阶段 / 状态',record.kind==='project'?crmStage(options,record.stageId):CRM_SERVICE[record.status]],['负责人',crmOwner(options,record.ownerId)],['背景',record.description],['下一步',record.nextAction],['计划日期',record.dueDate],['处理结果',record.outcome]]));
  if(permissions.canEdit&&!company.archived) content.append(crmButton('更新进展',()=>{content.closest('dialog')?.close();crmRecordEditor(company,record.kind,record,options,done);},'primary-button'));
  wsInspect('事项详情',content);
}
function wsLinkKnowledge(company,options,done) {
  crmModal('关联知识资料','保留关联时的版本快照；不会修改企业事实。',(grid)=>{const input=crmField(grid,'选择资料 *',crmSelect(options.knowledge.filter((k)=>k.active).map((k)=>[k.id,`${k.title} · v${k.version}`]),'','请选择'),true);input.required=true;return()=>({knowledgeId:input.value});},async(body)=>{await fetchJson(`${CRM_ROOT}/companies/${company.id}/knowledge`,{method:'POST',body:JSON.stringify(body)});notify('资料已关联');await done();});
}

function wsJson(value, fallback = []) { try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; } }
function wsRelatedCompanies(companies) { const row=el('div','ws-related'); row.append(el('span','muted','关联企业：')); for(const c of companies) row.append(wsLink(c.name,`#/companies/${encodeURIComponent(c.id)}/records`)); if(!companies.length) row.append(el('span','muted','暂无明确关联')); return row; }
function wsRecordTabs(active,query='') { return wsTabs([['daily','日报'],['weekly','周报与反馈'],['plans','周计划']].map(([key,label])=>[key,label,`#/records/${key}${query?`?${query}`:''}`]),active); }
async function wsRecords(hash) {
  const [raw,search='']=hash.split('?'), parts=raw.slice('#/records'.length).split('/').filter(Boolean), kind=parts[0]||'daily';
  if(kind==='week' && typeof rpWeek==='function') return rpWeek(decodeURIComponent(parts[1]),parts[2]);
  if(kind==='weekly' && !parts[1] && typeof rpWeeks==='function') return rpWeeks(search);
  if(parts[1] && kind==='daily') return wsDailyDetail(decodeURIComponent(parts[1]));
  if(parts[1] && kind==='weekly') return wsWeeklyDetail(decodeURIComponent(parts[1]));
  const params=new URLSearchParams(search), companyId=params.get('companyId')||'';
  const crm=await fetchJson(CRM_ROOT), company=crm.companies.find((c)=>c.id===companyId);
  app.replaceChildren(pageHeading('工作记录',company?`正在查看「${company.name}」的明确关联记录。`:'按人员、自然周查看日报、周报与反馈；原始记录和历史版本保留。'),wsRecordTabs(kind,search));
  if(companyId) app.append(wsLink('取消企业筛选',`#/records/${kind}`));
  const person=wsPeopleFilter(params.get('userId')||''), week=crmInput(params.get('weekId')||(kind==='plans'?wsMonday():''),'date');
  week.setAttribute('aria-label','周一日期');
  const filter=el('form','ws-filters'); const submit=el('button','secondary-button','查询');submit.type='submit';
  if(WS_VIEW==='team') filter.append(labeled('人员',person)); filter.append(labeled('自然周（选择周一，可留空）',week),submit);
  filter.addEventListener('submit',(event)=>{event.preventDefault();location.hash=`#/records/${kind}?${wsQuery({userId:person.value,weekId:week.value?wsMonday(week.value):'',companyId})}`;}); app.append(filter);
  const query=wsQuery({userId:person.value,weekId:week.value,companyId});
  if(kind==='plans') {
    const data=await fetchJson(`/api/v1/workspace/items?${query}`);
    app.append(el('p','muted',`周计划 · ${data.weekId} 起。事项属于本人工作计划；企业筛选不适用于周计划。`));
    if(WS_VIEW==='personal'&&WS_CONTEXT.users.some((u)=>u.id===WS_CONTEXT.me.id)) app.append(crmButton('新增周计划事项',()=>wsPlanEditor(null,data.weekId),'primary-button'));
    app.append(wsTable(['人员','事项名称','计划与背景','版本','操作'],data.items.map((item)=>[item.user_name,item.name,wsSummary(item.plan_background,120),`v${item.version}`,item.user_id===WS_CONTEXT.me.id&&WS_VIEW==='personal'&&typeof rpPlanActions==='function'?rpPlanActions(item,data.weekId):item.user_id===WS_CONTEXT.me.id&&WS_VIEW==='personal'?crmButton('编辑',()=>wsPlanEditor(item,data.weekId),'quiet-button'):crmButton('查看',()=>wsInspect(item.name,el('p','ws-prose',item.plan_background||'暂无背景')),'quiet-button')]),'本周暂无计划事项。'));
    return;
  }
  const data=await fetchJson(`/api/v1/workspace/${kind==='weekly'?'weekly-reports':'records'}?${query}`);
  if(kind==='daily' && WS_VIEW==='personal' && typeof rpDraftEditor==='function') app.append(crmButton('填写事项进展',()=>rpDraftEditor(null,data.reports.find(r=>r.user_id===WS_CONTEXT.me.id&&r.report_date===crmDate())),'primary-button'));
  app.append(el('p','ws-count',`共 ${data.reports.length} 份${data.reports.length===200?'（最多展示最近 200 份，请筛选周次）':''}`));
  app.append(kind==='weekly'
    ?wsTable(['周起始','人员','内容摘要','版本 / 模板','生成时间'],data.reports.map((r)=>[r.week_id,r.user_name,wsLink(wsSummary(r.content,90),`#/records/weekly/${r.id}`),`v${r.version} / ${r.template_version}`,crmTime(r.generated_at)]),'暂无周报。机器人按配置从已确认日报生成周报。')
    :wsTable(['日期','人员','内容摘要','状态','版本','确认时间'],data.reports.map((r)=>[r.report_date,r.user_name,wsLink(wsSummary(r.summary,90),`#/records/daily/${r.id}`),WS_STATUS[r.status]||r.status,`v${r.version}`,crmTime(r.confirmed_at)]),'暂无日报。请在企微私聊日报助手发送工作内容。'));
}
async function wsDailyDetail(id) {
  const data=await fetchJson(`/api/v1/workspace/records/${encodeURIComponent(id)}`), r=data.report;
  app.replaceChildren(wsLink('← 日报列表','#/records/daily','back'),pageHeading(`${r.user_name} · ${r.report_date} 日报`,`${WS_STATUS[r.status]||r.status} · v${r.version} · ${r.confirmed_at?`确认于 ${crmTime(r.confirmed_at)}`:'尚未正式确认'}`),wsRelatedCompanies(data.companies));
  app.append(el('section','ws-prose ws-detail',r.summary||'暂无摘要'));
  const progress=wsJson(r.progress_json);
  if(typeof rpDailyTools==='function') await rpDailyTools(r);
  if(Array.isArray(progress)&&progress.length) app.append(wsTable(['关联周计划（当前名称）','当日进展','进度','问题 / 下一步'],progress.map((p,index)=>[(data.workItems||[]).find((i)=>i.id===p.workItemRef)?.name||p.itemName||`历史事项 ${index+1}`,p.progressText||p.summary||'',p.progressValue==null?'—':`${p.progressValue}%`,[...(p.issues||[]),...(p.nextActions||[])].join(' / ')])));
  app.append(el('p','notice','此处为留存快照。修改或确认请在企微操作当前日报卡片；网页不会绕过员工确认直接入库。'),el('h3','section-title','原始工作记录'));
  app.append(wsTable(['收到时间','类型','原始内容'],data.sources.map((s)=>[crmTime(s.created_at),({text:'文字',voice:'语音',file:'文件',image:'图片',mixed:'图文'})[s.content_type]||s.content_type,el('div','ws-prose',s.text_content||'此条为附件消息；附件内容以已解析结果和原附件留存为准。')]),'暂无可见的原始记录。'));
}
async function wsWeeklyDetail(id) {
  if(typeof rpVersion==='function') return rpVersion(id);
  const data=await fetchJson(`/api/v1/workspace/weekly-reports/${encodeURIComponent(id)}`),r=data.report;
  app.replaceChildren(wsLink('← 周报列表','#/records/weekly','back'),pageHeading(`${r.user_name} · ${r.week_id} 周报`,`版本 v${r.version} · 模板 ${r.template_version} · ${crmTime(r.generated_at)}`),wsRelatedCompanies(data.companies),el('section','ws-prose ws-detail',r.content));
  for(const part of wsJson(r.sections_json)) {const section=el('section','ws-detail');section.append(el('h3','section-title',part.title),el('p','ws-prose',part.body));app.append(section);}
  const plans=wsJson(r.item_snapshot_json);if(plans.length) app.append(el('h3','section-title','生成时的周计划'),wsTable(['事项','计划与背景'],plans.map((item)=>[item.name,item.planBackground||item.plan_background])));
  const sources=wsJson(r.cited_report_ids_json), links=el('div','ws-related');
  sources.forEach((source,index)=>links.append(wsLink(`来源日报 ${index+1}`,`#/records/daily/${encodeURIComponent(source)}`)));
  if(sources.length) app.append(el('h3','section-title','生成依据'),links);
  const missing=wsJson(r.missing_days_json); if(missing.length) app.append(el('p','notice',`未覆盖日期：${missing.join('、')}。不虚构缺失工作。`));
  app.append(el('h3','section-title','管理反馈'));
  const feedback=el('div','ws-feedback-list'); for(const f of data.feedback) feedback.append(el('div','ws-feedback',`${crmTime(f.created_at)} · ${f.manager_name||WS_CONTEXT.users.find((u)=>u.id===f.manager_user_id)?.name||'管理者'}\n${f.content}`));
  if(!data.feedback.length) feedback.append(el('p','muted','暂无反馈。')); app.append(feedback);
  if(data.canFeedback&&WS_VIEW==='team') app.append(feedbackForm(r.user_id,r.week_id,feedback,r.id));
}
function wsPlanEditor(item,weekId) {
  crmModal(item?'编辑本人计划':'新增本人计划','只维护自己的计划。更新保留版本；已被日报引用的事项不能删除。',(grid)=>{
    const name=crmField(grid,'事项名称 *',crmInput(item?.name||'','text',120),true);name.required=true;
    const background=crmField(grid,'计划与背景',crmText(item?.plan_background||'',2000),true);
    return()=>({name:name.value,planBackground:background.value});
  },async(body)=>{await fetchJson(`/api/v1/workspace/items${item?`/${item.id}`:''}`,{method:item?'PUT':'POST',body:JSON.stringify(item?{...body,version:item.version}:{weekId,items:[body]})});notify('本人周计划已保存');await wsRefresh();},'保存计划');
}

async function wsUsers(hash) {
  if(WS_VIEW!=='team'||!WS_CONTEXT.canManageTeam) return wsReadOnly('人员管理仅在管理端开放。本人企业和工作记录请在员工端查看。');
  const [roster,crm]=await Promise.all([wsAdmin()?fetchJson('/api/v1/admin/users'):Promise.resolve({users:WS_CONTEXT.users}),fetchJson(CRM_ROOT)]);
  const id=hash.split('?')[0].slice('#/users/'.length), selected=roster.users.find((u)=>u.id===id);
  if(selected) return wsUserDetail(selected,roster,crm);
  const actions=wsAdmin()?crmButton('新增人员',()=>wsUserEditor(null,roster),'primary-button'):undefined;
  app.replaceChildren(pageHeading('人员管理','管理角色不排斥个人业务：组长可负责企业、写本人日报，同时查看汇报范围内的人员。',actions));
  app.append(el('p','notice','使用后台人员名单和一次性绑定码；不依赖企微通讯录，也不需要人工填写 userid。'));
  const search=crmInput('','search');search.placeholder='搜索姓名 / 部门';search.setAttribute('aria-label','搜索人员');
  const role=crmSelect(Object.entries(WS_ROLES),'','全部角色');role.setAttribute('aria-label','筛选角色');
  const list=el('div');app.append(wsFilters(search,role),list);
  const render=()=>{const q=search.value.trim().toLowerCase(), users=roster.users.filter((u)=>(!q||`${u.name} ${u.department}`.toLowerCase().includes(q))&&(!role.value||u.role===role.value));
    list.replaceChildren(wsTable(['姓名','部门','管理角色','直属上级','负责 / 协作企业','企微绑定','操作'],users.map((u)=>[wsLink(u.name,`#/users/${u.id}`),u.department,WS_ROLES[u.role],u.managerName||'无',crm.companies.filter((c)=>c.ownerId===u.id||(c.collaboratorIds||[]).includes(u.id)).length,u.bindingStatus==='bound'?'已绑定':'待绑定',wsLink('工作记录',`#/records?userId=${encodeURIComponent(u.id)}`)]),'暂无匹配人员。'));};
  search.addEventListener('input',render);role.addEventListener('change',render);render();
}
async function wsUserDetail(user,roster,crm) {
  const {companies}=await fetchJson(`/api/v1/workspace/users/${encodeURIComponent(user.id)}/companies`),actions=el('div','crm-inline-actions');
  if(wsAdmin()) actions.append(crmButton('编辑人员',()=>wsUserEditor(user,roster)));
  actions.append(crmButton('分配企业',()=>wsAssignCompany(user,crm),'primary-button'));
  app.replaceChildren(wsLink('← 人员列表','#/users','back'),pageHeading(user.name,`${user.department||'未设置部门'} · ${WS_ROLES[user.role]}`,actions));
  app.append(wsDefinition([['直属上级',user.managerName||'无直属上级'],['企微绑定',user.bindingStatus==='bound'?'已绑定':'待绑定'],['本人工作', '可负责或协作企业，并填写本人的计划、日报'],['管理权限',user.role==='employee'?'无团队管理权限':user.role==='admin'?'组织管理与系统设置':'仅按实际汇报关系管理，不自动查看其他团队']]),wsLink('查看该人员工作记录',`#/records?userId=${encodeURIComponent(user.id)}`));
  if(wsAdmin()) {
    const bind=el('div','ws-binding-actions');bind.append(crmButton(user.activationStatus==='available'?'重置绑定码':'生成绑定码',()=>wsIssueCode(user,false)));
    if(user.bindingStatus==='bound') bind.append(crmButton('解除企微绑定',()=>wsIssueCode(user,true),'danger-button'));
    bind.append(el('p','muted','绑定码一次性使用。解除绑定会使旧的个人入口和登录会话失效。'));app.append(bind);
    if(WS_ACTIVATION?.userId===user.id) {
      const result=WS_ACTIVATION; WS_ACTIVATION=null;
      const box=el('div','activation-box');box.append(el('p','','一次性绑定码（离开本页后不再显示）'),el('strong','activation-code',result.code),el('p','muted',`有效期至 ${crmTime(result.expiresAt)}`),crmButton('复制绑定码',async()=>{try{await copyText(result.code);notify('已复制');}catch(error){notify(error.message);}}));app.append(box);
    }
  }
  app.append(el('h3','section-title','负责 / 协作企业'),wsTable(['企业','责任关系','目前情况','下一步'],companies.map((c)=>[wsLink(c.name,`#/companies/${c.id}`),c.ownerId===user.id?'负责人':'协作人',wsSummary(c.summary),c.nextAction]),'尚未分配企业。'));
}
function wsUserEditor(user,roster) {
  crmModal(user?'编辑人员档案':'新增人员档案','角色决定管理范围，不限制本人跟进企业；直属上级决定汇报关系。',(grid)=>{
    const name=crmField(grid,'姓名 *',crmInput(user?.name||'','text',64));name.required=true;
    const department=crmField(grid,'部门',crmInput(user?.department||'','text',64));
    const role=crmField(grid,'管理角色',roleSelect(roster.roles||Object.entries(WS_ROLES).map(([value,label])=>({value,label})),user?.role||'employee'));
    const manager=crmField(grid,'直属上级',managerSelect(roster.users,user?.managerUserId||'',user?.id||''));
    return()=>({[user?'displayName':'name']:name.value,department:department.value,role:role.value,managerUserId:manager.value});
  },async(body)=>{
    const result=await fetchJson(`/api/v1/admin/users${user?`/${user.id}`:''}`,{method:user?'PUT':'POST',body:JSON.stringify(body)});
    if(!user) WS_ACTIVATION={userId:result.user.id,code:result.activationCode,expiresAt:result.activationExpiresAt};
    notify('人员档案已保存');if(location.hash===`#/users/${result.user.id}`) await wsRefresh();else location.hash=`#/users/${result.user.id}`;
  },user?'保存人员':'创建并生成绑定码');
}
async function wsIssueCode(user,unbind) {
  if(!window.confirm(unbind?`解除 ${user.name} 的当前企微绑定？旧入口将失效，历史工作记录保留。`:`为 ${user.name} 生成新绑定码？之前未使用的码将失效。`)) return;
  try{const result=await fetchJson(`/api/v1/admin/users/${encodeURIComponent(user.id)}/${unbind?'unbind':'activation-code'}`,{method:'POST'});WS_ACTIVATION={userId:user.id,code:result.activationCode,expiresAt:result.activationExpiresAt};await wsRefresh();}catch(error){notify(error.message);}
}
function wsAssignCompany(user,crm) {
  crmModal(`为 ${user.name} 分配企业`,'负责人和协作人获得企业业务访问权限，但不会自动获得其他员工的私人日报。',(grid)=>{
    const company=crmField(grid,'选择企业 *',crmSelect(crm.companies.filter((c)=>!c.archived).map((c)=>[c.id,c.name]),'','请选择'),true);company.required=true;
    const relation=crmField(grid,'责任关系',crmSelect([['owner','设为负责人（替换当前负责人）'],['collaborator','加入协作人员']],'collaborator'),true);
    const reason=crmField(grid,'分配原因 *',crmText('',1000),true);reason.required=true;
    return()=>({companyId:company.value,relation:relation.value,reason:reason.value});
  },async(body)=>{
    const {company,permissions}=await fetchJson(`${CRM_ROOT}/companies/${encodeURIComponent(body.companyId)}`);
    if(!permissions?.canAssign) throw new Error('无权调整该企业的责任人员');
    const change=body.relation==='owner'?{ownerId:user.id,collaboratorIds:(company.collaboratorIds||[]).filter((id)=>id!==user.id)}:{collaboratorIds:[...new Set([...(company.collaboratorIds||[]),user.id])].filter((id)=>id!==company.ownerId)};
    await fetchJson(`${CRM_ROOT}/companies/${encodeURIComponent(company.id)}`,{method:'PUT',body:JSON.stringify({...company,...change,version:company.version,reason:body.reason})});notify('企业分配已保存');await wsRefresh();
  },'确认分配');
}

async function wsKnowledge(kindArg,idArg) {
  const parts=location.hash.startsWith('#/knowledge')?location.hash.split('?')[0].slice('#/knowledge'.length).split('/').filter(Boolean):[];
  const kind=kindArg||(parts[0]==='templates'?'daily_template':parts[0])||'all',id=kindArg?(idArg||''):decodeURIComponent(parts[1]||'');
  if(kindArg) history.replaceState(null,'',`#/knowledge/${kind}${id?`/${encodeURIComponent(id)}`:''}`);
  const types=wsAdmin()?KNOWLEDGE_TYPES:KNOWLEDGE_TYPES.filter(([key])=>!key.endsWith('_template'));
  const isTemplate=kind.endsWith('_template');
  const action=wsAdmin()&&!id?crmButton(isTemplate?'新建模板版本':'新增资料',()=>{location.hash=`#/knowledge/${kind}/new`;},'primary-button'):undefined;
  app.replaceChildren(pageHeading('知识管理',wsAdmin()?'资料与汇报模板统一查看，点击名称进入详情。':'仅查看已授权企业关联的启用资料；参考内容不自动改变企业事实。',action));
  app.append(wsTabs([['all','全部资料','#/knowledge'],...types.map(([key,label])=>[key,label,`#/knowledge/${key}`])],kind));
  if(isTemplate&&!wsAdmin()) return wsReadOnly('模板配置仅向系统管理员开放。');
  const [data,templateData]=await Promise.all([
    isTemplate?Promise.resolve({entries:[]}):fetchJson(wsAdmin()?'/api/v1/admin/knowledge':'/api/v1/workspace/knowledge'),
    wsAdmin()&&(kind==='all'||isTemplate)?fetchJson('/api/v1/admin/templates'):Promise.resolve({templates:[]}),
  ]);
  const entries=wsKnowledgeEntries(data.entries,templateData.templates).filter((entry)=>kind==='all'||entry.kind===kind);
  if(id) {
    const entry=entries.find((k)=>k.id===id);app.append(wsLink('← 返回资料列表',`#/knowledge/${kind}`,'back'));
    if(id==='new'&&wsAdmin()) {
      if(isTemplate) app.append(templateBuilder(kind==='daily_template'?'daily':'weekly',templateData.templates));
      else app.append(knowledgeEditor(kind==='all'?'service_company':kind,null,true));
      return;
    }
    if(!entry) return wsReadOnly('资料不存在、已停用或当前身份没有访问权限。');
    if(entry.isTemplate) {
      if(!kindArg&&parts[2]==='edit'&&entry.active) {app.append(templateBuilder(entry.template.kind,templateData.templates));return;}
      const edit=entry.active?wsLink('编辑模板',`#/knowledge/${kind}/${encodeURIComponent(id)}/edit`,'secondary-button'):undefined;
      app.append(pageHeading(entry.title,`v${entry.version} · ${entry.active?'当前使用':'历史版本'} · ${crmTime(entry.created_at)}`,edit));
      app.append(wsTable(['字段 / 章节','整理规则','填写要求'],wsTemplateParts(entry.template).map((part)=>[part.title,part.guidance||'按工作记录整理',part.required?'必填':'选填']),'此版本未提供结构化字段。',true));
      if(!entry.active) app.append(el('p','muted','历史模板只读；修改当前模板请返回列表选择正在使用的版本。'));
      return;
    }
    app.append(wsDefinition([['资料名称',entry.title],['摘要',entry.summary],['来源',entry.source_name],['版本',`v${entry.version}`],['状态',entry.active?'启用':'停用'],['标签',wsJson(entry.tags_json).join('、')]]),el('section','ws-prose ws-detail',entry.content));
    if(wsAdmin()) {const edit=el('details','ws-edit-section');edit.append(el('summary','','编辑资料'),knowledgeEditor(entry.kind,entry));app.append(edit);}return;
  }
  app.append(wsTable(['资料名称','类别','摘要','版本','状态','来源'],entries.map((entry)=>[wsLink(entry.title,`#/knowledge/${entry.kind}/${encodeURIComponent(entry.id)}`),KNOWLEDGE_TYPES.find(([key])=>key===entry.kind)?.[1]||'资料',wsSummary(entry.summary),`v${entry.version}`,entry.isTemplate?(entry.active?'当前使用':'历史版本'):(entry.active?'启用':'停用'),entry.source_name]),wsAdmin()?'暂无此类资料，点击右上角新增。':'暂无可见资料。请联系管理员关联企业资料。',true));
}
function wsTemplateParts(template) {
  const parsed=wsJson(template.content,{}),items=template.kind==='daily'?parsed.fields:parsed.sections;
  return Array.isArray(items)?items.map((item)=>typeof item==='string'?{title:item,guidance:'',required:true}:{title:item?.title||item?.name||'未命名',guidance:item?.guidance||item?.instruction||'',required:item?.required!==false}):[];
}
function wsKnowledgeEntries(entries,templates) {
  return [...entries,...templates.map((template)=>({...template,title:template.name,kind:`${template.kind}_template`,summary:wsTemplateParts(template).map((p)=>p.title).join('、'),source_name:'汇报模板',isTemplate:true,template}))];
}

function wsSettingsTabs(active) { return wsTabs([['rules','业务配置'],['notifications','主动消息'],['logs','操作日志'],['exports','归档导出']].map(([key,label])=>[key,label,`#/settings/${key}`]),active); }
async function wsSettings(hash) {
  if(!wsAdmin()) return wsReadOnly('系统设置仅向系统管理员开放；组长无需配置系统也能管理团队和本人业务。');
  const kind=hash.split('?')[0].split('/')[2]||'rules';
  if(kind==='rules'||kind==='exports') {
    await (kind==='rules'?renderSettings():renderExports());
    const heading=app.querySelector('.page-heading');
    if(heading) heading.after(wsSettingsTabs(kind)); else app.prepend(wsSettingsTabs(kind));
    if(kind==='rules') {
      const reminders=[...app.querySelectorAll('.field-label')].filter((label)=>/提醒时间|生成周报时间/.test(label.firstChild?.textContent||''));
      reminders.forEach((label)=>label.hidden=true);
      app.append(el('p','notice','提醒开关与时间统一在“主动消息”中配置。留存天数属于策略配置，系统不会据此自动删除历史；实际清理需另行执行受控归档流程。'));
      if(typeof rpTypeSettings==='function') await rpTypeSettings();
    }
    return;
  }
  app.replaceChildren(pageHeading('系统设置','业务规则、主动消息与操作留痕集中维护。'),wsSettingsTabs(kind));
  if(kind==='notifications') return wsNotifications();
  const data=await fetchJson('/api/v1/admin/audit-logs');
  const query=crmInput('','search');query.placeholder='筛选操作人 / 操作';query.setAttribute('aria-label','搜索操作日志');const results=el('div');app.append(wsFilters(query),results);
  const actor=(log)=>log.actor_name||(log.actor_user_id==='poc-admin'?'后台管理员':log.actor_user_id==='demo-system'?'演示系统':'系统');
  const render=()=>{const q=query.value.trim().toLowerCase();results.replaceChildren(wsTable(['时间','操作人','操作','对象类型','详情'],data.logs.filter((log)=>!q||`${actor(log)} ${wsActionLabel(log.action)}`.toLowerCase().includes(q)).map((log)=>[crmTime(log.created_at),actor(log),wsActionLabel(log.action),wsResourceLabel(log.resource_type),crmButton('查看详情',()=>wsInspect('操作详情',wsAuditDetails(log.details_json)),'quiet-button')]),'暂无匹配日志。'));};query.addEventListener('input',render);render();
}
function wsActionLabel(action) {
  if (action === 'directory.configured') return '保存名录表格链接';
  if (action === 'directory.synced') return '同步员工与企业名录';
  const labels={'crm.company_created':'建立企业档案','crm.company_updated':'更新企业档案','crm.project_created':'建立招商项目','crm.project_updated':'更新招商项目','crm.service_created':'建立服务事项','crm.service_updated':'更新服务事项','crm.followup':'记录企业跟进','crm.knowledge_linked':'关联企业资料','crm.stages_updated':'更新招商阶段','weekly_plan.items_added':'新增周计划事项','weekly_plan.item_updated':'修改周计划事项','weekly_plan.item_deleted':'移除周计划事项','portal.grant_issued':'签发个人工作台入口','portal.grant_exchanged':'进入个人工作台','admin.portal_access_revoked':'撤销个人工作台访问','access_grant.issued':'签发周报专属入口','access_grant.exchanged':'进入周报专属页面','notifications.settings_updated':'更新主动消息配置','notifications.retry_requested':'申请重试消息','notification.sent':'收到消息发送回执','notification.failed':'消息发送失败','notification.cancelled':'取消过期或无权消息'};
  return labels[action]||actionLabel(action);
}
function wsResourceLabel(value) {return ({app_user:'人员',config:'配置',app_config:'业务规则',daily_report:'日报',weekly_report:'周报',report_template:'模板',knowledge_entry:'知识资料',message_outbox:'消息',crm_company:'企业',crm_record:'事项',work_item:'周计划',week_cycle:'周计划',portal_grant:'个人入口',access_grant:'周报入口',archive:'归档'})[value]||'业务操作';}
function wsAuditDetails(raw) {
  const labels={name:'姓名',displayName:'显示名',department:'部门',role:'角色',previousRole:'原角色',managerUserId:'直属上级',previousManagerUserId:'原直属上级',title:'名称',kind:'类别',version:'版本',previousVersion:'原版本',reason:'原因',active:'启用状态',weekId:'周次',reportDate:'日期',sourceCount:'来源条数',year:'年度',quarter:'季度',count:'数量',resourceScoped:'是否报告限定入口',displayNameChanged:'姓名已修改',departmentChanged:'部门已修改'};
  Object.assign(labels,{employees:'员工数量',companies:'企业数量',at:'同步时间',configured:'已配置表格'});
  const data=wsJson(raw,{}),rows=[];
  for(const [key,value] of Object.entries(data)) if(labels[key]&&value!==null&&typeof value!=='object') rows.push([labels[key],key.toLowerCase().includes('manageruserid')?wsName(value):key.toLowerCase().endsWith('role')?(WS_ROLES[value]||value):typeof value==='boolean'?(value?'是':'否'):value]);
  return rows.length?wsDefinition(rows):el('p','muted','此操作已留痕；内部标识、敏感字段和发送凭据不在页面展示。');
}
async function wsNotifications() {
  const data=await fetchJson('/api/v1/admin/notifications'),settings=data.settings;
  const form=el('form','ws-settings-form'),grid=el('div','editor-grid'),controls={};
  const defs=[['enabled','主动消息总开关'],['planReminderEnabled','周一计划提醒'],['dailyReminderEnabled','缺填 / 待确认提醒'],['weeklyReportEnabled','自动生成周报并通知管理者'],['feedbackEnabled','管理反馈通知员工'],['riskEnabled','进度风险提醒（默认关闭）'],['crmAssignmentEnabled','企业分配通知（默认关闭）'],['crmDueEnabled','企业 / 事项到期提醒（默认关闭）']];
  for(const [key,label] of defs) {controls[key]=crmSelect([['true','开启'],['false','关闭']],String(settings[key]));grid.append(labeled(label,controls[key]));}
  for(const [key,label] of [['planReminderAt','周一计划提醒时间'],['dailyReminderAt','日报提醒时间'],['weeklyGenerateAt','周报生成时间'],['crmDueAt','企业跟进提醒时间'],['quietStart','免打扰开始'],['quietEnd','免打扰结束']]) {controls[key]=crmInput(settings[key],'time');controls[key].required=true;grid.append(labeled(label,controls[key]));}
  grid.append(el('p','muted','免打扰仅限制定时提醒；老板反馈保存后优先通知员工，不受免打扰时段限制。通知总开关及反馈开关仍有效。'));
  controls.weeklyWeekday=crmSelect([1,2,3,4,5,6,7].map((d)=>[String(d),`周${['一','二','三','四','五','六','日'][d-1]}`]),String(settings.weeklyWeekday));grid.append(labeled('周报发送日',controls.weeklyWeekday));
  controls.weeklyTarget=crmSelect([['previous','上一自然周（建议周一发送）'],['current','当前自然周（阶段性汇总）']],settings.weeklyTarget);grid.append(labeled('汇总哪一周',controls.weeklyTarget));
  controls.dailyReminderDays=crmInput((settings.dailyReminderDays||[1,2,3,4,5,6,7]).join(','),'text',20);grid.append(labeled('日报提醒日（1周一至7周日，逗号分隔）',controls.dailyReminderDays));
  for(const [key,label,min,max] of [['catchupDays','停机后补发窗口（天）',0,6],['riskThreshold','风险阈值（低于该百分比提醒）',1,100],['riskEarliestWeekday','风险提醒最早周几（1至7）',1,7]]) {controls[key]=crmInput(settings[key],'number');controls[key].min=String(min);controls[key].max=String(max);controls[key].required=true;grid.append(labeled(label,controls[key]));}
  controls.maxAttempts=crmInput(settings.maxAttempts,'number');controls.maxAttempts.min='1';controls.maxAttempts.max='10';controls.maxAttempts.required=true;grid.append(labeled('自动尝试上限',controls.maxAttempts));
  const save=el('button','primary-button','保存主动消息设置');save.type='submit';const status=el('span','form-status'),actions=el('div','person-actions');actions.append(save,status);form.append(grid,actions);
  form.addEventListener('submit',async(event)=>{event.preventDefault();save.disabled=true;try {const body=Object.fromEntries(Object.entries(controls).map(([key,input])=>[key,key==='dailyReminderDays'?input.value.split(',').map(v=>Number(v.trim())):typeof settings[key]==='boolean'?input.value==='true':typeof settings[key]==='number'?Number(input.value):input.value]));await fetchJson('/api/v1/admin/notifications/settings',{method:'PUT',body:JSON.stringify(body)});status.textContent='已保存；网关运行时按新设置调度';}catch(error){status.textContent=error.message;}finally{save.disabled=false;}});
  if(data.compatibilityNote) app.append(el('p','notice warning',data.compatibilityNote));
  app.append(el('p','notice','统一使用北京时间。仅向有效绑定的人员发送；每次发送前复核权限。企业到期提醒以档案 / 事项当前计划日期为准，时间线里的历史计划不是待办。'),form,el('h3','section-title','最近发送记录'),el('p','muted','本页最多展示最近 200 条。未得到明确发送回执时暂停自动重试，需人工核对后再重试，避免重复通知。'));
  const labels={weekly_plan_reminder:'周计划提醒',daily_reminder:'日报提醒',weekly_report:'周报通知',weekly_missing:'零日报提醒',progress_risk:'进度风险',manager_feedback:'管理反馈',feedback:'管理反馈',crm_assignment:'企业分配',crm_due:'企业跟进到期'},states={pending:'等待发送',sending:'发送中',sent:'已取得发送回执',failed:'发送失败 / 待核对',cancelled:'已取消'};
  app.append(wsTable(['建立时间','消息类型','收件人','状态','尝试次数','说明','操作'],data.queue.map((job)=>[crmTime(job.created_at),labels[job.kind]||'业务通知',job.target_name,states[job.status]||job.status,job.attempts,job.last_error||'—',job.can_retry?crmButton('核对后重试',async()=>{if(!window.confirm('请先在企微核对是否已送达。确认再次尝试发送这条消息？'))return;try{await fetchJson(`/api/v1/admin/notifications/${encodeURIComponent(job.id)}/retry`,{method:'POST'});await wsRefresh();}catch(error){notify(error.message);}},'quiet-button'):'—']),'暂无发送记录。仅运行本地预览不会连接企微或触发消息。'));
}
