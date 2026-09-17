import { afterEach, describe, expect, it } from 'vitest';
import * as repo from '@wecom/persistence';
import type { AccessActor, Db, DailyReportRow } from '@wecom/persistence';
import { ensureProgressSchema, setItemMetric } from './progress-ledger';
import {
  abortWeeklyGeneration, captureWeeklySources, commitWeeklyGeneration, ensureWeeklyWorkflowSchema,
  getWeeklyDetail, getWeeklyInstance, saveWeeklyFeedback, saveWeeklyReason, startWeeklyGeneration, validateWeeklyId,
} from './weekly-workflow';

const week = '2026-08-31', time = new Date('2026-09-02T04:00:00.000Z');
const owner: AccessActor = { userId: 'employee', role: 'employee' };
const lead: AccessActor = { userId: 'lead', role: 'team_lead' };
const admin: AccessActor = { userId: 'admin', role: 'admin' };
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = repo.openDb(':memory:'); databases.push(db);
  repo.upsertUser(db, { id: 'admin', role: 'admin', name: '管理员' });
  repo.upsertUser(db, { id: 'lead', role: 'team_lead', manager_user_id: 'admin', name: '组长' });
  repo.upsertUser(db, { id: 'employee', role: 'employee', manager_user_id: 'lead', name: '员工' });
  repo.upsertUser(db, { id: 'outside', role: 'employee', name: '其他组员工' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', '另一租户', time.toISOString());
  repo.upsertUser(db, { id: 'foreign-user', tenant_id: 'other', role: 'employee' });
  repo.insertWorkItem(db, { id: 'item', user_id: 'employee', week_id: week, name: '走访企业', plan_background: '5家', deleted: 0, created_at: `${week}T04:00:00Z` });
  return db;
}
function daily(db: Db, id: string, date = week, version = 1, status: DailyReportRow['status'] = 'confirmed', user = 'employee', tenant = 'poc') {
  repo.insertDailyReport(db, { id, user_id: user, tenant_id: tenant, report_date: date, version, status, summary: `${id} 的原始摘要`,
    progress_json: JSON.stringify([{ workItemRef: 'item', progressText: '已走访企业A', progressValue: 20 }]),
    confirmed_at: status === 'confirmed' ? time.toISOString() : null, created_at: time.toISOString() });
}
function publish(db: Db, user = 'employee', selectedWeek = week, content = '整周工作总结') {
  const ticket = startWeeklyGeneration(db, user, selectedWeek, 'poc', time);
  return commitWeeklyGeneration(db, ticket, { content, sections: [{ title: '计划', body: '真实来源' }], progressSnapshot: { total: 20 } }, time);
}
function count(db: Db, table: string) { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n); }
function legacyReport(db: Db, id = 'legacy-week') {
  repo.insertWeeklyReport(db, { id, user_id: 'employee', week_id: week, template_version: '1', content: '旧版正文', missing_days_json: '[]', generated_at: time.toISOString() });
  return id;
}

