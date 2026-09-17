import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isExplicitConfirmation,
  revise,
} from './daily-report';
import type { DailyReportStatus, DailyReportVersion } from './daily-report';

describe('日报状态迁移', () => {
  const legal: Array<[DailyReportStatus, DailyReportStatus]> = [
    ['collecting', 'draft'],
    ['draft', 'pending_confirmation'],
    ['pending_confirmation', 'draft'],
    ['pending_confirmation', 'confirmed'],
    ['pending_confirmation', 'superseded'],
    ['draft', 'superseded'],
    ['confirmed', 'superseded'],
  ];

  it.each(legal)('%s → %s 合法', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const illegal: Array<[DailyReportStatus, DailyReportStatus]> = [
    ['draft', 'confirmed'], // 必须先发出确认卡片
    ['collecting', 'confirmed'],
    ['collecting', 'pending_confirmation'],
    ['confirmed', 'draft'], // 已确认不可回退成草稿
    ['superseded', 'draft'],
    ['superseded', 'confirmed'],
  ];

  it.each(illegal)('%s → %s 非法', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow();
  });
});

describe('确认语义', () => {
  it('只有按钮或明确口令算确认，「好的/知道了」不算', () => {
    expect(isExplicitConfirmation('button')).toBe(true);
    expect(isExplicitConfirmation('explicit_command')).toBe(true);
    expect(isExplicitConfirmation('soft_ack')).toBe(false);
  });
});

describe('更正建新版本', () => {
  it('旧正式版继续有效，新版本 version+1 且回到 draft', () => {
    const v1: DailyReportVersion = { version: 1, status: 'confirmed' };
    const { old, next } = revise(v1);
    expect(old.status).toBe('confirmed');
    expect(next.version).toBe(2);
    expect(next.status).toBe('draft');
  });

  it('非 confirmed 状态不可更正', () => {
    const draft: DailyReportVersion = { version: 1, status: 'draft' };
    expect(() => revise(draft)).toThrow();
  });
});
