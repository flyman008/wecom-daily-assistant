// Standalone mobile reports; scope and writes remain enforced by the shared API.
let MW_DEMO_CHECKED = false;
function mwWeek() {
  const candidate = new URLSearchParams(location.hash.split('?')[1] || location.search).get('weekId');
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) && !Number.isNaN(Date.parse(candidate)) ? wsMonday(candidate) : wsMonday();
}
function mwHeading(name, week, back = false) {
  const head = el('header', 'mw-heading');
  if (back && WS_CONTEXT?.canManageTeam) head.append(wsLink('‹ 团队周报', `#/weekly?weekId=${week}`, 'mw-back'));
  const end = new Date(`${week}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
  head.append(el('p', 'mw-brand', '日报助手 · 工作周报'));
  const row=el('div','mw-title-row'),period=`${week.slice(5).replace('-','.')}—${end.toISOString().slice(5,10).replace('-','.')}`;
  row.append(el('h1','',name),crmButton(`${period} ▾`,()=>mwWeekDialog(week),'mw-week-trigger'));head.append(row);
  return head;
}
function mwWeekDialog(week) {
  const dialog=el('dialog','crm-dialog mw-week-dialog'),wrap=el('section'),head=el('div','crm-modal-head');
  head.append(el('h2','','选择周次'),crmButton('关闭',()=>dialog.close(),'quiet-button'));wrap.append(head);
  const list=el('div','mw-week-list');
  for(let offset=-1;offset<4;offset++){const start=new Date(`${week}T12:00:00Z`);start.setUTCDate(start.getUTCDate()-offset*7);const value=start.toISOString().slice(0,10),finish=new Date(start);finish.setUTCDate(finish.getUTCDate()+6);const label=`${value.slice(5).replace('-','.')}—${finish.toISOString().slice(5,10).replace('-','.')}`;const button=crmButton(label,()=>{dialog.close();const match=location.hash.match(/^#\/employee\/([^/]+)\//);location.hash=match?`#/employee/${match[1]}/${value}`:`#/weekly?weekId=${value}`;},value===week?'mw-week-option active':'mw-week-option');list.append(button);}
  wrap.append(list);dialog.append(wrap);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
}
function mwFeedbackEntry(feedback=[],report=null,canFeedback=false,edit=rpFeedback) {
  if(!feedback.length&&!canFeedback)return el('span');
  const trigger=crmButton(`老板反馈${feedback.length?` ${feedback.length}条`:''}`,()=>{
    const dialog=el('dialog','crm-dialog mw-feedback-dialog'),wrap=el('section','mw-feedback-detail'),head=el('div','crm-modal-head');
    head.append(el('h2','','老板反馈'),crmButton('关闭',()=>dialog.close(),'quiet-button'));wrap.append(head);
    const sorted=[...feedback].sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||'')));
    if(!sorted.length)wrap.append(el('p','muted','暂时还没有反馈。'));
    for(const item of sorted){const row=el('article','mw-feedback-item');row.append(el('p','muted',`${item.manager_name||'负责人'}${item.created_at?` · ${crmTime(item.updated_at||item.created_at)}`:''}`),el('p','ws-prose',item.content));if(canFeedback&&item.manager_user_id===WS_SESSION?.userId)row.append(crmButton('修改',()=>{dialog.close();edit(report,item);},'quiet-button'));wrap.append(row);}
    if(canFeedback&&report)wrap.append(crmButton('写反馈',()=>{dialog.close();edit(report,null);},'primary-button'));
    dialog.append(wrap);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  },'mw-feedback-entry');
  return trigger;
}
async function mwEmployee(userId, week) {
  const data = await fetchJson(rpRoot(userId, week)), detail = data.detail;
  const report = detail.currentReport || detail.report;
  app.replaceChildren(mwHeading(`${data.name}的周报`, week, true));
  app.append(mwFeedbackEntry(detail.feedback || [], report, Boolean(report && data.canFeedback)), rpSummary(data.progress));
  app.append(rpTimeline(data.progress, crmDate(), {reasons: detail.reasons || []}));
  const overall = (detail.reasons || []).find(reason => !reason.workItemId);
  if (overall?.content) app.append(el('h3', 'section-title', '分析与后续安排'), el('p', 'ws-prose', overall.content));
}
async function mwSnapshot(hash) {
  // One-report grants must never be widened into a team/workspace session.
  const parts = hash.split('/');
  const report = await fetchJson(`/api/v1/reports/${encodeURIComponent(decodeURIComponent(parts[2]))}/${encodeURIComponent(parts[3])}`);
  app.replaceChildren(mwHeading(`${report.name}的周报`, report.weekId));
  app.append(mwFeedbackEntry(report.feedback || [], report, report.canFeedback, rpScopedFeedback));
  if (report.progressSnapshot) {
    const asOf = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(report.generatedAt));
    app.append(rpSummary(report.progressSnapshot, asOf), rpTimeline(report.progressSnapshot, asOf, report.sourceSnapshot));
  } else app.append(el('p', 'ws-prose', report.content));
  const reason = report.sourceSnapshot?.reasons?.find(row => !row.workItemId);
  if (reason?.content) app.append(el('h3', 'section-title', '分析与后续安排'), el('p', 'ws-prose', reason.content));
}
async function mwRoute() {
  const run = ++WS_ROUTE_RUN, hash = location.hash || '#/weekly';
  if (hash.startsWith('#/access/')) return exchangeAccessGrant(hash);
  if (!MW_DEMO_CHECKED || !token()) {
    MW_DEMO_CHECKED = true;
    // Each temporary public POC entry receives a distinct, server-limited identity.
    const sessionEndpoint=location.pathname.endsWith('/employee-weekly.html')?'/api/v1/demo/employee-weekly-session':'/api/v1/demo/weekly-session';
    const response = await fetch(API_BASE + sessionEndpoint, {method:'POST'}).catch(() => null);
    if (run !== WS_ROUTE_RUN) return;
    if (response?.ok) {
      const session = await response.json();
      if (run !== WS_ROUTE_RUN) return;
      sessionStorage.setItem(TOKEN_KEY, session.token);
    }
    if (!token()) return showLogin();
  }
  app.replaceChildren(el('p', 'muted', '正在加载周报…'));
  try {
    WS_SESSION = await fetchJson('/api/v1/session');
    if (run !== WS_ROUTE_RUN) return;
    document.body.classList.remove('logged-out');
    if (WS_SESSION.resourceScoped) {
      if (/^#\/report\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(hash)) await mwSnapshot(hash);
      else app.replaceChildren(el('p', 'notice', '此链接仅用于查看指定周报，请重新打开收到的周报链接。'));
      return;
    }
    WS_VIEW = ['admin','dept_head','team_lead'].includes(WS_SESSION.role) ? 'team' : 'personal';
    WS_CONTEXT = await fetchJson(`/api/v1/workspace?view=${WS_VIEW}`);
    if (run !== WS_ROUTE_RUN) return;
    const employee = hash.match(/^#\/(?:employee|records\/week|report)\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
    const snapshot = hash.match(/^#\/records\/weekly\/([^/?]+)$/);
    if (employee) await mwEmployee(decodeURIComponent(employee[1]), employee[2]);
    else if (snapshot) {
      const data = await fetchJson(`/api/v1/workspace/weekly-reports/${encodeURIComponent(decodeURIComponent(snapshot[1]))}`);
      // Keep old version links tied to their immutable snapshot, not today's progress.
      const r = data.report;
      app.replaceChildren(mwHeading(`${r.user_name}的周报`, r.week_id, true), mwFeedbackEntry(data.feedback || [], r, data.canFeedback));
      if (data.progressSnapshot) app.append(rpSummary(data.progressSnapshot, r.generated_at.slice(0,10)), rpTimeline(data.progressSnapshot, r.generated_at.slice(0,10), data.sourceSnapshot));
      else app.append(el('p','ws-prose',r.content));
    } else if (!WS_CONTEXT.canManageTeam) await mwEmployee(WS_SESSION.userId, mwWeek());
    else {
      const week = mwWeek(), data = await fetchJson(`/api/v1/reporting/weeks?weekId=${week}`);
      app.replaceChildren(mwHeading('团队工作周报', week), rpManagerReport(data.rows, week));
    }
    window.scrollTo(0,0);
  } catch (error) { if (run === WS_ROUTE_RUN) handlePageError(error); }
}