describe('稳定周实例、来源与不可变版本', () => {
  it('只读空周使用确定性ID，但不创建实例、表或其他业务行', () => {
    const db = setup(), before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    const first = getWeeklyInstance(db, 'employee', week);
    expect(first).toMatchObject({ currentReportId: null, stale: false, legacy: false, generationRevision: 0 });
    expect(getWeeklyDetail(db, owner, 'employee', week, { history: true, now: time })).toMatchObject({ instance: first, history: [], currentReport: null });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='weekly_instance'").get()).toBeUndefined();
    expect(Number(db.prepare('SELECT total_changes() AS n').get()!.n)).toBe(before);
    const reportId = publish(db);
    expect(getWeeklyInstance(db, 'employee', week)).toMatchObject({ id: first.id, currentReportId: reportId });
  });

  it('同一员工同一周新版本复用实例，旧正文、证据和进度快照独立保留', () => {
    const db = setup(); daily(db, 'day-v1');
    const first = publish(db), instanceId = getWeeklyInstance(db, 'employee', week).id;
    repo.updateDailyReportStatus(db, 'day-v1', 'superseded'); daily(db, 'day-v2', week, 2);
    expect(getWeeklyInstance(db, 'employee', week).stale).toBe(true);
    const second = publish(db, 'employee', week, '修订后的周报');
    const detail = getWeeklyDetail(db, lead, 'employee', week, { history: true, now: time });
    expect(detail.instance).toMatchObject({ id: instanceId, currentReportId: second, stale: false });
    expect(detail.history?.map(row => row.id)).toEqual([second, first]);
    const previous = getWeeklyDetail(db, owner, 'employee', week, { reportId: first, now: time });
    expect(previous.currentReport?.content).toBe('整周工作总结');
    expect(previous.evidence?.snapshot?.confirmed.map(row => [row.id, row.status])).toEqual([['day-v1', 'confirmed']]);
    expect(previous.evidence?.progressSnapshot).toEqual({ total: 20 });
    expect(count(db, 'weekly_instance')).toBe(1);
    expect(() => db.prepare('UPDATE weekly_report SET content=? WHERE id=?').run('篡改', first)).toThrow('immutable');
    expect(() => db.prepare('DELETE FROM weekly_evidence WHERE report_id=?').run(first)).toThrow('immutable');
  });

  it('同日待确认新版不会撤下已确认事实，确认替换后才改变周报来源', () => {
    const db = setup(); daily(db, 'confirmed');
    const hash = captureWeeklySources(db, 'employee', week).fingerprint;
    daily(db, 'draft', week, 2, 'pending_confirmation');
    expect(captureWeeklySources(db, 'employee', week).fingerprint).toBe(hash);
    const first = publish(db);
    expect(JSON.parse(repo.getWeeklyReportById(db, first)!.cited_report_ids_json)).toEqual(['confirmed']);
    repo.updateDailyReportStatus(db, 'confirmed', 'superseded'); repo.updateDailyReportStatus(db, 'draft', 'confirmed', time.toISOString());
    expect(captureWeeklySources(db, 'employee', week).confirmed.map(row => row.id)).toEqual(['draft']);
    expect(getWeeklyInstance(db, 'employee', week).stale).toBe(true);
  });

  it('只引用本租户本人本周最高已确认版本，兼容旧库同日多个confirmed', () => {
    const db = setup(); daily(db, 'old'); daily(db, 'new', week, 2); daily(db, 'unconfirmed', '2026-09-01', 1, 'pending_confirmation');
    daily(db, 'outside-date', '2026-09-07'); daily(db, 'other-owner', week, 1, 'confirmed', 'outside'); daily(db, 'other-tenant', week, 1, 'confirmed', 'foreign-user', 'other');
    expect(captureWeeklySources(db, 'employee', week).confirmed.map(row => row.id)).toEqual(['new']);
  });

  it('旧周报只读不补写、不伪造来源，下一次生成续接原版本', () => {
    const db = setup(), old = legacyReport(db), before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    const detail = getWeeklyDetail(db, owner, 'employee', week, { reportId: old, now: time });
    expect(detail.instance).toMatchObject({ legacy: true, stale: true, currentReportId: old });
    expect(detail.evidence).toMatchObject({ legacy: true, sourceFingerprint: null, snapshot: null });
    expect(Number(db.prepare('SELECT total_changes() AS n').get()!.n)).toBe(before);
    const fresh = publish(db);
    expect(repo.getWeeklyReportById(db, fresh)?.version).toBe(2);
    expect(repo.getWeeklyReportById(db, old)?.content).toBe('旧版正文');
  });

  it.each(['2026-02-30', '2026-09-01', '2026-8-31', 'invalid'])('拒绝不真实或不是周一的周标识 %s', value => {
    expect(() => validateWeeklyId(value)).toThrow();
  });

  it('跨年自然周保留七天，今天未到期、未来不标缺报', () => {
    const db = setup(); daily(db, 'newyear', '2026-01-01');
    const detail = getWeeklyDetail(db, owner, 'employee', '2025-12-29', { now: new Date('2026-01-02T01:00:00Z') });
    expect(detail.days).toEqual([
      { date: '2025-12-29', state: 'missing' }, { date: '2025-12-30', state: 'missing' }, { date: '2025-12-31', state: 'missing' },
      { date: '2026-01-01', state: 'confirmed' }, { date: '2026-01-02', state: 'not_due' }, { date: '2026-01-03', state: 'future' }, { date: '2026-01-04', state: 'future' },
    ]);
  });

  it('缺报日期由系统计算，不采用调用方伪造的未来缺报', () => {
    const db = setup(); daily(db, 'monday');
    const ticket = startWeeklyGeneration(db, 'employee', week, 'poc', time);
    const id = commitWeeklyGeneration(db, ticket, { content: '周报', missingDays: ['2026-09-06', '2026-09-02'] }, time);
    expect(JSON.parse(repo.getWeeklyReportById(db, id)!.missing_days_json)).toEqual(['2026-09-01']);
    repo.setConfig(db, 'weekBoundary', 'work_week');
    expect(getWeeklyDetail(db, owner, 'employee', week, { now: time }).days).toHaveLength(5);
  });
});

