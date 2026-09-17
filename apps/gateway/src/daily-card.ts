import type { TemplateCard } from '@wecom/aibot-node-sdk';

// Legacy cards referenced mutable drafts. Require a fresh v2 card after upgrade.
const DAILY_TASK_PREFIX = 'daily_v2_';

function displayDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

export function dailyTaskId(reportId: string): string {
  return `${DAILY_TASK_PREFIX}${reportId}`;
}

export function reportIdFromDailyTask(taskId?: string): string | undefined {
  if (!taskId?.startsWith(DAILY_TASK_PREFIX)) return undefined;
  const reportId = taskId.slice(DAILY_TASK_PREFIX.length);
  return reportId || undefined;
}

export function dailyDraftCard(reportId: string, date: string, version?: number): TemplateCard {
  return {
    card_type: 'button_interaction',
    source: { desc: '日报助手', desc_color: 3 },
    main_title: { title: '日报草稿待确认', desc: `${displayDate(date)}${version ? ` · 第${version}版` : ''}` },
    sub_title_text: '内容已在上一条消息中展示。确认后正式入库，如需调整请选择修改。',
    button_list: [
      { text: '确认入库', style: 1, key: 'confirm_daily' },
      { text: '修改日报', style: 2, key: 'edit_daily' },
    ],
    task_id: dailyTaskId(reportId),
  };
}

export function dailyEditPromptCard(taskId: string, date: string): TemplateCard {
  return {
    card_type: 'button_interaction',
    source: { desc: '日报助手', desc_color: 3 },
    main_title: { title: '等待修改内容', desc: displayDate(date) },
    sub_title_text: '请直接发送需要补充或更正的内容，我会重新整理并生成新的确认卡片。',
    button_list: [
      { text: '确认原稿', style: 1, key: 'confirm_daily' },
      { text: '取消修改', style: 2, key: 'cancel_edit_daily' },
    ],
    task_id: taskId,
  };
}

export function dailyConfirmedCard(taskId: string, date: string): TemplateCard {
  return {
    card_type: 'text_notice',
    source: { desc: '日报助手', desc_color: 3 },
    main_title: { title: '日报已确认', desc: displayDate(date) },
    sub_title_text: '已正式入库，后续将纳入本周周报。',
    task_id: taskId,
  };
}
