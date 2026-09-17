import { describe, it, expect } from 'vitest';
import { weekId, sundayOf, isTuesdayOrLater, ymdInTimeZone } from './week';

// 用 UTC 04:00（= 上海 12:00）构造，避免时区边界歧义。
const sh = (s: string) => new Date(`${s}T04:00:00Z`);

describe('自然周 weekId（Asia/Shanghai）', () => {
  it('周五 2026-09-04 归属 2026-08-31（周一）起的自然周', () => {
    expect(weekId(sh('2026-09-04'))).toBe('2026-08-31');
  });

  it('周一当天归属自己', () => {
    expect(weekId(sh('2026-08-31'))).toBe('2026-08-31');
  });

  it('周日归属本周周一，sundayOf 返回周日', () => {
    expect(weekId(sh('2026-09-06'))).toBe('2026-08-31');
    expect(sundayOf(sh('2026-09-06'))).toBe('2026-09-06');
  });
});

describe('周二锁定判定', () => {
  it('周一不锁定，周二起锁定', () => {
    expect(isTuesdayOrLater(sh('2026-08-31'))).toBe(false); // 周一
    expect(isTuesdayOrLater(sh('2026-09-01'))).toBe(true); // 周二
    expect(isTuesdayOrLater(sh('2026-09-06'))).toBe(true); // 周日
  });

  it('星期几映射正确', () => {
    expect(ymdInTimeZone(sh('2026-08-31')).weekday).toBe(1); // 周一
    expect(ymdInTimeZone(sh('2026-09-04')).weekday).toBe(5); // 周五
  });
});