describe('来源指纹、租约并发与失败原子性', () => {
  it.each(['daily', 'item', 'metric', 'reason', 'template', 'rules'])('%s 改变后旧生成结果拒绝发布并可重试', kind => {
    const db = setup(); daily(db, 'day');
    const ticket = startWeeklyGeneration(db, 'employee', week, 'poc', time);
    if (kind === 'daily') { repo.updateDailyReportStatus(db, 'day', 'superseded'); daily(db, 'corrected', week, 2); }
    if (kind === 'item') db.prepare('UPDATE work_item SET name=?,version=version+1 WHERE id=?').run('走访重点企业', 'item');
    if (kind === 'metric') setItemMetric(db, owner, 'item', { mode: 'count', total: 5, unit: '家', expectedVersion: 0 });
    if (kind === 'reason') saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, content: '设备维修导致延期', expectedVersion: 0 }, time);
    if (kind === 'template') repo.createTemplateVersion(db, { id: 'new-template', kind: 'weekly', name: '新模板', content: '{"sections":["结论"]}', created_at: time.toISOString() });
    if (kind === 'rules') repo.setConfig(db, 'weekBoundary', 'work_week');
    expect(() => commitWeeklyGeneration(db, ticket, { content: '过时的结果' }, time)).toThrow('来源已变更');
    expect(count(db, 'weekly_report')).toBe(0);
    expect(abortWeeklyGeneration(db, ticket, time)).toBe(true);
    expect(abortWeeklyGeneration(db, ticket, time)).toBe(false);
    expect(repo.getWeeklyReportById(db, publish(db))?.version).toBe(1);
  });

  it('后发先完成时旧结果和旧失败都不能覆盖或释放新请求', () => {
    const db = setup();
    const old = startWeeklyGeneration(db, 'employee', week, 'poc', time), fresh = startWeeklyGeneration(db, 'employee', week, 'poc', time);
    expect(abortWeeklyGeneration(db, old, time)).toBe(false);
    expect(() => commitWeeklyGeneration(db, old, { content: '旧结果' }, time)).toThrow('更新的生成请求');
    const id = commitWeeklyGeneration(db, fresh, { content: '新结果' }, time);
    expect(getWeeklyInstance(db, 'employee', week).currentReportId).toBe(id);
    expect(() => commitWeeklyGeneration(db, fresh, { content: '重复提交' }, time)).toThrow('更新的生成请求');
    expect(count(db, 'weekly_report')).toBe(1);
  });

  it('租约过期、人员停用、来源引用越界不会发布周报', () => {
    const db = setup();
    const expired = startWeeklyGeneration(db, 'employee', week, 'poc', time);
    expect(() => commitWeeklyGeneration(db, expired, { content: '超时' }, new Date(time.getTime() + 10 * 60_000))).toThrow('过期');
    const ticket = startWeeklyGeneration(db, 'employee', week, 'poc', time);
    expect(() => commitWeeklyGeneration(db, ticket, { content: '越界引用', citedReportIds: ['not-my-source'] }, time)).toThrow('非本次已确认来源');
    db.prepare('UPDATE app_user SET active=0 WHERE id=?').run('employee');
    expect(() => commitWeeklyGeneration(db, ticket, { content: '已停用' }, time)).toThrow('已停用');
    expect(() => startWeeklyGeneration(db, 'employee', week, 'poc', time)).toThrow('已停用');
    expect(count(db, 'weekly_report')).toBe(0);
  });

  it('审计失败完整回滚报告、证据和current指针，当前ticket可再尝试', () => {
    const db = setup(), ticket = startWeeklyGeneration(db, 'employee', week, 'poc', time);
    db.exec("CREATE TRIGGER fail_weekly_audit BEFORE INSERT ON audit_log WHEN NEW.action='weekly_report.generated' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    expect(() => commitWeeklyGeneration(db, ticket, { content: '不能半成功' }, time)).toThrow('audit unavailable');
    expect(count(db, 'weekly_report')).toBe(0); expect(count(db, 'weekly_evidence')).toBe(0);
    expect(getWeeklyInstance(db, 'employee', week).currentReportId).toBeNull();
    db.exec('DROP TRIGGER fail_weekly_audit');
    expect(commitWeeklyGeneration(db, ticket, { content: '重试成功' }, time)).toBeTruthy();
  });
});

