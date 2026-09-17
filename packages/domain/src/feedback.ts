// 领导反馈：绑定约束，对应方案 §6.3。
// 反馈必须绑定周报；事项级绑定受 feedback.granularity 约束（§18.2）。

import { defaults } from './defaults';
import type { FeedbackGranularity } from './defaults';

export interface ManagerFeedback {
  id: string;
  weeklyReportId: string; // 必须绑定周报
  workItemId: string | null; // 可选绑定事项
  content: string;
  createdAt: Date;
}

export function isValidFeedback(
  feedback: { weeklyReportId?: string; workItemId?: string | null },
  granularity: FeedbackGranularity = defaults.feedbackGranularity,
): boolean {
  if (!feedback.weeklyReportId) return false; // 必须绑定周报
  if (granularity === 'weekly_only' && feedback.workItemId != null) return false;
  return true;
}
