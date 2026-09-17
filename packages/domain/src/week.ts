// 自然周（周一至周日）与日期工具，时区固定 Asia/Shanghai。
// 对应方案 §8 `week_cycle`：周一至周日，时区 Asia/Shanghai。

import { defaults } from './defaults';

const TZ = defaults.timezone;

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

export interface Ymd {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekday: number; // 1=周一 .. 7=周日
}

/** 返回某个时刻在 Asia/Shanghai 时区下的年月日与星期几。 */
export function ymdInTimeZone(date: Date): Ymd {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
  };
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 自然周标识：该周周一的 YYYY-MM-DD（Asia/Shanghai）。 */
export function weekId(date: Date): string {
  const { year, month, day, weekday } = ymdInTimeZone(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - (weekday - 1));
  return toYmd(d);
}

/** 该自然周的周日 YYYY-MM-DD。 */
export function sundayOf(date: Date): string {
  const monday = weekId(date);
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return toYmd(d);
}

/** R02 锁定判定：进入周二（含）后为 true。 */
export function isTuesdayOrLater(date: Date): boolean {
  return ymdInTimeZone(date).weekday >= 2;
}
