import { randomUUID } from 'node:crypto';
import type { DailyExtractResult, DailyItemProgress, SourceRecordContext, WorkItemContext } from '@wecom/agent';
import { weekId as mondayOf } from '@wecom/domain';
import * as repo from '@wecom/persistence';
import type { AccessActor, DailyReportRow, Db, WorkItemRow } from '@wecom/persistence';
import { splitPlanEntry } from './plan-target';

export interface ItemMetric {
  workItemId: string;
  mode: 'count' | 'percent';
  total: number | null;
  unit: string;
  rounding: 'floor' | 'round';
  version: number;
  updatedAt: string;
}
export interface SetItemMetricInput {
  mode: 'count' | 'percent';
  total?: number | null;
  unit?: string;
  rounding?: 'floor' | 'round';
  expectedVersion: number;
}
export interface ProgressDay {
  date: string;
  progressText?: string;
  reported?: boolean;
  progressValue: number | null;
  completedCount: number | null;
  completedKeys: string[];
  carried: boolean;
  reportId?: string;
  reportVersion?: number;
}
export interface WeeklyProgressItem {
  workItemId: string;
  name: string;
  planBackground?: string;
  retired: boolean;
  metric: ItemMetric | null;
  days: ProgressDay[];
  questions: string[];
}
export interface WeeklyProgress {
  weekId: string;
  userId: string;
  dates: string[];
  items: WeeklyProgressItem[];
  questions: string[];
  sourceReportIds: string[];
}
export interface ProgressWorkItemContext extends WorkItemContext { metric?: ItemMetric | null }