describe('周分析与访问边界', () => {
  it('独立整周与事项原因均保留修订，编辑不改变已发布证据', () => {
    const db = setup(), id = publish(db);
    const first = saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, content: '整周说明', expectedVersion: 0 }, time);
    const second = saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, content: '更正说明', expectedVersion: 1 }, time);
    expect(second).toMatchObject({ id: first.id, version: 2 });
    expect(getWeeklyInstance(db, 'employee', week).stale).toBe(true);
    saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, workItemId: 'item', content: '事项延期说明', expectedVersion: 0 }, time);
    expect(getWeeklyDetail(db, lead, 'employee', week, { reportId: id }).evidence?.snapshot?.reasons).toEqual([]);
    expect(getWeeklyDetail(db, owner, 'employee', week).reasons).toHaveLength(2);
    expect(count(db, 'weekly_reason_revision')).toBe(3);
    saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, content: '更正说明', expectedVersion: 2 }, time);
    expect(count(db, 'weekly_reason_revision')).toBe(3);
    expect(() => saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, content: '过期请求', expectedVersion: 1 }, time)).toThrow('已更新');
    expect(() => db.exec("UPDATE weekly_reason_revision SET content='篡改'" )).toThrow('immutable');
  });

  it('管理者可以读下属但不能代写分析，员工不能跨人、跨租户或用资源链接访问', () => {
    const db = setup();
    expect(() => saveWeeklyReason(db, lead, { userId: 'employee', weekId: week, content: '代填', expectedVersion: 0 }, time)).toThrow('只能由本人');
    expect(() => getWeeklyDetail(db, owner, 'outside', week)).toThrow('无权查看');
    expect(() => getWeeklyDetail(db, admin, 'foreign-user', week)).toThrow('人员不存在');
    expect(() => getWeeklyDetail(db, { ...owner, resourceId: 'anything' }, 'employee', week)).toThrow('当前身份');
    expect(() => getWeeklyDetail(db, { ...owner, role: 'admin' }, 'outside', week)).toThrow('当前身份');
    db.prepare('UPDATE app_user SET manager_user_id=NULL WHERE id=?').run('employee');
    expect(() => getWeeklyDetail(db, lead, 'employee', week)).toThrow('无权查看');
  });

  it('查看旧版本时不得注入别人的reportId；无效/退役事项不能写原因', () => {
    const db = setup(), outside = publish(db, 'outside');
    expect(() => getWeeklyDetail(db, owner, 'employee', week, { reportId: outside })).toThrow('不属于');
    expect(() => saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, workItemId: 'outside', content: '原因', expectedVersion: 0 }, time)).toThrow('不属于');
    db.prepare('UPDATE work_item SET deleted=1 WHERE id=?').run('item');
    expect(() => saveWeeklyReason(db, owner, { userId: 'employee', weekId: week, workItemId: 'item', content: '原因', expectedVersion: 0 }, time)).toThrow('不属于');
  });
});

