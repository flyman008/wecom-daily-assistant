// 事项（周计划条目）与锁定规则，对应 R01/R02 与方案 §6.1。

import { defaults } from './defaults';
import { isTuesdayOrLater, weekId, ymdInTimeZone } from './week';

export interface WorkItem {
  id: string;
  name: string;
  planBackground: string;
  createdAt: Date;
}

/** R01：事项数量上限（默认 10）。 */
export function isAtMaxItems(count: number): boolean {
  return count >= defaults.maxWorkItems;
}

/**
 * R02：周一设定的整周计划，进入周二后锁定——不可删除，只能追加。
 * 周二及以后追加的事项不在锁定范围内，可删除。
 */
export function isItemLocked(item: WorkItem, now: Date): boolean {
  if (!isTuesdayOrLater(now)) {
    return false; // 周一当天仍可删
  }
  const created = ymdInTimeZone(item.createdAt);
  return created.weekday === 1 && weekId(item.createdAt) === weekId(now);
}
