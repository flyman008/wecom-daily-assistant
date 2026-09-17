import type { Db, UserRow } from '@wecom/persistence';

export const PRIVATE_CHAT_GUIDANCE = '我是示例企业的日报助手。工作记录、账号绑定和个人工作台请私聊我办理，群内不展示个人资料。';
export const UNBOUND_REMINDER = '账号尚未绑定。请找管理员领取一次性绑定码，再私聊发送“绑定 你的绑定码”。';
export const UNBOUND_GUIDANCE = [
  '你好，我是示例企业的日报助手，可以整理工作记录、日报和周报。',
  '首次使用请联系管理员领取一次性绑定码，再私聊发送绑定码，核对姓名后回复“确认绑定”；如姓名不对，回复“取消绑定”。',
  '请勿把绑定码发到群里。绑定前的消息不会记入工作记录。',
].join('\n');

const ROLE_LABELS: Record<UserRow['role'], string> = {
  employee: '员工', team_lead: '组长', dept_head: '部门负责人', admin: '管理员',
};

export function bindingTextPreview(user: UserRow): string {
  return `请核对绑定身份：\n姓名：${user.name}\n角色：${ROLE_LABELS[user.role]}${user.department?`\n部门：${user.department}`:''}\n\n如果是本人，请在10分钟内回复“确认绑定”。\n姓名不对请回复“取消绑定”。确认前不会记录日报。`;
}

export function isHelpCommand(text: string): boolean {
  return /^(?:帮助|help|\/help|开始|你好|您好|你好[，, ]?(?:日报助手|小助理)|(?:日报助手|小助理)[，, ]?你好|我能做什么|你能做什么|能做什么|你是谁|怎么用)[!！?？。\s]*$/iu.test(text.trim());
}

export function isPortalCommand(text: string): boolean {
  return /^(?:我的工作台|打开工作台)[!！?？。\s]*$/u.test(text.trim());
}

export function welcomeBack(user: UserRow): string {
  return `${user.name}，欢迎回来。直接发送今天的工作进展，我会整理草稿供你确认。发送“我的工作台”查看本人工作${user.role === 'employee' ? '' : '或切换团队管理'}；发送“帮助”查看用法。`;
}

export function bindingIntroduction(user: UserRow): string {
  return [
    `身份：${ROLE_LABELS[user.role]}。${user.role === 'employee' ? '支持本人工作记录。' : '支持本人日报和授权团队管理。'}`,
    '我能整理日报/周报、接收反馈。原始记录留存，日报需你确认后才正式入库。',
    '文字/企微语音转写可整理；图片文件请补文字。',
  ].join('\n');
}

export function helpFor(user: UserRow): string {
  return [
    `${user.name}，你可以这样使用日报助手：`,
    '• 直接发工作进展，例如“今天电话联系A企业，约好下周看场地”。',
    '• “我的日报”：查看草稿；“修改日报：更正内容”修改，或发“退出修改”。',
    '• 核对后回复“确认日报”。原始记录保留，未确认草稿不计入正式周报；“重新整理日报”按已有原文重整待确认草稿。',
    '• “周计划：企业走访｜本周联系5家企业”；“生成周报”：汇总已确认日报。',
    '• “补记 年-月-日：工作内容”：补记本周记录，例如日期写成2026-09-05。',
    '• “我的工作台”：本人企业、工作记录和反馈入口。',
    '• “查询历史：关键词”查授权企业跟进和已确认日报；“查询资料：关键词”查授权知识摘录。',
    '• “记录企业跟进：企业全称”另起一行写“内容：跟进事实”，核对预览后确认保存。',
    ...(user.role === 'admin' ? ['• “设置日报提醒：17:30”先预览后确认；也支持周计划提醒、周报生成时间。', '• 文字建库：依次另起行发送“新增资料：标题”“类型：园区资料”“正文：完整内容”；也支持政策文件、操作指南、企业参考资料。确认后才入库。'] : []),
    ...(user.role === 'employee' ? [] : ['• 你既可记录本人的工作，也可管理授权团队；“反馈 员工姓名：反馈内容”发送管理反馈。']),
    '语音依赖企微转写；图片/文件暂不识别正文，请附文字。企业阶段目前在工作台维护，日报不会自动更改企业阶段。',
  ].join('\n');
}

/** A small durable delivery ledger: no messages, names, tokens or business content. */
export class OnboardingDelivery {
  constructor(private readonly db: Db, private readonly tenantId = 'poc') {
    db.exec(`CREATE TABLE IF NOT EXISTS onboarding_delivery (
      tenant_id TEXT NOT NULL,
      wecom_userid TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, wecom_userid, delivery_key)
    )`);
  }

  reserve(wecomUserid: string, key: string, now: string, ttlMs?: number): boolean {
    if (ttlMs === undefined) {
      return this.db.prepare(`INSERT OR IGNORE INTO onboarding_delivery
        (tenant_id, wecom_userid, delivery_key, reserved_at) VALUES (?, ?, ?, ?)`)
        .run(this.tenantId, wecomUserid, key, now).changes === 1;
    }
    const before = new Date(Date.parse(now) - ttlMs).toISOString();
    return this.db.prepare(`INSERT INTO onboarding_delivery
      (tenant_id, wecom_userid, delivery_key, reserved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, wecom_userid, delivery_key) DO UPDATE SET reserved_at=excluded.reserved_at
      WHERE onboarding_delivery.reserved_at<=?`)
      .run(this.tenantId, wecomUserid, key, now, before).changes === 1;
  }

  release(wecomUserid: string, key: string, reservation: string): void {
    this.db.prepare(`DELETE FROM onboarding_delivery
      WHERE tenant_id=? AND wecom_userid=? AND delivery_key=? AND reserved_at=?`)
      .run(this.tenantId, wecomUserid, key, reservation);
  }
}
