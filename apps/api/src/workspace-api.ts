import { activeUser, companyMemberIds, managedUserIds, type AccessActor, type Db, type WorkspaceView } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { sundayOf, weekId } from '@wecom/domain';
import { CrmError, CrmStore } from '../../../packages/persistence/src/crm';
import { DailyAssistantApp } from './app';
import { authorizedKnowledgeIds, crmRequest, visibleCompanies, type CrmRequestAccess } from './crm-api';
import { getWeeklyDetail } from './weekly-workflow';

export function workspaceContext(db: Db, actor: AccessActor, viewValue: string | null) {
  const view: WorkspaceView = viewValue === 'team' ? 'team' : 'personal';
  if (viewValue && !['personal', 'team'].includes(viewValue)) throw new CrmError('视图无效');
  if (actor.resourceId) throw new CrmError('报告限定入口不能访问工作台，请重新获取本人门户入口', 403);
  const canManageTeam = ['admin', 'team_lead', 'dept_head'].includes(actor.role);
  if (view === 'team' && !canManageTeam) throw new CrmError('当前身份没有团队管理权限', 403);
  const userIds = managedUserIds(db, actor, view);
  const users = repo.listUsers(db).filter((user) => userIds.includes(user.id));
  const allUsers = new Map(repo.listUsers(db).map((user) => [user.id, user]));
  const me = activeUser(db, actor.userId);
  const access: CrmRequestAccess = { userId: actor.userId, userIds, canManage: view === 'team' && canManageTeam, isAdmin: view === 'team' && actor.role === 'admin', view };
  return {
    access, view, canManageTeam, canAdmin: actor.role === 'admin',
    me: { id: actor.userId, name: me?.name ?? '管理员', role: actor.role, department: me?.department ?? '' },
    users: users.map((user) => ({ id: user.id, name: user.name, displayName: user.name, role: user.role, department: user.department,
      managerUserId: user.manager_user_id, managerName: user.manager_user_id ? allUsers.get(user.manager_user_id)?.name ?? null : null,
      bindingStatus: repo.isUserBound(user) ? 'bound' : 'unbound' })),
  };
}

function filterIds(db: Db, actor: AccessActor, search: URLSearchParams, access: CrmRequestAccess) {
  const userId = search.get('userId');
  if (userId && !access.userIds.includes(userId)) throw new CrmError('无权访问该人员记录', 403);
  const ids = userId ? [userId] : access.userIds;
  const companyId = search.get('companyId');
  if (companyId && !visibleCompanies(new CrmStore(db), access).some((company) => company.id === companyId)) throw new CrmError('企业不存在或无权访问', 404);
  const week = search.get('weekId');
  if (week && (!/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(Date.parse(week)) || weekId(new Date(`${week}T04:00:00Z`)) !== week)) throw new CrmError('请选择自然周周一日期');
  return { ids, companyId, week };
}

function companyReportIds(db: Db, companyId: string): Set<string> {
  return new Set(db.prepare(`SELECT DISTINCT source_report_id FROM crm_event
    WHERE tenant_id='poc' AND company_id=? AND source_report_id IS NOT NULL`).all(companyId).map((row) => String(row.source_report_id)));
}

function dailyRecords(db: Db, ids: string[], companyId: string | null, week: string | null): Array<Record<string, unknown>> {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT d.*,u.name AS user_name FROM daily_report d
    JOIN app_user u ON u.id=d.user_id AND u.tenant_id=d.tenant_id
    WHERE d.tenant_id='poc' AND d.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.report_date DESC,d.version DESC`).all(...ids);
  const linked = companyId ? companyReportIds(db, companyId) : null;
  const until = week ? sundayOf(new Date(`${week}T04:00:00Z`)) : null;
  return rows.filter((row) => (!linked || linked.has(String(row.id))) && (!week || (String(row.report_date) >= week && String(row.report_date) <= until!))).slice(0, 200)
    .map(row=>repo.isGeneratedReportReadable(db,String(row.user_id),String(row.id),'daily')?row:{...row,summary:'引用资料权限或版本已变化，历史原文仍归档保留',progress_json:'[]',restricted:true});
}

function weeklyRecords(db: Db, ids: string[], companyId: string | null, week: string | null): Array<Record<string, unknown>> {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT w.*,u.name AS user_name FROM weekly_report w
    JOIN app_user u ON u.id=w.user_id AND u.tenant_id=w.tenant_id
    WHERE w.tenant_id='poc' AND w.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY w.week_id DESC,w.version DESC`).all(...ids);
  const linked = companyId ? companyReportIds(db, companyId) : null;
  return rows.filter((row) => (!week || row.week_id === week) && (!linked || (JSON.parse(String(row.cited_report_ids_json)) as string[]).some((id) => linked.has(id)))).slice(0, 200)
    .map(row=>repo.isGeneratedReportReadable(db,String(row.user_id),String(row.id),'weekly')?row:{...row,content:'引用资料权限或版本已变化，历史原文仍归档保留',sections_json:'[]',item_snapshot_json:'[]',restricted:true});
}

