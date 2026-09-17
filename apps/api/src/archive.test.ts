import { afterEach, describe, expect, it } from 'vitest';
import * as repo from '@wecom/persistence';
import type { AccessActor, DailyReportRow, Db } from '@wecom/persistence';
import { buildStructuredArchive, verifyStructuredArchive, type StructuredArchive } from './archive';
import { buildWeeklyProgress, setItemMetric } from './progress-ledger';
import { saveDailyQuality } from './daily-input';
import { commitWeeklyGeneration, saveWeeklyFeedback, saveWeeklyReason, startWeeklyGeneration } from './weekly-workflow';

type Row = Record<string, unknown>;
const at = new Date('2026-04-07T04:00:00Z'), week = '2025-12-29';
const owner: AccessActor = { userId: 'staff', role: 'employee' }, admin: AccessActor = { userId: 'admin', role: 'admin' };
const databases: Db[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup(): Db {
  const db = repo.openDb(':memory:'); databases.push(db);
  repo.upsertUser(db, { id: 'admin', role: 'admin' });
  repo.upsertUser(db, { id: 'staff', role: 'employee', name: '员工甲', manager_user_id: 'admin', wecom_userid: 'sensitive-wecom-identity' });
  repo.upsertUser(db, { id: 'other', role: 'employee', name: '其他员工' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('foreign', '其他企业', at.toISOString());
  repo.upsertUser(db, { id: 'foreign-user', tenant_id: 'foreign', role: 'employee' });
  return db;
}
function item(db: Db, id = 'item', user = 'staff', selectedWeek = week, tenant = 'poc') {
  repo.insertWorkItem(db, { id, tenant_id: tenant, user_id: user, week_id: selectedWeek, name: '走访', plan_background: '真实计划原文\n保留换行。', deleted: 0, created_at: `${selectedWeek}T04:00:00Z` });
}
function daily(db: Db, id: string, date: string, version = 1, status: DailyReportRow['status'] = 'confirmed', user = 'staff', tenant = 'poc') {
  repo.insertDailyReport(db, { id, tenant_id: tenant, user_id: user, report_date: date, version, status, summary: `${id} 原文\n第二行`,
    progress_json: JSON.stringify([{ workItemRef: 'item', progressValue: null, completedCount: 1, sourceRecordRefs: [] }]), created_at: at.toISOString(), confirmed_at: status === 'confirmed' ? at.toISOString() : null });
}
function source(db: Db, id: string, date: string, user = 'staff', tenant = 'poc') {
  repo.insertSourceMessage(db, { id, tenant_id: tenant, msg_id: `msg:${id}`, user_id: user, report_date: date, content_type: 'file', text_content: `${id} 原始事实\n未做改写`, quoted_text: '引用原文',
    attachments_json: JSON.stringify([{ name: 'D:\\private\\record.docx?token=sensitive-download', path: 'D:\\private\\actual-file.docx', token: 'sensitive-file-token', kind: 'file' }]),
    process_status: 'completed', process_error: 'D:\\private\\path-secret', daily_report_id: null, created_at: at.toISOString() });
}
function publish(db: Db, text: string) {
  const ticket = startWeeklyGeneration(db, 'staff', week, 'poc', at);
  return commitWeeklyGeneration(db, ticket, { content: text, progressSnapshot: buildWeeklyProgress(db, 'staff', week) }, at);
}
function rows(archive: StructuredArchive, name: string): Row[] { return archive[name] as Row[]; }
function exported(db: Db, extra = {}) { return buildStructuredArchive(db, admin, { year: 2026, quarter: 1, userId: 'staff', ...extra }, at); }

describe('结构化档案完整性、季度边界与安全投影', () => {
  it('知识依赖仅归档所选租户/本人/实际报告的id和版本，损坏元数据显式标记但不导出秘密字段', () => {
    const db = setup();
    for (const [id, day] of [['mine', '01'], ['wrong-owner', '02'], ['malformed', '03']]) daily(db, id, `2026-01-${day}`);
    daily(db, 'other-day', '2026-01-01', 1, 'confirmed', 'other');
    daily(db, 'foreign-day', '2026-01-01', 1, 'confirmed', 'foreign-user', 'foreign');
    db.exec('CREATE TABLE generated_report_knowledge(tenant_id TEXT,report_kind TEXT,report_id TEXT,user_id TEXT,dependencies_json TEXT,created_at TEXT)');
    const insert = db.prepare('INSERT INTO generated_report_knowledge VALUES(?,?,?,?,?,?)');
    insert.run('poc', 'daily', 'mine', 'staff', '[{"id":"knowledge-a","version":2}]', at.toISOString());
    insert.run('poc', 'daily', 'wrong-owner', 'other', '[{"id":"must-not-export-wrong-owner","version":1}]', at.toISOString());
    insert.run('poc', 'daily', 'malformed', 'staff', '[{"id":"knowledge-a","version":2,"secret":"sensitive-extra"}]', at.toISOString());
    insert.run('poc', 'daily', 'other-day', 'other', '[{"id":"must-not-export-other","version":1}]', at.toISOString());
    insert.run('foreign', 'daily', 'foreign-day', 'foreign-user', '[{"id":"must-not-export-foreign","version":1}]', at.toISOString());
    insert.run('poc', 'weekly', 'mine', 'staff', '[{"id":"must-not-export-wrong-kind","version":1}]', at.toISOString());
    insert.run('poc', 'daily', 'missing', 'staff', '[{"id":"must-not-export-orphan","version":1}]', at.toISOString());
    const archive = exported(db), dependencies = rows(archive, 'generatedKnowledgeDependencies');
    expect(dependencies).toHaveLength(2);
    expect(dependencies.find(row => row.report_id === 'mine')).toMatchObject({ report_kind: 'daily', user_id: 'staff', dependencies: [{ id: 'knowledge-a', version: 2 }], metadataValid: true });
    expect(dependencies.find(row => row.report_id === 'malformed')).toMatchObject({ dependencies: null, metadataValid: false });
    expect(JSON.stringify(dependencies)).not.toMatch(/must-not-export|sensitive-extra|dependencies_json/);
    expect(archive.manifest.tables.generatedKnowledgeDependencies.count).toBe(2);
    expect(verifyStructuredArchive(JSON.parse(JSON.stringify(archive)))).toBe(true);
  });

  it('第一季度包含跨年周及跨季度完整周，非相关日期不混入', () => {
    const db = setup(); item(db); item(db, 'last-week', 'staff', '2026-03-30'); item(db, 'later-week', 'staff', '2026-04-06');
    for (const date of ['2025-12-28', '2025-12-29', '2026-01-01', '2026-03-31', '2026-04-05', '2026-04-06']) daily(db, date, date);
    const archive = exported(db);
    expect(archive.boundary).toMatchObject({ requestedFrom: '2026-01-01', requestedToExclusive: '2026-04-01', includedFrom: '2025-12-29', includedToExclusive: '2026-04-06' });
    expect(rows(archive, 'dailyReports').map(row => row.id)).toEqual(['2025-12-29', '2026-01-01', '2026-03-31', '2026-04-05']);
    expect(rows(archive, 'workItems').map(row => row.id)).toEqual(['item', 'last-week']);
    expect(archive.boundary.explanation).toContain('不按修订发生时间截断');
  });

  it('完整年度同样包含年底自然周至次年周日，不因周一在上一年漏掉年初', () => {
    const db = setup(); daily(db, 'start', '2025-12-29'); daily(db, 'tail', '2027-01-03'); daily(db, 'outside', '2027-01-04');
    const archive = exported(db, { quarter: null });
    expect(archive.boundary).toMatchObject({ requestedToExclusive: '2027-01-01', includedFrom: '2025-12-29', includedToExclusive: '2027-01-04' });
    expect(rows(archive, 'dailyReports').map(row => row.id)).toEqual(['start', 'tail']);
  });

  it('收齐事项/目标/日报/周报/原因/反馈所有版本与历史证据，原文不覆盖', () => {
    const db = setup(); item(db); source(db, 'source-v1', '2026-01-01');
    setItemMetric(db, owner, 'item', { mode: 'count', total: 3, unit: '家', expectedVersion: 0 });
    daily(db, 'daily-v1', '2026-01-01'); repo.linkReportSource(db, 'daily-v1', 'source-v1');
    saveDailyQuality(db, 'daily-v1', { schemaVersion: 1, summary: '原文', items: [], missingFields: ['请补充原因'], riskFlags: [] });
    const reason = saveWeeklyReason(db, owner, { userId: 'staff', weekId: week, content: '整周原因初稿', expectedVersion: 0 }, at);
    const firstWeek = publish(db, '首次周报原文');
    const feedback = saveWeeklyFeedback(db, admin, { weeklyReportId: firstWeek, content: '最初领导反馈' }, at);
    repo.updateDailyReportStatus(db, 'daily-v1', 'superseded'); daily(db, 'daily-v2', '2026-01-01', 2); daily(db, 'daily-pending', '2026-01-01', 3, 'pending_confirmation');
    repo.updateWorkItem(db, repo.getWorkItem(db, 'item')!, 1, { name: '修改后名称', plan_background: '修改后背景', updated_at: at.toISOString() });
    setItemMetric(db, owner, 'item', { mode: 'count', total: 5, unit: '家', expectedVersion: 1 });
    saveWeeklyReason(db, owner, { userId: 'staff', weekId: week, content: '整周原因修订', expectedVersion: 1 }, at);
    saveWeeklyFeedback(db, admin, { weeklyReportId: firstWeek, feedbackId: feedback.id, expectedVersion: 1, content: '修订领导反馈' }, at);
    const secondWeek = publish(db, '新版周报原文');
    const archive = exported(db);
    expect(rows(archive, 'dailyReports').map(row => row.id)).toEqual(['daily-v1', 'daily-v2', 'daily-pending']);
    expect(rows(archive, 'weeklyReports').map(row => row.id)).toEqual([firstWeek, secondWeek]);
    expect(rows(archive, 'workItemRevisions').map(row => row.version)).toEqual([1, 2]);
    expect(rows(archive, 'metricRevisions').map(row => row.version)).toEqual([1, 2]);
    expect(rows(archive, 'reasonRevisions').filter(row => row.reason_id === reason.id).map(row => row.content)).toEqual(['整周原因初稿', '整周原因修订']);
    expect(rows(archive, 'feedbackRevisions').map(row => row.content)).toEqual(['最初领导反馈', '修订领导反馈']);
    expect(rows(archive, 'sourceLinks')).toEqual([{ daily_report_id: 'daily-v1', source_message_id: 'source-v1' }]);
    expect(rows(archive, 'dailyQuality')).toHaveLength(1);
    const firstEvidence = rows(archive, 'weeklyEvidence').find(row => row.report_id === firstWeek)!;
    expect(JSON.parse(String(firstEvidence.snapshot_json)).confirmed[0].summary).toBe('daily-v1 原文\n第二行');
    expect(JSON.parse(String(firstEvidence.progress_snapshot_json)).items[0].days[3].progressValue).toBe(33);
    expect(rows(archive, 'auditLogs').some(row => row.action === 'weekly_report.feedback_revised')).toBe(true);
  });

  it('个人档案不泄露同企业其他员工、其他租户或伪造关联的来源与修订', () => {
    const db = setup(); item(db); item(db, 'other-item', 'other'); item(db, 'foreign-item', 'foreign-user', week, 'foreign');
    daily(db, 'my-day', '2026-01-01'); daily(db, 'other-day', '2026-01-01', 1, 'confirmed', 'other'); daily(db, 'foreign-day', '2026-01-01', 1, 'confirmed', 'foreign-user', 'foreign');
    source(db, 'my-source', '2026-01-01'); source(db, 'other-source', '2026-01-01', 'other'); source(db, 'foreign-source', '2026-01-01', 'foreign-user', 'foreign');
    repo.linkReportSource(db, 'my-day', 'my-source'); repo.linkReportSource(db, 'my-day', 'other-source'); repo.linkReportSource(db, 'my-day', 'foreign-source');
    setItemMetric(db, { userId: 'other', role: 'employee' }, 'other-item', { mode: 'percent', expectedVersion: 0 });
    const archive = exported(db), json = JSON.stringify(archive);
    expect(rows(archive, 'people').map(row => row.id)).toEqual(['staff']);
    expect(rows(archive, 'dailyReports').map(row => row.id)).toEqual(['my-day']);
    expect(rows(archive, 'sourceLinks')).toEqual([{ daily_report_id: 'my-day', source_message_id: 'my-source' }]);
    for (const marker of ['other-day', 'foreign-day', 'other-source', 'foreign-source', 'other-item', 'foreign-item']) expect(json).not.toContain(marker);
    expect(() => exported(db, { userId: 'foreign-user' })).toThrow('导出人员不存在');
  });

  it('只导出附件名称清单和日志事件，排除真实路径/会话/激活码/发送与生成租约', () => {
    const db = setup(); item(db); daily(db, 'day', '2026-01-01'); source(db, 'source', '2026-01-01');
    publish(db, '业务周报'); startWeeklyGeneration(db, 'staff', week, 'poc', at);
    repo.insertAudit(db, { id: 'selected-log', actor_user_id: 'staff', action: 'daily.updated', resource_type: 'daily_report', resource_id: 'day', details_json: JSON.stringify({ token: 'sensitive-token', path: 'D:\\private\\audit' }), created_at: at.toISOString() });
    const archive = exported(db), json = JSON.stringify(archive);
    for (const marker of ['sensitive-', 'private', 'lease_token', 'generation_sources_json', 'wecom_userid', 'auth_session', 'activation_code', 'message_outbox', 'details_json']) expect(json).not.toContain(marker);
    expect(rows(archive, 'attachments')).toEqual([{ sourceMessageId: 'source', userId: 'staff', date: '2026-01-01', index: 0, name: 'record.docx', kind: 'file' }]);
    expect(rows(archive, 'sourceMessages')[0].text_content).toBe('source 原始事实\n未做改写');
    expect(rows(archive, 'auditLogs').some(row => row.id === 'selected-log')).toBe(true);
  });

  it('当前管理员权限重新验证，拒绝资源链接、停用、角色伪造和跨租户', () => {
    const db = setup();
    for (const actor of [owner, { ...admin, resourceId: 'report' }, { userId: 'staff', role: 'admin' as const }, { ...admin, tenantId: 'foreign' }]) {
      expect(() => buildStructuredArchive(db, actor, { year: 2026 }, at)).toThrow('管理员');
    }
    db.prepare("UPDATE app_user SET active=0 WHERE id='admin'").run();
    expect(() => exported(db)).toThrow('管理员');
    expect(() => buildStructuredArchive(db, { userId: 'poc-admin', role: 'admin' }, { year: 2026 }, at)).not.toThrow();
  });

  it('JSON往返内容与分表SHA256可验证，篡改任一原文、计数或manifest均不能通过', () => {
    const db = setup(); daily(db, 'day', '2026-01-01');
    const archive = exported(db), copy = JSON.parse(JSON.stringify(archive));
    expect(copy).toEqual(archive); expect(verifyStructuredArchive(copy)).toBe(true);
    expect(archive.manifest.signed).toBe(false);
    copy.dailyReports[0].summary = '篡改后的原文'; expect(verifyStructuredArchive(copy)).toBe(false);
    const wrongCount = JSON.parse(JSON.stringify(archive)); wrongCount.manifest.tables.dailyReports.count++; expect(verifyStructuredArchive(wrongCount)).toBe(false);
    const wrongTable = JSON.parse(JSON.stringify(archive)); delete wrongTable.manifest.tables.dailyReports; expect(verifyStructuredArchive(wrongTable)).toBe(false);
    expect(verifyStructuredArchive({})).toBe(false);
  });

  it('只读兼容旧库缺少扩展表，拒绝非法筛选，不写入或自动删除档案', () => {
    const db = setup(); daily(db, 'day', '2026-01-01');
    const before = db.prepare('SELECT total_changes() AS n').get()!.n;
    const one = exported(db), two = exported(db);
    expect(one).toEqual(two); expect(rows(one, 'weeklyEvidence')).toEqual([]); expect(rows(one, 'metricRevisions')).toEqual([]);
    expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
    for (const extra of [{ year: 1999 }, { quarter: 0 }, { quarter: 5 }, { userId: 'missing' }, { secret: 'no' }]) expect(() => exported(db, extra)).toThrow();
    expect(repo.getDailyReportById(db, 'day')?.summary).toBe('day 原文\n第二行');
  });
});
