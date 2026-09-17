import { createHash, randomUUID } from 'node:crypto';
import type { Agent, DailyExtractResult } from '@wecom/agent';
import {
  assertTransition,
  defaults,
  isExplicitConfirmation,
  isItemLocked,
  isValidFeedback,
  missingDaysOfWeek,
  sundayOf,
  weekId,
  type ConfirmationSource,
  type WeekBoundary,
} from '@wecom/domain';
import type { Db } from '@wecom/persistence';
import { inTransaction } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { getItemMetric, setItemMetric, normalizeDailyProgress, buildWeeklyProgress } from './progress-ledger';
import { planTarget, splitPlanEntry } from './plan-target';
import { dailyQuality, progressTypes, saveDailyQuality } from './daily-input';
import { matchDailyCompanies, linkConfirmedCompanies } from './daily-companies';
import { startWeeklyGeneration, commitWeeklyGeneration, abortWeeklyGeneration, saveWeeklyFeedback } from './weekly-workflow';

const iso = (d = new Date()) => d.toISOString();
const dateAt = (ymd: string) => new Date(`${ymd}T04:00:00Z`);
const weekIdOf = (ymd: string) => weekId(dateAt(ymd));

function validateDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(dateAt(value).getTime()) || dateAt(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`日期格式无效：${value}`);
  }
}

export interface AppOptions {
  tenantId?: string;
  weekBoundary?: WeekBoundary;
  maxWorkItems?: number;
}

export interface SubmitRecordOptions {
  /** Explicitly re-extract existing raw messages; no synthetic message is inserted. */
  reprocess?: boolean;
  reprocessKey?: string;
  messageId?: string;
  contentType?: 'text' | 'voice' | 'mixed' | 'image' | 'file';
  quotedText?: string;
  attachments?: Array<{ kind: string; name: string; path?: string }>;
  editingReportId?: string;
  /** Internal only: validated, explicitly user-entered structured progress. Never pass raw HTTP JSON here. */
  structuredResult?: DailyExtractResult;
}

export interface DailyPresentation {
  report: repo.DailyReportRow;
  stateVersion: number;
  contentHash: string;
}
type KnowledgeDependency = { id: string; version: number };

function dailyContentHash(row: repo.DailyReportRow): string {
  return createHash('sha256').update(JSON.stringify([
    row.tenant_id, row.user_id, row.id, row.report_date, row.version, row.summary, row.progress_json,
  ])).digest('hex');
}

export class DailyAssistantApp {
  readonly tenantId: string;
  private readonly weekBoundaryFallback: WeekBoundary;
  private readonly maxWorkItemsFallback: number;

  constructor(
    readonly db: Db,
    readonly agent: Agent,
    options: AppOptions = {},
  ) {
    this.tenantId = options.tenantId ?? 'poc';
    this.weekBoundaryFallback = options.weekBoundary ?? defaults.weekBoundary;
    this.maxWorkItemsFallback = options.maxWorkItems ?? defaults.maxWorkItems;
    if (!repo.hasConfig(db, 'weekBoundary', this.tenantId)) repo.setConfig(db, 'weekBoundary', this.weekBoundaryFallback, this.tenantId);
    if (!repo.hasConfig(db, 'maxWorkItems', this.tenantId)) repo.setConfig(db, 'maxWorkItems', this.maxWorkItemsFallback, this.tenantId);
    db.exec(`CREATE TABLE IF NOT EXISTS generated_report_knowledge (
      tenant_id TEXT NOT NULL REFERENCES tenant(id), report_kind TEXT NOT NULL CHECK(report_kind IN ('daily','weekly')),
      report_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES app_user(id), dependencies_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,report_kind,report_id)
    );`);
  }

  get weekBoundary(): WeekBoundary {
    const value = repo.getConfig(this.db, 'weekBoundary', this.weekBoundaryFallback, this.tenantId);
    return value === 'work_week' ? 'work_week' : 'natural_week';
  }

  get maxWorkItems(): number {
    const value = repo.getConfig(this.db, 'maxWorkItems', this.maxWorkItemsFallback, this.tenantId);
    return Number.isInteger(value) && value > 0 && value <= 100 ? value : this.maxWorkItemsFallback;
  }