describe('领导反馈修订、幂等与动态授权', () => {
  it('原作者修订反馈，原文留存、已读清空、revision outbox独立且可回放', () => {
    const db = setup(), weeklyReportId = publish(db);
    const first = saveWeeklyFeedback(db, lead, { weeklyReportId, content: '继续跟进', idempotencyKey: 'create-once' }, time);
    db.prepare('UPDATE manager_feedback SET read_at=? WHERE id=?').run(time.toISOString(), first.id);
    const revised = saveWeeklyFeedback(db, lead, { weeklyReportId, feedbackId: first.id, expectedVersion: 1, content: '优先联系A企业', idempotencyKey: 'revise-once' }, time);
    expect(revised).toMatchObject({ id: first.id, revision: 2, replayed: false });
    const feedback = getWeeklyDetail(db, owner, 'employee', week).feedback[0];
    expect(feedback).toMatchObject({ content: '优先联系A企业', read_at: null, revision: 2, manager_name: '组长', revisions: [{ version: 1, content: '继续跟进' }] });
    expect(db.prepare('SELECT dedupe_key FROM message_outbox ORDER BY dedupe_key').all()).toEqual([{ dedupe_key: `feedback:${first.id}:v1` }, { dedupe_key: `feedback:${first.id}:v2` }]);
    expect(saveWeeklyFeedback(db, lead, { weeklyReportId, feedbackId: first.id, expectedVersion: 1, content: '优先联系A企业', idempotencyKey: 'revise-once' }, time)).toMatchObject({ id: first.id, revision: 2, replayed: true });
    expect(count(db, 'message_outbox')).toBe(2); expect(count(db, 'manager_feedback_revision')).toBe(2);
    expect(() => db.exec("UPDATE manager_feedback_revision SET content='篡改'" )).toThrow('immutable');
  });

  it('反馈首次提交复投不重复写入，相同key改内容冲突，原地相同内容不产生新修订', () => {
    const db = setup(), weeklyReportId = publish(db), input = { weeklyReportId, content: '按计划推进', idempotencyKey: 'create-id' };
    const first = saveWeeklyFeedback(db, lead, input, time);
    expect(saveWeeklyFeedback(db, lead, input, time)).toMatchObject({ id: first.id, replayed: true });
    expect(() => saveWeeklyFeedback(db, lead, { ...input, content: '悄悄换内容' }, time)).toThrow('不同内容');
    const noop = { weeklyReportId, feedbackId: first.id, content: input.content, expectedVersion: 1, idempotencyKey: 'noop-id' };
    expect(saveWeeklyFeedback(db, lead, noop, time)).toMatchObject({ revision: 1, replayed: true });
    expect(() => saveWeeklyFeedback(db, lead, { ...noop, content: '复用无操作key' }, time)).toThrow('不同内容');
    expect(count(db, 'manager_feedback')).toBe(1); expect(count(db, 'manager_feedback_revision')).toBe(1); expect(count(db, 'message_outbox')).toBe(1);
  });

  it('旧反馈首次修改先留存v1基线，读操作不补写修订', () => {
    const db = setup(), weeklyReportId = legacyReport(db);
    repo.insertFeedback(db, { id: 'legacy-feedback', weekly_report_id: weeklyReportId, work_item_id: null, manager_user_id: 'lead', to_user_id: 'employee', content: '旧反馈', created_at: time.toISOString() });
    const before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    expect(getWeeklyDetail(db, owner, 'employee', week).feedback[0]).toMatchObject({ revision: 1, revisions: [] });
    expect(Number(db.prepare('SELECT total_changes() AS n').get()!.n)).toBe(before);
    saveWeeklyFeedback(db, lead, { weeklyReportId, feedbackId: 'legacy-feedback', expectedVersion: 1, content: '新反馈' }, time);
    expect(getWeeklyDetail(db, owner, 'employee', week).feedback[0]).toMatchObject({ revision: 2, revisions: [{ version: 1, content: '旧反馈' }] });
  });

  it('只有当前有管辖权的原作者能改，员工不可改领导意见、领导不能自评', () => {
    const db = setup(), weeklyReportId = publish(db), ownReport = publish(db, 'lead');
    const first = saveWeeklyFeedback(db, lead, { weeklyReportId, content: '原意见' }, time);
    const revision = { weeklyReportId, feedbackId: first.id, expectedVersion: 1, content: '改意见' };
    expect(() => saveWeeklyFeedback(db, admin, revision, time)).toThrow('原反馈作者');
    expect(() => saveWeeklyFeedback(db, owner, revision, time)).toThrow('只能反馈');
    expect(() => saveWeeklyFeedback(db, lead, { weeklyReportId: ownReport, content: '自我反馈' }, time)).toThrow('不能给本人');
    db.prepare('UPDATE app_user SET manager_user_id=NULL WHERE id=?').run('employee');
    expect(() => saveWeeklyFeedback(db, lead, revision, time)).toThrow('只能反馈');
  });

  it('复投仍重新核查角色/关系/租户权限，不能利用已成功receipt继续越权', () => {
    const db = setup(), weeklyReportId = publish(db), input = { weeklyReportId, content: '管理反馈', idempotencyKey: 'success-key' };
    saveWeeklyFeedback(db, lead, input, time);
    db.prepare('UPDATE app_user SET role=? WHERE id=?').run('employee', 'lead');
    expect(() => saveWeeklyFeedback(db, lead, input, time)).toThrow('当前身份');
    expect(() => saveWeeklyFeedback(db, { ...admin, resourceId: weeklyReportId }, input, time)).toThrow('当前身份');
    expect(() => saveWeeklyFeedback(db, { userId: 'foreign-user', role: 'employee', tenantId: 'other' }, input, time)).toThrow('周报不存在');
  });

  it('bootstrap管理员仅poc可用，并在事务内创建真实作者用于后续修订', () => {
    const db = setup(), weeklyReportId = publish(db), bootstrap: AccessActor = { userId: 'poc-admin', role: 'admin' };
    expect(repo.getUser(db, 'poc-admin')).toBeUndefined();
    const first = saveWeeklyFeedback(db, bootstrap, { weeklyReportId, content: '管理员反馈', idempotencyKey: 'bootstrap' }, time);
    expect(repo.getUser(db, 'poc-admin')).toMatchObject({ name: '后台管理员', role: 'admin' });
    expect(saveWeeklyFeedback(db, bootstrap, { weeklyReportId, feedbackId: first.id, expectedVersion: 1, content: '管理员修订' }, time).revision).toBe(2);
    expect(() => saveWeeklyFeedback(db, { ...bootstrap, tenantId: 'other' }, { weeklyReportId, content: '跨租户' }, time)).toThrow('当前身份');
  });

  it('反馈审计故障回滚正文、修订、outbox与receipt，失败可用同key重试', () => {
    const db = setup(), weeklyReportId = publish(db);
    ensureWeeklyWorkflowSchema(db); ensureProgressSchema(db);
    db.exec("CREATE TRIGGER fail_feedback_audit BEFORE INSERT ON audit_log WHEN NEW.action='weekly_report.feedback_added' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    const input = { weeklyReportId, content: '需要完整保存', idempotencyKey: 'retry-after-failure' };
    expect(() => saveWeeklyFeedback(db, lead, input, time)).toThrow('audit unavailable');
    for (const table of ['manager_feedback', 'manager_feedback_revision', 'message_outbox', 'weekly_feedback_receipt']) expect(count(db, table)).toBe(0);
    db.exec('DROP TRIGGER fail_feedback_audit');
    expect(saveWeeklyFeedback(db, lead, input, time)).toMatchObject({ revision: 1, replayed: false });
  });
});
