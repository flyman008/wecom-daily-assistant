// 日报状态机：Collecting → Draft → PendingConfirmation → Confirmed → Superseded
// 对应方案 §6.2。Agent 只能产出草稿；只有明确确认才能入库；更正建新版本、旧版本 superseded。

export type DailyReportStatus =
  | 'collecting' // 收到原始记录，尚无草稿
  | 'draft' // 已有草稿（Agent 生成或员工修改后）
  | 'pending_confirmation' // 已发出确认卡片，等待员工确认
  | 'confirmed' // 员工明确确认，正式入库
  | 'superseded'; // 被更正后的新版本替代

const TRANSITIONS: Record<DailyReportStatus, readonly DailyReportStatus[]> = {
  collecting: ['draft'],
  draft: ['pending_confirmation', 'superseded'],
  pending_confirmation: ['draft', 'confirmed', 'superseded'],
  confirmed: ['superseded'],
  superseded: [],
};

export function canTransition(from: DailyReportStatus, to: DailyReportStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DailyReportStatus, to: DailyReportStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法日报状态迁移：${from} → ${to}`);
  }
}

// §6.2：普通「好的 / 知道了」不得误判为确认；只有按钮或与当前草稿绑定的明确口令才算。
export type ConfirmationSource = 'button' | 'explicit_command' | 'soft_ack';

export function isExplicitConfirmation(source: ConfirmationSource): boolean {
  return source === 'button' || source === 'explicit_command';
}

export interface DailyReportVersion {
  version: number;
  status: DailyReportStatus;
}

// 发起更正只创建草稿；原正式版在新版确认事务成功前继续有效。
export function revise(confirmed: DailyReportVersion): { old: DailyReportVersion; next: DailyReportVersion } {
  if (confirmed.status !== 'confirmed') throw new Error('只有正式日报可以发起更正');
  return {
    old: { ...confirmed },
    next: { version: confirmed.version + 1, status: 'draft' },
  };
}