  private knowledgeFor(text: string, userId: string, limit = 8) {
    const user = this.requireActiveUser(userId);
    // A person's report uses the same personal-view knowledge scope as their
    // workspace. Matching a title or tag never grants access to a document.
    const entries = repo.listKnowledgeEntries(this.db, { active: true }, this.tenantId);
    const readable = new Set(repo.filterReadableKnowledge(this.db,
      { userId, role: user.role, tenantId: this.tenantId }, entries, { view: 'personal' }).map((entry) => entry.id));
    const haystack = text.toLowerCase();
    return entries.filter((entry) => readable.has(entry.id))
      .map((entry) => {
        let tags: string[] = [];
        try {
          const parsed = JSON.parse(entry.tags_json) as unknown;
          if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
        } catch { tags = []; }
        const titleMatch = haystack.includes(entry.title.toLowerCase()) ? 8 : 0;
        const tagMatches = tags.filter((tag) => tag && haystack.includes(tag.toLowerCase())).length * 3;
        const baseline = entry.kind === 'service_company' ? 0 : 1;
        return { entry, score: titleMatch + tagMatches + baseline };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.entry.updated_at.localeCompare(left.entry.updated_at))
      .slice(0, limit)
      .map(({ entry }) => ({
        id: entry.id, kind: entry.kind, title: entry.title,
        content: `${entry.summary}${entry.summary ? '\n' : ''}${entry.content}`.slice(0, 12_000),
        version: entry.version,
      }));
  }

  private requireActiveUser(userId: string): repo.UserRow {
    const user = repo.activeUser(this.db, userId, this.tenantId);
    if (!user) throw new Error('人员不存在或已停用，不能生成、展示或确认新内容');
    return user;
  }

  /** Recheck only the exact selected knowledge IDs in the same personal scope. */
  private assertKnowledgeCurrent(userId: string, dependencies: readonly KnowledgeDependency[]): void {
    const user = this.requireActiveUser(userId);
    if (!dependencies.length) return;
    const readable = new Map(repo.filterReadableKnowledge(this.db, {userId,role:user.role,tenantId:this.tenantId},
      dependencies.map(item => ({id:item.id,tenant_id:this.tenantId})), {view:'personal'}).map(item => [item.id,item.version]));
    if (dependencies.some(item => readable.get(item.id) !== item.version)) {
      throw new Error('本次使用的知识资料权限或版本已变化，请重新生成；旧内容未作为新结果发布或确认');
    }
  }

  private saveKnowledgeDependencies(userId: string, reportId: string, kind: 'daily'|'weekly', dependencies: readonly KnowledgeDependency[]): void {
    this.db.prepare('INSERT INTO generated_report_knowledge(tenant_id,report_kind,report_id,user_id,dependencies_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(this.tenantId,kind,reportId,userId,JSON.stringify(dependencies.map(({id,version}) => ({id,version}))),iso());
  }

  private storedKnowledgeDependencies(userId: string, reportId: string, kind: 'daily'|'weekly'): KnowledgeDependency[] {
    const stored = this.db.prepare('SELECT dependencies_json FROM generated_report_knowledge WHERE tenant_id=? AND report_kind=? AND report_id=? AND user_id=?')
      .get(this.tenantId,kind,reportId,userId);
    return stored ? JSON.parse(String(stored.dependencies_json)) as KnowledgeDependency[] : [];
  }

  /** Missing metadata means a legacy report, not proof that it never used knowledge. Its body is not rewritten. */
  assertReportKnowledge(userId: string, reportId: string, kind: 'daily'|'weekly'): void {
    this.requireActiveUser(userId);
    const report = kind === 'daily' ? repo.getDailyReportById(this.db,reportId,this.tenantId) : repo.getWeeklyReportById(this.db,reportId,this.tenantId);
    if (!report || report.user_id !== userId) throw new Error('报告不存在或无权操作');
    this.assertKnowledgeCurrent(userId,this.storedKnowledgeDependencies(userId,reportId,kind));
  }

  ensureUser(userId: string, name = userId): void {
    if (!repo.getUser(this.db, userId, this.tenantId)) {
      repo.upsertUser(this.db, { id: userId, wecom_userid: userId, name, tenant_id: this.tenantId });
    }
  }

  createWeeklyPlan(
    userId: string,
    weekIdStr: string,
    items: Array<{ name: string; planBackground: string }>,
    nowValue = new Date(),
  ): void {
    validateDate(weekIdStr);
    if (weekIdOf(weekIdStr) !== weekIdStr) throw new Error('weekId必须是该周周一');
    this.ensureUser(userId);
    const existing = repo.listWorkItems(this.db, userId, weekIdStr, this.tenantId).length;
    if (items.length === 0) throw new Error('周计划至少包含一个事项');
    if (existing + items.length > this.maxWorkItems) {
      throw new Error(`每周事项最多 ${this.maxWorkItems} 项`);
    }
    const now = iso(nowValue);
    inTransaction(this.db, () => {
      for (const item of items) {
        const name = item.name.trim();
        if (!name) throw new Error('事项名称不能为空');
        const itemId = randomUUID();
        repo.insertWorkItem(this.db, {
          id: itemId,
          tenant_id: this.tenantId,
          user_id: userId,
          week_id: weekIdStr,
          name,
          plan_background: item.planBackground.trim(),
          created_at: now,
          deleted: 0,
          actor_user_id: userId,
        });
        const target = planTarget(name, item.planBackground.trim());
        if(target) setItemMetric(this.db,{userId,role:this.requireActiveUser(userId).role,tenantId:this.tenantId},itemId,{mode:'count',...target,expectedVersion:0});
      }
      repo.insertAudit(this.db, {
        id: randomUUID(), tenant_id: this.tenantId, actor_user_id: userId,
        action: 'weekly_plan.items_added', resource_type: 'week_cycle', resource_id: `${userId}:${weekIdStr}`,
        details_json: JSON.stringify({ count: items.length }), created_at: now,
      });
    });
  }

  updateWeeklyPlanItem(
    actorUserId: string,
    itemId: string,
    expectedVersion: number,
    values: { name: string; planBackground: string },
    now = new Date(),
  ): repo.WorkItemRow {
    const item = repo.getWorkItem(this.db, itemId, this.tenantId);
    if (!item || item.deleted) throw new Error('事项不存在');
    if (weekId(now) !== item.week_id) throw new Error('只能修改本周事项');
    const name = values.name.trim();
    if (!name) throw new Error('事项名称不能为空');
    const at = iso(now);
    return inTransaction(this.db, () => {
      const updated = repo.updateWorkItem(this.db, item, expectedVersion, {
        name,
        plan_background: values.planBackground.trim(),
        actor_user_id: actorUserId,
        updated_at: at,
      });
      repo.insertAudit(this.db, {
        id: randomUUID(), tenant_id: this.tenantId, actor_user_id: actorUserId,
        action: 'weekly_plan.item_updated', resource_type: 'work_item', resource_id: item.id,
        details_json: JSON.stringify({ fromVersion: expectedVersion, toVersion: updated.version }), created_at: at,
      });
      return updated;
    });
  }

  deleteWeeklyPlanItem(actorUserId: string, itemId: string, expectedVersion: number, now = new Date()): void {
    const item = repo.getWorkItem(this.db, itemId, this.tenantId);
    if (!item || item.deleted) throw new Error('事项不存在');
    if (weekId(now) !== item.week_id) throw new Error('只能删除本周事项');
    if (isItemLocked({
      id: item.id,
      name: item.name,
      planBackground: item.plan_background,
      createdAt: new Date(item.created_at),
    }, now)) throw new Error('周一设定的事项从周二起已锁定，只能追加或保留版本修改');
    const at = iso(now);
    inTransaction(this.db, () => {
      repo.deleteWorkItem(this.db, item, expectedVersion, actorUserId, at);
      repo.insertAudit(this.db, {
        id: randomUUID(), tenant_id: this.tenantId, actor_user_id: actorUserId,
        action: 'weekly_plan.item_deleted', resource_type: 'work_item', resource_id: item.id,
        details_json: JSON.stringify({ fromVersion: expectedVersion }), created_at: at,
      });
    });
  }

  /** 原始消息先幂等落库；Agent失败时也保留原文供重试。 */
  async submitRecord(
    userId: string,
    reportDate: string,
    text: string,
    options: SubmitRecordOptions = {},
  ): Promise<string> {
    validateDate(reportDate);
    this.ensureUser(userId);
    this.requireActiveUser(userId);
    if (options.editingReportId) this.assertInteractiveEditDate(userId,this.ownedDailyReport(userId,options.editingReportId));
    const messageId = options.messageId ?? `local:${randomUUID()}`;
    const regenerationAuditId=options.reprocess&&options.reprocessKey?`daily-reprocess:${createHash('sha256').update(JSON.stringify([this.tenantId,userId,options.reprocessKey])).digest('hex')}`:undefined;
    const submission = inTransaction(this.db, () => {
      if (options.editingReportId) {
        const edit = this.ownedDailyReport(userId, options.editingReportId);
        if (edit.report_date !== reportDate || edit.status !== 'pending_confirmation'
          || repo.getLatestDailyReport(this.db, userId, reportDate, this.tenantId)?.id !== edit.id) {
          throw new Error('原日报草稿已更新，请查看最新日报草稿后再修改');
        }
      }
      const stored = repo.insertSourceMessage(this.db, {
        id: randomUUID(),
        tenant_id: this.tenantId,
        msg_id: messageId,
        user_id: userId,
        report_date: reportDate,
        content_type: options.contentType ?? 'text',
        text_content: text,
        quoted_text: options.quotedText ?? null,
        attachments_json: JSON.stringify(options.attachments ?? []),
        process_status: 'received',
        process_error: null,
        daily_report_id: null,
        created_at: iso(),
      });
      if (stored.row.user_id !== userId || stored.row.report_date !== reportDate) throw new Error('消息标识与原记录不一致');
      if(regenerationAuditId) {
        const replay=this.db.prepare('SELECT resource_id FROM audit_log WHERE id=? AND tenant_id=?').get(regenerationAuditId,this.tenantId) as {resource_id:string}|undefined;
        if(replay)return {stored,reportId:replay.resource_id,revision:0};
      }
      if (!stored.inserted && stored.row.daily_report_id && !options.reprocess) return { stored, reportId: stored.row.daily_report_id, revision: 0 };
      if (!stored.inserted && stored.row.process_status !== 'agent_failed') {
        const current = repo.getDailyGeneration(this.db, this.tenantId, userId, reportDate);
        // A crashed invocation can be retried after its bounded lease expires.
        if (current?.status === 'running' && Date.now() - Date.parse(current.updated_at) < 5 * 60_000) {
          throw new Error('该消息正在处理中，请稍后查看日报结果');
        }
      }
      this.db.prepare(`UPDATE source_message SET process_status='received', process_error=NULL
        WHERE id=? AND daily_report_id IS NULL`).run(stored.row.id);
      return { stored, reportId: undefined, revision: repo.beginDailyGeneration(this.db, this.tenantId, userId, reportDate, iso()) };
    });
    if (submission.reportId) return submission.reportId;
    const { stored, revision } = submission;
    const failGeneration = (error: unknown) => inTransaction(this.db, () => {
      repo.finishDailyGeneration(this.db,this.tenantId,userId,reportDate,revision,'failed',iso());
      this.db.prepare(`UPDATE source_message SET process_status='agent_failed', process_error=?
        WHERE id=? AND daily_report_id IS NULL`).run(error instanceof Error ? error.message : String(error),stored.row.id);
    });

    const wk = weekIdOf(reportDate);
    const {workItems,sources,dailyTemplate,knowledgeSnippets} = (() => {
    try {
    const workItems = repo.listWorkItems(this.db, userId, wk, this.tenantId).map((item) => ({
      id: item.id,
      name: splitPlanEntry(item.name).name,
      planBackground: item.plan_background||splitPlanEntry(item.name).planBackground,
      metric: getItemMetric(this.db, item.id, this.tenantId),
    }));
    const sources = repo.listSourceMessages(this.db, userId, reportDate, this.tenantId);
    const dailyTemplate = repo.getActiveTemplate(this.db, 'daily', this.tenantId);
    // The structured form never calls an LLM; do not invent unused knowledge dependencies.
    // Recording facts does not require policy/park retrieval; explicit explanatory requests do.
    const sourceText=sources.map(source=>source.text_content).join('\n');
    const needsReference=/(?:查询|查一下|解释|解读|请参考|依据|对照).{0,12}(?:政策|园区|资料|规则)/u.test(sourceText);
    // Retain linked-company context and its revocation checks; just lower the ordinary retrieval budget.
    const knowledgeSnippets = options.structuredResult ? [] : this.knowledgeFor(sourceText, userId, needsReference ? 8 : 2);
    return {workItems,sources,dailyTemplate,knowledgeSnippets};
    } catch(error) { failGeneration(error); throw error; }
    })();

    let result;
    try {
      const response = options.structuredResult ? { taskType: 'daily_record_extract' as const, result: options.structuredResult } : await this.agent.run({
        schemaVersion: 1,
        requestId: randomUUID(),
        idempotencyKey: messageId,
        tenantId: this.tenantId,
        taskType: 'daily_record_extract',
        actor: { role: 'employee', userRef: userId },
        context: {
          timezone: 'Asia/Shanghai',
          weekId: wk,
          workItems,
          progressTypes: progressTypes(this.db, this.tenantId),
          template: dailyTemplate ? { version: String(dailyTemplate.version), content: dailyTemplate.content } : undefined,
          sourceRecords: sources.map((source) => ({ id: source.id, text: source.text_content, date: source.report_date })),
          knowledgeSnippets,
          businessRules: { progressMode: repo.getConfig(this.db, 'progressMode', defaults.progressMode, this.tenantId) },
        },
        input: {
          text: sources.map((source) => source.text_content).filter(Boolean).join('\n'),
          quotedText: options.quotedText,
          attachments: (options.attachments ?? []).map((attachment) => ({
            kind: attachment.kind === 'voice' ? 'voice_transcript' : attachment.kind === 'image' ? 'image' : 'file',
            name: attachment.name,
            summary: '',
          })),
        },
      });
      if (response.taskType !== 'daily_record_extract') throw new Error(`意外任务结果：${response.taskType}`);
      if(response.result.items.some(item=>!progressTypes(this.db,this.tenantId).includes(item.progressType))) throw new Error('进展类型不在当前配置中，请修改后重试');
      result = normalizeDailyProgress(response.result, workItems, sources.map(source => ({id:source.id,text:source.text_content,date:source.report_date})), { structured: Boolean(options.structuredResult) });
      if (options.structuredResult) for (const item of result.items) item.sourceRecordRefs = [stored.row.id];
      result = matchDailyCompanies(this.db, userId, result, sources.map(source => ({id:source.id,text:source.text_content,date:source.report_date})), this.tenantId);
    } catch (error) {
      failGeneration(error);
      throw error;
    }

    const now = iso();
    try {
    if (options.editingReportId) this.assertInteractiveEditDate(userId,this.ownedDailyReport(userId,options.editingReportId));
    const reportId = inTransaction(this.db, () => {
      this.assertKnowledgeCurrent(userId,knowledgeSnippets);
      if (!repo.finishDailyGeneration(this.db, this.tenantId, userId, reportDate, revision, 'completed', now)) {
        throw new Error('已有更新的工作记录正在整理或已生成，请查看最新日报草稿');
      }
      const latest = repo.getLatestDailyReport(this.db, userId, reportDate, this.tenantId);
      const targetId = randomUUID();
      // Replaced drafts can be retired now; confirmed facts stay effective until confirmation.
      if (latest && ['collecting', 'draft', 'pending_confirmation'].includes(latest.status)) {
        repo.updateDailyReportStatus(this.db, latest.id, 'superseded');
      }
      repo.insertDailyReport(this.db, {
        id: targetId, tenant_id: this.tenantId, user_id: userId, report_date: reportDate,
        version: (latest?.version ?? 0) + 1, generation_revision: revision,
        status: 'pending_confirmation', summary: result.summary, progress_json: JSON.stringify(result.items),
        confirmed_at: null, created_at: now, updated_at: now,
      });
      saveDailyQuality(this.db, targetId, result, this.tenantId);
      this.saveKnowledgeDependencies(userId,targetId,'daily',knowledgeSnippets);

      for (const source of sources) {
        repo.linkReportSource(this.db, targetId, source.id);
        repo.updateSourceMessageResult(this.db, source.id, 'processed', targetId, null);
      }
      repo.insertAudit(this.db, {
        id: regenerationAuditId??randomUUID(), tenant_id: this.tenantId, actor_user_id: userId,
        action: 'daily_report.draft_generated', resource_type: 'daily_report', resource_id: targetId,
        details_json: JSON.stringify({ reportDate, sourceCount: sources.length, revision }), created_at: now,
      });
      if (options.editingReportId) this.cancelDailyEdit(userId, options.editingReportId);
      return targetId;
    });
    return reportId;
    } catch(error) { failGeneration(error); throw error; }
  }

  private ownedDailyReport(userId: string, reportId: string): repo.DailyReportRow {
    const row = repo.getDailyReportById(this.db, reportId, this.tenantId);
    if (!row || row.user_id !== userId) throw new Error('日报不存在或无权操作');
    return row;
  }

  /** Show all persisted facts before recording the version-bound presentation receipt. */
  dailyPreview(report: repo.DailyReportRow, options: {newCompanyPending?:boolean} = {}): string {
    this.assertReportKnowledge(report.user_id,report.id,'daily');
    const items = JSON.parse(report.progress_json ?? '[]') as DailyExtractResult['items'];
    const lines:string[] = items.length ? [] : [report.summary ?? '暂无摘要'];
    for(const item of items) {
      const name=splitPlanEntry(repo.getWorkItem(this.db,item.workItemRef,this.tenantId)?.name??'历史事项').name;
      const metric=getItemMetric(this.db,item.workItemRef,this.tenantId);
      const progress=metric?.mode==='count'?(item.completedCount==null?`本周计划${metric.total}${metric.unit}`:`本周 ${item.completedCount}/${metric.total}${metric.unit}${item.progressValue==null?'':` · ${item.progressValue}%`}`):item.progressValue==null?'进度待核对':`${item.progressValue}%`;
      lines.push(`\n${name}｜${progress}\n${item.progressText}`);
      const extraCompanies=item.companyRefs?.map(company=>company.name).filter(name=>!item.progressText.includes(name));
      if(extraCompanies?.length) lines.push(`企业：${extraCompanies.join('、')}`);
      const extraKeys=item.completedKeys?.filter(key=>!item.progressText.includes(key));
      if(extraKeys?.length) lines.push(`完成对象：${extraKeys.join('、')}`);
      if(item.retractedKeys?.length) lines.push(`撤销完成：${item.retractedKeys.join('、')}`);
      if(item.issues?.length) lines.push(`问题：${item.issues.join('；')}`);
      if(item.nextActions?.length) lines.push(`下一步：${item.nextActions.join('；')}`);
    }
    const quality=dailyQuality(this.db,report.id,this.tenantId);
    const questions=quality.questions.filter(q=>!(options.newCompanyPending&&/企业全称|企业名录|关联.*企业/.test(q)));
    if(questions.length) lines.push(`\n待补充：${[...new Set(questions)].join('；')}`);
    if(quality.riskFlags.length&&!questions.length) lines.push(`注意：${quality.riskFlags.join('；')}`);
    if(report.status==='pending_confirmation'&&!options.newCompanyPending) lines.push('\n回复“确认日报”，或“修改日报：…”');
    return lines.join('\n').trim();
  }

  private assertCurrentDaily(row: repo.DailyReportRow): void {
    const latest = repo.getLatestDailyReport(this.db, row.user_id, row.report_date, this.tenantId);
    if (latest?.id !== row.id) throw new Error('这份日报草稿已更新，请查看最新日报草稿');
    const generation = repo.getDailyGeneration(this.db, this.tenantId, row.user_id, row.report_date);
    if (generation && (generation.status !== 'completed' || generation.revision !== row.generation_revision)) {
      throw new Error('新的工作记录尚未整理完成，请稍后查看最新日报草稿');
    }
  }

  /** Reserve a display sequence before sending; acknowledge only after the full content was sent. */
  prepareDailyPresentation(userId: string, reportId: string): DailyPresentation {
    return inTransaction(this.db, () => {
      this.assertReportKnowledge(userId,reportId,'daily');
      const report = this.ownedDailyReport(userId, reportId);
      this.assertCurrentDaily(report);
      if (!['pending_confirmation', 'confirmed'].includes(report.status)) throw new Error('这份日报已失效');
      repo.ensureDailyUserState(this.db, this.tenantId, userId, iso());
      this.db.prepare(`UPDATE daily_user_state SET state_version=state_version+1, updated_at=? WHERE tenant_id=? AND user_id=?`)
        .run(iso(), this.tenantId, userId);
      return { report, stateVersion: repo.getDailyUserState(this.db, this.tenantId, userId)!.state_version, contentHash: dailyContentHash(report) };
    });
  }

  completeDailyPresentation(userId: string, presentation: DailyPresentation): boolean {
    return inTransaction(this.db, () => {
      this.assertReportKnowledge(userId,presentation.report.id,'daily');
      const report = this.ownedDailyReport(userId, presentation.report.id);
      if (dailyContentHash(report) !== presentation.contentHash) throw new Error('展示内容与日报快照不一致');
      const now = iso();
      this.db.prepare(`INSERT OR IGNORE INTO daily_report_presentation
        (daily_report_id, tenant_id, user_id, content_hash, presented_at) VALUES (?, ?, ?, ?, ?)`)
        .run(report.id, this.tenantId, userId, presentation.contentHash, now);
      // A delayed network acknowledgement must not replace a newer user interaction.
      return this.db.prepare(`UPDATE daily_user_state SET displayed_report_id=?, editing_report_id=NULL, updated_at=?
        WHERE tenant_id=? AND user_id=? AND state_version=?`)
        .run(report.id, now, this.tenantId, userId, presentation.stateVersion).changes === 1;
    });
  }

  private assertPresented(row: repo.DailyReportRow): void {
    this.assertReportKnowledge(row.user_id,row.id,'daily');
    const shown = this.db.prepare(`SELECT content_hash FROM daily_report_presentation
      WHERE tenant_id=? AND user_id=? AND daily_report_id=?`).get(this.tenantId, row.user_id, row.id) as { content_hash: string } | undefined;
    if (shown?.content_hash !== dailyContentHash(row)) throw new Error('这份草稿尚未完整展示，请先发送“我的日报”查看后再确认');
  }

  getPendingDailyEdit(userId: string): { reportId: string; date: string } | undefined {
    this.requireActiveUser(userId);
    const reportId = repo.getDailyUserState(this.db, this.tenantId, userId)?.editing_report_id;
    if (!reportId) return undefined;
    const row = this.ownedDailyReport(userId, reportId);
    this.assertInteractiveEditDate(userId,row);
    return { reportId, date: row.report_date };
  }

  private assertInteractiveEditDate(userId: string, report: repo.DailyReportRow): void {
    const now=new Date(), today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    if (report.report_date>today || weekIdOf(report.report_date)!==weekId(now)) {
      // Clear outside the caller's write transaction, then reject this message. It
      // must not be silently reinterpreted as a new current-week work record.
      this.cancelDailyEdit(userId,report.id);
      throw new Error('原日报修改已跨周或日期无效，已退出修改。本条内容未作为本周新日报保存，请核对日期后重新发送本周实际工作。');
    }
  }

  startDailyEdit(userId: string, reportId: string): void {
    this.assertInteractiveEditDate(userId,this.ownedDailyReport(userId,reportId));
    inTransaction(this.db, () => {
      const row = this.ownedDailyReport(userId, reportId);
      this.assertCurrentDaily(row);
      this.assertPresented(row);
      if (row.status !== 'pending_confirmation') throw new Error('该版本已经确认，请用“补记 日期：更正内容”创建修改稿');
      this.db.prepare(`UPDATE daily_user_state SET editing_report_id=?, displayed_report_id=?, state_version=state_version+1, updated_at=?
        WHERE tenant_id=? AND user_id=?`).run(reportId, reportId, iso(), this.tenantId, userId);
    });
  }

  cancelDailyEdit(userId: string, reportId: string): void {
    this.db.prepare(`UPDATE daily_user_state SET editing_report_id=NULL, state_version=state_version+1, updated_at=?
      WHERE tenant_id=? AND user_id=? AND editing_report_id=?`).run(iso(), this.tenantId, userId, reportId);
  }

  confirm(userId: string, reportDate: string, source: ConfirmationSource, commandId?: string): repo.DailyReportRow {
    return this.confirmDisplayedReport(userId, source, commandId, reportDate);
  }

  confirmDisplayedReport(userId: string, source: ConfirmationSource, commandId?: string, reportDate?: string): repo.DailyReportRow {
    return this.confirmTarget(userId, undefined, source, commandId, reportDate);
  }

  confirmReport(userId: string, reportId: string, source: ConfirmationSource, commandId?: string): repo.DailyReportRow {
    return this.confirmTarget(userId, reportId, source, commandId);
  }

  private confirmTarget(
    userId: string, reportId: string | undefined, source: ConfirmationSource, commandId?: string, reportDate?: string,
  ): repo.DailyReportRow {
    if (!isExplicitConfirmation(source)) throw new Error('非明确确认，忽略');
    this.requireActiveUser(userId);
    // Bind the inbound command before validation. Even a rejected command must never
    // pick a different draft if WeCom redelivers it after another draft is displayed.
    const command = commandId ? inTransaction(this.db, () => {
      const previous = this.db.prepare(`SELECT user_id, daily_report_id, completed_at FROM daily_confirmation_receipt
        WHERE tenant_id=? AND command_id=?`).get(this.tenantId, commandId) as {
          user_id: string; daily_report_id: string | null; completed_at: string | null;
        } | undefined;
      if (previous) {
        if (previous.user_id !== userId || (reportId && previous.daily_report_id !== reportId)) throw new Error('确认消息标识与原操作不一致');
        return previous;
      }
      const selected = reportId ?? repo.getDailyUserState(this.db, this.tenantId, userId)?.displayed_report_id ?? null;
      if (selected) this.ownedDailyReport(userId, selected);
      this.db.prepare(`INSERT INTO daily_confirmation_receipt
        (tenant_id, command_id, user_id, daily_report_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(this.tenantId, commandId, userId, selected, iso());
      return { user_id: userId, daily_report_id: selected, completed_at: null };
    }) : undefined;
    return inTransaction(this.db, () => {
      const targetId = command ? command.daily_report_id : reportId ?? repo.getDailyUserState(this.db, this.tenantId, userId)?.displayed_report_id;
      if (!targetId) throw new Error('没有已展示的日报草稿，请先发送“我的日报”');
      const row = this.ownedDailyReport(userId, targetId);
      this.assertReportKnowledge(userId,row.id,'daily');
      if (command?.completed_at) return row;
      if (reportDate && row.report_date !== reportDate) throw new Error('最近展示的日报不是今天，请先发送“我的日报”核对日期');
      const now = iso();
      const saveReceipt = () => {
        if (commandId) this.db.prepare(`UPDATE daily_confirmation_receipt SET completed_at=?
          WHERE tenant_id=? AND command_id=?`).run(now, this.tenantId, commandId);
      };
      // Duplicate clicks acknowledge this already confirmed snapshot, never another draft.
      if (row.status === 'confirmed') {
        saveReceipt();
        return row;
      }
      this.assertCurrentDaily(row);
      this.assertPresented(row);
      assertTransition(row.status, 'confirmed');
      this.db.prepare(`UPDATE daily_report SET status='superseded', updated_at=?
        WHERE tenant_id=? AND user_id=? AND report_date=? AND status='confirmed' AND id<>?`)
        .run(now, this.tenantId, userId, row.report_date, row.id);
      repo.updateDailyReportStatus(this.db, row.id, 'confirmed', now);
      linkConfirmedCompanies(this.db, row);
      repo.ensureDailyUserState(this.db, this.tenantId, userId, now);
      this.db.prepare(`UPDATE daily_user_state SET last_confirmed_report_id=?,
        editing_report_id=CASE WHEN editing_report_id=? THEN NULL ELSE editing_report_id END,
        state_version=state_version+1, updated_at=? WHERE tenant_id=? AND user_id=?`)
        .run(row.id, row.id, now, this.tenantId, userId);
      saveReceipt();
      repo.insertAudit(this.db, {
        id: randomUUID(), tenant_id: this.tenantId, actor_user_id: userId,
        action: 'daily_report.confirmed', resource_type: 'daily_report', resource_id: row.id,
        details_json: JSON.stringify({ source, version: row.version, contentHash: dailyContentHash(row) }), created_at: now,
      });
      return this.ownedDailyReport(userId, row.id);
    });
  }

  async generateWeeklyReport(userId: string, weekIdStr: string, options: { authorizeCommit?:()=>void; notifyManager?:boolean } = {}): Promise<string> {
    validateDate(weekIdStr);
    this.ensureUser(userId);
    this.requireActiveUser(userId);
    const ticket = startWeeklyGeneration(this.db, userId, weekIdStr, this.tenantId);
    try {
    const confirmed = ticket.sources.confirmed;
    for (const report of confirmed) this.assertReportKnowledge(userId,report.id,'daily');
    const confirmedDates = [...new Set(confirmed.map((row) => row.report_date))];
    const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const missing = missingDaysOfWeek(weekIdStr, confirmedDates, this.weekBoundary).filter(date => date <= today);
    const weeklyTemplate = ticket.sources.template;
    const workItems = ticket.sources.items.map((item) => ({
      id: item.id,
      name: item.name,
      planBackground: item.plan_background,
    }));
    const knowledgeSnippets = this.knowledgeFor(confirmed.map((row) => `${row.summary ?? ''}\n${row.progress_json ?? ''}`).join('\n'), userId);
    // Preserve indirect dependencies too: a weekly paragraph can derive from a
    // daily summary even when that knowledge is not selected again for this run.
    const knowledgeDependencies = [...new Map([...knowledgeSnippets,
      ...confirmed.flatMap(report=>this.storedKnowledgeDependencies(userId,report.id,'daily'))]
      .map(item=>[item.id,{id:item.id,version:item.version}])).values()];

    const response = await this.agent.run({
      schemaVersion: 1,
      requestId: randomUUID(),
      idempotencyKey: `weekly:${this.tenantId}:${userId}:${weekIdStr}:${ticket.revision}:${ticket.sources.fingerprint}`,
      tenantId: this.tenantId,
      taskType: 'weekly_report_generate',
      actor: { role: 'manager', userRef: userId },
      context: {
        timezone: 'Asia/Shanghai',
        weekId: weekIdStr,
        workItems,
        template: weeklyTemplate ? { version: String(weeklyTemplate.version), content: weeklyTemplate.content } : undefined,
        sourceRecords: confirmed.map((row) => ({
          id: row.id,
          text: `${row.summary ?? ''}\n结构化进展：${row.progress_json ?? '[]'}`,
          date: row.report_date,
        })),
        knowledgeSnippets,
        businessRules: { progressMode: repo.getConfig(this.db, 'progressMode', defaults.progressMode, this.tenantId) },
      },
      input: {text: `系统确定性计算的逐日累计进度（不可改写数值；未知不等于0）：\n${JSON.stringify(buildWeeklyProgress(this.db,userId,weekIdStr,this.tenantId))}\n员工独立填写的整周原因（与工作事实分开，不能作为新的完成事件）：\n${JSON.stringify(ticket.sources.reasons)}`},
    });
    if (response.taskType !== 'weekly_report_generate') throw new Error(`意外任务结果：${response.taskType}`);
    let required: string[] = [];
    if (weeklyTemplate) {
      const template = JSON.parse(weeklyTemplate.content);
      required = Array.isArray(template.sections) ? template.sections.flatMap((part: unknown) => typeof part === 'string' ? [part] : part && typeof part === 'object' && 'title' in part && (!('required' in part) || part.required !== false) ? [String(part.title)] : []) : [];
    }
    const missingSections = required.filter(title => !response.result.sections.some(section => section.title === title && section.body.trim()));
    if (missingSections.length) throw new Error(`周报未满足模板必填栏目：${missingSections.join('、')}；未发布，请重试`);
    return inTransaction(this.db,()=>{
      options.authorizeCommit?.();
      for (const report of confirmed) this.assertReportKnowledge(userId,report.id,'daily');
      this.assertKnowledgeCurrent(userId,knowledgeDependencies);
      const reportId=commitWeeklyGeneration(this.db,ticket,{content:response.result.summary,sections:response.result.sections,citedReportIds:response.result.citedReportIds,missingDays:missing,progressSnapshot:buildWeeklyProgress(this.db,userId,weekIdStr,this.tenantId)});
      this.saveKnowledgeDependencies(userId,reportId,'weekly',knowledgeDependencies);
      if(options.notifyManager) {
        const owner=repo.activeUser(this.db,userId,this.tenantId), manager=owner?.manager_user_id?repo.activeUser(this.db,owner.manager_user_id,this.tenantId):undefined;
        if(manager&&manager.id!==userId&&['admin','dept_head','team_lead'].includes(manager.role)&&repo.canReadUser(this.db,{userId:manager.id,role:manager.role,tenantId:this.tenantId},userId)) {
          const now=iso();repo.insertOutbox(this.db,{id:randomUUID(),tenant_id:this.tenantId,kind:'weekly_report',dedupe_key:`weekly-report:${manager.id}:${reportId}`,target_user_id:manager.id,payload_json:JSON.stringify({reportId,week:weekIdStr}),next_attempt_at:now,created_at:now});
        }
      }
      return reportId;
    });
    } catch(error) { abortWeeklyGeneration(this.db,ticket); throw error; }
  }

  addFeedback(
    weeklyReportId: string,
    content: string,
    workItemId: string | null = null,
    managerUserId = 'manager',
    idempotencyKey?: string,
  ): string {
    const report = repo.getWeeklyReportById(this.db, weeklyReportId, this.tenantId);
    if (!report) throw new Error('周报不存在');
    if (!isValidFeedback({ weeklyReportId, workItemId })) throw new Error('反馈绑定不合法');
    const normalized = content.trim();
    if (!normalized) throw new Error('反馈内容不能为空');
    let manager = repo.getUser(this.db, managerUserId, this.tenantId);
    if (!manager && managerUserId === 'poc-admin' && this.tenantId === 'poc') {
      manager = repo.upsertUser(this.db, {
        id: managerUserId, wecom_userid: `pending:${managerUserId}`, name: '后台管理员',
        role: 'admin', tenant_id: this.tenantId,
      });
    }
    if (!manager?.active || !['admin', 'dept_head', 'team_lead'].includes(manager.role)) throw new Error('反馈人不存在、已停用或没有管理角色');
    return saveWeeklyFeedback(this.db,{userId:managerUserId,role:manager.role,tenantId:this.tenantId},
      {weeklyReportId:report.id,content:normalized,idempotencyKey}).id;
  }
}
