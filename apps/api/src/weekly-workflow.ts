import { createHash, randomUUID } from 'node:crypto';
import * as repo from '@wecom/persistence';
import type { AccessActor, Db, DailyReportRow, WorkItemRow, WeeklyReportRow, FeedbackRow, TemplateRow } from '@wecom/persistence';

export class WeeklyWorkflowError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_input') { super(message); }
}
function fail(message: string, status = 400, code = 'invalid_input'): never { throw new WeeklyWorkflowError(message, status, code); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const dateAt = (value: string) => new Date(`${value}T00:00:00.000Z`);
function checkedDate(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(dateAt(value).getTime()) || dateAt(value).toISOString().slice(0, 10) !== value) fail('日期无效');
  return value;
}
export function validateWeeklyId(weekId: string): string {
  checkedDate(weekId);
  if (dateAt(weekId).getUTCDay() !== 1) fail('周标识必须为周一日期');
  return weekId;
}
const shift = (value: string, days: number) => new Date(dateAt(value).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const localDate = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
function checkedNow(now: Date): string {
  if (!Number.isFinite(now.getTime())) fail('时间无效');
  return now.toISOString();
}
function atomic<T>(db: Db, operation: () => T): T {
  const name = `weekly_${randomUUID().replace(/-/g, '')}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const result = operation(); db.exec(`RELEASE SAVEPOINT ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO SAVEPOINT ${name}`); db.exec(`RELEASE SAVEPOINT ${name}`); throw error; }
}
const hasTable = (db: Db, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export function ensureWeeklyWorkflowSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_instance (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), user_id TEXT NOT NULL REFERENCES app_user(id), week_id TEXT NOT NULL,
      current_report_id TEXT REFERENCES weekly_report(id), source_fingerprint TEXT,
      generation_revision INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_expires_at TEXT,
      generation_fingerprint TEXT, generation_sources_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tenant_id,user_id,week_id)
    );
    CREATE TABLE IF NOT EXISTS weekly_evidence (
      report_id TEXT PRIMARY KEY REFERENCES weekly_report(id), tenant_id TEXT NOT NULL REFERENCES tenant(id), instance_id TEXT NOT NULL REFERENCES weekly_instance(id),
      source_fingerprint TEXT NOT NULL, snapshot_json TEXT NOT NULL, progress_snapshot_json TEXT, generation_revision INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weekly_reason (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), user_id TEXT NOT NULL REFERENCES app_user(id), week_id TEXT NOT NULL,
      item_key TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tenant_id,user_id,week_id,item_key)
    );
    CREATE TABLE IF NOT EXISTS weekly_reason_revision (
      id TEXT PRIMARY KEY, reason_id TEXT NOT NULL REFERENCES weekly_reason(id), tenant_id TEXT NOT NULL REFERENCES tenant(id),
      version INTEGER NOT NULL, content TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES app_user(id), created_at TEXT NOT NULL,
      UNIQUE(tenant_id,reason_id,version)
    );
    CREATE TABLE IF NOT EXISTS manager_feedback_revision (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), feedback_id TEXT NOT NULL REFERENCES manager_feedback(id), version INTEGER NOT NULL,
      weekly_report_id TEXT NOT NULL REFERENCES weekly_report(id), manager_user_id TEXT NOT NULL REFERENCES app_user(id), to_user_id TEXT NOT NULL REFERENCES app_user(id),
      content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,feedback_id,version)
    );
    CREATE TABLE IF NOT EXISTS weekly_feedback_receipt (
      tenant_id TEXT NOT NULL REFERENCES tenant(id), actor_user_id TEXT NOT NULL REFERENCES app_user(id), request_key TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,actor_user_id,request_key)
    );
    CREATE TRIGGER IF NOT EXISTS immutable_weekly_evidence_update BEFORE UPDATE ON weekly_evidence BEGIN SELECT RAISE(ABORT,'weekly evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_weekly_evidence_delete BEFORE DELETE ON weekly_evidence BEGIN SELECT RAISE(ABORT,'weekly evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_managed_weekly_update BEFORE UPDATE ON weekly_report WHEN EXISTS(SELECT 1 FROM weekly_evidence WHERE report_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'published weekly report is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_managed_weekly_delete BEFORE DELETE ON weekly_report WHEN EXISTS(SELECT 1 FROM weekly_evidence WHERE report_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'published weekly report is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_weekly_reason_revision_update BEFORE UPDATE ON weekly_reason_revision BEGIN SELECT RAISE(ABORT,'reason revision is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_weekly_reason_revision_delete BEFORE DELETE ON weekly_reason_revision BEGIN SELECT RAISE(ABORT,'reason revision is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_feedback_revision_update BEFORE UPDATE ON manager_feedback_revision BEGIN SELECT RAISE(ABORT,'feedback revision is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_feedback_revision_delete BEFORE DELETE ON manager_feedback_revision BEGIN SELECT RAISE(ABORT,'feedback revision is immutable'); END;
  `);
}

