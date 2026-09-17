import { createHash, randomUUID } from 'node:crypto';
import * as repo from '@wecom/persistence';
import type { AccessActor, Db } from '@wecom/persistence';

type Row = Record<string, unknown>;
export interface ArchiveSelection { year: number; quarter?: number | null; userId?: string | null }
export class ArchiveError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const columns = {
  people: 'id tenant_id name role manager_user_id active department created_at',
  dailyReports: 'id tenant_id user_id report_date version generation_revision status summary progress_json confirmed_at created_at updated_at',
  sourceMessages: 'id tenant_id msg_id user_id report_date content_type text_content quoted_text process_status daily_report_id created_at',
  weeklyReports: 'id tenant_id user_id week_id version template_version content sections_json cited_report_ids_json item_snapshot_json missing_days_json generated_at',
  workItems: 'id tenant_id user_id week_id name plan_background version created_at updated_at deleted',
  workItemRevisions: 'id tenant_id work_item_id version change_type name plan_background actor_user_id created_at',
  metrics: 'tenant_id work_item_id mode total unit rounding version updated_at',
  metricRevisions: 'id tenant_id work_item_id version metric_json actor_user_id created_at',
  reasons: 'id tenant_id user_id week_id item_key content version created_at updated_at',
  reasonRevisions: 'id reason_id tenant_id version content actor_user_id created_at',
  feedback: 'id tenant_id weekly_report_id work_item_id manager_user_id to_user_id content read_at created_at',
  feedbackRevisions: 'id tenant_id feedback_id version weekly_report_id manager_user_id to_user_id content created_at',
  weeklyInstances: 'id tenant_id user_id week_id current_report_id source_fingerprint generation_revision created_at updated_at',
  weeklyEvidence: 'report_id tenant_id instance_id source_fingerprint snapshot_json progress_snapshot_json generation_revision created_at',
  dailyQuality: 'report_id tenant_id questions_json risk_flags_json created_at',
  reportPresentations: 'daily_report_id tenant_id user_id content_hash presented_at',
  auditLogs: 'id tenant_id actor_user_id action resource_type resource_id created_at',
} as const;
function pick(row: Row, fields: string): Row { return Object.fromEntries(fields.split(' ').filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])); }
function object(value: unknown): Row | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined; }
function parsed(value: unknown): unknown { try { return JSON.parse(String(value)); } catch { return null; } }
function array(value: unknown): Row[] { return Array.isArray(value) ? value.map(object).filter((row): row is Row => !!row) : []; }
function ids(rows: Row[], key = 'id'): Set<string> { return new Set(rows.map(row => String(row[key]))); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function monday(date: string): string { const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return shift(date, -((day + 6) % 7)); }
function hasTable(db: Db, table: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }

export interface ArchiveManifest {
  algorithm: 'SHA-256'; serialization: 'sorted-keys-json-utf8'; signed: false; payloadHash: string;
  tables: Record<string, { count: number; sha256: string }>;
}
export interface StructuredArchive extends Row {
  schemaVersion: 2; generatedAt: string; tenantId: 'poc'; filters: { year: number; quarter: number | null; userId: string | null };
  boundary: { policy: 'complete-natural-weeks'; requestedFrom: string; requestedToExclusive: string; includedFrom: string; includedToExclusive: string; timezone: 'Asia/Shanghai'; explanation: string };
  manifest: ArchiveManifest;
}

/** Read-only fact archive, not an operational database backup or automatic restore package. */
export function buildStructuredArchive(db: Db, actor: AccessActor, selection: ArchiveSelection, now = new Date()): StructuredArchive {
  const tenantId = actor.tenantId ?? 'poc', current = repo.activeUser(db, actor.userId, tenantId);
  const bootstrap = actor.userId === 'poc-admin' && actor.role === 'admin' && !repo.getUser(db, actor.userId, tenantId);
  if (tenantId !== 'poc' || actor.resourceId || actor.role !== 'admin' || (!bootstrap && (!current || current.role !== 'admin'))) throw new ArchiveError('只有当前企业管理员可以导出档案', 403);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['year', 'quarter', 'userId'].includes(key))) throw new ArchiveError('导出筛选字段无效');
  const { year } = selection, quarter = selection.quarter ?? null, userId = selection.userId ?? null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ArchiveError('导出年份无效');
  if (quarter !== null && (!Number.isInteger(quarter) || quarter < 1 || quarter > 4)) throw new ArchiveError('季度必须为1到4');
  if (userId !== null && (typeof userId !== 'string' || !userId || !repo.getUser(db, userId, tenantId))) throw new ArchiveError('导出人员不存在');
  if (!Number.isFinite(now.getTime())) throw new ArchiveError('导出时间无效');
  const fromMonth = quarter === null ? 1 : (quarter - 1) * 3 + 1;
  const requestedFrom = `${year}-${String(fromMonth).padStart(2, '0')}-01`;
  const requestedToExclusive = quarter === null || quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(fromMonth + 3).padStart(2, '0')}-01`;
  const includedFrom = monday(requestedFrom), includedToExclusive = shift(monday(shift(requestedToExclusive, -1)), 7);
  // A read transaction gives every exported table the same database snapshot.
  const savepoint = `archive_${randomUUID().replaceAll('-', '')}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const tenantRows = (table: string): Row[] => hasTable(db, table) ? db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY rowid`).all(tenantId) as Row[] : [];
    const selectedOwner = (row: Row) => userId === null || row.user_id === userId;
    const inPeriod = (row: Row, field: string) => typeof row[field] === 'string' && row[field] >= includedFrom && row[field] < includedToExclusive;
    const ownPeriod = (table: string, field: string, fields: string) => tenantRows(table).filter(row => selectedOwner(row) && inPeriod(row, field)).map(row => pick(row, fields));
    const people = tenantRows('app_user').filter(row => userId === null || row.id === userId).map(row => pick(row, columns.people));
    const workItems = ownPeriod('work_item', 'week_id', columns.workItems), itemIds = ids(workItems);
    const dailyReports = ownPeriod('daily_report', 'report_date', columns.dailyReports), dailyIds = ids(dailyReports);
    const weeklyReports = ownPeriod('weekly_report', 'week_id', columns.weeklyReports), weeklyIds = ids(weeklyReports);
    const weekOwner = new Map(weeklyReports.map(row => [String(row.id), row]));
    const sourceRaw = tenantRows('source_message').filter(row => selectedOwner(row) && inPeriod(row, 'report_date'));
    const sourceIds = ids(sourceRaw);
    const sourceMessages = sourceRaw.map(row => ({ ...pick(row, columns.sourceMessages), attachments_json: JSON.stringify(attachmentList(row)) }));
    const childRows = (table: string, foreignKey: string, allowed: Set<string>, fields: string) => tenantRows(table).filter(row => allowed.has(String(row[foreignKey]))).map(row => pick(row, fields));
    const workItemRevisions = childRows('work_item_revision', 'work_item_id', itemIds, columns.workItemRevisions);
    const metrics = childRows('work_item_metric', 'work_item_id', itemIds, columns.metrics);
    const metricRevisions = childRows('work_item_metric_revision', 'work_item_id', itemIds, columns.metricRevisions);
    const reasons = ownPeriod('weekly_reason', 'week_id', columns.reasons), reasonIds = ids(reasons);
    const reasonRevisions = childRows('weekly_reason_revision', 'reason_id', reasonIds, columns.reasonRevisions);
    const feedback = childRows('manager_feedback', 'weekly_report_id', weeklyIds, columns.feedback)
      .filter(row => weekOwner.get(String(row.weekly_report_id))?.user_id === row.to_user_id);
    const feedbackIds = ids(feedback);
    const feedbackRevisions = childRows('manager_feedback_revision', 'feedback_id', feedbackIds, columns.feedbackRevisions)
      .filter(row => weeklyIds.has(String(row.weekly_report_id)) && weekOwner.get(String(row.weekly_report_id))?.user_id === row.to_user_id);
    const weeklyInstances = ownPeriod('weekly_instance', 'week_id', columns.weeklyInstances).map(row => ({ ...row, current_report_id: weeklyIds.has(String(row.current_report_id)) ? row.current_report_id : null }));
    const weeklyEvidence = childRows('weekly_evidence', 'report_id', weeklyIds, columns.weeklyEvidence).map(row => {
      const report = weekOwner.get(String(row.report_id))!;
      return { ...row, snapshot_json: projectedSnapshot(row.snapshot_json, report), progress_snapshot_json: projectedProgress(row.progress_snapshot_json, report, itemIds, dailyIds) };
    });
    const sourceLinks = db.prepare(`SELECT l.daily_report_id,l.source_message_id FROM daily_report_source l
      JOIN daily_report d ON d.id=l.daily_report_id JOIN source_message s ON s.id=l.source_message_id
      WHERE d.tenant_id=? AND s.tenant_id=? AND d.user_id=s.user_id ORDER BY l.daily_report_id,l.source_message_id`).all(tenantId, tenantId)
      .filter(row => dailyIds.has(String(row.daily_report_id)) && sourceIds.has(String(row.source_message_id)));
    const dailyQuality = childRows('daily_quality', 'report_id', dailyIds, columns.dailyQuality);
    const reportPresentations = childRows('daily_report_presentation', 'daily_report_id', dailyIds, columns.reportPresentations)
      .filter(row => dailyReports.some(report => report.id === row.daily_report_id && report.user_id === row.user_id));
    const resources: Record<string, Set<string>> = { work_item: itemIds, daily_report: dailyIds, weekly_report: weeklyIds, weekly_instance: ids(weeklyInstances),
      weekly_reason: reasonIds, manager_feedback: feedbackIds, feedback: feedbackIds, source_message: sourceIds };
    // Export an event's identity/time only. Arbitrary details may contain activation
    // codes, paths or message URLs, and are not necessary to retain business facts.
    const auditLogs = tenantRows('audit_log').filter(row => resources[String(row.resource_type)]?.has(String(row.resource_id))).map(row => pick(row, columns.auditLogs));
    const attachments = sourceRaw.flatMap(row => attachmentList(row));
    const templateVersions = new Set(weeklyReports.map(row => String(row.template_version)));
    const templates = tenantRows('report_template').filter(row => row.kind === 'weekly' && (templateVersions.has(String(row.version)) || templateVersions.has(String(row.id))))
      .map(row => pick(row, 'id tenant_id kind name version content active created_at'));
    const dailyOwner = new Map(dailyReports.map(row => [String(row.id), row.user_id]));
    const generatedKnowledgeDependencies = tenantRows('generated_report_knowledge')
      .filter(row => row.report_kind === 'daily' ? dailyIds.has(String(row.report_id)) && dailyOwner.get(String(row.report_id)) === row.user_id
        : row.report_kind === 'weekly' && weeklyIds.has(String(row.report_id)) && weekOwner.get(String(row.report_id))?.user_id === row.user_id)
      .map(row => {
        const dependencies = repo.parseGeneratedKnowledgeDependencies(row.dependencies_json);
        return { ...pick(row, 'tenant_id report_kind report_id user_id created_at'), dependencies: dependencies ?? null, metadataValid: dependencies !== undefined };
      });
    const payload = {
      schemaVersion: 2 as const, generatedAt: now.toISOString(), tenantId: 'poc' as const, filters: { year, quarter, userId },
      boundary: { policy: 'complete-natural-weeks' as const, requestedFrom, requestedToExclusive, includedFrom, includedToExclusive, timezone: 'Asia/Shanghai' as const,
        explanation: '按所选日历区间覆盖的完整自然周归档，边界可能含前后季度或年度的依赖事实。所有已保留日报和周报版本、事项及目标修订、原因和反馈修订均包含；不按修订发生时间截断。' },
      exclusions: ['这是业务事实档案，不是完整数据库备份，不含自动恢复程序。', '不含身份绑定码、企微账号标识、密码、会话、访问授权、发送队列或运行租约。',
        '附件仅导出名称与记录关联清单，不读取文件，不含原存储路径、下载链接或文件本体。', '操作日志只导出所选事实资源的事件元数据，不导出可能含敏感值的自由格式details。',
        'SHA-256仅校验导出内容完整性，不是签名或来源真实性认证。'],
      people, dailyReports, sourceMessages, sourceLinks, dailyQuality, reportPresentations, weeklyReports, workItems, workItemRevisions,
      metrics, metricRevisions, weeklyInstances, weeklyEvidence, reasons, reasonRevisions, feedback, feedbackRevisions, auditLogs, attachments, templates, generatedKnowledgeDependencies,
    };
    const tables = Object.fromEntries(Object.entries(payload).filter(([key, value]) => Array.isArray(value) && key !== 'exclusions')
      .map(([key, value]) => [key, { count: (value as unknown[]).length, sha256: hash(value) }]));
    const result = { ...payload, manifest: { algorithm: 'SHA-256' as const, serialization: 'sorted-keys-json-utf8' as const, signed: false as const, payloadHash: hash(payload), tables } };
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); throw error; }
}

function attachmentList(source: Row): Row[] {
  return array(parsed(source.attachments_json)).map((attachment, index) => {
    const name = typeof attachment.name === 'string' ? attachment.name.replace(/\\/g, '/').split('/').at(-1)!.split(/[?#]/)[0].replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 500) : '未命名附件';
    return { sourceMessageId: source.id, userId: source.user_id, date: source.report_date, index, name: name || '未命名附件',
      kind: ['file', 'image', 'voice', 'voice_transcript'].includes(String(attachment.kind)) ? attachment.kind : 'file' };
  });
}
function projectedSnapshot(value: unknown, report: Row): string | null {
  const snapshot = object(parsed(value));
  if (!snapshot || snapshot.tenantId !== 'poc' || snapshot.userId !== report.user_id || snapshot.weekId !== report.week_id) return null;
  const own = (row: Row) => row.tenant_id === 'poc' && row.user_id === report.user_id;
  const items = array(snapshot.items).filter(row => own(row) && row.week_id === report.week_id).map(row => pick(row, columns.workItems));
  const itemIds = ids(items);
  const confirmed = array(snapshot.confirmed).filter(row => own(row) && typeof row.report_date === 'string' && monday(row.report_date) === report.week_id)
    .map(row => pick(row, columns.dailyReports));
  const reasons = array(snapshot.reasons).filter(row => row.userId === report.user_id && row.weekId === report.week_id)
    .map(row => pick(row, 'id userId weekId workItemId content version createdAt updatedAt'));
  const metrics = array(snapshot.metrics).filter(row => row.tenant_id === 'poc' && itemIds.has(String(row.work_item_id))).map(row => pick(row, columns.metrics));
  const template = object(snapshot.template);
  return JSON.stringify({ schemaVersion: 1, tenantId: 'poc', userId: report.user_id, weekId: report.week_id, confirmed, items, reasons, metrics,
    template: template?.tenant_id === 'poc' ? pick(template, 'id tenant_id kind name version content active created_at') : null,
    businessRules: object(snapshot.businessRules) ? pick(snapshot.businessRules as Row, 'weekBoundary progressMode') : {} });
}
function projectedProgress(value: unknown, report: Row, itemIds: Set<string>, dailyIds: Set<string>): string | null {
  if (value === null || value === undefined) return null;
  const progress = object(parsed(value));
  if (!progress || progress.userId !== report.user_id || progress.weekId !== report.week_id) return null;
  return JSON.stringify({ ...pick(progress, 'userId weekId dates questions'),
    items: array(progress.items).filter(item => itemIds.has(String(item.workItemId))).map(item => pick(item, 'workItemId name retired metric days questions')),
    sourceReportIds: Array.isArray(progress.sourceReportIds) ? progress.sourceReportIds.filter(id => dailyIds.has(String(id))) : [] });
}

/** Verification after JSON round-trip/download; no claim of signature authenticity. */
export function verifyStructuredArchive(value: unknown): boolean {
  const root = object(value), manifest = root && object(root.manifest);
  if (!root || root.schemaVersion !== 2 || !manifest || manifest.algorithm !== 'SHA-256' || manifest.serialization !== 'sorted-keys-json-utf8' || manifest.signed !== false) return false;
  const { manifest: _manifest, ...payload } = root;
  if (manifest.payloadHash !== hash(payload)) return false;
  const tables = object(manifest.tables);
  if (!tables) return false;
  const actualNames = Object.entries(payload).filter(([key, rows]) => Array.isArray(rows) && key !== 'exclusions').map(([key]) => key).sort();
  if (canonical(Object.keys(tables).sort()) !== canonical(actualNames)) return false;
  return actualNames.every(name => { const entry = object(tables[name]); return !!entry && Array.isArray(payload[name]) && entry.count === payload[name].length && entry.sha256 === hash(payload[name]); });
}