function sourceRecords(db: Db, reportIds: string[], userIds: string[]) {
  if (!reportIds.length || !userIds.length) return [];
  return db.prepare(`SELECT DISTINCT s.id,s.user_id,u.name AS user_name,s.report_date,s.content_type,s.text_content,s.process_status,s.created_at
    FROM source_message s JOIN daily_report_source l ON l.source_message_id=s.id
    JOIN app_user u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.tenant_id='poc'
    AND l.daily_report_id IN (${reportIds.map(() => '?').join(',')}) AND s.user_id IN (${userIds.map(() => '?').join(',')})
    ORDER BY s.created_at,s.id`).all(...reportIds, ...userIds);
}

function relatedCompanies(db: Db, reportIds: string[], access: CrmRequestAccess) {
  const linked = new Set(db.prepare("SELECT company_id,source_report_id FROM crm_event WHERE tenant_id='poc' AND source_report_id IS NOT NULL")
    .all().filter((row) => reportIds.includes(String(row.source_report_id))).map((row) => String(row.company_id)));
  return visibleCompanies(new CrmStore(db), access).filter((company) => linked.has(company.id));
}

/** Current display names only; neither a historical name snapshot nor an edit to the report. */
function dailyWorkItems(db: Db, report: repo.DailyReportRow): Array<{ id: string; name: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(report.progress_json ?? '[]'); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const ids = [...new Set(parsed.flatMap((entry) => entry && typeof entry === 'object' && typeof entry.workItemRef === 'string' ? [entry.workItemRef as string] : []))];
  return ids.flatMap((id) => {
    // Deleted historical items remain resolvable; references never authorize a different person's item.
    const item = repo.getWorkItem(db, id, report.tenant_id);
    return item?.user_id === report.user_id ? [{ id: item.id, name: item.name }] : [];
  });
}

