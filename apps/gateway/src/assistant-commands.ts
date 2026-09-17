import type { TemplateCard } from '@wecom/aibot-node-sdk';

export type AssistantCommand =
  | { type: 'lookup'; scope: 'history' | 'knowledge'; query: string }
  | { type: 'schedule'; payload: { planReminderAt?: string; dailyReminderAt?: string; weeklyGenerateAt?: string } }
  | { type: 'knowledge'; payload: { kind: 'park_material' | 'policy' | 'guide' | 'service_company'; title: string; content: string; sourceName?: string; tags?: string[] } }
  | { type: 'followup'; companyName: string; content: string }
  | { type: 'invalid'; message: string };

const KNOWLEDGE_FORMAT = '请按此格式发送文字资料：\n新增资料：资料标题\n类型：园区资料（或政策文件、操作指南、企业参考资料）\n来源：可选的出处\n正文：完整文字内容\n本入口不解析附件，提交后还需确认。';
const FOLLOWUP_FORMAT = '请按此格式发送：\n记录企业跟进：企业全称\n内容：本次跟进事实\n只追加历史，不自动更新阶段或负责人。';
const TIME_FIELDS = { 日报提醒: 'dailyReminderAt', 周计划提醒: 'planReminderAt', 周报生成时间: 'weeklyGenerateAt' } as const;

/** Explicit bounded commands. Unrecognized ordinary chat remains a work record. */
export function parseAssistantCommand(raw: string): AssistantCommand | undefined {
  const text = raw.trim();
  const lookup = /^(?:查询|查)(历史|资料)[：:]\s*([\s\S]*)$/u.exec(text);
  if (lookup) return lookup[2].trim() && lookup[2].trim().length <= 160
    ? { type: 'lookup', scope: lookup[1] === '历史' ? 'history' : 'knowledge', query: lookup[2].trim() }
    : { type: 'invalid', message: '请在冒号后填写1—160字关键词，例如“查询历史：园区走访”。' };
  const schedule = /^(?:设置|修改)(日报提醒|周计划提醒|周报生成时间)[：:\s]*([\s\S]*)$/u.exec(text)
    ?? /^把(日报提醒|周计划提醒|周报生成时间)(?:时间)?改(?:为|成)\s*([\s\S]*)$/u.exec(text);
  if (schedule) return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule[2])
    ? { type: 'schedule', payload: { [TIME_FIELDS[schedule[1] as keyof typeof TIME_FIELDS]]: schedule[2] } }
    : { type: 'invalid', message: '时间请写为HH:mm，例如“设置日报提醒：17:30”。日期、免打扰和开关不会随本操作改变。' };
  if (/^新增资料(?:[：:]|$)/u.test(text)) {
    const lines = text.split(/\r?\n/);
    const title = /^新增资料[：:]\s*(.+)$/.exec(lines[0])?.[1]?.trim();
    const bodyAt = lines.findIndex((line, index) => index > 0 && /^正文[：:]/u.test(line));
    if (!title || bodyAt < 1) return { type: 'invalid', message: KNOWLEDGE_FORMAT };
    const fields = new Map<string, string>();
    for (const line of lines.slice(1, bodyAt)) {
      if (!line.trim()) continue;
      const match = /^(类型|来源|标签)[：:]\s*(.*)$/u.exec(line);
      if (!match || fields.has(match[1])) return { type: 'invalid', message: KNOWLEDGE_FORMAT };
      fields.set(match[1], match[2]);
    }
    const kinds = { 园区资料: 'park_material', 政策文件: 'policy', 操作指南: 'guide', 企业参考资料: 'service_company' } as const;
    const kind = kinds[fields.get('类型') as keyof typeof kinds];
    const content = [lines[bodyAt].replace(/^正文[：:]\s*/u, ''), ...lines.slice(bodyAt + 1)].join('\n').trim();
    if (!kind || !content) return { type: 'invalid', message: KNOWLEDGE_FORMAT };
    return { type: 'knowledge', payload: { kind, title, content, sourceName: fields.get('来源'),
      tags: fields.get('标签')?.split(/[，,]/).map(x => x.trim()).filter(Boolean) } };
  }
  if (/^记录企业跟进(?:[：:]|$)/u.test(text)) {
    const match = /^记录企业跟进[：:]\s*([^\n]+)\r?\n内容[：:]\s*([\s\S]+)$/u.exec(text);
    return match?.[1].trim() && match[2].trim()
      ? { type: 'followup', companyName: match[1].trim(), content: match[2].trim() }
      : { type: 'invalid', message: FOLLOWUP_FORMAT };
  }
  if (/^(?:新增资料|记录企业跟进|(?:设置|修改|把)(?:日报提醒|周计划提醒|周报生成时间)|(?:查询|查)(?:历史|资料))/u.test(text)) {
    return { type: 'invalid', message: '这是操作或查询指令，尚未记入日报。请发送“帮助”查看支持的格式。' };
  }
  return undefined;
}

const PREFIX = 'action_v1:';
export function actionTaskId(id: string, token: string): string {
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(token)) throw new Error('操作确认标识无效');
  const task = `${PREFIX}${id}:${token}`;
  if (task.length > 128) throw new Error('操作确认标识过长');
  return task;
}
export function actionFromTask(task?: string): { id: string; token: string } | undefined {
  if (!task?.startsWith(PREFIX)) return undefined;
  const parts = task.slice(PREFIX.length).split(':');
  return parts.length === 2 && parts.every(x => /^[\w-]+$/.test(x)) ? { id: parts[0], token: parts[1] } : undefined;
}
export function actionCard(id: string, token: string): TemplateCard {
  return { card_type: 'button_interaction', source: { desc: '日报助手 · 操作确认', desc_color: 3 },
    main_title: { title: '请核对上方变更预览', desc: '10分钟内有效 · 未确认不执行' },
    sub_title_text: '确认后才保存到后台。修改会取消本次提案，请重新发送完整要求。',
    button_list: [{ text: '确认执行', style: 1, key: 'confirm_action' }, { text: '修改', style: 2, key: 'edit_action' }, { text: '取消', style: 2, key: 'cancel_action' }],
    task_id: actionTaskId(id, token) };
}
