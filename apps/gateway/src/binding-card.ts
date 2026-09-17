import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { UserRow } from '@wecom/persistence';
import { bindingIntroduction } from './onboarding';

const BINDING_TASK_PREFIX = 'binding_';

export function bindingTaskId(activationId: string): string {
  return `${BINDING_TASK_PREFIX}${activationId}`;
}

export function activationIdFromBindingTask(taskId?: string): string | undefined {
  if (!taskId?.startsWith(BINDING_TASK_PREFIX)) return undefined;
  return taskId.slice(BINDING_TASK_PREFIX.length) || undefined;
}

export function bindingConfirmCard(activationId: string, name: string, department: string): TemplateCard {
  return {
    card_type: 'button_interaction',
    source: { desc: '日报助手', desc_color: 3 },
    main_title: { title: `确认绑定：${name}`, desc: department || '示例企业' },
    sub_title_text: '确认后，此企微账号将用于提交本人日报、接收反馈和查看授权内容。',
    button_list: [
      { text: '确认绑定', style: 1, key: 'confirm_binding' },
      { text: '取消', style: 2, key: 'cancel_binding' },
    ],
    task_id: bindingTaskId(activationId),
  };
}

export function bindingCompletedCard(taskId: string, name: string, user?: UserRow, portalUrl?: string): TemplateCard {
  return {
    card_type: 'text_notice',
    source: { desc: '日报助手', desc_color: 3 },
    main_title: { title: '绑定成功', desc: `${name}${user?.department ? ` · ${user.department}` : ''}` },
    sub_title_text: user ? bindingIntroduction(user) : '现在可以发送工作记录；日报草稿需你确认后入库。发送“我的工作台”或“帮助”继续。',
    horizontal_content_list: [
      { keyname: '试着发', value: '今天联系A企业，约好下周看场地' },
      { keyname: '周计划', value: '周计划：企业走访｜本周联系5家' },
    ],
    jump_list: [
      ...(portalUrl ? [{ type: 1 as const, title: '工作台（10分钟内有效）', url: portalUrl }] : [{ type: 3 as const, title: '我的工作台', question: '我的工作台' }]),
      { type: 3, title: '使用帮助', question: '帮助' },
    ],
    task_id: taskId,
  };
}

export function bindingCancelledCard(taskId: string): TemplateCard {
  return {
    card_type: 'text_notice',
    source: { desc: '日报助手', desc_color: 2 },
    main_title: { title: '已取消绑定', desc: '账号尚未关联' },
    sub_title_text: '绑定码仍在有效期内。如需继续，可再次发送“绑定 绑定码”。',
    task_id: taskId,
  };
}
