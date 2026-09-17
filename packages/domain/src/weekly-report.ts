// 周报：缺报判定与快照生成约束，对应方案 §6.3。
// §6.2：周报只使用已确认日报；未确认日期显示为缺报，不允许 Agent 补写成事实。

export interface WeeklyReportSnapshot {
  /** 周一 YYYY-MM-DD */
  weekId: string;
  templateVersion: string;
  generatedAt: Date;
  /** 只允许引用已确认日报的 id */
  citedReportIds: string[];
  /** 缺报日期列表（YYYY-MM-DD） */
  missingDays: string[];
}

import type { WeekBoundary } from './defaults';

/** 给定周一与已确认日报日期集合，返回缺报日期列表。 */
export function missingDaysOfWeek(
  monday: string,
  confirmedDates: string[],
  boundary: WeekBoundary = 'natural_week',
): string[] {
  const confirmed = new Set(confirmedDates);
  const missing: string[] = [];
  const start = new Date(`${monday}T00:00:00Z`);
  const dayCount = boundary === 'work_week' ? 5 : 7;
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start.getTime());
    d.setUTCDate(start.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10);
    if (!confirmed.has(ymd)) missing.push(ymd);
  }
  return missing;
}
