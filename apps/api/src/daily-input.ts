import type { DailyExtractResult, DailyItemProgress } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { weekId } from '@wecom/domain';
import { CrmError } from '../../../packages/persistence/src/crm';
import { getItemMetric } from './progress-ledger';
import type { DailyAssistantApp } from './app';

export function ensureDailyQualitySchema(db: repo.Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_quality (
    report_id TEXT PRIMARY KEY REFERENCES daily_report(id), tenant_id TEXT NOT NULL,
    questions_json TEXT NOT NULL, risk_flags_json TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
}
export function saveDailyQuality(db: repo.Db, reportId: string, result: DailyExtractResult, tenantId = 'poc'): void {
  ensureDailyQualitySchema(db);
  db.prepare('INSERT OR REPLACE INTO daily_quality VALUES(?,?,?,?,?)').run(reportId, tenantId,
    JSON.stringify(result.missingFields), JSON.stringify(result.riskFlags), new Date().toISOString());
}
export function dailyQuality(db: repo.Db, reportId: string, tenantId = 'poc') {
  ensureDailyQualitySchema(db);
  const row = db.prepare('SELECT questions_json,risk_flags_json FROM daily_quality WHERE report_id=? AND tenant_id=?').get(reportId, tenantId);
  return { questions: row ? JSON.parse(String(row.questions_json)) as string[] : [], riskFlags: row ? JSON.parse(String(row.risk_flags_json)) as string[] : [] };
}
export function progressTypes(db: repo.Db, tenantId = 'poc'): string[] {
  return repo.getConfig(db, 'progressTypes', ['走访', '活动', '其他'], tenantId);
}
function field(value: unknown, max: number, label: string, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new CrmError(`${label}格式无效`);
  return value.trim();
}
function keys(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 120 || /[\p{Cc}\p{Cf}]/u.test(x))) throw new CrmError(`${label}格式无效`);
  return [...new Set(value.map(x => String(x).trim()))];
}
/** Authoritative form facts still generate an immutable pending draft; they never silently confirm it. */
export async function submitStructuredDaily(app: DailyAssistantApp, actor: repo.AccessActor, body: Record<string, unknown>, requestId: string, now = new Date()): Promise<string> {
  const tenantId = actor.tenantId ?? 'poc', user = repo.activeUser(app.db, actor.userId, tenantId);
  if (actor.resourceId || !user || user.role !== actor.role || app.tenantId !== tenantId) throw new CrmError('当前身份不能填写日报', 403);
  if (Object.keys(body).some(key => !['date','summary','items','expectedReportId'].includes(key))) throw new CrmError('不支持的日报字段');
  const date = field(body.date, 10, '日期', true), instant = new Date(`${date}T04:00:00Z`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(instant.getTime()) || instant.toISOString().slice(0,10) !== date || date > today || weekId(instant) !== weekId(now)) throw new CrmError('只允许填写今天或本周之前真实日期的工作');
  if (!requestId.trim() || requestId.length > 200) throw new CrmError('缺少请求标识');
  const prior = repo.getSourceMessageByMsgId(app.db, `form:${requestId}`, tenantId);
  const summary = field(body.summary, 6000, '事实摘要', true);
  const allowed = new Map(repo.listWorkItems(app.db, actor.userId, weekId(instant), tenantId).map(item => [item.id,item]));
  if (!Array.isArray(body.items) || body.items.length > app.maxWorkItems || !body.items.length) throw new CrmError('请至少填写一个本人计划事项');
  const seen = new Set<string>(), kinds = progressTypes(app.db, tenantId);
  const items: DailyItemProgress[] = body.items.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CrmError('事项格式无效');
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !['workItemRef','progressText','progressValue','progressType','completedCount','completedKeys','retractedKeys'].includes(key))) throw new CrmError('不支持的进度字段');
    const ref = field(item.workItemRef, 120, '事项', true);
    if (!allowed.has(ref) || seen.has(ref)) throw new CrmError('事项必须属于本人本周且不能重复');
    seen.add(ref);
    const value = item.progressValue ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)) throw new CrmError('进度必须是0至100，未知请留空');
    const count = item.completedCount;
    if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1_000_000)) throw new CrmError('累计完成数必须为非负整数');
    const kind = field(item.progressType, 32, '进展类型', true);
    if (!kinds.includes(kind)) throw new CrmError('请选择当前可用进展类型');
    return { workItemRef:ref, progressText:field(item.progressText, 4000, '事项事实', true), progressValue:value,
      progressType:kind, issues:[], nextActions:[], sourceRecordRefs:[], ...(count === undefined?{}:{completedCount:count}),
      ...(item.completedKeys === undefined?{}:{completedKeys:keys(item.completedKeys,'完成对象')}),
      ...(item.retractedKeys === undefined?{}:{retractedKeys:keys(item.retractedKeys,'撤销对象')}) };
  });
  const payload = JSON.stringify({ summary, items });
  if (prior) {
    if (prior.user_id !== actor.userId || prior.report_date !== date || prior.text_content !== payload) throw new CrmError('同一请求标识不能提交不同日报', 409);
    if (prior.daily_report_id) return prior.daily_report_id;
  }
  const latest = repo.getLatestDailyReport(app.db, actor.userId, date, tenantId);
  if ((latest?.id ?? null) !== (body.expectedReportId ?? null)) throw new CrmError('日报已有更新，请刷新后核对再提交', 409);
  // Validate the complete user-entered snapshot against the configured metric
  // before creating any source message or draft. Normalization is deliberately
  // conservative, but must not silently discard authenticated form facts.
  for (const item of items) {
    const name = allowed.get(item.workItemRef)!.name, metric = getItemMetric(app.db, item.workItemRef, tenantId);
    if (!metric) throw new CrmError(`请先设置“${name}”的进度口径，再填写事项进展`);
    if (!['floor', 'round'].includes(metric.rounding) || !Number.isInteger(metric.version) || metric.version < 1
      || typeof metric.unit !== 'string' || !metric.unit.trim() || metric.unit.length > 20 || /[\p{Cc}\p{Cf}]/u.test(metric.unit)
      || !(metric.mode === 'percent' && metric.total === null || metric.mode === 'count' && Number.isInteger(metric.total) && Number(metric.total) > 0 && Number(metric.total) <= 1_000_000)) {
      throw new CrmError(`“${name}”的进度口径无效，请先重新设置`);
    }
    const added = item.completedKeys ?? [], removed = item.retractedKeys ?? [];
    if (metric.mode === 'percent') {
      if (item.completedCount !== undefined || added.length || removed.length) throw new CrmError(`“${name}”采用百分比口径，不能混填累计完成数或完成、撤销对象`);
    } else {
      if (item.progressValue !== null) throw new CrmError(`“${name}”采用计数口径，请填写累计完成数或完成对象，百分比由系统计算`);
      if (item.completedCount !== undefined && (added.length || removed.length)) throw new CrmError(`“${name}”不能同时填写累计完成数和完成、撤销对象，请选择一种计数方式`);
      if (added.some(key => removed.includes(key))) throw new CrmError(`“${name}”不能同时完成和撤销同一个对象`);
    }
  }
  return app.submitRecord(actor.userId, date, payload, { messageId:`form:${requestId}`,
    structuredResult:{schemaVersion:1,summary,items,missingFields:[],riskFlags:[]} });
}
