import { randomUUID } from 'node:crypto';
import { getConfig, setConfig, insertAudit, inTransaction, type Db } from '@wecom/persistence';

export interface NotificationSettings {
  enabled: boolean;
  planReminderEnabled: boolean;
  planReminderAt: string;
  dailyReminderEnabled: boolean;
  dailyReminderAt: string;
  dailyReminderDays: number[];
  weeklyReportEnabled: boolean;
  weeklyGenerateAt: string;
  weeklyWeekday: number;
  weeklyTarget: 'previous' | 'current';
  catchupDays: number;
  riskEnabled: boolean;
  riskThreshold: number;
  riskEarliestWeekday: number;
  feedbackEnabled: boolean;
  crmAssignmentEnabled: boolean;
  crmDueEnabled: boolean;
  crmDueAt: string;
  quietStart: string;
  quietEnd: string;
  maxAttempts: number;
}
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true, planReminderEnabled: true, planReminderAt: '09:00',
  dailyReminderEnabled: true, dailyReminderAt: '17:30', dailyReminderDays: [1, 2, 3, 4, 5, 6, 7], weeklyReportEnabled: true,
  weeklyGenerateAt: '09:00', weeklyWeekday: 1, weeklyTarget: 'previous', catchupDays: 2, feedbackEnabled: true,
  riskEnabled: false, riskThreshold: 50, riskEarliestWeekday: 5,
  crmAssignmentEnabled: false, crmDueEnabled: false, crmDueAt: '09:30',
  quietStart: '21:00', quietEnd: '08:00', maxAttempts: 5,
};

