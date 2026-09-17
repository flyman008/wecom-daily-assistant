import { describe, it, expect } from 'vitest';
import { isValidFeedback } from './feedback';

describe('反馈绑定校验', () => {
  it('必须绑定周报', () => {
    expect(isValidFeedback({})).toBe(false);
    expect(isValidFeedback({ weeklyReportId: 'wr-1' })).toBe(true);
  });

  it('weekly_only 模式不允许事项级反馈', () => {
    expect(isValidFeedback({ weeklyReportId: 'wr-1', workItemId: 'wi-1' }, 'weekly_only')).toBe(false);
    expect(isValidFeedback({ weeklyReportId: 'wr-1', workItemId: null }, 'weekly_only')).toBe(true);
  });

  it('weekly_and_item 模式允许事项级反馈', () => {
    expect(isValidFeedback({ weeklyReportId: 'wr-1', workItemId: 'wi-1' }, 'weekly_and_item')).toBe(true);
  });
});
