import path from 'node:path';
import { weekBoundaryFrom, type WeekBoundary } from '@wecom/domain';
export { readProjectEnv as loadProjectEnv } from '../../shared/project-env';

export interface GatewayConfig {
  botId: string;
  secret: string;
  databasePath: string;
  attachmentDir: string;
  attachmentMaxBytes: number;
  healthPort: number;
  heartbeatMs: number;
  maxReconnectAttempts: number;
  maxActiveTasksPerUser: number;
  streamFlushMs: number;
  streamTimeoutMs: number;
  outboxPollMs: number;
  planReminderAt: string;
  dailyReminderAt: string;
  weeklyGenerateAt: string;
  weekBoundary: WeekBoundary;
  reportBaseUrl?: string;
}

function time(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${name}必须是HH:mm`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少必填配置：${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name}必须是不小于${minimum}的整数`);
  return value;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = {}): GatewayConfig {
  const reconnect = Number(env.WECOM_MAX_RECONNECT_ATTEMPTS ?? -1);
  if (!Number.isInteger(reconnect) || reconnect < -1) throw new Error('WECOM_MAX_RECONNECT_ATTEMPTS必须为-1或非负整数');
  return {
    botId: required(env, 'WECOM_BOT_ID'),
    secret: required(env, 'WECOM_BOT_SECRET'),
    databasePath: path.resolve(env.DATABASE_PATH ?? '.runtime/data/poc.sqlite'),
    attachmentDir: path.resolve(env.ATTACHMENT_DIR ?? '.runtime/attachments'),
    attachmentMaxBytes: integer(env, 'ATTACHMENT_MAX_BYTES', 50 * 1024 * 1024, 1024),
    healthPort: integer(env, 'GATEWAY_HEALTH_PORT', 8788, 1),
    heartbeatMs: integer(env, 'WECOM_HEARTBEAT_MS', 30_000, 5_000),
    maxReconnectAttempts: reconnect,
    maxActiveTasksPerUser: integer(env, 'MAX_ACTIVE_TASKS_PER_USER', 3, 1),
    streamFlushMs: integer(env, 'STREAM_FLUSH_MS', 800, 100),
    streamTimeoutMs: integer(env, 'STREAM_TIMEOUT_MS', 330_000, 10_000),
    outboxPollMs: integer(env, 'OUTBOX_POLL_MS', 5_000, 1_000),
    planReminderAt: time(env, 'PLAN_REMINDER_AT', '09:00'),
    dailyReminderAt: time(env, 'DAILY_REMINDER_AT', '17:30'),
    weeklyGenerateAt: time(env, 'WEEKLY_GENERATE_AT', '09:00'),
    weekBoundary: weekBoundaryFrom(env.WEEK_BOUNDARY),
    reportBaseUrl: env.REPORT_BASE_URL?.trim() || undefined,
  };
}
