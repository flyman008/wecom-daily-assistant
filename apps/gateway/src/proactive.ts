import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WSClient } from '@wecom/aibot-node-sdk';
import { weekId } from '@wecom/domain';
import { inTransaction, type Db, type OutboxRow } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { CrmStore, type CrmEntity } from '../../../packages/persistence/src/crm';
import type { DailyAssistantApp } from '../../api/src/app';
import { ensureNotificationSchema, notificationSettings, type NotificationSettings } from '../../api/src/notifications';
import { captureWeeklySources, getWeeklyInstance } from '../../api/src/weekly-workflow';
import { buildWeeklyProgress } from '../../api/src/progress-ledger';
import type { GatewayConfig } from './config';
import { logger } from './logger';

type Client = Pick<WSClient, 'isConnected' | 'sendMessage'>;
type Payload = { date?: string; week?: string; reportId?: string; weeklyReportId?: string; feedbackId?: string; feedbackRevision?: number; companyId?: string; recordId?: string; dueDate?: string; ownerId?: string; workItemId?: string };
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function localTime(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now);
  const part = (key: string) => parts.find((value) => value.type === key)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, clock: `${part('hour')}:${part('minute')}`, weekday: weekdays.indexOf(part('weekday')) + 1 };
}
function quiet(clock: string, settings: NotificationSettings): boolean {
  return settings.quietStart < settings.quietEnd ? clock >= settings.quietStart && clock < settings.quietEnd : clock >= settings.quietStart || clock < settings.quietEnd;
}
const addMs = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();
const shiftDate = (date: string, days: number) => new Date(new Date(`${date}T04:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
/** Catch up only the latest due schedule, never send a future week or an unbounded backlog. */
export function dueWeeklyTarget(now: Date, settings: NotificationSettings): string | undefined {
  const local = localTime(now);
  let due = shiftDate(weekId(now), settings.weeklyWeekday - 1);
  if (due > local.date || due === local.date && local.clock < settings.weeklyGenerateAt) due = shiftDate(due, -7);
  const elapsedDays = Math.round((Date.parse(local.date) - Date.parse(due)) / 86_400_000);
  if (elapsedDays > settings.catchupDays) return undefined;
  const scheduleWeek = weekId(new Date(`${due}T04:00:00Z`));
  return settings.weeklyTarget === 'previous' ? shiftDate(scheduleWeek, -7) : scheduleWeek;
}
const plain = (value: unknown, max = 700) => String(value ?? '').replace(/[<>&`*\[\]()]/g, '').slice(0, max);