export function ensureProgressSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_item_metric (
    tenant_id TEXT NOT NULL REFERENCES tenant(id), work_item_id TEXT NOT NULL REFERENCES work_item(id),
    mode TEXT NOT NULL CHECK(mode IN ('count','percent')), total REAL,
    unit TEXT NOT NULL DEFAULT '', rounding TEXT NOT NULL DEFAULT 'floor' CHECK(rounding IN ('floor','round')),
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id,work_item_id),
    CHECK((mode='count' AND total IS NOT NULL AND total>0 AND total=CAST(total AS INTEGER)) OR (mode='percent' AND total IS NULL))
  );
  CREATE TABLE IF NOT EXISTS work_item_metric_revision (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), work_item_id TEXT NOT NULL REFERENCES work_item(id),
    version INTEGER NOT NULL, metric_json TEXT NOT NULL, actor_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(tenant_id,work_item_id,version)
  );`);
}

export function getItemMetric(db: Db, workItemId: string, tenantId = 'poc'): ItemMetric | undefined {
  ensureProgressSchema(db);
  const row = db.prepare(`SELECT m.* FROM work_item_metric m JOIN work_item w ON w.id=m.work_item_id AND w.tenant_id=m.tenant_id
    WHERE m.tenant_id=? AND m.work_item_id=?`).get(tenantId, workItemId);
  return row ? { workItemId: String(row.work_item_id), mode: row.mode as ItemMetric['mode'], total: row.total === null ? null : Number(row.total),
    unit: String(row.unit), rounding: row.rounding as ItemMetric['rounding'], version: Number(row.version), updatedAt: String(row.updated_at) } : undefined;
}

/** First write expects version 0; only the current active owner can change their target. */
export function setItemMetric(db: Db, actor: AccessActor, workItemId: string, input: SetItemMetricInput): ItemMetric {
  ensureProgressSchema(db);
  const tenantId = actor.tenantId ?? 'poc';
  const current = repo.activeUser(db, actor.userId, tenantId);
  const item = repo.getWorkItem(db, workItemId, tenantId);
  if (actor.resourceId || !current || current.role !== actor.role || !item || item.user_id !== current.id) throw new Error('只有事项本人可以设置进度目标');
  if (item.deleted) throw new Error('退役事项不能调整目标，历史进度仍保留');
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['mode', 'total', 'unit', 'rounding', 'expectedVersion'].includes(key))) throw new Error('目标配置包含不支持的字段');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('expectedVersion必须为非负整数');
  if (!['count', 'percent'].includes(input.mode)) throw new Error('进度模式必须是count或percent');
  const total = input.mode === 'count' ? input.total : null;
  if (input.mode === 'count' && (typeof total !== 'number' || !Number.isInteger(total) || total <= 0 || total > 1_000_000)) throw new Error('计数目标须明确填写大于0的整数总数');
  if (input.mode === 'percent' && input.total != null) throw new Error('百分比模式不接受总数');
  const unit = input.unit ?? (input.mode === 'percent' ? '%' : '');
  if (typeof unit !== 'string' || !unit.trim() || unit.trim().length > 20 || /[\p{Cc}\p{Cf}]/u.test(unit)) throw new Error('请填写1—20字计量单位');
  if (input.rounding !== undefined && !['floor', 'round'].includes(input.rounding)) throw new Error('取整规则无效');
  const metric: ItemMetric = { workItemId, mode: input.mode, total: total ?? null, unit: unit.trim(), rounding: input.rounding ?? 'floor',
    version: input.expectedVersion + 1, updatedAt: new Date().toISOString() };
  // SAVEPOINT composes safely with app-level transactions and keeps audit atomic.
  const savepoint = `metric_${randomUUID().replaceAll('-', '')}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const before = getItemMetric(db, workItemId, tenantId);
    if ((before?.version ?? 0) !== input.expectedVersion) throw new Error('目标已被修改，请刷新后重试');
    db.prepare(`INSERT INTO work_item_metric(tenant_id,work_item_id,mode,total,unit,rounding,version,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,work_item_id) DO UPDATE SET mode=excluded.mode,total=excluded.total,unit=excluded.unit,rounding=excluded.rounding,version=excluded.version,updated_at=excluded.updated_at`)
      .run(tenantId, workItemId, metric.mode, metric.total, metric.unit, metric.rounding, metric.version, metric.updatedAt);
    db.prepare('INSERT INTO work_item_metric_revision(id,tenant_id,work_item_id,version,metric_json,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), tenantId, workItemId, metric.version, JSON.stringify(metric), actor.userId, metric.updatedAt);
    repo.insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: actor.userId, action: 'work_item.metric_updated', resource_type: 'work_item', resource_id: workItemId,
      details_json: JSON.stringify({ before: before ?? null, after: metric }), created_at: metric.updatedAt });
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return metric;
  } catch (error) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); throw error; }
}

