import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, type Agent, type AgentTaskRequest } from '@wecom/agent';
import { openDb, type Db } from '@wecom/persistence';
import { createKnowledgeEntry, getKnowledgeEntry, updateKnowledgeEntry, upsertUser } from '../../../packages/persistence/src/repository';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { DailyAssistantApp } from './app';

const at = '2026-09-05T00:00:00.000Z';
const databases: Db[] = [];
const matchingText = '今天核对本人资料、协作资料、他人资料、未关联资料、停用资料、管理员资料、外租户资料，命中标签。';

function setup() {
  const db = openDb(':memory:'); databases.push(db);
  const calls: AgentTaskRequest[] = [], mock = new MockAgent();
  const capture: Agent = { run: async (request) => { calls.push(structuredClone(request)); return mock.run(request); } };
  const app = new DailyAssistantApp(db, capture);
  upsertUser(db, { id: 'manager', role: 'team_lead' });
  upsertUser(db, { id: 'employee', manager_user_id: 'manager' });
  upsertUser(db, { id: 'other' });
  upsertUser(db, { id: 'admin', role: 'admin' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('foreign', '隔离租户', at);
  upsertUser(db, { id: 'foreign-user', tenant_id: 'foreign' });
  const crm = new CrmStore(db), foreignCrm = new CrmStore(db, 'foreign');
  const mine = crm.saveCompany({ name: '本人企业', ownerId: 'employee' }, 'admin');
  const shared = crm.saveCompany({ name: '协作企业', ownerId: 'other', collaboratorIds: ['employee'] }, 'admin');
  const outside = crm.saveCompany({ name: '他人企业', ownerId: 'other' }, 'admin');
  const adminCompany = crm.saveCompany({ name: '管理员本人企业', ownerId: 'admin' }, 'admin');
  const foreignCompany = foreignCrm.saveCompany({ name: '其他租户企业', ownerId: 'foreign-user' }, 'foreign-user');
  const entries = [
    { id: 'mine', title: '本人资料', company: mine.id },
    { id: 'shared', title: '协作资料', company: shared.id },
    { id: 'outside', title: '他人资料', company: outside.id },
    { id: 'unlinked', title: '未关联资料' },
    { id: 'disabled', title: '停用资料', company: mine.id },
    { id: 'admin-only', title: '管理员资料', company: adminCompany.id },
    { id: 'foreign', title: '外租户资料', company: foreignCompany.id, tenant: 'foreign' },
  ];
  for (const entry of entries) {
    createKnowledgeEntry(db, { id: entry.id, tenant_id: entry.tenant ?? 'poc', kind: 'service_company', title: entry.title,
      summary: `SUMMARY_${entry.id}`, content: `BODY_${entry.id}`, tags_json: '["命中标签"]', source_name: '测试文档', created_at: at, updated_at: at });
    if (entry.company) (entry.tenant === 'foreign' ? foreignCrm : crm).link(entry.company, { knowledgeId: entry.id }, entry.tenant === 'foreign' ? 'foreign-user' : 'admin');
  }
  db.prepare('UPDATE knowledge_entry SET active=0 WHERE id=?').run('disabled');
  return { db, app, calls, crm, mine, shared };
}
function latest(calls: AgentTaskRequest[], type: AgentTaskRequest['taskType']): AgentTaskRequest {
  const request = calls.filter((entry) => entry.taskType === type).at(-1);
  expect(request, `未捕获 ${type} 请求`).toBeDefined();
  return request!;
}
function knowledgeIds(request: AgentTaskRequest): string[] {
  return (request.context.knowledgeSnippets ?? []).map((entry) => entry.id).sort();
}
function confirm(app: DailyAssistantApp, owner: string, reportId: string): void {
  app.completeDailyPresentation(owner, app.prepareDailyPresentation(owner, reportId));
  app.confirmReport(owner, reportId, 'button');
}
function expectNoPrivatePayload(request: AgentTaskRequest): void {
  const serialized = JSON.stringify(request);
  for (const id of ['outside', 'unlinked', 'disabled', 'admin-only', 'foreign']) {
    expect(serialized).not.toContain(`BODY_${id}`);
    expect(serialized).not.toContain(`SUMMARY_${id}`);
  }
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('日报/周报实际Agent请求的知识边界', () => {
  it('日报先按本人企业ACL筛选，再做标题或标签命中，禁止敏感正文进入模型请求', async () => {
    const { app, calls } = setup();
    await app.submitRecord('employee', '2026-09-04', matchingText);
    const request = latest(calls, 'daily_record_extract');
    expect(knowledgeIds(request)).toEqual(['mine', 'shared']);
    expectNoPrivatePayload(request);
    expect(request.context.knowledgeSnippets?.every((item) => item.version === 1 && item.content.includes(`BODY_${item.id}`))).toBe(true);
  });

  it('即使只命中其他人员知识的标题/标签，也不会把未获授权资料交给模型', async () => {
    const { db, app, calls } = setup();
    db.prepare('UPDATE knowledge_entry SET tags_json=? WHERE id IN (?,?)').run('[]', 'mine', 'shared');
    await app.submitRecord('employee', '2026-09-04', '今天处理他人资料，命中标签。');
    const request = latest(calls, 'daily_record_extract');
    expect(knowledgeIds(request)).toEqual([]);
    expectNoPrivatePayload(request);
  });

  it('周报同样按报表本人范围取知识，而不是使用任务中的manager角色全库检索', async () => {
    const { app, calls } = setup();
    const id = await app.submitRecord('employee', '2026-09-04', matchingText);
    confirm(app, 'employee', id);
    await app.generateWeeklyReport('employee', '2026-08-31');
    const request = latest(calls, 'weekly_report_generate');
    expect(request.actor.userRef).toBe('employee');
    expect(knowledgeIds(request)).toEqual(['mine', 'shared']);
    expectNoPrivatePayload(request);
  });

  it('管理员的本人日报和周报不会因admin身份灌入全部知识', async () => {
    const { app, calls } = setup();
    const id = await app.submitRecord('admin', '2026-09-04', matchingText);
    const daily = latest(calls, 'daily_record_extract');
    expect(knowledgeIds(daily)).toEqual(['admin-only']);
    confirm(app, 'admin', id);
    await app.generateWeeklyReport('admin', '2026-08-31');
    expect(knowledgeIds(latest(calls, 'weekly_report_generate'))).toEqual(['admin-only']);
    expect(JSON.stringify(daily)).not.toContain('BODY_outside');
    expect(JSON.stringify(daily)).not.toContain('BODY_unlinked');
  });

  it('主管本人工作上下文不使用团队企业资料', async () => {
    const { app, calls } = setup();
    const id = await app.submitRecord('manager', '2026-09-04', matchingText);
    expect(knowledgeIds(latest(calls, 'daily_record_extract'))).toEqual([]);
    confirm(app, 'manager', id);
    await app.generateWeeklyReport('manager', '2026-08-31');
    expect(knowledgeIds(latest(calls, 'weekly_report_generate'))).toEqual([]);
  });

  it('知识停用、企业改派或移除协作关系后，后续日报和周报请求即时撤销片段', async () => {
    const { db, app, calls, crm, mine, shared } = setup();
    const id = await app.submitRecord('employee', '2026-09-03', matchingText);
    confirm(app, 'employee', id);
    db.prepare('UPDATE knowledge_entry SET active=0 WHERE id=?').run('mine');
    crm.saveCompany({ version: shared.version, collaboratorIds: [], reason: '收回测试协作授权' }, 'admin', shared.id);
    await app.submitRecord('employee', '2026-09-04', matchingText);
    expect(knowledgeIds(latest(calls, 'daily_record_extract'))).toEqual([]);
    const beforeWeekly=calls.filter(request=>request.taskType==='weekly_report_generate').length;
    // The confirmed September 3 summary was derived from the now-revoked
    // knowledge. Do not re-introduce that content through a source-record path.
    await expect(app.generateWeeklyReport('employee', '2026-08-31')).rejects.toThrow('权限或版本已变化');
    expect(calls.filter(request=>request.taskType==='weekly_report_generate')).toHaveLength(beforeWeekly);
    db.prepare('UPDATE knowledge_entry SET active=1 WHERE id=?').run('mine');
    crm.saveCompany({ version: mine.version, ownerId: 'other', reason: '企业重新分配测试' }, 'admin', mine.id);
    await app.submitRecord('employee', '2026-09-05', matchingText);
    expect(knowledgeIds(latest(calls, 'daily_record_extract'))).toEqual([]);
  });

  it('模型获得当前资料版本，而不是企业关联时保留的旧知识快照', async () => {
    const { db, app, calls } = setup();
    const original = getKnowledgeEntry(db, 'mine')!;
    updateKnowledgeEntry(db, 'mine', original.version, { ...original, content: '核验后的当前版本正文', summary: '新版摘要' }, '2026-09-05T01:00:00.000Z');
    await app.submitRecord('employee', '2026-09-04', matchingText);
    const snippet = latest(calls, 'daily_record_extract').context.knowledgeSnippets?.find((entry) => entry.id === 'mine');
    expect(snippet).toMatchObject({ version: 2 });
    expect(snippet?.content).toContain('核验后的当前版本正文');
    expect(snippet?.content).not.toContain('BODY_mine');
  });

  it('当日日报可整理尚未确认的原始消息，周报只读取已确认版本而非后来待确认草稿', async () => {
    const { app, calls } = setup();
    await app.submitRecord('employee', '2026-09-04', '当天第一条尚未确认的原始消息');
    const confirmed = await app.submitRecord('employee', '2026-09-04', '当天第二条待员工核对的原始消息');
    const beforeConfirm = latest(calls, 'daily_record_extract');
    expect(beforeConfirm.context.sourceRecords?.map((source) => source.text).join('\n')).toContain('第一条尚未确认');
    expect(beforeConfirm.context.sourceRecords?.map((source) => source.text).join('\n')).toContain('第二条待员工核对');
    confirm(app, 'employee', confirmed);
    const pending = await app.submitRecord('employee', '2026-09-04', '第三条新增待确认信息不得进入正式周报');
    await app.generateWeeklyReport('employee', '2026-08-31');
    const weekly = latest(calls, 'weekly_report_generate');
    expect(weekly.context.sourceRecords?.map((source) => source.id)).toEqual([confirmed]);
    expect(weekly.context.sourceRecords?.some((source) => source.id === pending)).toBe(false);
    expect(JSON.stringify(weekly.context.sourceRecords)).not.toContain('第三条新增待确认信息');
  });
});
