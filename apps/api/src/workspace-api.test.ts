import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import * as repo from '@wecom/persistence';
import type { Role } from '@wecom/domain';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { startServer } from './server';

const fixtures: Array<{ server: Awaited<ReturnType<typeof startServer>>; directory: string; db: repo.Db }> = [];
const at = '2026-09-04T08:00:00.000Z';
async function setup(demoMode = true) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-api-test-'));
  const dbPath = join(directory, 'poc.sqlite');
  const server = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'isolated-workspace-test', demoMode });
  const db = repo.openDb(dbPath);
  fixtures.push({ server, directory, db });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let admin = '';
  const request = async (path: string, token: string | null = admin, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}/api/v1${path}`, { method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Heterogeneous HTTP contracts are asserted explicitly in each test below.
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const login = await request('/auth/login', null, 'POST', { accessCode: 'isolated-workspace-test' });
  expect(login.status).toBe(200);
  admin = login.body.token as string;
  const portal = async (userId: string) => {
    const grant = repo.issuePortalAccessGrant(db, userId, { baseUrl: base });
    const exchanged = await request('/portal-grants/exchange', null, 'POST', { token: grant.token });
    expect(exchanged.status).toBe(200);
    return exchanged.body.token as string;
  };
  const scopedSession = (role: Role) => {
    const id = `scoped-${role}`, token = randomUUID();
    repo.upsertUser(db, { id, role });
    repo.insertAuthSession(db, { token_hash: createHash('sha256').update(token).digest('hex'), user_id: id,
      role, resource_id: 'single-report', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
    return token;
  };
  return { request, db, admin, portal, scopedSession, store: new CrmStore(db), base };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('真实身份的个人/团队工作台', () => {
  it('演示组长自己有企业/日报/周计划，同时仅能管理直属树，角色不互斥', async () => {
    const { request, portal } = await setup(), lead = await portal('e001');
    expect((await request('/session', lead)).body).toMatchObject({ userId: 'e001', name: '张三', role: 'team_lead',
      resourceScoped: false, demoMode: true, canAdmin: false, canManageTeam: true });
    const personal = await request('/workspace?view=personal&weekId=2026-08-31', lead);
    expect(personal.status).toBe(200);
    expect(personal.body.me).toMatchObject({ id: 'e001', name: '张三', role: 'team_lead' });
    expect(personal.body.users.map((user: { id: string }) => user.id)).toEqual(['e001']);
    expect(personal.body.counts).toMatchObject({ companies: 1, dailyReports: 4, weeklyReports: 1 });
    const personalCrm = await request('/workspace/crm?view=personal', lead);
    expect(personalCrm.body.companies.map((company: { ownerId: string }) => company.ownerId)).toEqual(['e001']);
    expect(personalCrm.body.permissions).toMatchObject({ canCreate: true, canAssign: false, canConfigureStages: false });
    const team = await request('/workspace?view=team', lead);
    expect(team.body.users.map((user: { id: string }) => user.id).sort()).toEqual(['e001', 'e002']);
    expect(JSON.stringify(team.body.users)).not.toContain('wecom_userid');
    expect(team.body.users.find((user: { id: string }) => user.id === 'e002')).toMatchObject({ managerUserId: 'e001', managerName: '张三', bindingStatus: 'bound' });
    expect((await request('/workspace/crm?view=team', lead)).body.companies).toHaveLength(2);
    expect((await request('/workspace/items?view=personal&weekId=2026-08-31', lead)).body.items).toHaveLength(3);
    const ownPlan = await request('/workspace/items?view=personal', lead, 'POST', { weekId: '2026-08-24', items: [{ name: '兼任组长的本人工作', planBackground: '独立业务责任' }] });
    expect(ownPlan.status).toBe(201);
    expect(ownPlan.body.items[0].user_id).toBe('e001');
    expect((await request('/workspace/items?view=team', lead, 'POST', { userId: 'e002', weekId: '2026-08-24', items: [{ name: '冒充下属' }] })).status).toBe(403);
    const outsideItem = (await request('/workspace/items?view=team&userId=e003&weekId=2026-08-31')).body.items[0];
    expect((await request(`/workspace/items/${outsideItem.id}?view=team`, lead, 'DELETE', { version: outsideItem.version })).status).toBe(403);
  });

  it('员工无团队模式、跨组和报告限定session不能进入工作台，部门领导不自动全员', async () => {
    const { request, portal, db, scopedSession } = await setup();
    const employee = await portal('e002'), lead = await portal('e001');
    expect((await request('/workspace', null)).status).toBe(401);
    expect((await request('/workspace?view=team', employee)).status).toBe(403);
    expect((await request('/workspace?view=bogus', employee)).status).toBe(400);
    expect((await request('/workspace/records?view=team&userId=e003', lead)).status).toBe(403);
    expect((await request('/workspace/records?view=personal&userId=e001', employee)).status).toBe(403);
    expect((await request('/workspace/records?weekId=2026-09-01', employee)).status).toBe(400);
    expect((await request('/workspace?view=team', scopedSession('admin'))).status).toBe(403);
    expect((await request('/admin/users', lead)).status).toBe(403);
    expect((await request('/admin/notifications', lead)).status).toBe(403);
    expect((await request('/admin/knowledge', employee)).status).toBe(403);
    repo.upsertUser(db, { id: 'unrelated-head', name: '独立部门主管', role: 'dept_head' });
    const head = await portal('unrelated-head');
    expect((await request('/workspace?view=team', head)).body.users.map((user: { id: string }) => user.id)).toEqual(['unrelated-head']);
    expect((await request('/workspace?view=team')).body.users).toHaveLength(6); // Seed four + scoped admin + unrelated head.
  });

  it('负责人可为组长，分配必须管理视图且目标在范围内，协作者不能自取企业', async () => {
    const { request, portal, store } = await setup(), lead = await portal('e001'), employee = await portal('e002');
    const own = store.companies().find((company) => company.ownerId === 'e001')!;
    const outside = store.companies().find((company) => company.ownerId === 'e003')!;
    expect((await request(`/workspace/crm/companies/${outside.id}?view=team`, lead)).status).toBe(404);
    expect((await request(`/workspace/users/e003/companies?view=team`, lead)).status).toBe(403);
    expect((await request(`/workspace/crm/companies/${own.id}?view=personal`, lead, 'PUT', { version: own.version, ownerId: 'e002', reason: '个人视角不分配' })).status).toBe(403);
    expect((await request(`/workspace/crm/companies/${own.id}?view=team`, lead, 'PUT', { version: own.version, ownerId: 'e003', reason: '跨组转交' })).status).toBe(403);
    expect((await request(`/workspace/crm/companies/${own.id}?view=team`, lead, 'PUT', { version: own.version, collaboratorIds: ['e003'], reason: '跨组协作' })).status).toBe(403);
    const assigned = await request(`/workspace/crm/companies/${own.id}?view=team`, lead, 'PUT', { version: own.version, ownerId: 'e001', collaboratorIds: ['e002'], reason: '本人负责，李四协作' });
    expect(assigned.status).toBe(200);
    expect(assigned.body.company).toMatchObject({ ownerId: 'e001', collaboratorIds: ['e002'] });
    const detail = await request(`/workspace/crm/companies/${own.id}?view=personal`, employee);
    expect(detail.body.permissions).toEqual({ canEdit: false, canAssign: false, canFollowup: true, canLinkKnowledge: true });
    expect(detail.body.company).toMatchObject({ ownerName: '张三', collaboratorNames: ['李四'] });
    expect((await request('/workspace/crm/options', employee)).body.users.map((user: { id: string }) => user.id)).toEqual(['e002']);
    expect((await request(`/workspace/crm/companies/${own.id}?view=personal`, employee, 'PUT', { version: assigned.body.company.version, ownerId: 'e002', reason: '协作者自取' })).status).toBe(403);
    expect((await request(`/workspace/crm/companies/${own.id}/followups?view=personal`, employee, 'POST', { content: '已电话联络企业' })).status).toBe(201);
    for (const section of ['projects', 'services']) {
      expect((await request(`/workspace/crm/companies/${own.id}/${section}`, employee, 'POST', { title: '协作者越权新建' })).status).toBe(403);
      const kind = section === 'projects' ? 'project' : 'service';
      const existingRecord = store.records(own.id).find((record) => record.kind === kind)
        ?? store.saveRecord(own.id, kind, { title: '权限测试既有事项', ownerId: 'e001' }, 'poc-admin');
      expect((await request(`/workspace/crm/companies/${own.id}/${section}/${existingRecord.id}`, employee, 'PUT', { version: existingRecord.version, title: '协作者越权修改', reason: '越权' })).status).toBe(403);
    }
    const personCompanies = await request('/workspace/users/e002/companies?view=team', lead);
    expect(personCompanies.body.companies).toHaveLength(2);
    expect((await request('/workspace/crm/stages?view=team', lead, 'PUT', { stages: [] })).status).toBe(403);
    const fresh = await request('/workspace/crm/companies?view=personal', lead, 'POST', { name: '组长本人新企业' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.company.ownerId).toBe('e001');
    expect((await request('/workspace/crm/companies?view=personal', employee, 'POST', { name: '越权新建', ownerId: 'e003' })).status).toBe(403);
    const project = await request(`/workspace/crm/companies/${fresh.body.company.id}/projects?view=personal`, lead, 'POST', { title: '本人招商项目' });
    expect(project.status).toBe(201);
    expect(project.body.record.ownerId).toBe('e001');
    const projectPath = `/workspace/crm/companies/${fresh.body.company.id}/projects/${project.body.record.id}`;
    expect((await request(`${projectPath}?view=personal`, lead, 'PUT', { version: 1, ownerId: 'e002', reason: '个人不能改事项负责人' })).status).toBe(403);
    expect((await request(`${projectPath}?view=team`, lead, 'PUT', { version: 1, ownerId: 'e003', reason: '跨组不能改事项负责人' })).status).toBe(403);
    expect((await request(`${projectPath}?view=team`, lead, 'PUT', { version: 1, ownerId: 'e002', reason: '主管分配给下属' })).status).toBe(200);
    const maintain = await request(`${projectPath}?view=personal`, lead, 'PUT', { version: 2, ownerId: 'e002', stageId: 'needs', reason: '个人保持原负责人，补充需求阶段' });
    expect(maintain.status).toBe(200);
    expect(maintain.body.record).toMatchObject({ ownerId: 'e002', stageId: 'needs' });
  });
});

describe('关联企业与报告原文隐私', () => {
  it('日报详情另返所引用周计划的当前名称，不改历史正文，已删除项可解析但不串人员或租户', async () => {
    const { request, portal, db } = await setup(), employee = await portal('e002'), lead = await portal('e001');
    const item = (id: string, userId = 'e002', tenant = 'poc', deleted = 0) => repo.insertWorkItem(db, {
      id, user_id: userId, tenant_id: tenant, week_id: '2026-08-31', name: `名称-${id}`, plan_background: '不额外暴露的背景', created_at: at, deleted,
    });
    item('current-own'); item('deleted-own', 'e002', 'poc', 1); item('other-person', 'e001');
    db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', '隔离测试', at);
    repo.upsertUser(db, { id: 'other-tenant-user', tenant_id: 'other' });
    item('other-tenant-item', 'other-tenant-user', 'other');
    const progress = JSON.stringify(['current-own','deleted-own','other-person','other-tenant-item','missing'].map((workItemRef) => ({ workItemRef, progressText: '原始进展快照', progressValue: 20 })));
    repo.insertDailyReport(db, { id: 'current-name-report', user_id: 'e002', report_date: '2026-09-04', version: 1, status: 'confirmed',
      summary: '历史正文不变', progress_json: progress, confirmed_at: at, created_at: at });
    const snapshot = repo.getDailyReportById(db, 'current-name-report')!;
    db.prepare("UPDATE work_item SET name='现在的事项名称' WHERE id='current-own'").run();
    for (const [token, view] of [[employee, 'personal'], [lead, 'team']]) {
      const response = await request(`/workspace/records/current-name-report?view=${view}`, token);
      expect(response.status).toBe(200);
      expect(response.body.workItems).toEqual([{ id: 'current-own', name: '现在的事项名称' }, { id: 'deleted-own', name: '名称-deleted-own' }]);
      expect(response.body.report).toMatchObject({ summary: '历史正文不变', progress_json: progress });
    }
    expect(repo.getDailyReportById(db, 'current-name-report')).toEqual(snapshot);
  });

  it('反馈绑定所查看的历史周报ID，不串新版；本人、员工、跨组及个人视图均不能管理反馈', async () => {
    const { request, portal, db } = await setup(), lead = await portal('e001'), employee = await portal('e002');
    const previous = repo.getWeeklyReport(db, 'e002', '2026-08-31')!;
    const latestId = 'newer-weekly-report';
    repo.insertWeeklyReport(db, { ...previous, id: latestId, version: previous.version + 1, content: '新版本内容' });
    const route = `/workspace/weekly-reports/${previous.id}/feedback?view=team`;
    const response = await request(route, lead, 'POST', { content: '这条反馈针对历史版' });
    expect(response.status).toBe(201);
    expect(repo.listFeedback(db, previous.id)).toHaveLength(1);
    expect(repo.listFeedback(db, previous.id)[0]).toMatchObject({ content: '这条反馈针对历史版', manager_user_id: 'e001', to_user_id: 'e002' });
    expect(repo.listFeedback(db, latestId)).toEqual([]);
    const outbox = db.prepare("SELECT payload_json FROM message_outbox WHERE kind='manager_feedback' AND target_user_id='e002'").all();
    expect(JSON.parse(String(outbox[0].payload_json))).toMatchObject({ weeklyReportId: previous.id, feedbackId: response.body.id });
    expect((await request(route, employee, 'POST', { content: '员工越权' })).status).toBe(403);
    expect((await request(route.replace('view=team', 'view=personal'), lead, 'POST', { content: '个人模式越权' })).status).toBe(403);
    const self = repo.getWeeklyReport(db, 'e001', '2026-08-31')!;
    expect((await request(`/workspace/weekly-reports/${self.id}/feedback?view=team`, lead, 'POST', { content: '反馈给本人' })).status).toBe(403);
    const outside = repo.getWeeklyReport(db, 'e003', '2026-08-31')!;
    expect((await request(`/workspace/weekly-reports/${outside.id}/feedback?view=team`, lead, 'POST', { content: '跨组反馈' })).status).toBe(404);
    expect((await request(route, lead, 'POST', { content: '  ' })).status).toBe(400);
    expect((await request(route, lead, 'POST', { content: '超'.repeat(10_001) })).status).toBe(400);
    // The bootstrap admin must not be silently created as a department head.
    expect((await request(route, undefined, 'POST', { content: '管理员复核历史版' })).status).toBe(201);
    expect(repo.getUser(db, 'poc-admin')?.role).toBe('admin');
    expect(repo.isUserBound(repo.getUser(db, 'poc-admin')!)).toBe(false);
    expect((await request('/workspace?view=team')).body.users.length).toBeGreaterThan(0);
    expect((await request('/session')).body).toMatchObject({ role: 'admin', canAdmin: true });
    expect(repo.listFeedback(db, latestId)).toEqual([]);
  });

  it('企业共享不共享个人日报原文；详情、来源选项、工作记录与周报仅显式关联且按人员范围过滤', async () => {
    const { request, portal, store, db } = await setup(), employee = await portal('e002'), lead = await portal('e001');
    const outside = store.companies().find((company) => company.ownerId === 'e003')!;
    store.saveCompany({ version: outside.version, collaboratorIds: ['e002'], reason: '管理员明确授权协作' }, 'poc-admin', outside.id);
    repo.insertDailyReport(db, { id: 'private-daily', user_id: 'e003', report_date: '2026-09-04', version: 1, status: 'confirmed',
      summary: 'OUTSIDE-PRIVATE-DAILY-TEXT', progress_json: '[]', confirmed_at: at, created_at: at });
    store.followup(outside.id, { content: '授权共享的企业跟进摘要', sourceReportId: 'private-daily' }, 'poc-admin');
    const ownReport = repo.listDailyReportsInRange(db, 'e002', '2026-08-31', '2026-09-04')[0];
    const ownWeekly = repo.getWeeklyReport(db, 'e002', '2026-08-31')!;
    store.followup(outside.id, { content: '李四明确关联的跟进', sourceReportId: ownReport.id }, 'e002');
    for (const [token, view] of [[employee, 'personal'], [lead, 'team']]) {
      const detail = await request(`/workspace/crm/companies/${outside.id}?view=${view}`, token);
      expect(detail.status).toBe(200);
      expect(JSON.stringify(detail.body)).not.toContain('OUTSIDE-PRIVATE-DAILY-TEXT');
      expect(detail.body.events.some((event: { source_report_id?: string }) => event.source_report_id === 'private-daily')).toBe(false);
      expect(JSON.stringify(detail.body.events)).not.toContain('授权共享的企业跟进摘要');
      expect(detail.body.workRecords.reports.map((report: { id: string }) => report.id)).toEqual([ownReport.id]);
      expect(detail.body.workRecords.reports[0].user_name).toBe('李四');
      expect(detail.body.workRecords.weeklyReports.map((report: { id: string }) => report.id)).toEqual([ownWeekly.id]);
      expect(detail.body.permissions.canAssign).toBe(false); // Collaborator in scope does not give ownership reassignment authority.
      expect((await request(`/workspace/records/private-daily?view=${view}`, token)).status).toBe(404);
      expect((await request('/reports/e003/2026-08-31', token)).status).toBe(403);
      const options = await request(`/workspace/crm/options?view=${view}`, token);
      expect(options.body.reports.every((report: { user_id: string }) => report.user_id !== 'e003')).toBe(true);
    }
    const records = await request(`/workspace/records?companyId=${outside.id}`, employee);
    expect(records.body.reports.map((report: { id: string }) => report.id)).toEqual([ownReport.id]);
    expect(records.body.sources.every((source: { user_id: string }) => source.user_id === 'e002')).toBe(true);
    expect(JSON.stringify(records.body.sources)).not.toContain('attachments_json');
    const ownDetail = await request(`/workspace/records/${ownReport.id}`, employee);
    expect(ownDetail.body).toMatchObject({ canConfirm: false, report: { id: ownReport.id, user_name: '李四' } });
    expect(ownDetail.body.companies.map((company: { id: string }) => company.id)).toContain(outside.id);
    const weekly = await request(`/workspace/weekly-reports?companyId=${outside.id}`, employee);
    expect(weekly.body.reports.map((report: { id: string }) => report.id)).toEqual([ownWeekly.id]);
    expect((await request(`/workspace/weekly-reports/${ownWeekly.id}?view=team`, lead)).body.canFeedback).toBe(true);
    expect((await request(`/workspace/weekly-reports/${ownWeekly.id}`, employee)).body.canFeedback).toBe(false);
    expect((await request(`/workspace/crm/companies/${outside.id}/followups`, employee, 'POST', { content: '试图关联他人原文', sourceReportId: 'private-daily' })).status).toBe(403);
    // A company name in prose does not create an implicit relationship.
    const unrelated = store.saveCompany({ name: ownReport.summary!.slice(0, 40), ownerId: 'e002' }, 'poc-admin');
    expect((await request(`/workspace/crm/companies/${unrelated.id}`, employee)).body.workRecords.reports).toEqual([]);
  });

  it('资料只按明确关联授权，停用后隐藏原文及历史快照，但管理员保留审计', async () => {
    const { request, portal, store, db } = await setup(), employee = await portal('e002');
    const own = store.companies().find((company) => company.ownerId === 'e002')!;
    const other = store.companies().find((company) => company.ownerId === 'e003')!;
    const knowledge = (id: string) => repo.createKnowledgeEntry(db, { id, kind: 'park_material', title: `资料-${id}`, summary: '',
      content: `SECRET-CONTENT-${id}`, tags_json: '[]', source_name: '', created_at: at, updated_at: at });
    knowledge('allowed'); knowledge('unrelated');
    store.link(own.id, { knowledgeId: 'allowed' }, 'poc-admin');
    store.link(other.id, { knowledgeId: 'unrelated' }, 'poc-admin');
    const visible = await request('/workspace/knowledge', employee);
    expect(visible.body.entries.map((entry: { id: string }) => entry.id)).toEqual(['allowed']);
    expect((await request(`/workspace/crm/companies/${own.id}/knowledge`, employee, 'POST', { knowledgeId: 'unrelated' })).status).toBe(403);
    db.prepare("UPDATE knowledge_entry SET active=0 WHERE id='allowed'").run();
    const hidden = await request(`/workspace/crm/companies/${own.id}`, employee);
    expect(hidden.body.links).toEqual([]);
    expect(JSON.stringify(hidden.body)).not.toContain('SECRET-CONTENT-allowed');
    expect(hidden.body.events.some((event: { kind: string }) => event.kind === 'knowledge_linked')).toBe(false);
    expect(JSON.stringify(hidden.body.events)).not.toContain('资料-allowed');
    expect(JSON.stringify((await request(`/admin/crm/companies/${own.id}`)).body)).toContain('SECRET-CONTENT-allowed');
  });
});

describe('门户授权和身份变动', () => {
  it('门户令牌一次性，演示身份选择必须显式demoMode且完整admin登录', async () => {
    const { request, portal, scopedSession } = await setup();
    const employee = await portal('e002');
    expect((await request('/demo/portal', null, 'POST', { userId: 'e001' })).status).toBe(401);
    expect((await request('/demo/portal', employee, 'POST', { userId: 'e001' })).status).toBe(403);
    expect((await request('/demo/portal', scopedSession('admin'), 'POST', { userId: 'e001' })).status).toBe(403);
    const entry = await request('/demo/portal', undefined, 'POST', { userId: 'e001' });
    expect(entry.status).toBe(200);
    expect(entry.body.route).toBe(`#/portal/${entry.body.portalToken}`);
    const exchange = await request('/portal-grants/exchange', null, 'POST', { token: entry.body.portalToken, userId: 'e003', role: 'admin' });
    expect(exchange.body.user).toMatchObject({ id: 'e001', role: 'team_lead' });
    expect((await request('/portal-grants/exchange', null, 'POST', { token: entry.body.portalToken })).status).toBe(401);
    const production = await setup(false);
    expect((await production.request('/session')).body.demoMode).toBe(false);
    expect((await production.request('/demo/portal', undefined, 'POST', { userId: 'e001' })).status).toBe(404);
  });

  it('角色变化永久撤销旧门户与未用授权；解绑、禁用和会话过期实时失效', async () => {
    const { request, portal, db, base } = await setup();
    const employee = await portal('e002');
    const unused = repo.issuePortalAccessGrant(db, 'e002', { baseUrl: base });
    expect((await request('/admin/users/e002', undefined, 'PUT', { role: 'team_lead', managerUserId: 'e001' })).status).toBe(200);
    expect((await request('/session', employee)).status).toBe(401);
    expect((await request('/portal-grants/exchange', null, 'POST', { token: unused.token })).status).toBe(401);
    expect((await request('/admin/users/e002', undefined, 'PUT', { role: 'employee', managerUserId: 'e001' })).status).toBe(200);
    expect((await request('/session', employee)).status).toBe(401);
    const fresh = await portal('e002');
    expect((await request('/admin/users/e002/unbind', undefined, 'POST', {})).status).toBe(200);
    expect((await request('/session', fresh)).status).toBe(401);
    const outside = await portal('e003');
    db.prepare("UPDATE app_user SET active=0 WHERE id='e003'").run();
    expect((await request('/workspace', outside)).status).toBe(401);
    const lead = await portal('e001');
    db.prepare("UPDATE auth_session SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id='e001'").run();
    expect((await request('/workspace', lead)).status).toBe(401);
  });

  it('直属关系变化立即改变团队数据，无须重登；管理者主动撤销入口后会话失效', async () => {
    const { request, portal } = await setup(), lead = await portal('e001');
    expect((await request('/workspace?view=team', lead)).body.users).toHaveLength(2);
    expect((await request('/admin/users/e002', undefined, 'PUT', { role: 'employee', managerUserId: 'manager' })).status).toBe(200);
    expect((await request('/workspace?view=team', lead)).body.users.map((user: { id: string }) => user.id)).toEqual(['e001']);
    expect((await request('/workspace/records?view=team&userId=e002', lead)).status).toBe(403);
    expect((await request('/admin/users/e001/portal-access/revoke', undefined, 'POST', {})).status).toBe(200);
    expect((await request('/workspace', lead)).status).toBe(401);
  });

  it('并发兑换只有一条会话成功；角色变更审计失败会回滚角色与授权撤销', async () => {
    const { request, db, base, portal } = await setup();
    const grant = repo.issuePortalAccessGrant(db, 'e002', { baseUrl: base });
    const responses = await Promise.all([1, 2].map(() => request('/portal-grants/exchange', null, 'POST', { token: grant.token })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const employee = await portal('e002');
    db.exec("CREATE TRIGGER test_assignment_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='admin.user_assignment_updated' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END");
    expect((await request('/admin/users/e002', undefined, 'PUT', { role: 'team_lead', managerUserId: 'e001' })).status).toBe(400);
    expect(repo.getUser(db, 'e002')!.role).toBe('employee');
    expect((await request('/session', employee)).status).toBe(200);
    expect((await request('/admin/users/missing/portal-access/revoke', undefined, 'POST', {})).status).toBe(404);
  });
});
