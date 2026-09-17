// 默认配置的唯一来源。方案 §18：业务决策一律做成「配置项 + 初始化默认值」，
// Mock Agent 与正式 Agent 都从这里读；业务代码中不得二次硬编码这些值。

export type WeekBoundary = 'natural_week' | 'work_week';
export type ConfirmPolicy = 'button_and_text' | 'button_only' | 'text_only';
export type ProgressMode = 'cumulative' | 'incremental' | 'subitem';
export type FeedbackGranularity = 'weekly_and_item' | 'weekly_only';

export const ROLES = ['employee', 'team_lead', 'dept_head', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface RetentionPolicy {
  /** 已确认日报/周报及版本：长期保存，不从后台硬删除 */
  dailyWeekly: 'keep';
  /** 管理者反馈：随周报长期保存 */
  feedback: 'keep';
  /** 审计日志留存天数，不少于 1 年 */
  auditLogDays: number;
  /** 原始文字/语音转写留存天数 */
  sourceDays: number;
  /** 原始附件留存天数 */
  attachmentDays: number;
}

export interface ScheduleDefaults {
  /** 周一未设置周计划提醒 */
  planReminderAt: string;
  /** 每日填写进展提醒（工作日） */
  dailyReminderAt: string;
  /** 当日超时未确认算缺报 */
  dailyCutoffAt: string;
  /** 周报生成 */
  weeklyGenerate: { weekday: 'monday'; time: string };
  /** 周报推送管理者 */
  weeklyPush: { weekday: 'monday'; time: string };
}

export interface Defaults {
  tenantName: string;
  timezone: 'Asia/Shanghai';
  weekBoundary: WeekBoundary;
  confirmPolicy: ConfirmPolicy;
  progressMode: ProgressMode;
  feedbackGranularity: FeedbackGranularity;
  /** R01：事项数量上限 */
  maxWorkItems: number;
  schedule: ScheduleDefaults;
  retention: RetentionPolicy;
  roles: readonly Role[];
  agent: { runtime: string };
  deployment: { githubAccount: string; authFallback: string };
}

export function weekBoundaryFrom(value: string | undefined): WeekBoundary {
  return value === 'work_week' ? 'work_week' : 'natural_week';
}

export const defaults: Defaults = {
  tenantName: '示例企业',
  timezone: 'Asia/Shanghai',
  weekBoundary: 'natural_week',
  confirmPolicy: 'button_and_text',
  progressMode: 'cumulative',
  feedbackGranularity: 'weekly_and_item',
  maxWorkItems: 10,
  schedule: {
    planReminderAt: '09:00',
    dailyReminderAt: '17:30',
    dailyCutoffAt: '18:00',
    weeklyGenerate: { weekday: 'monday', time: '09:00' },
    weeklyPush: { weekday: 'monday', time: '09:00' },
  },
  retention: {
    dailyWeekly: 'keep',
    feedback: 'keep',
    auditLogDays: 365,
    sourceDays: 365,
    attachmentDays: 90,
  },
  roles: ['employee', 'team_lead', 'dept_head', 'admin'],
  agent: { runtime: 'mock' },
  deployment: { githubAccount: '', authFallback: '短时访问码' },
};