export function ensureNotificationSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_delivery (
    outbox_id TEXT PRIMARY KEY REFERENCES message_outbox(id),
    state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','cancelled','exhausted')),
    lease_until TEXT, reason TEXT
  );
  CREATE TABLE IF NOT EXISTS notification_job (
    tenant_id TEXT NOT NULL, job_key TEXT NOT NULL, state TEXT NOT NULL,
    lease_until TEXT NOT NULL, result_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id,job_key)
  );`);
}

export function notificationSettings(db: Db, tenantId = 'poc', fallbacks: Partial<NotificationSettings> = {}): NotificationSettings {
  const defaults = { ...DEFAULT_NOTIFICATION_SETTINGS, ...fallbacks };
  // Preserve pre-existing schedule settings until explicitly changed in this page.
  for (const key of ['planReminderAt', 'dailyReminderAt', 'weeklyGenerateAt'] as const) defaults[key] = getConfig(db, key, defaults[key], tenantId);
  const saved = getConfig<Partial<NotificationSettings>>(db, 'notifications', {}, tenantId);
  const legacy = !saved.weeklyTarget && (saved.weeklyWeekday !== undefined || saved.weeklyGenerateAt !== undefined || getConfig<string | null>(db, 'weeklyGenerateAt', null, tenantId) !== null);
  return { ...defaults, ...(legacy ? { weeklyWeekday: saved.weeklyWeekday ?? 7, weeklyTarget: 'current' as const } : {}), ...saved,
    dailyReminderDays: [...(saved.dailyReminderDays ?? defaults.dailyReminderDays)] };
}

export function updateNotificationSettings(db: Db, value: unknown, actorUserId: string | null, tenantId = 'poc', now = new Date()): NotificationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('通知配置必须是对象');
  const input = value as Record<string, unknown>;
  const current = notificationSettings(db, tenantId);
  for (const [key, item] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_NOTIFICATION_SETTINGS, key)) throw new Error(`不支持的通知配置：${key}`);
    if (key === 'dailyReminderDays') {
      if (!Array.isArray(item) || item.length > 7 || !item.every(day => Number.isInteger(day) && day >= 1 && day <= 7) || new Set(item).size !== item.length) throw new Error('日报提醒日须为不重复的1到7，可留空停用');
      continue;
    }
    if (key === 'weeklyTarget') {
      if (item !== 'previous' && item !== 'current') throw new Error('周报目标周必须为previous或current');
      continue;
    }
    const expected = typeof DEFAULT_NOTIFICATION_SETTINGS[key as keyof NotificationSettings];
    if (typeof item !== expected) throw new Error(`${key}类型不正确`);
    if (expected === 'string' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(item))) throw new Error(`${key}必须为HH:mm`);
  }
  const next = { ...current, ...input } as NotificationSettings;
  if (!Number.isInteger(next.weeklyWeekday) || next.weeklyWeekday < 1 || next.weeklyWeekday > 7) throw new Error('周报发送日必须为1到7');
  if (!Number.isInteger(next.maxAttempts) || next.maxAttempts < 1 || next.maxAttempts > 10) throw new Error('自动重试次数必须为1到10');
  if (!Number.isInteger(next.catchupDays) || next.catchupDays < 0 || next.catchupDays > 6) throw new Error('错过排期补发天数必须为0到6');
  if (!Number.isFinite(next.riskThreshold) || next.riskThreshold < 0 || next.riskThreshold > 100) throw new Error('风险阈值必须为0到100');
  if (!Number.isInteger(next.riskEarliestWeekday) || next.riskEarliestWeekday < 1 || next.riskEarliestWeekday > 7) throw new Error('风险提醒起始日必须为1到7');
  if (next.quietStart === next.quietEnd) throw new Error('免打扰开始和结束时间不能相同');
  ensureNotificationSchema(db);
  return inTransaction(db, () => {
    if (next.crmAssignmentEnabled && !current.crmAssignmentEnabled) setConfig(db, 'notifications.crmAssignmentSince', now.toISOString(), tenantId);
    setConfig(db, 'notifications', next, tenantId);
    for (const key of ['planReminderAt', 'dailyReminderAt', 'weeklyGenerateAt'] as const) setConfig(db, key, next[key], tenantId);
    insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: actorUserId,
      action: 'notifications.settings_updated', resource_type: 'config', resource_id: 'notifications',
      details_json: JSON.stringify({ before: current, after: next }), created_at: now.toISOString() });
    return next;
  });
}

export function notificationOverview(db: Db, tenantId = 'poc') {
  ensureNotificationSchema(db);
  const queue = db.prepare(`SELECT o.id,o.kind,o.target_user_id,COALESCE(u.name,'人员不可用') AS target_name,
    CASE WHEN d.state='cancelled' THEN 'cancelled' ELSE o.status END AS status,
    o.attempts,o.created_at,o.next_attempt_at,o.sent_at,
    CASE WHEN d.reason IS NOT NULL THEN d.reason WHEN o.last_error IS NOT NULL THEN '旧发送错误，请检查脱敏网关日志' ELSE NULL END AS last_error,
    CASE WHEN o.status='failed' AND COALESCE(d.state,'ready')<>'cancelled' THEN 1 ELSE 0 END AS can_retry
    FROM message_outbox o LEFT JOIN app_user u ON u.id=o.target_user_id AND u.tenant_id=o.tenant_id
    LEFT JOIN notification_delivery d ON d.outbox_id=o.id
    WHERE o.tenant_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 200`).all(tenantId);
  const saved = getConfig<Partial<NotificationSettings>>(db, 'notifications', {}, tenantId);
  const legacy = !saved.weeklyTarget && (saved.weeklyWeekday !== undefined || saved.weeklyGenerateAt !== undefined || getConfig<string | null>(db, 'weeklyGenerateAt', null, tenantId) !== null);
  return { settings: notificationSettings(db, tenantId), queue, compatibilityNote: legacy ? '检测到旧排期：已保留原发送日、时间及当周口径。请确认并保存“目标周”，新配置默认周一09:00发送上一自然周。' : null };
}

export function retryNotification(db: Db, id: string, actorUserId: string | null, tenantId = 'poc', now = new Date()): void {
  ensureNotificationSchema(db);
  inTransaction(db, () => {
    const row = db.prepare(`SELECT o.status,d.state FROM message_outbox o LEFT JOIN notification_delivery d ON d.outbox_id=o.id WHERE o.id=? AND o.tenant_id=?`).get(id, tenantId) as { status: string; state: string } | undefined;
    if (!row || row.status !== 'failed' || row.state === 'cancelled') throw new Error('仅失败且未撤销的消息可以重试');
    db.prepare("UPDATE notification_delivery SET state='ready',lease_until=NULL,reason=NULL WHERE outbox_id=?").run(id);
    db.prepare("UPDATE message_outbox SET status='pending',attempts=0,next_attempt_at=?,last_error=NULL WHERE id=? AND tenant_id=?").run(now.toISOString(), id, tenantId);
    insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: actorUserId, action: 'notifications.retry_requested', resource_type: 'message_outbox', resource_id: id, created_at: now.toISOString() });
  });
}
