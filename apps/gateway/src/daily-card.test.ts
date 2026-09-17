import { describe, expect, it } from 'vitest';
import {
  dailyConfirmedCard,
  dailyDraftCard,
  dailyEditPromptCard,
  dailyTaskId,
  reportIdFromDailyTask,
} from './daily-card';

describe('日报确认卡片', () => {
  it('只展示操作说明，不重复日报摘要，并提供确认与修改操作', () => {
    const card = dailyDraftCard('report-1', '2026-09-05');

    expect(card.main_title).toEqual({ title: '日报草稿待确认', desc: '2026年9月5日' });
    expect(card.sub_title_text).not.toContain('招商项目进展');
    expect(card.button_list).toEqual([
      { text: '确认入库', style: 1, key: 'confirm_daily' },
      { text: '修改日报', style: 2, key: 'edit_daily' },
    ]);
    expect(card.task_id).toBe('daily_v2_report-1');
  });

  it('修改与确认后的卡片状态文案清晰', () => {
    const editCard = dailyEditPromptCard('daily_report-1', '2026-09-05');
    expect(editCard.main_title?.title).toBe('等待修改内容');
    expect(editCard.button_list?.map((button) => button.key)).toEqual(['confirm_daily', 'cancel_edit_daily']);
    expect(dailyConfirmedCard('daily_report-1', '2026-09-05').sub_title_text).toContain('正式入库');
  });

  it('任务标识可安全往返解析', () => {
    expect(dailyTaskId('abc-123')).toBe('daily_v2_abc-123');
    expect(reportIdFromDailyTask('daily_v2_abc-123')).toBe('abc-123');
    expect(reportIdFromDailyTask('daily_abc-123')).toBeUndefined();
    expect(reportIdFromDailyTask('weekly_abc-123')).toBeUndefined();
    expect(reportIdFromDailyTask('daily_')).toBeUndefined();
    expect(reportIdFromDailyTask('daily_v2_')).toBeUndefined();
  });

  it('显示具体版本号供员工核对', () => {
    expect(dailyDraftCard('report-2', '2026-09-05', 2).main_title?.desc).toContain('第2版');
  });
});
