import { describe, it, expect } from 'vitest';
import { isAtMaxItems, isItemLocked } from './work-item';
import type { WorkItem } from './work-item';

const sh = (s: string) => new Date(`${s}T04:00:00Z`);

const item = (id: string, createdAt: string): WorkItem => ({
  id,
  name: `事项-${id}`,
  planBackground: '',
  createdAt: sh(createdAt),
});

describe('事项数量上限（R01，默认 10）', () => {
  it('10 项封顶', () => {
    expect(isAtMaxItems(9)).toBe(false);
    expect(isAtMaxItems(10)).toBe(true);
    expect(isAtMaxItems(11)).toBe(true);
  });
});

describe('事项锁定（R02）', () => {
  it('周一设定的整周计划，周二起锁定', () => {
    const plan = item('1', '2026-08-31'); // 周一设定
    expect(isItemLocked(plan, sh('2026-08-31'))).toBe(false); // 周一当天可删
    expect(isItemLocked(plan, sh('2026-09-01'))).toBe(true); // 周二锁定
    expect(isItemLocked(plan, sh('2026-09-04'))).toBe(true); // 周五仍锁定
  });

  it('周二起追加的事项不锁定，可删除', () => {
    const appended = item('2', '2026-09-02'); // 周三追加
    expect(isItemLocked(appended, sh('2026-09-03'))).toBe(false);
  });
});