/** Persisted scheduler + guarded private-message delivery. Never sends to group chat IDs. */
export class ProactiveService {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private flushing = false;
  constructor(private readonly db: Db, private readonly app: DailyAssistantApp, private readonly config: GatewayConfig, private readonly client: Client) {
    ensureNotificationSchema(db);
    // Pre-lease versions may have left a sending row. Treat delivery as uncertain, not successful.
    db.prepare(`UPDATE message_outbox SET status='failed',last_error='上次发送结果不确定，请核对后重试'
      WHERE tenant_id=? AND status='sending' AND id NOT IN (SELECT outbox_id FROM notification_delivery)`).run(app.tenantId);
    db.prepare(`INSERT OR IGNORE INTO notification_delivery(outbox_id,state,reason)
      SELECT id,'exhausted','上次发送结果不确定，请核对后重试' FROM message_outbox WHERE tenant_id=? AND status='failed' AND last_error='上次发送结果不确定，请核对后重试'`).run(app.tenantId);
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A slow weekly LLM generation must not hold up already queued human feedback.
      void this.flushOutbox().catch((error) => logger.error('主动消息发送失败', error));
      void this.tick().catch((error) => logger.error('主动消息调度失败', error));
    }, this.config.outboxPollMs);
    void this.tick().catch((error) => logger.error('主动消息调度失败', error));
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private settings() { return notificationSettings(this.db, this.app.tenantId, { planReminderAt: this.config.planReminderAt, dailyReminderAt: this.config.dailyReminderAt, weeklyGenerateAt: this.config.weeklyGenerateAt }); }
  private enqueue(kind: string, key: string, target: string, payload: Payload, now: Date): void {
    repo.insertOutbox(this.db, { id: randomUUID(), tenant_id: this.app.tenantId, kind, dedupe_key: key,
      target_user_id: target, payload_json: JSON.stringify(payload), next_attempt_at: now.toISOString(), created_at: now.toISOString() });
  }
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.settings();
      const local = localTime(now);
      if (!settings.enabled) return;
      if (!quiet(local.clock, settings)) {
        const users = repo.listUsers(this.db, this.app.tenantId).filter(user => user.active);
        const week = weekId(now);
        const weeklyTarget = settings.weeklyReportEnabled ? dueWeeklyTarget(now, settings) : undefined;
        for (const user of users) {
          const bound = Boolean(user.wecom_userid && repo.isUserBound(user));
          if (bound && settings.planReminderEnabled && local.weekday <= 1 + settings.catchupDays && (local.weekday > 1 || local.clock >= settings.planReminderAt) && !repo.listWorkItems(this.db, user.id, week, this.app.tenantId).length) {
            this.enqueue('weekly_plan_reminder', `weekly-plan-reminder:${user.id}:${week}`, user.id, { week, date: local.date }, now);
          }
          if (bound && settings.dailyReminderEnabled && settings.dailyReminderDays.includes(local.weekday) && local.clock >= settings.dailyReminderAt && repo.getLatestDailyReport(this.db, user.id, local.date, this.app.tenantId)?.status !== 'confirmed') {
            this.enqueue('daily_reminder', `daily-reminder:${user.id}:${local.date}`, user.id, { date: local.date }, now);
          }
          if (weeklyTarget) await this.weekly(user, weeklyTarget, now);
          if (settings.riskEnabled && local.weekday >= settings.riskEarliestWeekday) this.risks(user, week, now, settings);
        }
        if (settings.crmAssignmentEnabled) this.assignments(now);
        if (settings.crmDueEnabled && local.clock >= settings.crmDueAt) this.crmDue(now);
      }
      await this.flushOutbox(now);
    } finally { this.ticking = false; }
  }
  private async weekly(user: repo.UserRow, week: string, now: Date): Promise<void> {
    // A manager may also own work. Participation is independent of management role.
    const manager = this.managerOf(user);
    if (!manager) return;
    const sources = captureWeeklySources(this.db, user.id, week, this.app.tenantId);
    if (!sources.confirmed.length) {
      this.enqueue('weekly_missing', `weekly-missing:${manager.id}:${user.id}:${week}`, manager.id, { ownerId: user.id, week }, now);
      return;
    }
    // Fingerprints include confirmed report revisions, plan/metric/reason/template changes.
    // A completed job for an older fingerprint must not suppress a corrected report.
    const key = `weekly:${user.id}:${week}:${sources.fingerprint}`;
    const current = getWeeklyInstance(this.db, user.id, week, this.app.tenantId);
    let reportId = !current.stale && current.currentReportId ? current.currentReportId : null;
    if (!reportId) {
      const claimed = this.db.prepare(`INSERT INTO notification_job(tenant_id,job_key,state,lease_until) VALUES(?,?,'running',?)
        ON CONFLICT(tenant_id,job_key) DO UPDATE SET state='running',lease_until=excluded.lease_until
        WHERE notification_job.lease_until<=?`).run(this.app.tenantId, key, addMs(now, 10 * 60_000), now.toISOString());
      if (!claimed.changes) return;
      try {
        reportId = await this.app.generateWeeklyReport(user.id, week);
        this.db.prepare("UPDATE notification_job SET state='done',result_id=?,lease_until=? WHERE tenant_id=? AND job_key=?").run(reportId, now.toISOString(), this.app.tenantId, key);
      } catch {
        this.db.prepare("UPDATE notification_job SET state='failed',attempts=attempts+1,lease_until=? WHERE tenant_id=? AND job_key=?").run(addMs(now, 60_000), this.app.tenantId, key);
        return;
      }
    }
    if (!reportId) return;
    this.enqueue('weekly_report', `weekly-report:${manager.id}:${reportId}`, manager.id, { reportId, week }, now);
  }
  private managerOf(user: repo.UserRow): repo.UserRow | undefined {
    const manager = user.manager_user_id ? repo.activeUser(this.db, user.manager_user_id, this.app.tenantId) : undefined;
    return manager && manager.id !== user.id && ['admin', 'team_lead', 'dept_head'].includes(manager.role)
      && repo.canReadUser(this.db, { userId: manager.id, role: manager.role, tenantId: this.app.tenantId }, user.id) ? manager : undefined;
  }
  private risks(user: repo.UserRow, week: string, now: Date, settings: NotificationSettings): void {
    const today = localTime(now).date;
    const progress = buildWeeklyProgress(this.db, user.id, week, this.app.tenantId);
    const manager = this.managerOf(user);
    for (const item of progress.items.filter(item => !item.retired)) {
      const current = item.days.find(day => day.date === today);
      if (!current || current.progressValue === null || current.progressValue >= settings.riskThreshold) continue;
      for (const target of [user.id, ...(manager ? [manager.id] : [])]) this.enqueue('progress_risk', `progress-risk:${target}:${item.workItemId}:${today}`, target,
        { ownerId: user.id, workItemId: item.workItemId, date: today, week }, now);
    }
  }
  private assignments(now: Date): void {
    const since = repo.getConfig(this.db, 'notifications.crmAssignmentSince', '', this.app.tenantId);
    if (!since) return; // Enabling starts with new assignments; never backfill a whole historic roster.
    const cursor = repo.getConfig(this.db, 'notifications.crmAssignmentCursor', 0, this.app.tenantId);
    const events = this.db.prepare(`SELECT rowid AS sequence,id,company_id,kind,details_json FROM crm_event WHERE tenant_id=? AND created_at>=? AND rowid>? ORDER BY rowid LIMIT 200`).all(this.app.tenantId, since, cursor) as unknown as Array<{ sequence: number; id: string; company_id: string; kind: string; details_json: string }>;
    inTransaction(this.db, () => {
      for (const event of events) {
        const data = JSON.parse(event.details_json) as { before?: Record<string, unknown>; after?: Record<string, unknown>; recordId?: string };
        if (/^(company|project|service)_(created|updated)$/.test(event.kind) && data.after) {
          const members = (value: Record<string, unknown> | undefined) => value ? repo.companyMemberIds(value) : [];
          const previous = members(data.before);
          for (const target of members(data.after).filter((id) => !previous.includes(id))) this.enqueue('crm_assignment', `crm-assignment:${event.id}:${target}`, target, { companyId: event.company_id, recordId: data.recordId }, now);
        }
        repo.setConfig(this.db, 'notifications.crmAssignmentCursor', event.sequence, this.app.tenantId);
      }
    });
  }
  private crmDue(now: Date): void {
    const date = localTime(now).date;
    const crm = new CrmStore(this.db, this.app.tenantId);
    for (const company of crm.companies().filter((item) => !item.archived && !item.isDemo)) {
      if (typeof company.nextDate === 'string' && company.nextDate && company.nextDate <= date && company.ownerId) this.enqueue('crm_due', `crm-due:${company.id}:${company.nextDate}:${date}`, String(company.ownerId), { companyId: company.id, dueDate: company.nextDate, date }, now);
      for (const record of crm.records(company.id)) {
        if (!this.recordOpen(record, crm) || typeof record.dueDate !== 'string' || !record.dueDate || record.dueDate > date) continue;
        const target = String(record.ownerId || company.ownerId || '');
        if (target) this.enqueue('crm_due', `crm-due:${record.id}:${record.dueDate}:${date}`, target, { companyId: company.id, recordId: record.id, dueDate: record.dueDate, date }, now);
      }
    }
  }
  private recordOpen(record: CrmEntity & { kind: string }, crm: CrmStore): boolean {
    return record.kind === 'service' ? !['resolved', 'paused'].includes(String(record.status)) : crm.stages().find((stage) => stage.id === record.stageId)?.outcome === 'open' && record.stageId !== 'paused';
  }
  private enabled(kind: string, settings: NotificationSettings): boolean {
    const flags: Record<string, boolean> = { weekly_plan_reminder: settings.planReminderEnabled, daily_reminder: settings.dailyReminderEnabled,
      weekly_report: settings.weeklyReportEnabled, weekly_missing: settings.weeklyReportEnabled, progress_risk: settings.riskEnabled,
      manager_feedback: settings.feedbackEnabled, crm_assignment: settings.crmAssignmentEnabled, crm_due: settings.crmDueEnabled };
    return settings.enabled && flags[kind] === true;
  }
  private cancel(row: OutboxRow, reason: string): void {
    this.db.prepare("UPDATE notification_delivery SET state='cancelled',lease_until=NULL,reason=? WHERE outbox_id=?").run(reason, row.id);
    this.db.prepare("UPDATE message_outbox SET status='failed',last_error=? WHERE tenant_id=? AND id=?").run(reason, this.app.tenantId, row.id);
    this.audit(row, 'cancelled', reason);
  }
  private audit(row: OutboxRow, status: string, reason?: string): void {
    repo.insertAudit(this.db, { id: randomUUID(), tenant_id: this.app.tenantId, action: `notification.${status}`, resource_type: 'message_outbox', resource_id: row.id,
      details_json: JSON.stringify({ kind: row.kind, targetUserId: row.target_user_id, reason }), created_at: new Date().toISOString() });
  }
  private reportUrl(userId: string, reportId: string, now: Date): string | undefined {
    if (!this.config.reportBaseUrl) return undefined;
    const token = randomBytes(32).toString('base64url');
    repo.insertAccessGrant(this.db, { id: randomUUID(), tenant_id: this.app.tenantId, token_hash: createHash('sha256').update(token).digest('hex'), user_id: userId,
      resource_type: 'weekly_report', resource_id: reportId, expires_at: addMs(now, 86_400_000), created_at: now.toISOString() });
    const configuredBase = this.config.reportBaseUrl.replace(/\/$/, '');
    const weeklyBase = /\/weekly\.html$/i.test(configuredBase) ? configuredBase : `${configuredBase}/weekly.html`;
    return `${weeklyBase}#/access/${token}`;
  }
  /** Build content from current authorized records, never trust cached message payload text or URLs. */
  private content(row: OutboxRow, payload: Payload, target: repo.UserRow, now: Date): string | undefined {
    const today = localTime(now).date;
    if (row.kind === 'daily_reminder') {
      if (payload.date !== today || !this.settings().dailyReminderDays.includes(localTime(now).weekday)) return undefined;
      const report = repo.getLatestDailyReport(this.db, target.id, today, this.app.tenantId);
      if (report?.status === 'confirmed') return undefined;
      return report?.status === 'pending_confirmation' ? `你${today}的日报草稿还未确认。发送“我的日报”查看后，可以确认入库或选择修改。` : `今天还没有已确认日报。直接发文字或语音记录工作，我会整理草稿供你确认；也可发送“帮助”。`;
    }
    if (row.kind === 'weekly_plan_reminder') {
      if (payload.week !== weekId(now) || localTime(now).weekday > 1 + this.settings().catchupDays || repo.listWorkItems(this.db, target.id, payload.week, this.app.tenantId).length) return undefined;
      return '新的一周开始了，请发送“周计划：事项｜计划及背景；…”设置本周计划。你也可以先发送“帮助”查看示例。';
    }
    if (row.kind === 'weekly_report') {
      if (!payload.reportId) return undefined; // Legacy unscoped URL-only messages cannot be safely delivered.
      const report = repo.getWeeklyReportById(this.db, payload.reportId, this.app.tenantId);
      const owner = report ? repo.activeUser(this.db, report.user_id, this.app.tenantId) : undefined;
      if (!owner || !report || this.managerOf(owner)?.id !== target.id) return undefined;
      try { this.app.assertReportKnowledge(owner.id,report.id,'weekly'); } catch { return undefined; }
      const instance = getWeeklyInstance(this.db, owner.id, report.week_id, this.app.tenantId);
      if (instance.stale || instance.currentReportId !== report.id) return undefined;
      const url = this.reportUrl(target.id, report.id, now);
      return `${plain(owner.name)}的周报${report.version > 1 ? '已更新' : '已生成'}（${report.week_id}当周 · 第${report.version}版）。${url ? `\n[查看周报](${url})` : `\n${plain(report.content, 1800)}`}\n可回复“反馈 ${plain(owner.name)} ${report.week_id} v${report.version}：反馈内容”。`;
    }
    if (row.kind === 'weekly_missing') {
      if (!payload.ownerId || !payload.week || payload.week !== dueWeeklyTarget(now, this.settings())) return undefined;
      const owner = repo.activeUser(this.db, payload.ownerId, this.app.tenantId);
      if (!owner || this.managerOf(owner)?.id !== target.id || captureWeeklySources(this.db, owner.id, payload.week, this.app.tenantId).confirmed.length) return undefined;
      return `周报缺报提醒：${plain(owner.name)}在${payload.week}当周暂无已确认日报，未生成成果周报。\n请核实缺报原因；资料补充确认后，排期补发窗口内会重新汇总。不能将“未提交”视为零进度。`;
    }
    if (row.kind === 'progress_risk') {
      const settings = this.settings();
      if (!payload.ownerId || !payload.workItemId || payload.date !== today || payload.week !== weekId(now) || localTime(now).weekday < settings.riskEarliestWeekday) return undefined;
      const owner = repo.activeUser(this.db, payload.ownerId, this.app.tenantId);
      if (!owner || owner.id !== target.id && this.managerOf(owner)?.id !== target.id) return undefined;
      const item = buildWeeklyProgress(this.db, owner.id, payload.week, this.app.tenantId).items.find(item => item.workItemId === payload.workItemId && !item.retired);
      const day = item?.days.find(day => day.date === today);
      if (!item || !day || day.progressValue === null || day.progressValue >= settings.riskThreshold) return undefined;
      return `进度核查提醒：${plain(owner.name)} · ${plain(item.name)}\n截至${today}已确认累计进度${day.progressValue}%，低于配置提醒线${settings.riskThreshold}%。\n这是规则提示，不代表任务已延期。请在工作记录核对事实、补充整周原因或安排下一步。`;
    }
    if (row.kind === 'manager_feedback') {
      if (!payload.feedbackId) return undefined;
      const feedback = this.db.prepare('SELECT * FROM manager_feedback WHERE tenant_id=? AND id=? AND to_user_id=?').get(this.app.tenantId, payload.feedbackId, target.id) as unknown as repo.FeedbackRow | undefined;
      const report = feedback ? repo.getWeeklyReportById(this.db, feedback.weekly_report_id, this.app.tenantId) : undefined;
      if (!feedback || report?.user_id !== target.id) return undefined;
      const manager = repo.activeUser(this.db, feedback.manager_user_id, this.app.tenantId);
      if (!manager || manager.id === target.id || !['admin', 'team_lead', 'dept_head'].includes(manager.role)
        || !repo.canReadUser(this.db, { userId: manager.id, role: manager.role, tenantId: this.app.tenantId }, target.id)) return undefined;
      const hasRevisions = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_feedback_revision'").get();
      const revision = hasRevisions ? Number(this.db.prepare('SELECT COALESCE(MAX(version),1) AS version FROM manager_feedback_revision WHERE tenant_id=? AND feedback_id=?').get(this.app.tenantId, feedback.id)!.version) : 1;
      // A queued old revision must not accidentally re-send the newest content a second time.
      if ((payload.feedbackRevision ?? 1) !== revision) return undefined;
      return `你收到${plain(manager.name)}对${report.week_id}当周周报的${revision > 1 ? '反馈修订' : '反馈'}（第${revision}版）：\n${plain(feedback.content, 1800)}\n反馈及修订历史已留存在工作记录中。`;
    }
    if ((row.kind === 'crm_assignment' || row.kind === 'crm_due') && payload.companyId) {
      const crm = new CrmStore(this.db, this.app.tenantId);
      const company = crm.companies().find((item) => item.id === payload.companyId);
      if (!company || company.archived || company.isDemo) return undefined;
      const record = payload.recordId ? crm.records(company.id).find((item) => item.id === payload.recordId) : undefined;
      if (payload.recordId && !record) return undefined;
      const members = record ? [String(record.ownerId || company.ownerId || '')] : repo.companyMemberIds(company);
      if (!members.includes(target.id)) return undefined;
      if (row.kind === 'crm_due') {
        const due = record ? record.dueDate : company.nextDate;
        if (payload.date !== today || payload.dueDate !== due || (record && !this.recordOpen(record, crm))) return undefined;
        return `跟进提醒：${plain(company.name)}${record ? ` · ${plain(record.title)}` : ''}\n计划日期：${plain(due)}\n下一步：${plain(record?.nextAction || company.nextAction || '请核实并安排下一步')}\n请在企业管理中更新进展，也可以把今天的实际工作发给我整理日报。`;
      }
      return `你有新的企业协作分工：${plain(company.name)}${record ? ` · ${plain(record.title)}` : ''}。\n请在员工端“企业管理”查看档案和下一步安排。`;
    }
    return undefined;
  }
  async flushOutbox(now = new Date()): Promise<void> {
    if (this.flushing || !this.client.isConnected) return;
    const settings = this.settings();
    if (!settings.enabled) return;
    // Human feedback is transactional, not a scheduled nudge: deliver even in quiet hours.
    const feedbackOnly = quiet(localTime(now).clock, settings);
    this.flushing = true;
    try {
      // An expired sending lease has an ambiguous transport outcome. Do not blindly duplicate it.
      this.db.prepare(`UPDATE notification_delivery SET state='exhausted',reason='发送结果不确定，请核对后手动重试'
        WHERE outbox_id IN (SELECT id FROM message_outbox WHERE tenant_id=? AND status='sending') AND lease_until<=?`).run(this.app.tenantId, now.toISOString());
      this.db.prepare(`UPDATE message_outbox SET status='failed',last_error='发送结果不确定，请核对后手动重试'
        WHERE tenant_id=? AND status='sending' AND id IN (SELECT outbox_id FROM notification_delivery WHERE state='exhausted')`).run(this.app.tenantId);
      const rows = this.db.prepare(`SELECT o.* FROM message_outbox o LEFT JOIN notification_delivery d ON d.outbox_id=o.id
        WHERE o.tenant_id=? AND o.status IN ('pending','failed') AND o.next_attempt_at<=? AND COALESCE(d.state,'ready')='ready' AND o.attempts<?
        AND (?=0 OR o.kind='manager_feedback') ORDER BY CASE WHEN o.kind='manager_feedback' THEN 0 ELSE 1 END,o.next_attempt_at,o.id LIMIT 30`)
        .all(this.app.tenantId, now.toISOString(), settings.maxAttempts, feedbackOnly ? 1 : 0) as unknown as OutboxRow[];
      for (const row of rows) {
        if (!this.enabled(row.kind, this.settings())) continue;
        const claimed = inTransaction(this.db, () => {
          this.db.prepare('INSERT OR IGNORE INTO notification_delivery(outbox_id) VALUES(?)').run(row.id);
          const claimed = repo.claimOutbox(this.db, row.id);
          if (claimed) this.db.prepare('UPDATE notification_delivery SET lease_until=? WHERE outbox_id=?').run(addMs(now, 5 * 60_000), row.id);
          return claimed;
        });
        if (!claimed) continue;
        let transportAccepted = false;
        try {
          const target = repo.activeUser(this.db, row.target_user_id, this.app.tenantId);
          if (!target) { this.cancel(row, '收件人不存在或已停用'); continue; }
          if (!target.wecom_userid || !repo.isUserBound(target)) throw new Error('unbound');
          const content = this.content(row, JSON.parse(row.payload_json) as Payload, target, now);
          if (!content) { this.cancel(row, '资料已变化、提醒已过期或收件人不再有权限'); continue; }
          await this.client.sendMessage(target.wecom_userid, { msgtype: 'markdown', markdown: { content } });
          transportAccepted = true;
          repo.markOutboxSent(this.db, row.id, now.toISOString());
          this.db.prepare('UPDATE notification_delivery SET lease_until=NULL,reason=NULL WHERE outbox_id=?').run(row.id);
          this.audit(row, 'sent');
        } catch (error) {
          const uncertain = transportAccepted || (error instanceof Error && /ack timeout|connection.*closed|server disconnected/i.test(error.message));
          const reason = uncertain ? '发送结果不确定，请核对后手动重试' : error instanceof Error && error.message === 'unbound' ? '收件人尚未绑定企微，等待绑定后重试' : '企微发送失败，等待重试；详情请检查脱敏网关日志';
          const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(row.attempts, 8));
          repo.markOutboxFailed(this.db, row.id, reason, addMs(now, delay));
          this.db.prepare('UPDATE notification_delivery SET lease_until=NULL,state=?,reason=? WHERE outbox_id=?').run(uncertain || row.attempts + 1 >= settings.maxAttempts ? 'exhausted' : 'ready', reason, row.id);
          this.audit(row, 'failed', reason);
        }
      }
    } finally { this.flushing = false; }
  }
}