export interface WeeklyReason { id: string; userId: string; weekId: string; workItemId: string | null; content: string; version: number; createdAt: string; updatedAt: string }
interface ReasonRow { id: string; user_id: string; week_id: string; item_key: string; content: string; version: number; created_at: string; updated_at: string }
const reasonView = (row: ReasonRow): WeeklyReason => ({ id: row.id, userId: row.user_id, weekId: row.week_id, workItemId: row.item_key || null,
  content: row.content, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
function reasonRows(db: Db, userId: string, weekId: string, tenantId: string): WeeklyReason[] {
  if (!hasTable(db, 'weekly_reason')) return [];
  return (db.prepare('SELECT * FROM weekly_reason WHERE tenant_id=? AND user_id=? AND week_id=? ORDER BY item_key,id').all(tenantId, userId, weekId) as unknown as ReasonRow[]).map(reasonView);
}
function requireIdentity(db: Db, actor: AccessActor): void {
  const tenantId = actor.tenantId ?? 'poc', current = repo.activeUser(db, actor.userId, tenantId);
  const bootstrap = tenantId === 'poc' && actor.userId === 'poc-admin' && actor.role === 'admin' && !repo.getUser(db, actor.userId, tenantId);
  if (actor.resourceId || (!bootstrap && (!current || current.role !== actor.role))) fail('当前身份无权执行该周报操作', 403, 'forbidden');
}
function requireTarget(db: Db, userId: string, weekId: string, tenantId: string): void {
  validateWeeklyId(weekId);
  if (!repo.getUser(db, userId, tenantId)) fail('人员不存在', 404, 'not_found');
}
function requireRead(db: Db, actor: AccessActor, userId: string, weekId: string): void {
  requireIdentity(db, actor);
  requireTarget(db, userId, weekId, actor.tenantId ?? 'poc');
  if (!repo.canReadUser(db, actor, userId)) fail('无权查看该人员周报', 404, 'not_found');
}
export function listWeeklyReasons(db: Db, actor: AccessActor, userId: string, weekId: string): WeeklyReason[] {
  requireRead(db, actor, userId, weekId);
  return reasonRows(db, userId, weekId, actor.tenantId ?? 'poc');
}

export interface WeeklySourceSnapshot {
  schemaVersion: 1; tenantId: string; userId: string; weekId: string;
  confirmed: DailyReportRow[]; items: WorkItemRow[]; reasons: WeeklyReason[]; metrics: Record<string, unknown>[];
  template: TemplateRow | null; businessRules: { weekBoundary: string; progressMode: string };
}
export interface WeeklySources {
  fingerprint: string; confirmed: DailyReportRow[]; items: WorkItemRow[]; reasons: WeeklyReason[]; metrics: Record<string, unknown>[];
  template: TemplateRow | undefined; snapshot: WeeklySourceSnapshot;
}
/** Read-only snapshot; no real-time clock or model output participates in the source hash. */
export function captureWeeklySources(db: Db, userId: string, weekId: string, tenantId = 'poc'): WeeklySources {
  requireTarget(db, userId, weekId, tenantId);
  return atomic(db, () => {
    const confirmed = db.prepare(`SELECT d.* FROM daily_report d WHERE d.tenant_id=? AND d.user_id=? AND d.report_date>=? AND d.report_date<=?
      AND d.status='confirmed' AND NOT EXISTS(SELECT 1 FROM daily_report newer WHERE newer.tenant_id=d.tenant_id AND newer.user_id=d.user_id
        AND newer.report_date=d.report_date AND newer.status='confirmed' AND newer.version>d.version) ORDER BY d.report_date,d.id`).all(tenantId, userId, weekId, shift(weekId, 6)) as unknown as DailyReportRow[];
    const items = db.prepare('SELECT * FROM work_item WHERE tenant_id=? AND user_id=? AND week_id=? ORDER BY id').all(tenantId, userId, weekId) as unknown as WorkItemRow[];
    const reasons = reasonRows(db, userId, weekId, tenantId);
    const metrics = hasTable(db, 'work_item_metric') ? db.prepare(`SELECT m.* FROM work_item_metric m JOIN work_item w ON w.id=m.work_item_id AND w.tenant_id=m.tenant_id
      WHERE m.tenant_id=? AND w.user_id=? AND w.week_id=? ORDER BY m.work_item_id`).all(tenantId, userId, weekId) as Record<string, unknown>[] : [];
    const template = repo.getActiveTemplate(db, 'weekly', tenantId);
    const snapshot: WeeklySourceSnapshot = { schemaVersion: 1, tenantId, userId, weekId, confirmed, items, reasons, metrics, template: template ?? null,
      businessRules: { weekBoundary: repo.getConfig(db, 'weekBoundary', 'natural_week', tenantId), progressMode: repo.getConfig(db, 'progressMode', 'cumulative', tenantId) } };
    return { fingerprint: fingerprint(snapshot), confirmed, items, reasons, metrics, template, snapshot };
  });
}

interface InstanceRow {
  id: string; tenant_id: string; user_id: string; week_id: string; current_report_id: string | null; source_fingerprint: string | null;
  generation_revision: number; lease_token: string | null; lease_expires_at: string | null; generation_fingerprint: string | null; generation_sources_json: string | null;
}
export interface WeeklyInstance {
  id: string; tenantId: string; userId: string; weekId: string; currentReportId: string | null; sourceFingerprint: string | null;
  stale: boolean; legacy: boolean; generationRevision: number;
}
const stableId = (tenantId: string, userId: string, weekId: string) => `week_${fingerprint([tenantId, userId, weekId]).slice(0, 40)}`;
function storedInstance(db: Db, userId: string, weekId: string, tenantId: string): InstanceRow | undefined {
  return hasTable(db, 'weekly_instance') ? db.prepare('SELECT * FROM weekly_instance WHERE tenant_id=? AND user_id=? AND week_id=?').get(tenantId, userId, weekId) as unknown as InstanceRow | undefined : undefined;
}
/** Legacy reports are not rewritten. An unsaved empty week has the same deterministic ID as its eventual persisted instance. */
export function getWeeklyInstance(db: Db, userId: string, weekId: string, tenantId = 'poc'): WeeklyInstance {
  requireTarget(db, userId, weekId, tenantId);
  const stored = storedInstance(db, userId, weekId, tenantId);
  const legacyLatest = !stored?.current_report_id ? repo.getWeeklyReport(db, userId, weekId, tenantId) : undefined;
  const currentReportId = stored?.current_report_id ?? legacyLatest?.id ?? null;
  const sourceFingerprint = stored?.source_fingerprint ?? null;
  return { id: stored?.id ?? stableId(tenantId, userId, weekId), tenantId, userId, weekId, currentReportId, sourceFingerprint,
    stale: currentReportId !== null && (sourceFingerprint === null || sourceFingerprint !== captureWeeklySources(db, userId, weekId, tenantId).fingerprint),
    legacy: currentReportId !== null && sourceFingerprint === null, generationRevision: stored?.generation_revision ?? 0 };
}
function ensureInstance(db: Db, userId: string, weekId: string, tenantId: string, now: string): InstanceRow {
  const instance = getWeeklyInstance(db, userId, weekId, tenantId);
  db.prepare(`INSERT OR IGNORE INTO weekly_instance(id,tenant_id,user_id,week_id,current_report_id,source_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(instance.id, tenantId, userId, weekId, instance.currentReportId, instance.sourceFingerprint, now, now);
  return storedInstance(db, userId, weekId, tenantId)!;
}
export interface WeeklyGenerationTicket { instanceId: string; userId: string; weekId: string; tenantId: string; revision: number; leaseToken: string; sources: WeeklySources }
export function startWeeklyGeneration(db: Db, userId: string, weekId: string, tenantId = 'poc', now = new Date()): WeeklyGenerationTicket {
  requireTarget(db, userId, weekId, tenantId);
  if (!repo.activeUser(db, userId, tenantId)) fail('人员已停用，不能生成新周报', 403, 'forbidden');
  const time = checkedNow(now);
  ensureWeeklyWorkflowSchema(db);
  return atomic(db, () => {
    const instance = ensureInstance(db, userId, weekId, tenantId, time), sources = captureWeeklySources(db, userId, weekId, tenantId);
    const revision = instance.generation_revision + 1, leaseToken = randomUUID();
    db.prepare(`UPDATE weekly_instance SET generation_revision=?,lease_token=?,lease_expires_at=?,generation_fingerprint=?,generation_sources_json=?,updated_at=? WHERE id=? AND tenant_id=?`)
      .run(revision, leaseToken, new Date(now.getTime() + 10 * 60_000).toISOString(), sources.fingerprint, JSON.stringify(sources.snapshot), time, instance.id, tenantId);
    return { instanceId: instance.id, userId, weekId, tenantId, revision, leaseToken, sources };
  });
}
export interface WeeklyGenerationResult { content: string; sections?: unknown; citedReportIds?: string[]; missingDays?: string[]; progressSnapshot?: unknown }
/** A failed older request must never release the newer request's lease. Safe to call repeatedly. */
export function abortWeeklyGeneration(db: Db, ticket: WeeklyGenerationTicket, now = new Date()): boolean {
  if (!hasTable(db, 'weekly_instance')) return false;
  const time = checkedNow(now);
  const result = db.prepare(`UPDATE weekly_instance SET lease_token=NULL,lease_expires_at=NULL,generation_fingerprint=NULL,generation_sources_json=NULL,updated_at=?
    WHERE id=? AND tenant_id=? AND user_id=? AND week_id=? AND generation_revision=? AND lease_token=?`)
    .run(time, ticket.instanceId, ticket.tenantId, ticket.userId, ticket.weekId, ticket.revision, ticket.leaseToken);
  return Number(result.changes) === 1;
}
export function commitWeeklyGeneration(db: Db, ticket: WeeklyGenerationTicket, result: WeeklyGenerationResult, now = new Date()): string {
  const time = checkedNow(now);
  requireTarget(db, ticket.userId, ticket.weekId, ticket.tenantId);
  if (!repo.activeUser(db, ticket.userId, ticket.tenantId)) fail('人员已停用，不能发布周报', 403, 'forbidden');
  if (typeof result.content !== 'string' || !result.content.trim() || result.content.length > 100_000) fail('周报正文无效');
  ensureWeeklyWorkflowSchema(db);
  return atomic(db, () => {
    const row = storedInstance(db, ticket.userId, ticket.weekId, ticket.tenantId);
    if (!row || row.id !== ticket.instanceId || row.generation_revision !== ticket.revision || row.lease_token !== ticket.leaseToken) fail('已存在更新的生成请求，本次结果不发布', 409, 'superseded_generation');
    if (!row.lease_expires_at || row.lease_expires_at <= time) fail('生成租约已过期，请重新生成', 409, 'expired_generation');
    const current = captureWeeklySources(db, ticket.userId, ticket.weekId, ticket.tenantId);
    if (!row.generation_fingerprint || current.fingerprint !== row.generation_fingerprint) fail('周报来源已变更，本次旧结果不发布，请重新生成', 409, 'source_changed');
    const source = JSON.parse(row.generation_sources_json!) as WeeklySourceSnapshot;
    if (fingerprint(source) !== row.generation_fingerprint) fail('生成来源快照校验失败', 409, 'source_changed');
    const sourceIds = new Set(source.confirmed.map(report => report.id));
    const cited = result.citedReportIds ?? [...sourceIds];
    if (!Array.isArray(cited) || cited.some(id => typeof id !== 'string' || !sourceIds.has(id))) fail('周报引用包含非本次已确认来源');
    const id = randomUUID(), version = repo.nextWeeklyReportVersion(db, ticket.userId, ticket.weekId, ticket.tenantId);
    const days = coverageDays(ticket.weekId, source.confirmed, source.businessRules.weekBoundary, now);
    // Never trust caller/model supplied missing-day labels: future dates are not missing or overdue.
    const missing = days.filter(day => day.state === 'missing').map(day => day.date);
    repo.insertWeeklyReport(db, { id, tenant_id: ticket.tenantId, user_id: ticket.userId, week_id: ticket.weekId, version,
      template_version: String(source.template?.version ?? 1), content: result.content, sections_json: JSON.stringify(result.sections ?? []),
      cited_report_ids_json: JSON.stringify([...new Set(cited)]), item_snapshot_json: JSON.stringify(source.items.filter(item => !item.deleted).map(item => ({ id: item.id, name: item.name, planBackground: item.plan_background }))),
      missing_days_json: JSON.stringify(missing), generated_at: time });
    db.prepare(`INSERT INTO weekly_evidence(report_id,tenant_id,instance_id,source_fingerprint,snapshot_json,progress_snapshot_json,generation_revision,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, ticket.tenantId, row.id, row.generation_fingerprint, row.generation_sources_json, result.progressSnapshot === undefined ? null : JSON.stringify(result.progressSnapshot), ticket.revision, time);
    db.prepare(`UPDATE weekly_instance SET current_report_id=?,source_fingerprint=?,lease_token=NULL,lease_expires_at=NULL,generation_fingerprint=NULL,generation_sources_json=NULL,updated_at=? WHERE id=? AND tenant_id=?`)
      .run(id, row.generation_fingerprint, time, row.id, ticket.tenantId);
    repo.insertAudit(db, { id: randomUUID(), tenant_id: ticket.tenantId, actor_user_id: ticket.userId, action: 'weekly_report.generated', resource_type: 'weekly_report', resource_id: id,
      details_json: JSON.stringify({ instanceId: row.id, version, generationRevision: ticket.revision, sourceFingerprint: row.generation_fingerprint }), created_at: time });
    return id;
  });
}

export interface WeeklyDayState { date: string; state: 'confirmed' | 'missing' | 'not_due' | 'future' }
function coverageDays(weekId: string, reports: DailyReportRow[], boundary: string, now: Date): WeeklyDayState[] {
  const today = localDate(now), confirmed = new Set(reports.map(report => report.report_date));
  return Array.from({ length: boundary === 'work_week' ? 5 : 7 }, (_, index) => {
    const date = shift(weekId, index);
    return { date, state: date > today ? 'future' : confirmed.has(date) ? 'confirmed' : date === today ? 'not_due' : 'missing' };
  });
}
export interface WeeklyEvidence { reportId: string; sourceFingerprint: string | null; snapshot: WeeklySourceSnapshot | null; progressSnapshot: unknown | null; legacy: boolean }
export interface WeeklyFeedbackRevision { version: number; content: string; manager_user_id: string; created_at: string }
export interface WeeklyFeedbackView extends FeedbackRow {
  revision: number; manager_name: string;
  /** Earlier immutable revisions only; the latest content is already on this row. */
  revisions: WeeklyFeedbackRevision[];
}
export interface WeeklyDetail {
  instance: WeeklyInstance; currentReport: WeeklyReportRow | null; history?: WeeklyReportRow[]; reasons: WeeklyReason[]; evidence: WeeklyEvidence | null;
  feedback: WeeklyFeedbackView[]; days: WeeklyDayState[];
}
export function getWeeklyDetail(db: Db, actor: AccessActor, userId: string, weekId: string, options: { history?: boolean; reportId?: string; now?: Date } = {}): WeeklyDetail {
  requireRead(db, actor, userId, weekId);
  const tenantId = actor.tenantId ?? 'poc', instance = getWeeklyInstance(db, userId, weekId, tenantId);
  const selectedId = options.reportId ?? instance.currentReportId;
  const report = selectedId ? repo.getWeeklyReportById(db, selectedId, tenantId) : undefined;
  if (selectedId && (!report || report.user_id !== userId || report.week_id !== weekId)) fail('周报不属于该人员和周次', 404, 'not_found');
  const stored = report && hasTable(db, 'weekly_evidence') ? db.prepare('SELECT * FROM weekly_evidence WHERE tenant_id=? AND report_id=? AND instance_id=?').get(tenantId, report.id, instance.id) : undefined;
  const evidence: WeeklyEvidence | null = report ? { reportId: report.id, sourceFingerprint: stored ? String(stored.source_fingerprint) : null,
    snapshot: stored ? JSON.parse(String(stored.snapshot_json)) : null, progressSnapshot: stored?.progress_snapshot_json ? JSON.parse(String(stored.progress_snapshot_json)) : null, legacy: !stored } : null;
  const sources = captureWeeklySources(db, userId, weekId, tenantId);
  const feedback = report ? repo.listFeedback(db, report.id, tenantId).map(row => {
    const revision = feedbackVersion(db, row.id, tenantId);
    const revisions = hasTable(db, 'manager_feedback_revision') ? db.prepare(`SELECT version,content,manager_user_id,created_at FROM manager_feedback_revision
      WHERE tenant_id=? AND feedback_id=? AND version<? ORDER BY version DESC`).all(tenantId, row.id, revision) as unknown as WeeklyFeedbackRevision[] : [];
    return { ...row, revision, manager_name: repo.getUser(db, row.manager_user_id, tenantId)?.name ?? '原管理者', revisions };
  }) : [];
  return { instance, currentReport: report ?? null,
    ...(options.history ? { history: db.prepare('SELECT * FROM weekly_report WHERE tenant_id=? AND user_id=? AND week_id=? ORDER BY version DESC,id').all(tenantId, userId, weekId) as unknown as WeeklyReportRow[] } : {}),
    reasons: sources.reasons, evidence, feedback, days: coverageDays(weekId, sources.confirmed, sources.snapshot.businessRules.weekBoundary, options.now ?? new Date()) };
}

export interface SaveWeeklyReasonInput { userId: string; weekId: string; workItemId?: string | null; content: string; expectedVersion: number }
export function saveWeeklyReason(db: Db, actor: AccessActor, input: SaveWeeklyReasonInput, now = new Date()): WeeklyReason {
  requireRead(db, actor, input.userId, input.weekId);
  if (actor.userId !== input.userId) fail('分析原因只能由本人填写，管理者不能代填', 403, 'forbidden');
  if (typeof input.content !== 'string' || input.content.length > 10_000 || /[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(input.content)) fail('分析原因格式无效或超过10000字');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) fail('请提供有效原因版本');
  if (input.workItemId != null && (typeof input.workItemId !== 'string' || !input.workItemId || input.workItemId.length > 200)) fail('事项标识无效');
  const tenantId = actor.tenantId ?? 'poc', itemKey = input.workItemId ?? '', time = checkedNow(now);
  ensureWeeklyWorkflowSchema(db);
  return atomic(db, () => {
    if (itemKey && !db.prepare('SELECT 1 FROM work_item WHERE tenant_id=? AND user_id=? AND week_id=? AND id=? AND deleted=0').get(tenantId, input.userId, input.weekId, itemKey)) fail('事项不属于本人的本周有效计划', 404, 'not_found');
    const old = db.prepare('SELECT * FROM weekly_reason WHERE tenant_id=? AND user_id=? AND week_id=? AND item_key=?').get(tenantId, input.userId, input.weekId, itemKey) as unknown as ReasonRow | undefined;
    if ((old?.version ?? 0) !== input.expectedVersion) fail('分析原因已更新，请刷新后再修改', 409, 'version_conflict');
    if (old?.content === input.content) return reasonView(old);
    const id = old?.id ?? randomUUID(), version = input.expectedVersion + 1;
    if (old) db.prepare('UPDATE weekly_reason SET content=?,version=?,updated_at=? WHERE tenant_id=? AND id=? AND version=?').run(input.content, version, time, tenantId, id, input.expectedVersion);
    else db.prepare('INSERT INTO weekly_reason(id,tenant_id,user_id,week_id,item_key,content,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, tenantId, input.userId, input.weekId, itemKey, input.content, version, time, time);
    db.prepare('INSERT INTO weekly_reason_revision(id,reason_id,tenant_id,version,content,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, tenantId, version, input.content, actor.userId, time);
    repo.insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: actor.userId, action: 'weekly_reason.saved', resource_type: 'weekly_reason', resource_id: id,
      details_json: JSON.stringify({ userId: input.userId, weekId: input.weekId, workItemId: itemKey || null, version }), created_at: time });
    ensureInstance(db, input.userId, input.weekId, tenantId, time);
    return reasonView(db.prepare('SELECT * FROM weekly_reason WHERE tenant_id=? AND id=?').get(tenantId, id) as unknown as ReasonRow);
  });
}

function feedbackVersion(db: Db, feedbackId: string, tenantId: string): number {
  if (!hasTable(db, 'manager_feedback_revision')) return 1;
  return Number(db.prepare('SELECT COALESCE(MAX(version),1) AS version FROM manager_feedback_revision WHERE tenant_id=? AND feedback_id=?').get(tenantId, feedbackId)!.version);
}
export interface SaveWeeklyFeedbackInput { weeklyReportId: string; content: string; feedbackId?: string; expectedVersion?: number; idempotencyKey?: string }
export interface WeeklyFeedbackResult { id: string; revision: number; weeklyReportId: string; replayed: boolean }
export function saveWeeklyFeedback(db: Db, actor: AccessActor, input: SaveWeeklyFeedbackInput, now = new Date()): WeeklyFeedbackResult {
  requireIdentity(db, actor);
  const tenantId = actor.tenantId ?? 'poc', time = checkedNow(now);
  if (typeof input.weeklyReportId !== 'string' || !input.weeklyReportId || input.weeklyReportId.length > 200) fail('周报标识无效');
  if (input.feedbackId !== undefined && (typeof input.feedbackId !== 'string' || !input.feedbackId || input.feedbackId.length > 200)) fail('反馈标识无效');
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || /[\p{C}]/u.test(input.idempotencyKey))) fail('反馈请求标识无效');
  const report = repo.getWeeklyReportById(db, input.weeklyReportId, tenantId);
  if (!report) fail('周报不存在', 404, 'not_found');
  validateWeeklyId(report.week_id);
  if (!['admin', 'team_lead', 'dept_head'].includes(actor.role) || report.user_id === actor.userId || !repo.canReadUser(db, actor, report.user_id)) fail('只能反馈当前管辖员工的整周工作，不能给本人反馈', 403, 'forbidden');
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 10_000 || /[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(input.content)) fail('反馈内容不能为空、不能有隐藏控制字符且最多10000字');
  if (input.feedbackId && (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)) fail('修改反馈必须提供当前版本');
  if (!input.feedbackId && input.expectedVersion !== undefined && input.expectedVersion !== 0) fail('新反馈版本应为0');
  ensureWeeklyWorkflowSchema(db);
  return atomic(db, () => {
    const old = input.feedbackId ? db.prepare('SELECT * FROM manager_feedback WHERE tenant_id=? AND id=?').get(tenantId, input.feedbackId) as unknown as FeedbackRow | undefined : undefined;
    if (input.feedbackId && (!old || old.weekly_report_id !== report.id || old.to_user_id !== report.user_id)) fail('反馈不属于该周报', 404, 'not_found');
    if (old && old.manager_user_id !== actor.userId) fail('仅原反馈作者可以修改', 403, 'forbidden');
    const inputFingerprint = fingerprint({ weeklyReportId: report.id, feedbackId: input.feedbackId ?? null, expectedVersion: input.expectedVersion ?? null, content: input.content.trim() });
    const receipt = input.idempotencyKey ? db.prepare('SELECT input_fingerprint,result_json FROM weekly_feedback_receipt WHERE tenant_id=? AND actor_user_id=? AND request_key=?')
      .get(tenantId, actor.userId, input.idempotencyKey) : undefined;
    if (receipt) {
      if (receipt.input_fingerprint !== inputFingerprint) fail('同一反馈请求标识不能提交不同内容', 409, 'idempotency_conflict');
      return { ...JSON.parse(String(receipt.result_json)) as WeeklyFeedbackResult, replayed: true };
    }
    const finish = (result: WeeklyFeedbackResult): WeeklyFeedbackResult => {
      if (input.idempotencyKey) db.prepare('INSERT INTO weekly_feedback_receipt(tenant_id,actor_user_id,request_key,input_fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(tenantId, actor.userId, input.idempotencyKey, inputFingerprint, JSON.stringify(result), time);
      return result;
    };
    const previousVersion = old ? feedbackVersion(db, old.id, tenantId) : 0;
    if (old && input.expectedVersion !== previousVersion) fail('反馈已更新，请刷新后再修改', 409, 'version_conflict');
    const content = input.content.trim();
    if (old?.content === content) return finish({ id: old.id, revision: previousVersion, weeklyReportId: report.id, replayed: true });
    // Preserve the old immutable baseline before the first edit of a legacy feedback row.
    if (old && !db.prepare('SELECT 1 FROM manager_feedback_revision WHERE tenant_id=? AND feedback_id=?').get(tenantId, old.id)) {
      db.prepare('INSERT INTO manager_feedback_revision(id,tenant_id,feedback_id,version,weekly_report_id,manager_user_id,to_user_id,content,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), tenantId, old.id, 1, old.weekly_report_id, old.manager_user_id, old.to_user_id, old.content, old.created_at);
    }
    if (!repo.getUser(db, actor.userId, tenantId) && actor.userId === 'poc-admin' && actor.role === 'admin' && tenantId === 'poc') {
      repo.upsertUser(db, { id: actor.userId, tenant_id: tenantId, wecom_userid: `pending:${actor.userId}`, name: '后台管理员', role: 'admin' });
    }
    const id = old?.id ?? randomUUID(), revision = previousVersion + 1;
    if (old) db.prepare('UPDATE manager_feedback SET content=?,read_at=NULL WHERE tenant_id=? AND id=?').run(content, tenantId, id);
    else repo.insertFeedback(db, { id, tenant_id: tenantId, weekly_report_id: report.id, work_item_id: null, manager_user_id: actor.userId,
      to_user_id: report.user_id, content, read_at: null, created_at: time });
    db.prepare('INSERT INTO manager_feedback_revision(id,tenant_id,feedback_id,version,weekly_report_id,manager_user_id,to_user_id,content,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), tenantId, id, revision, report.id, actor.userId, report.user_id, content, time);
    repo.insertOutbox(db, { id: randomUUID(), tenant_id: tenantId, kind: 'manager_feedback', dedupe_key: `feedback:${id}:v${revision}`, target_user_id: report.user_id,
      payload_json: JSON.stringify({ feedbackId: id, weeklyReportId: report.id, feedbackRevision: revision }), next_attempt_at: time, created_at: time });
    repo.insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: actor.userId, action: old ? 'weekly_report.feedback_revised' : 'weekly_report.feedback_added',
      resource_type: 'weekly_report', resource_id: report.id, details_json: JSON.stringify({ feedbackId: id, revision }), created_at: time });
    return finish({ id, revision, weeklyReportId: report.id, replayed: false });
  });
}
