import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { CrmError, CrmStore, DEFAULT_CRM_STAGES, seedCrmDemo } from './crm';
import { createKnowledgeEntry, insertDailyReport, updateDailyReportStatus, updateKnowledgeEntry, upsertUser } from './repository';

const databases: Db[] = [];
const actor = 'crm-admin';
const at = '2026-09-04T08:00:00.000Z';

function setup() {
  const db = openDb(':memory:');
  databases.push(db);
  upsertUser(db, { id: actor, name: '测试管理员', role: 'admin' });
  upsertUser(db, { id: 'employee', name: '测试员工' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', '隔离测试企业', at);
  upsertUser(db, { id: 'other-employee', name: '其他租户员工', tenant_id: 'other' });
  return { db, store: new CrmStore(db), other: new CrmStore(db, 'other') };
}

function errorStatus(action: () => unknown, status: number): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CrmError);
  expect(failure).toMatchObject({ status });
}

function counts(db: Db) {
  return ['crm_company', 'crm_record', 'crm_event', 'audit_log'].map((table) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function report(db: Db, id: string, status: 'confirmed' | 'pending_confirmation' | 'superseded', tenant = 'poc') {
  insertDailyReport(db, { id, tenant_id: tenant, user_id: tenant === 'poc' ? 'employee' : 'other-employee',
    report_date: '2026-09-04', version: Number(id.replace(/\D/g, '')) || 1, status,
    summary: `原始日报:${id}`, progress_json: '[]', confirmed_at: status === 'confirmed' ? at : null, created_at: at });
}

function knowledge(db: Db, id = 'knowledge-1', tenant = 'poc') {
  return createKnowledgeEntry(db, { id, tenant_id: tenant, kind: 'park_material', title: '园区资料',
    content: '版本一原文', summary: '资料摘要', tags_json: '[]', source_name: '测试资料', created_at: at, updated_at: at });
}

afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('企业档案、事项及留痕', () => {
  it('企业新增、部分修改、归档及恢复保留原档案、事项和事件', () => {
    const { db, store } = setup();
    const company = store.saveCompany({ name: '测试企业', ownerId: 'employee', aliases: ['简称', '简称'], industry: '服务业' }, actor);
    expect(company).toMatchObject({ name: '测试企业', version: 1, aliases: ['简称'], isDemo: false, archived: false });
    const record = store.saveRecord(company.id, 'project', { title: '入驻项目' }, actor);
    const changed = store.saveCompany({ version: 1, summary: '更新诉求', reason: '电话核实' }, actor, company.id);
    expect(changed).toMatchObject({ version: 2, name: '测试企业', industry: '服务业', summary: '更新诉求' });
    const archived = store.saveCompany({ version: 2, archived: true, reason: '停止服务' }, actor, company.id);
    expect(archived).toMatchObject({ archived: true, version: 3 });
    expect(store.detail(company.id).records[0].id).toBe(record.id);
    expect(() => store.followup(company.id, { content: '归档后新增' }, actor)).toThrow('归档');
    expect(() => store.saveRecord(company.id, 'service', { title: '新服务' }, actor)).toThrow('归档');
    const restored = store.saveCompany({ version: 3, archived: false, reason: '恢复服务' }, actor, company.id);
    expect(restored).toMatchObject({ archived: false, version: 4 });
    expect(store.detail(company.id).events).toHaveLength(5);
    expect((db.prepare('SELECT COUNT(*) AS n FROM crm_company').get() as { n: number }).n).toBe(1);
  });

  it('规范化同名会冲突但不合并，其他租户可以维护同名档案', () => {
    const { store, other } = setup();
    const original = store.saveCompany({ name: 'ＡＢＣ 企业', summary: '不可被覆盖' }, actor);
    errorStatus(() => store.saveCompany({ name: 'abc企业', summary: '同名新信息' }, actor), 409);
    expect(store.companies()).toHaveLength(1);
    expect(store.detail(original.id).company.summary).toBe('不可被覆盖');
    expect(other.saveCompany({ name: 'ABC企业' }, 'other-employee').name).toBe('ABC企业');
    errorStatus(() => other.detail(original.id), 404);
  });

  it('档案和事项都拒绝陈旧版本，修改必须填写理由且失败无附带写入', () => {
    const { db, store } = setup();
    const company = store.saveCompany({ name: '并发测试' }, actor);
    store.saveCompany({ version: 1, summary: '第一位编辑', reason: '核实' }, actor, company.id);
    const before = counts(db);
    errorStatus(() => store.saveCompany({ version: 1, summary: '陈旧覆盖', reason: '陈旧页面' }, actor, company.id), 409);
    errorStatus(() => store.saveCompany({ version: 2, summary: '没有理由' }, actor, company.id), 400);
    expect(counts(db)).toEqual(before);
    const project = store.saveRecord(company.id, 'project', { title: '项目' }, actor);
    const changed = store.saveRecord(company.id, 'project', { version: 1, stageId: 'needs', reason: '需求确认' }, actor, project.id);
    expect(changed).toMatchObject({ stageId: 'needs', version: 2 });
    errorStatus(() => store.saveRecord(company.id, 'project', { version: 1, stageId: 'landed', reason: '陈旧覆盖' }, actor, project.id), 409);
    expect(store.records(company.id)[0].stageId).toBe('needs');
  });

  it('项目阶段受配置约束，服务结案必须保留处理结果', () => {
    const { db, store } = setup();
    const company = store.saveCompany({ name: '服务企业' }, actor);
    errorStatus(() => store.saveRecord(company.id, 'project', { title: '项目', stageId: 'invented-stage' }, actor), 400);
    const project = store.saveRecord(company.id, 'project', { title: '项目', stageId: 'landed' }, actor);
    expect(project.stageId).toBe('landed');
    const before = counts(db);
    errorStatus(() => store.saveRecord(company.id, 'service', { title: '人才服务', status: 'resolved', outcome: '  ' }, actor), 400);
    expect(counts(db)).toEqual(before);
    const service = store.saveRecord(company.id, 'service', { title: '人才服务', status: 'working' }, actor);
    errorStatus(() => store.saveRecord(company.id, 'service', { version: 1, status: 'resolved', reason: '处理结束' }, actor, service.id), 400);
    const closed = store.saveRecord(company.id, 'service', { version: 1, status: 'resolved', outcome: '已协助完成材料提交', reason: '员工确认完成' }, actor, service.id);
    expect(closed).toMatchObject({ status: 'resolved', outcome: '已协助完成材料提交', version: 2 });
    errorStatus(() => store.saveRecord(company.id, 'service', { version: 1, status: 'working', reason: '陈旧页面' }, actor, service.id), 409);
  });

  it('负责人和关联事项不能越租户或越企业，停用负责人不接受新分配', () => {
    const { db, store, other } = setup();
    errorStatus(() => store.saveCompany({ name: '不合法负责人', ownerId: 'other-employee' }, actor), 400);
    db.prepare("UPDATE app_user SET active=0 WHERE id='employee'").run();
    errorStatus(() => store.saveCompany({ name: '停用负责人', ownerId: 'employee' }, actor), 400);
    const one = store.saveCompany({ name: '企业一' }, actor);
    const two = store.saveCompany({ name: '企业二' }, actor);
    const item = store.saveRecord(one.id, 'project', { title: '企业一项目' }, actor);
    errorStatus(() => store.followup(two.id, { content: '跟进', recordId: item.id }, actor), 400);
    errorStatus(() => store.saveRecord(two.id, 'project', { version: 1, title: '冒用项目', reason: '修改' }, actor, item.id), 404);
    errorStatus(() => other.saveRecord(one.id, 'project', { title: '跨租户项目' }, 'other-employee'), 404);
  });

  it('参数化保存名称和备注，注入文本不会改变查询或删除业务表', () => {
    const { db, store } = setup();
    const hostile = "'; DROP TABLE crm_company; --";
    const company = store.saveCompany({ name: hostile, summary: '<script>alert(1)</script>' }, actor);
    store.followup(company.id, { content: hostile, type: 'call' }, actor);
    expect(store.detail(company.id).company.name).toBe(hostile);
    errorStatus(() => store.detail("' OR 1=1 --"), 404);
    expect((db.prepare('SELECT COUNT(*) AS n FROM crm_company').get() as { n: number }).n).toBe(1);
  });
});

describe('来源、知识快照与事务边界', () => {
  it('只接受本租户有效已确认日报，失败的来源关联不会留下半条业务记录', () => {
    const { db, store } = setup();
    report(db, 'pending-1', 'pending_confirmation');
    report(db, 'retired-2', 'superseded');
    report(db, 'other-3', 'confirmed', 'other');
    report(db, 'valid-4', 'confirmed');
    for (const sourceReportId of ['pending-1', 'retired-2', 'other-3', 'missing']) {
      const before = counts(db);
      expect(() => store.saveCompany({ name: `拒绝来源-${sourceReportId}`, sourceReportId }, actor)).toThrow('已确认且有效');
      expect(counts(db)).toEqual(before);
    }
    const company = store.saveCompany({ name: '有来源企业', sourceReportId: 'valid-4' }, actor);
    expect(store.detail(company.id).events[0].source_report_id).toBe('valid-4');
    expect(store.reports().map((row) => row.id)).toEqual(['valid-4']);
    const before = counts(db);
    expect(() => store.saveRecord(company.id, 'project', { title: '来源不合法项目', sourceReportId: 'pending-1' }, actor)).toThrow('已确认且有效');
    expect(() => store.followup(company.id, { content: '来源不合法跟进', sourceReportId: 'other-3' }, actor)).toThrow('已确认且有效');
    expect(counts(db)).toEqual(before);
    updateDailyReportStatus(db, 'valid-4', 'superseded');
    expect(store.reports()).toHaveLength(0);
    expect(store.detail(company.id).events[0].source_report_id).toBe('valid-4');
    expect(() => store.followup(company.id, { content: '重复使用退役来源', sourceReportId: 'valid-4' }, actor)).toThrow('已确认且有效');
  });

  it('未来/非法发生日期被拒绝并回滚，但未来下一步截止日期允许', () => {
    const { db, store } = setup();
    const beforeCreate = counts(db);
    expect(() => store.saveCompany({ name: '未来事实', occurredOn: '2999-01-01' }, actor)).toThrow('未来');
    expect(counts(db)).toEqual(beforeCreate);
    const company = store.saveCompany({ name: '计划企业', nextDate: '2999-01-01' }, actor);
    const before = counts(db);
    expect(() => store.saveRecord(company.id, 'service', { title: '未来已发生服务', occurredOn: '2999-01-01' }, actor)).toThrow('未来');
    expect(() => store.followup(company.id, { content: '未来跟进', occurredOn: '2999-01-01' }, actor)).toThrow('未来');
    expect(() => store.followup(company.id, { content: '非法日期', occurredOn: '2026-02-30' }, actor)).toThrow('日期无效');
    expect(counts(db)).toEqual(before);
    store.followup(company.id, { content: '已电话沟通', dueDate: '2999-01-01' }, actor);
    expect(store.detail(company.id).events).toHaveLength(2);
  });

  it('知识关联保留当时版本，重关联新版仍可从事件回溯旧内容', () => {
    const { db, store } = setup();
    const company = store.saveCompany({ name: '资料企业' }, actor);
    const first = knowledge(db);
    store.link(company.id, { knowledgeId: first.id }, actor);
    const updated = updateKnowledgeEntry(db, first.id, 1, { ...first, content: '版本二原文' }, '2026-09-05T08:00:00.000Z')!;
    const beforeRelink = store.detail(company.id).links[0];
    expect(JSON.parse(String(beforeRelink.snapshot_json))).toMatchObject({ content: '版本一原文', version: 1 });
    expect(beforeRelink.current_version).toBe(2);
    store.link(company.id, { knowledgeId: updated.id }, actor);
    expect(JSON.parse(String(store.detail(company.id).links[0].snapshot_json))).toMatchObject({ content: '版本二原文', version: 2 });
    expect(JSON.stringify(store.detail(company.id).events)).toContain('版本一原文');
  });

  it('不允许关联其他租户或停用资料，归档企业需恢复后才可新增关联', () => {
    const { db, store } = setup();
    const company = store.saveCompany({ name: '资料权限企业' }, actor);
    const allowed = knowledge(db);
    knowledge(db, 'other-knowledge', 'other');
    const disabled = knowledge(db, 'disabled');
    db.prepare('UPDATE knowledge_entry SET active=0 WHERE id=?').run(disabled.id);
    expect(() => store.link(company.id, { knowledgeId: 'other-knowledge' }, actor)).toThrow('资料不存在');
    expect(() => store.link(company.id, { knowledgeId: disabled.id }, actor)).toThrow('已停用');
    store.saveCompany({ version: company.version, archived: true, reason: '归档' }, actor, company.id);
    expect(() => store.link(company.id, { knowledgeId: allowed.id }, actor)).toThrow('归档');
  });

  it('事件或审计写入失败时档案、项目和资料关联完整回滚', () => {
    const { db, store } = setup();
    const company = store.saveCompany({ name: '回滚企业' }, actor);
    const entry = knowledge(db);
    const before = counts(db);
    db.exec(`CREATE TRIGGER test_crm_audit_failure BEFORE INSERT ON audit_log
      WHEN NEW.action LIKE 'crm.%' BEGIN SELECT RAISE(ABORT, '模拟审计故障'); END;`);
    expect(() => store.saveCompany({ version: 1, name: '不该生效', reason: '变更' }, actor, company.id)).toThrow('模拟审计故障');
    expect(() => store.saveRecord(company.id, 'project', { title: '不该留下项目' }, actor)).toThrow('模拟审计故障');
    expect(() => store.link(company.id, { knowledgeId: entry.id }, actor)).toThrow('模拟审计故障');
    expect(store.detail(company.id).company).toMatchObject({ name: '回滚企业', version: 1 });
    expect(store.detail(company.id).links).toHaveLength(0);
    expect(counts(db)).toEqual(before);
  });
});

describe('阶段配置与演示数据', () => {
  it('阶段可改名/重排/新增，稳定ID和结果语义不变，重建Store不重置配置', () => {
    const { db, store } = setup();
    const previous = store.stages();
    const requested = [...previous].reverse().map((stage) => ({ ...stage, label: stage.id === 'lead' ? '新的接洽名称' : stage.label }));
    requested.push({ id: 'review', label: '内部评审', outcome: 'open', position: requested.length });
    const changed = store.saveStages({ previousStages: previous, stages: requested }, actor);
    expect(changed.find((stage) => stage.id === 'lead')?.label).toBe('新的接洽名称');
    expect(new CrmStore(db).stages()).toEqual(changed);
    errorStatus(() => store.saveStages({ previousStages: previous, stages: requested }, actor), 409);
    expect(() => store.saveStages({ previousStages: changed, stages: changed.filter((stage) => stage.id !== 'lead') }, actor)).toThrow('不可删除');
    expect(() => store.saveStages({ previousStages: changed, stages: changed.map((stage) => stage.id === 'landed' ? { ...stage, outcome: 'lost' } : stage) }, actor)).toThrow('结果类型');
    expect(store.stages()).toEqual(changed);
  });

  it('阶段非法ID、重复名称与审计失败不改变既有配置', () => {
    const { db, store } = setup();
    const original = store.stages();
    expect(() => store.saveStages({ previousStages: original, stages: [...original, { id: 'bad; DROP TABLE', label: '非法', outcome: 'open' }] }, actor)).toThrow('无效');
    expect(() => store.saveStages({ previousStages: original, stages: [...original, { id: 'duplicate_name', label: original[0].label, outcome: 'open' }] }, actor)).toThrow('重复');
    db.exec(`CREATE TRIGGER test_stage_audit_failure BEFORE INSERT ON audit_log
      WHEN NEW.action='crm.stages_updated' BEGIN SELECT RAISE(ABORT, '阶段审计故障'); END;`);
    expect(() => store.saveStages({ previousStages: original, stages: original.map((stage) => ({ ...stage, label: `${stage.label}新` })) }, actor)).toThrow('阶段审计故障');
    expect(store.stages()).toEqual(original);
  });

  it('普通构造只初始化阶段不注入演示企业；显式demo种子带标识且不重复', () => {
    const { store } = setup();
    expect(store.companies()).toHaveLength(0);
    expect(store.stages()).toHaveLength(DEFAULT_CRM_STAGES.length);
    seedCrmDemo(store);
    expect(store.companies()).toHaveLength(3);
    expect(store.companies().every((company) => company.isDemo)).toBe(true);
    seedCrmDemo(store);
    expect(store.companies()).toHaveLength(3);
  });
});