function datesOf(week: string): string[] {
  const date = new Date(`${week}T04:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== week || mondayOf(date) !== week) throw new Error('weekId必须是真实日期且为该周周一');
  return Array.from({ length: 7 }, (_, offset) => new Date(date.getTime() + offset * 86_400_000).toISOString().slice(0, 10));
}
function validNumber(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max; }
function validCount(value: unknown): value is number { return validNumber(value, 1_000_000) && Number.isInteger(value); }
function keys(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 1000 && value.every(key => typeof key === 'string' && key.trim() === key && !!key && key.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(key))
    ? [...new Set(value)] as string[] : undefined;
}
function metricValid(metric: ItemMetric | null | undefined): metric is ItemMetric {
  return !!metric && ['floor', 'round'].includes(metric.rounding) && (metric.mode === 'percent' && metric.total === null || metric.mode === 'count' && validCount(metric.total) && metric.total > 0);
}
function percentage(count: number, metric: ItemMetric): number {
  const exact = Math.min(100, count * 100 / metric.total!);
  return metric.rounding === 'round' ? Math.round(exact) : Math.floor(exact);
}
function progressArray(report: DailyReportRow): DailyItemProgress[] {
  try { const data: unknown = JSON.parse(report.progress_json ?? '[]'); return Array.isArray(data) ? data.filter(item => item && typeof item === 'object') as DailyItemProgress[] : []; }
  catch { return []; }
}

/** Pure replay: callers may freeze items/metrics/reports in a weekly version for immutable historical charts. */
export function buildProgressFromSources(userId: string, week: string, workItems: readonly WorkItemRow[], metrics: readonly ItemMetric[], reports: readonly DailyReportRow[], tenantId = 'poc'): WeeklyProgress {
  const dates = datesOf(week);
  const effective = new Map<string, DailyReportRow>();
  for (const report of reports) {
    if (report.tenant_id !== tenantId || report.user_id !== userId || report.status !== 'confirmed' || !dates.includes(report.report_date)) continue;
    const previous = effective.get(report.report_date);
    if (!previous || report.version > previous.version) effective.set(report.report_date, report);
  }
  const scoped = workItems.filter(item => item.tenant_id === tenantId && item.user_id === userId && item.week_id === week);
  const result: WeeklyProgress = { userId, weekId: week, dates, items: [], questions: [], sourceReportIds: dates.flatMap(date => effective.get(date)?.id ?? []) };
  const knownItems = new Set(scoped.map(item => item.id));
  for (const report of effective.values()) {
    try {
      if (!Array.isArray(JSON.parse(report.progress_json ?? '[]'))) result.questions.push(`${report.report_date}进度数据格式无效，请核对原日报`);
    } catch { result.questions.push(`${report.report_date}进度数据无法读取，请核对原日报`); }
    for (const row of progressArray(report)) if (!knownItems.has(row.workItemRef)) result.questions.push(`${report.report_date}存在不属于本周本人的事项，未计入进度`);
  }
  for (const item of scoped) {
    const metric = metrics.find(value => value.workItemId === item.id) ?? null;
    const questions: string[] = [];
    if (!metricValid(metric)) questions.push(`请为“${item.name}”配置明确的进度模式、总数和单位`);
    let value: number | null = null;
    let count: number | null = null;
    let anonymousSnapshot = false;
    const seen = new Set<string>(), active = new Set<string>();
    let evidence: { reportId: string; reportVersion: number } | undefined;
    const days = dates.map(date => {
      const report = effective.get(date);
      const entries = report ? progressArray(report).filter(row => row.workItemRef === item.id) : [];
      let changed = false;
      if (entries.length > 1) questions.push(`${date}“${item.name}”有重复事项结果，请合并核对后重新确认日报`);
      if (entries.length === 1 && metricValid(metric)) {
        const entry = entries[0];
        const added = entry.completedKeys === undefined ? [] : keys(entry.completedKeys);
        const removed = entry.retractedKeys === undefined ? [] : keys(entry.retractedKeys);
        const invalid = !added || !removed || entry.completedCount !== undefined && entry.completedCount !== null && !validCount(entry.completedCount)
          || entry.progressValue !== null && entry.progressValue !== undefined && !validNumber(entry.progressValue, 100);
        if (invalid) questions.push(`${date}“${item.name}”进度字段无效，未覆盖上一有效值`);
        else if (metric.mode === 'percent') {
          if (added.length || removed.length || entry.completedCount != null) questions.push(`${date}“${item.name}”是百分比模式，不能混入完成计数`);
          else if (validNumber(entry.progressValue, 100)) { value = entry.progressValue; changed = true; }
        } else if (entry.completedCount != null && (added.length || removed.length)) {
          questions.push(`${date}“${item.name}”同时提供累计数和完成键，请选一种明确口径`);
        } else if (entry.completedCount != null) {
          count = entry.completedCount;
          // A confirmed cumulative snapshot is authoritative, never an increment.
          if (count < active.size) active.clear();
          anonymousSnapshot = count > active.size;
          value = percentage(count, metric); changed = true;
        } else if (added.length || removed.length) {
          if (added.some(key => removed.includes(key))) questions.push(`${date}“${item.name}”同一完成键同时新增和撤销，未计入`);
          else if (anonymousSnapshot && added.some(key => !seen.has(key))) questions.push(`${date}“${item.name}”此前累计数缺少对象身份，请继续明确累计数，避免与完成键重复计数`);
          else {
            for (const key of removed) {
              if (active.delete(key)) { count = Math.max(0, (count ?? 0) - 1); changed = true; }
              else if (!seen.has(key)) questions.push(`${date}“${item.name}”撤销键“${key}”没有已确认完成事实，未扣减`);
            }
            for (const key of added) if (!seen.has(key)) { seen.add(key); active.add(key); count = (count ?? 0) + 1; changed = true; }
            if (count !== null) value = percentage(count, metric);
          }
        } else if (entry.progressValue != null) questions.push(`${date}“${item.name}”计数模式缺少稳定完成键或明确累计数，不能由模型百分比倒推`);
        if (changed) evidence = { reportId: report!.id, reportVersion: report!.version };
      }
      return { date, progressText: entries.map(entry=>entry.progressText).filter(Boolean).join('\n'), reported: Boolean(report), progressValue: value, completedCount: count, completedKeys: [...active].sort(), carried: !changed, ...evidence };
    });
    result.items.push({ workItemId: item.id, name: item.name, planBackground: item.plan_background, retired: !!item.deleted, metric, days, questions: [...new Set(questions)] });
    result.questions.push(...questions);
  }
  result.questions = [...new Set(result.questions)];
  return result;
}

/** Rebuilt exclusively from current confirmed sources; no mutable running total or LLM arithmetic. */
export function buildWeeklyProgress(db: Db, userId: string, week: string, tenantId = 'poc'): WeeklyProgress {
  const dates = datesOf(week);
  if (!repo.getUser(db, userId, tenantId)) throw new Error('人员不存在或不属于当前企业');
  ensureProgressSchema(db);
  const items = db.prepare('SELECT * FROM work_item WHERE tenant_id=? AND user_id=? AND week_id=? ORDER BY created_at,id').all(tenantId, userId, week) as unknown as WorkItemRow[];
  const metrics = items.flatMap(item => getItemMetric(db, item.id, tenantId) ?? []);
  const reports = repo.listDailyReportsInRange(db, userId, dates[0], dates[6], tenantId);
  return buildProgressFromSources(userId, week, items, metrics, reports, tenantId);
}

function escaped(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hasValue(text: string, value: number, kind: 'percent' | 'count', unit: string): boolean {
  return text.split(/[\n。；;，,]/u).some(clause => {
    if (/计划|准备|将要|拟|明天|下周|目标|预计|如果|假设|期望|希望/u.test(clause)) return false;
    if (/并非|不是|不等于|大概|大约|约莫|左右|超过|低于|高于|大于|小于|不到|不足|[<>＜＞≈~～]/u.test(clause)) return false;
    // Reject negated or comparative claims, and do not match 1% inside 11.1%.
    // An asserted exact snapshot is required, not a bound ("不到80%") or delta.
    if (kind === 'percent') {
      if (/尚未|还未|未达|不到|不足|未完成|没完成|没有完成|超过|低于|高于|大于|小于|增加|新增|提升|提高|下降|减少|降低|增幅|降幅/u.test(clause)) return false;
      return new RegExp(`(?:^|[^\\d.\\w+\\-−])${escaped(String(value))}\\s*[%％]`, 'u').test(clause);
    }
    if (value === 0 && /(?:尚未开始|还未开始|尚未完成任何|完成数[：:]?\s*0)/u.test(clause)) return true;
    if (/未完成|没完成|未走访|未开展|未学习|未梳理/u.test(clause)) return false;
    return new RegExp(`(?:累计|总计|合计|截至[^\\n。；;]{0,12})(?:已)?[^\\d\\n。；;+\\-−.]{0,12}${value}\\s*${escaped(unit)}`, 'u').test(clause);
  });
}
function evidenceForKey(text: string, key: string, retract: boolean): boolean {
  const present = new RegExp(`${/^[\w-]/u.test(key) ? '(?<![A-Za-z0-9_-])' : ''}${escaped(key)}${/[\w-]$/u.test(key) ? '(?![A-Za-z0-9_-])' : ''}`, 'u');
  const clauses = text.split(/[\n。；;]/u).filter(clause => present.test(clause));
  return clauses.some(clause => retract
    ? /撤销|撤回|取消完成|更正.*(?:未完成|没完成)/u.test(clause)
    : !/计划|准备|将要|拟|明天|下周|预计|如果|假设|期望|希望|尚未|未完成|没完成|未拜访|没有拜访|未走访|没有完成|没有走访|未开展|未学习|未梳理|取消|撤销|撤回/u.test(clause)
      && (!/^\d+$/u.test(key) || /完成键|完成编号/u.test(clause))
      && /完成|(?:已|今天|今日|本日)(?:经)?(?:拜访|走访)|(?:拜访|走访)了|已走访|走访\s*[0-9一二三四五六七八九十两]+家|已开展|开展\s*[0-9一二三四五六七八九十两]+场|已梳理|已学习|完成键/u.test(clause));
}

/** A named paragraph owns its following sentences, until another heading or ambiguous task resets it. */
function scopedEvidence(text: string, target: ProgressWorkItemContext, workItems: readonly ProgressWorkItemContext[]): string {
  const labels=workItems.map(item=>({id:item.id,name:splitPlanEntry(item.name).name}));
  let owner:string|undefined;
  const selected:string[]=[];
  for(const clause of text.split(/[\n。；;]/u)) {
    const trimmed=clause.trim();
    if(!trimmed)continue;
    const matched=labels.filter(item=>trimmed.includes(item.name)||(/企业走访|走访企业|企业拜访/.test(item.name)&&/拜访|走访/.test(trimmed)));
    if(matched.length) owner=matched.length===1?matched[0].id:undefined;
    else if(/^[^：:]{1,30}[：:]/u.test(trimmed)&&!/^(?:本周累计|累计|问题|下一步|补充|更正)[：:]/u.test(trimmed)) owner=undefined;
    if(owner===target.id)selected.push(clause);
  }
  return selected.join('\n');
}

/** Treat model numbers as claims requiring explicit raw-source evidence; structured UI values are separately authenticated by the caller. */
export function normalizeDailyProgress(result: DailyExtractResult, workItems: readonly ProgressWorkItemContext[], sources: readonly SourceRecordContext[], options: { structured?: boolean } = {}): DailyExtractResult {
  const missing = [...result.missingFields], risks = [...result.riskFlags];
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const duplicateIds = new Set(result.items.filter((item, index) => result.items.findIndex(other => other.workItemRef === item.workItemRef) !== index).map(item => item.workItemRef));
  const items: DailyItemProgress[] = [];
  for (const item of result.items) {
    const target = workItems.find(candidate => candidate.id === item.workItemRef);
    if (!target || duplicateIds.has(item.workItemRef)) { missing.push('请明确对应的本周事项，每个事项只提供一份合并结果'); continue; }
    const clean: DailyItemProgress = { workItemRef: item.workItemRef, progressText: typeof item.progressText === 'string' ? item.progressText : '', progressValue: null,
      progressType: typeof item.progressType === 'string' ? item.progressType : '其他', issues: Array.isArray(item.issues) ? item.issues.filter(x => typeof x === 'string') : [],
      nextActions: Array.isArray(item.nextActions) ? item.nextActions.filter(x => typeof x === 'string') : [], sourceRecordRefs: Array.isArray(item.sourceRecordRefs) ? [...new Set(item.sourceRecordRefs.filter(ref => sourceMap.has(ref)))] : [] };
    items.push(clean);
    if (!Array.isArray(item.sourceRecordRefs) || item.sourceRecordRefs.some(ref => typeof ref !== 'string' || !sourceMap.has(ref))) {
      missing.push(`“${target.name}”引用了未知原始记录，进度暂为未知`); continue;
    }
    if (!metricValid(target.metric)) { missing.push(`请为“${target.name}”设置计数总数和单位，或选择百分比模式`); continue; }
    const metric = target.metric;
    let text = clean.sourceRecordRefs.map(ref => sourceMap.get(ref)!.text).join('\n');
    if (!options.structured && !text) { missing.push(`“${target.name}”没有可核验的原始记录引用，进度暂为未知`); continue; }
    if (!options.structured && workItems.length > 1) {
      text=clean.sourceRecordRefs.map(ref=>scopedEvidence(sourceMap.get(ref)!.text,target,workItems)).filter(Boolean).join('\n');
      if (!text) { missing.push(`请明确“${splitPlanEntry(target.name).name}”本次做了什么、累计完成多少`); continue; }
    }
    const added = item.completedKeys === undefined ? [] : keys(item.completedKeys);
    const removed = item.retractedKeys === undefined ? [] : keys(item.retractedKeys);
    if (!added || !removed || item.completedCount != null && !validCount(item.completedCount) || item.progressValue != null && !validNumber(item.progressValue, 100)) {
      missing.push(`“${target.name}”进度字段类型或范围无效，请核对`); continue;
    }
    if (metric.mode === 'percent') {
      if (added.length || removed.length || item.completedCount != null) { missing.push(`“${target.name}”采用百分比快照，请勿混填计数`); continue; }
      if (item.progressValue == null) continue;
      if (options.structured || hasValue(text, item.progressValue, 'percent', metric.unit)) clean.progressValue = item.progressValue;
      else { missing.push(`请明确“${target.name}”目前累计百分比，未知不记为0`); risks.push(`已移除“${target.name}”缺少原文依据的百分比`); }
    } else {
      if (item.completedCount != null && (added.length || removed.length) || added.some(key => removed.includes(key))) { missing.push(`“${target.name}”请勿混用累计数与完成键，或同时新增撤销同一键`); continue; }
      // Prefer a unique, explicit cumulative snapshot in this item's raw paragraph.
      // The LLM may choose entity keys or omit the count despite the source spelling it out.
      const rawCounts=options.structured?[]:[...new Set([...text.matchAll(new RegExp(`(?<![\\d.])([0-9]+)\\s*${escaped(metric.unit)}`,'gu'))]
        .map(match=>Number(match[1])).filter(value=>validCount(value)&&hasValue(text,value,'count',metric.unit)))];
      const completedCount=item.completedCount??(rawCounts.length===1?rawCounts[0]:undefined);
      if (completedCount != null) {
        if (options.structured || hasValue(text, completedCount, 'count', metric.unit)) { clean.completedCount = completedCount; clean.progressValue = percentage(completedCount, metric); }
        else missing.push(`请明确“${target.name}”累计已完成多少${metric.unit}；当日新增数量不能当作累计数`);
      } else if (added.length || removed.length) {
        const supportedAdded = options.structured ? added : added.filter(key => evidenceForKey(text, key, false));
        const supportedRemoved = options.structured ? removed : removed.filter(key => evidenceForKey(text, key, true));
        if (supportedAdded.length !== added.length || supportedRemoved.length !== removed.length) {
          missing.push(`请核对“${target.name}”完成或撤销的具体对象，不能生成原文不存在的完成键`); risks.push(`“${target.name}”存在缺少实际完成依据的键，本项暂不计入`);
        } else { if (added.length) clean.completedKeys = added; if (removed.length) clean.retractedKeys = removed; }
      } else if (item.progressValue != null) missing.push(`请提供“${target.name}”稳定完成对象或明确累计完成数，系统不从百分比猜测完成数量`);
    }
  }
  if (!items.length && workItems.length) missing.push('请明确本条工作对应的本周事项，未明确的内容不会自动绑定到第一项');
  return { ...result, items, missingFields: [...new Set(missing)], riskFlags: [...new Set(risks)] };
}
