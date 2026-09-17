import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { CrmStore } from './crm';
import { createKnowledgeEntry, insertDailyReport, upsertUser } from './repository';
import type { AccessActor } from './access';
import { searchBusinessMemory } from './business-memory';

const at = '2026-09-05T00:00:00.000Z';
const databases: Db[] = [];
const employee: AccessActor = { userId: 'employee', role: 'employee' };
const manager: AccessActor = { userId: 'manager', role: 'dept_head' };
const admin: AccessActor = { userId: 'admin', role: 'admin' };
function setup() {
  const db = openDb(':memory:'); databases.push(db);
  upsertUser(db, { id: 'admin', role: 'admin' });
  upsertUser(db, { id: 'manager', role: 'dept_head' });
  upsertUser(db, { id: 'lead', role: 'team_lead', manager_user_id: 'manager' });
  upsertUser(db, { id: 'employee', manager_user_id: 'lead' });
  upsertUser(db, { id: 'coworker' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', '其他租户', at);
  upsertUser(db, { id: 'foreign-user', tenant_id: 'other' });
  const crm = new CrmStore(db), foreignCrm = new CrmStore(db, 'other');
  const mine = crm.saveCompany({ name: 'A企业', ownerId: 'employee', collaboratorIds: ['coworker'] }, 'admin');
  const outside = crm.saveCompany({ name: 'B企业', ownerId: 'coworker' }, 'admin');
  const foreign = foreignCrm.saveCompany({ name: 'A企业', ownerId: 'foreign-user' }, 'foreign-user');
  return { db, mine, outside, foreign };
}
function daily(db: Db, id: string, owner = 'employee', status: 'confirmed' | 'pending_confirmation' | 'superseded' = 'confirmed', date = '2026-09-04', version = 1, content = `A企业已记录事实：${id}`, tenant = 'poc') {
  insertDailyReport(db, { id, tenant_id: tenant, user_id: owner, report_date: date, version, status,
    summary: content, progress_json: '{"secret":"不得作为记忆返回的隐藏字段"}', confirmed_at: status === 'confirmed' ? at : null, created_at: at });
}
function event(db: Db, id: string, company: string, options: { content?: string; date?: string; sourceId?: string; kind?: string; details?: unknown; tenant?: string } = {}) {
  db.prepare(`INSERT INTO crm_event(id,tenant_id,company_id,kind,actor_id,content,occurred_on,source_report_id,details_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, options.tenant ?? 'poc', company, options.kind ?? 'followup', 'admin', options.content ?? `A企业跟进记录：${id}`,
    options.date ?? '2026-09-04', options.sourceId ?? null, JSON.stringify(options.details ?? {}), at);
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('获授权且可追溯的业务事实检索', () => {
  it('知识撤权或版本变化后，衍生日报及其CRM跟进不再进入二次检索，独立跟进仍可用', () => {
    const { db, mine } = setup();
    db.exec('CREATE TABLE generated_report_knowledge(tenant_id TEXT,report_kind TEXT,report_id TEXT,user_id TEXT,dependencies_json TEXT,created_at TEXT)');
    createKnowledgeEntry(db, { id: 'used-knowledge', kind: 'park_material', title: '园区资料', summary: '', content: '原始园区资料', tags_json: '[]', source_name: '', created_at: at, updated_at: at });
    new CrmStore(db).link(mine.id, { knowledgeId: 'used-knowledge' }, 'admin');
    daily(db, 'derived'); event(db, 'derived-followup', mine.id, { sourceId: 'derived' }); event(db, 'independent', mine.id);
    db.prepare('INSERT INTO generated_report_knowledge VALUES(?,?,?,?,?,?)').run('poc', 'daily', 'derived', 'employee', '[{"id":"used-knowledge","version":1}]', at);
    expect(searchBusinessMemory(db, employee, { query: 'A企业' }).items.map(row => row.sourceId).sort()).toEqual(['derived', 'derived-followup', 'independent']);
    db.prepare("UPDATE knowledge_entry SET version=2 WHERE id='used-knowledge'").run();
    expect(searchBusinessMemory(db, employee, { query: 'A企业' }).items.map(row => row.sourceId)).toEqual(['independent']);
    expect(searchBusinessMemory(db, manager, { query: 'A企业' }).items.map(row => row.sourceId)).toEqual(['independent']);
    db.prepare("UPDATE knowledge_entry SET version=1,active=0 WHERE id='used-knowledge'").run();
    expect(searchBusinessMemory(db, employee, { query: 'A企业' }).items.map(row => row.sourceId)).toEqual(['independent']);
  });

  it('撤权新报告及其跟进不占结果配额，旧授权记录仍可检索，内部owner元数据不外泄', () => {
    const { db, mine } = setup();
    db.exec('CREATE TABLE generated_report_knowledge(tenant_id TEXT,report_kind TEXT,report_id TEXT,user_id TEXT,dependencies_json TEXT,created_at TEXT)');
    daily(db, 'revoked'); daily(db, 'legacy-old', 'employee', 'confirmed', '2020-01-01'); event(db, 'independent-old', mine.id, { date: '2019-01-01' });
    db.prepare('INSERT INTO generated_report_knowledge VALUES(?,?,?,?,?,?)').run('poc', 'daily', 'revoked', 'employee', '[{"id":"missing","version":1}]', at);
    for (let index = 0; index < 30; index++) event(db, `blocked-${index}`, mine.id, { sourceId: 'revoked' });
    const result = searchBusinessMemory(db, employee, { query: 'A企业', limit: 2 });
    expect(result.items.map(row => row.sourceId)).toEqual(['legacy-old', 'independent-old']);
    expect(JSON.stringify(result)).not.toMatch(/ownerUserId|derivedReportId|blocked-|revoked/);
  });

  it('空白/过长查询、日期无效及倒置范围不返回默认全量记忆', () => {
    const { db, mine } = setup(); event(db, 'e1', mine.id); daily(db, 'd1');
    for (const query of ['', '   ', 'A'.repeat(161)]) expect(searchBusinessMemory(db, employee, { query }).items).toEqual([]);
    expect(searchBusinessMemory(db, employee, { query: 'A企业', fromDate: '2026-02-30' }).items).toEqual([]);
    expect(searchBusinessMemory(db, employee, { query: 'A企业', fromDate: '2026-09-05', toDate: '2026-09-01' }).items).toEqual([]);
    expect(searchBusinessMemory(db, employee, { query: '%' }).items).toEqual([]);
  });

  it('只返回明确跟进文本与有效确认日报，不返回草稿、已替代版本或任意JSON快照', () => {
    const { db, mine } = setup();
    daily(db, 'confirmed'); daily(db, 'pending', 'employee', 'pending_confirmation', '2026-09-05');
    daily(db, 'superseded', 'employee', 'superseded', '2026-09-03');
    event(db, 'followup', mine.id, { details: { snapshot: { content: '机密知识快照' }, source_summary: '他人的机密日报' } });
    event(db, 'knowledge-event', mine.id, { kind: 'knowledge_linked', content: 'A企业机密知识快照', details: { snapshot: '机密' } });
    const result = searchBusinessMemory(db, employee, { query: 'A企业' });
    expect(result.items.map((item) => item.sourceId).sort()).toEqual(['confirmed', 'followup']);
    expect(result.items.find((item) => item.sourceId === 'confirmed')).toEqual({ sourceId: 'confirmed', sourceType: 'confirmed_daily', date: '2026-09-04', version: 1, content: 'A企业已记录事实：confirmed' });
    expect(JSON.stringify(result)).not.toMatch(/机密|隐藏字段|details_json|progress_json/);
  });

  it('共享企业允许共享独立跟进，但不开放同事日报或从同事日报衍生的跟进', () => {
    const { db, mine } = setup();
    daily(db, 'mine'); daily(db, 'coworker-daily', 'coworker');
    event(db, 'shared-followup', mine.id);
    event(db, 'private-derived', mine.id, { sourceId: 'coworker-daily', content: 'A企业：复制的同事日报内容' });
    const ids = searchBusinessMemory(db, employee, { query: 'A企业' }).items.map((item) => item.sourceId);
    expect(ids).toContain('shared-followup'); expect(ids).toContain('mine');
    expect(ids).not.toContain('coworker-daily'); expect(ids).not.toContain('private-derived');
  });

  it('主管沿汇报树读取本人和下级已确认日报，不能读取旁系员工', () => {
    const { db } = setup();
    daily(db, 'own', 'manager'); daily(db, 'lead', 'lead'); daily(db, 'member', 'employee'); daily(db, 'outside', 'coworker');
    expect(searchBusinessMemory(db, manager, { query: 'A企业' }).items.map((item) => item.sourceId).sort()).toEqual(['lead', 'member', 'own']);
  });

  it('跨租户、停用、角色变更与分享会话均不能读取历史记忆', () => {
    const { db, foreign } = setup();
    daily(db, 'mine'); daily(db, 'foreign', 'foreign-user', 'confirmed', '2026-09-04', 1, 'A企业其他租户机密', 'other');
    event(db, 'foreign-event', foreign.id, { tenant: 'other' });
    expect(searchBusinessMemory(db, employee, { query: 'A企业' }).items.map((item) => item.sourceId)).toEqual(['mine']);
    expect(searchBusinessMemory(db, { ...employee, tenantId: 'other' }, { query: 'A企业' }).items).toEqual([]);
    expect(searchBusinessMemory(db, { ...employee, role: 'admin' }, { query: 'A企业' }).items).toEqual([]);
    expect(searchBusinessMemory(db, { ...admin, resourceId: 'a-report' }, { query: 'A企业' }).items).toEqual([]);
    db.prepare('UPDATE app_user SET active=0 WHERE id=?').run('employee');
    expect(searchBusinessMemory(db, employee, { query: 'A企业' }).items).toEqual([]);
  });

  it('企业与日期过滤同时生效，无权企业不会降级为搜索其他全部内容', () => {
    const { db, mine, outside } = setup();
    daily(db, 'linked'); daily(db, 'unlinked', 'employee', 'confirmed', '2026-09-03');
    event(db, 'linked-event', mine.id, { sourceId: 'linked' });
    event(db, 'old-event', mine.id, { date: '2026-09-02' });
    event(db, 'outside-event', outside.id);
    const result = searchBusinessMemory(db, employee, { query: 'A企业', companyId: mine.id, fromDate: '2026-09-04', toDate: '2026-09-04' });
    expect(result.items.map((item) => item.sourceId).sort()).toEqual(['linked', 'linked-event']);
    expect(searchBusinessMemory(db, employee, { query: 'A企业', companyId: outside.id }).items).toEqual([]);
    expect(searchBusinessMemory(db, employee, { query: 'A企业', companyId: 'nonexistent' }).items).toEqual([]);
  });

  it('关联草稿、旧版本日报及伪造跨租户source_report_id的跟进不进入事实记忆', () => {
    const { db, mine } = setup();
    daily(db, 'pending', 'employee', 'pending_confirmation');
    daily(db, 'old', 'employee', 'confirmed', '2026-09-03', 1);
    daily(db, 'new', 'employee', 'confirmed', '2026-09-03', 2);
    daily(db, 'foreign', 'foreign-user', 'confirmed', '2026-09-04', 1, 'A企业其他租户', 'other');
    event(db, 'pending-derived', mine.id, { sourceId: 'pending' });
    event(db, 'old-derived', mine.id, { sourceId: 'old' });
    event(db, 'foreign-derived', mine.id, { sourceId: 'foreign' });
    expect(searchBusinessMemory(db, employee, { query: 'A企业' }).items.map((item) => item.sourceId)).toEqual(['new']);
  });

  it('条数与总字符数有硬上限，单来源截断保留检索词附近证据', () => {
    const { db, mine } = setup();
    for (let index = 0; index < 30; index++) event(db, `followup-${index}`, mine.id, { content: '前文'.repeat(1000) + '关键检索词：有明确进展' + '后文'.repeat(1000) });
    const bounded = searchBusinessMemory(db, employee, { query: '关键检索词', limit: 999, maxChars: 999999 });
    expect(bounded.items.length).toBeLessThanOrEqual(20);
    expect(bounded.items.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(12000);
    expect(bounded.items.every((item) => item.content.length <= 1500)).toBe(true);
    expect(bounded.items[0].content).toContain('关键检索词');
    expect(bounded.truncated).toBe(true);
    const tiny = searchBusinessMemory(db, employee, { query: '关键检索词', maxChars: 10 });
    expect(tiny.items.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(10);
  });

  it('查询先做权限过滤再限量，不被其他员工的大量新记录挤掉授权匹配', () => {
    const { db, mine, outside } = setup();
    event(db, 'readable-old', mine.id, { date: '2020-01-01' });
    for (let index = 0; index < 40; index++) event(db, `unreadable-${index}`, outside.id);
    expect(searchBusinessMemory(db, employee, { query: 'A企业', limit: 1 }).items.map((item) => item.sourceId)).toEqual(['readable-old']);
  });

  it('长期已确认事实可以显式检索，查询不写入任何记忆、偏好或业务记录', () => {
    const { db } = setup();
    daily(db, 'archive', 'employee', 'confirmed', '2019-01-01', 1, 'A企业历史确认记录');
    const before = db.prepare('SELECT total_changes() AS count').get()?.count;
    const result = searchBusinessMemory(db, employee, { query: 'A企业', fromDate: '2019-01-01', toDate: '2019-12-31' });
    expect(result.items[0]).toMatchObject({ sourceId: 'archive', date: '2019-01-01', version: 1 });
    expect(db.prepare('SELECT total_changes() AS count').get()?.count).toBe(before);
  });

  it('主管个人视图不返回团队记忆，管理视图才沿授权汇报树展开', () => {
    const { db, mine } = setup(); daily(db, 'mine', 'manager'); daily(db, 'subordinate'); event(db, 'team-followup', mine.id);
    expect(searchBusinessMemory(db, manager, { query: 'A企业', view: 'personal' }).items.map((item) => item.sourceId)).toEqual(['mine']);
    expect(searchBusinessMemory(db, manager, { query: 'A企业', view: 'team' }).items.map((item) => item.sourceId).sort()).toEqual(['mine', 'subordinate', 'team-followup']);
    expect(searchBusinessMemory(db, manager, { query: 'A企业', view: 'personal', companyId: mine.id }).items).toEqual([]);
  });
});
