import { describe, it, expect } from 'vitest';
import { missingDaysOfWeek } from './weekly-report';

describe('缺报判定', () => {
  it('整周未确认则 7 天全缺报', () => {
    expect(missingDaysOfWeek('2026-08-31', [])).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });

  it('确认周一到周五，周末缺报', () => {
    const confirmed = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    expect(missingDaysOfWeek('2026-08-31', confirmed)).toEqual(['2026-09-05', '2026-09-06']);
  });

  it('重复确认去重', () => {
    const confirmed = ['2026-08-31', '2026-08-31', '2026-09-01'];
    expect(missingDaysOfWeek('2026-08-31', confirmed)).toHaveLength(5);
  });

  it('工作周模式只检查周一到周五', () => {
    const confirmed = ['2026-08-31', '2026-09-01'];
    expect(missingDaysOfWeek('2026-08-31', confirmed, 'work_week')).toEqual([
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
  });
});