export function workspaceRequest(db: Db, app: DailyAssistantApp, url: URL, method: string, body: Record<string, unknown>, actor: AccessActor) {
  const context = workspaceContext(db, actor, url.searchParams.get('view'));
  const access = context.access;
  const suffix = url.pathname.slice('/api/v1/workspace'.length);
  const store = new CrmStore(db);
  if (suffix.startsWith('/crm')) {
    const result = crmRequest(db, `/api/v1/admin/crm${suffix.slice('/crm'.length)}`, method, body, actor.userId, access);
    if (method === 'GET' && /^\/crm\/companies\/[^/]+$/.test(suffix)) {
      const companyId = decodeURIComponent(suffix.split('/').at(-1)!);
      return { ...result, body: { ...result.body, workRecords: {
        reports: dailyRecords(db, access.userIds, companyId, null), weeklyReports: weeklyRecords(db, access.userIds, companyId, null),
      } } };
    }
    return result;
  }
  const selected = filterIds(db, actor, url.searchParams, access);
  const selectedWeek = selected.week ?? weekId(new Date());
  if (suffix === '' && method === 'GET') {
    const companies = visibleCompanies(store, access), companyIds = new Set(companies.map((company) => company.id));
    const records = store.records().filter((record) => companyIds.has(record.companyId));
    const reports = dailyRecords(db, access.userIds, null, selectedWeek);
    const { access: _internal, ...publicContext } = context;
    return { status: 200, body: { ...publicContext, weekId: selectedWeek, counts: { companies: companies.length,
      projects: records.filter((record) => record.kind === 'project').length,
      services: records.filter((record) => record.kind === 'service').length,
      dailyReports: reports.length, pendingDailyReports: reports.filter((report) => report.status === 'pending_confirmation').length,
      weeklyReports: new Set(weeklyRecords(db, access.userIds, null, selectedWeek).map(row=>`${row.user_id}:${row.week_id}`)).size,
    } } };
  }
  if (suffix === '/users' && method === 'GET') return { status: 200, body: { users: context.users } };
  const person = suffix.match(/^\/users\/([^/]+)\/companies$/);
  if (person && method === 'GET') {
    const userId = decodeURIComponent(person[1]);
    if (!access.userIds.includes(userId)) throw new CrmError('无权访问该人员', 403);
    return { status: 200, body: { companies: visibleCompanies(store, access).filter((company) => companyMemberIds(company).includes(userId)) } };
  }
  if (suffix === '/records' && method === 'GET') {
    const reports = dailyRecords(db, selected.ids, selected.companyId, selected.week);
    return { status: 200, body: { reports, sources: sourceRecords(db, reports.map((report) => String(report.id)), selected.ids) } };
  }
  const recordMatch = suffix.match(/^\/records\/([^/]+)$/);
  if (recordMatch && method === 'GET') {
    const id = decodeURIComponent(recordMatch[1]), report = repo.getDailyReportById(db, id);
    if (!report || !access.userIds.includes(report.user_id)) throw new CrmError('工作记录不存在或无权访问', 404);
    if(!repo.isGeneratedReportReadable(db,report.user_id,report.id,'daily')) throw new CrmError('引用资料权限或版本已变化，请重新整理；历史原文仍归档保留',403);
    return { status: 200, body: { report: { ...report, user_name: repo.getUser(db, report.user_id)?.name },
      sources: sourceRecords(db, [id], access.userIds), companies: relatedCompanies(db, [id], access), workItems: dailyWorkItems(db, report), canConfirm: false } };
  }
  if (suffix === '/weekly-reports' && method === 'GET') return { status: 200, body: { reports: weeklyRecords(db, selected.ids, selected.companyId, selected.week) } };
  const feedbackMatch = suffix.match(/^\/weekly-reports\/([^/]+)\/feedback$/);
  if (feedbackMatch && method === 'POST') {
    if (!access.canManage) throw new CrmError('请使用有权管理的团队视图提交反馈', 403);
    const report = repo.getWeeklyReportById(db, decodeURIComponent(feedbackMatch[1]));
    if (!report || !access.userIds.includes(report.user_id)) throw new CrmError('周报不存在或无权访问', 404);
    if (report.user_id === actor.userId || !activeUser(db, report.user_id)) throw new CrmError('不能向本人或停用人员提交管理反馈', 403);
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 10_000) throw new CrmError('请填写1至10000字的反馈');
    return { status: 201, body: { id: app.addFeedback(report.id, body.content, null, actor.userId) } };
  }
  const weeklyMatch = suffix.match(/^\/weekly-reports\/([^/]+)$/);
  if (weeklyMatch && method === 'GET') {
    const report = repo.getWeeklyReportById(db, decodeURIComponent(weeklyMatch[1]));
    if (!report || !access.userIds.includes(report.user_id)) throw new CrmError('周报不存在或无权访问', 404);
    const detail = getWeeklyDetail(db,actor,report.user_id,report.week_id,{reportId:report.id});
    if(!repo.isGeneratedReportReadable(db,report.user_id,report.id,'weekly')) throw new CrmError('引用资料权限或版本已变化，请重新生成；历史原文仍归档保留',403);
    return { status: 200, body: { report: { ...report, user_name: repo.getUser(db, report.user_id)?.name },
      progressSnapshot:detail.evidence?.progressSnapshot ?? null,
      sourceSnapshot:detail.evidence?.snapshot ?? null,
      companies: relatedCompanies(db, JSON.parse(report.cited_report_ids_json), access), feedback: detail.feedback,
      canFeedback: access.canManage && report.user_id !== actor.userId && Boolean(activeUser(db, report.user_id)) } };
  }
  if (suffix === '/knowledge' && method === 'GET') {
    const ids = authorizedKnowledgeIds(db, store, access, selected.companyId ?? undefined);
    return { status: 200, body: { entries: repo.listKnowledgeEntries(db, { active: true }).filter((entry) => ids.has(entry.id)) } };
  }
  if (suffix === '/items' && method === 'GET') return { status: 200, body: { weekId: selectedWeek,
    items: selected.ids.flatMap((id) => repo.listWorkItems(db, id, selectedWeek).map((item) => ({ ...item, user_name: repo.getUser(db, id)?.name }))) } };
  if (suffix === '/items' && method === 'POST') {
    if (!activeUser(db, actor.userId) || (body.userId && body.userId !== actor.userId)) throw new CrmError('只能维护本人的周计划', 403);
    if (!Array.isArray(body.items) || body.items.some((entry) => !entry || typeof entry !== 'object' || typeof entry.name !== 'string')) throw new CrmError('事项格式无效');
    const items = body.items.map((entry) => ({ name: entry.name as string, planBackground: typeof entry.planBackground === 'string' ? entry.planBackground : '' }));
    app.createWeeklyPlan(actor.userId, typeof body.weekId === 'string' ? body.weekId : selectedWeek, items);
    return { status: 201, body: { items: repo.listWorkItems(db, actor.userId, typeof body.weekId === 'string' ? body.weekId : selectedWeek) } };
  }
  const itemMatch = suffix.match(/^\/items\/([^/]+)$/);
  if (itemMatch && (method === 'PUT' || method === 'DELETE')) {
    const item = repo.getWorkItem(db, decodeURIComponent(itemMatch[1]));
    if (!item || item.user_id !== actor.userId) throw new CrmError('只能维护本人的周计划', 403);
    if (!Number.isInteger(body.version) || Number(body.version) < 1) throw new CrmError('事项版本无效');
    if (method === 'DELETE') { app.deleteWeeklyPlanItem(actor.userId, item.id, Number(body.version)); return { status: 200, body: { ok: true } }; }
    if (typeof body.name !== 'string' || typeof body.planBackground !== 'string') throw new CrmError('事项名称与背景必须为文字');
    return { status: 200, body: { item: app.updateWeeklyPlanItem(actor.userId, item.id, Number(body.version), { name: body.name, planBackground: body.planBackground }) } };
  }
  throw new CrmError('接口不存在', 404);
}
