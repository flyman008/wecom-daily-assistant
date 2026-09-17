// 可运行 demo：走一遍完整闭环（周计划 → 记录 → 草稿 → 确认 → 周报 → 反馈），
// 全程用 Mock Agent，数据落在 SQLite。用于「能跑」验收。
import { openDb } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { MockAgent } from '@wecom/agent';
import type { Agent } from '@wecom/agent';
import { DailyAssistantApp } from './app';

export interface DemoResult {
  workItems: number;
  dailyReport: { status: string; summary: string };
  weeklyReport: { content: string; missingDays: string[] };
  feedbackCount: number;
}

export async function runDemo(dbPath = ':memory:', agent: Agent = new MockAgent()): Promise<DemoResult> {
  const db = openDb(dbPath);
  const app = new DailyAssistantApp(db, agent);
  const user = 'e001';
  const week = '2026-08-31';

  app.createWeeklyPlan(user, week, [
    { name: '走访企业5家', planBackground: 'A/B/C/D/E 五家企业' },
    { name: '开展活动2场', planBackground: '' },
  ]);

  const draftId = await app.submitRecord(user, '2026-08-31', '走访1家，是A企业，完成20%');
  // Local demo simulates the delivery acknowledgement; production does this after sending.
  app.completeDailyPresentation(user, app.prepareDailyPresentation(user, draftId));
  app.confirm(user, '2026-08-31', 'button');

  const wrId = await app.generateWeeklyReport(user, week);
  repo.upsertUser(db, { id: 'manager', name: '演示主管', role: 'dept_head' });
  repo.updateUserAssignment(db,'e001','employee','manager');
  app.addFeedback(wrId, '进度不错，下周继续');

  const daily = repo.getLatestDailyReport(db, user, '2026-08-31')!;
  const weekly = repo.getWeeklyReport(db, user, week)!;
  const workItems = repo.listWorkItems(db, user, week);
  const feedbackCount = db.prepare('SELECT COUNT(*) AS n FROM manager_feedback').get() as { n: number };

  const result: DemoResult = {
    workItems: workItems.length,
    dailyReport: { status: daily.status, summary: daily.summary ?? '' },
    weeklyReport: { content: weekly.content, missingDays: JSON.parse(weekly.missing_days_json) },
    feedbackCount: feedbackCount.n,
  };

  console.log('=== 日报周报小助理 POC 闭环 ===');
  console.log(`周计划事项：${result.workItems} 项`);
  console.log(`日报草稿 id=${draftId}，确认后状态=${result.dailyReport.status}`);
  console.log(`  日报摘要：${result.dailyReport.summary}`);
  console.log(`周报 id=${wrId}，摘要：${result.weeklyReport.content}`);
  console.log(`  缺报天数：${result.weeklyReport.missingDays.length} 天（${result.weeklyReport.missingDays.join(', ')}）`);
  console.log(`领导反馈：${result.feedbackCount} 条`);

  return result;
}
