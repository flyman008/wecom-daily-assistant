import { describe, it, expect, vi } from 'vitest';
import { runDemo } from './demo';

describe('POC 闭环集成', () => {
  it('跑通周计划→记录→草稿→确认→周报→反馈', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-07T04:00:00Z'));
    try {
    const r = await runDemo(':memory:');
    expect(r.workItems).toBe(2);
    expect(r.dailyReport.status).toBe('confirmed');
    expect(r.dailyReport.summary).toContain('走访1家');
    expect(r.weeklyReport.content).toContain('周报');
    // 只确认了周一，其余 6 天缺报
    expect(r.weeklyReport.missingDays).toHaveLength(6);
    expect(r.feedbackCount).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});
