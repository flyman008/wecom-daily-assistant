import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMessage, FileMessage, TextMessage, VoiceMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { MockAgent } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { WeComGateway } from './gateway';
import { loadGatewayConfig } from './config';
import { bindingTaskId } from './binding-card';
import { OnboardingDelivery, helpFor, isHelpCommand } from './onboarding';

vi.mock('@wecom/aibot-node-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@wecom/aibot-node-sdk')>(),
  WSClient: class {
    on = vi.fn();
    replyStream = vi.fn().mockResolvedValue({});
    replyWelcome = vi.fn().mockResolvedValue({});
    replyTemplateCard = vi.fn().mockResolvedValue({});
    replyStreamWithCard = vi.fn().mockResolvedValue({});
    sendMessage = vi.fn().mockResolvedValue({});
    updateTemplateCard = vi.fn().mockResolvedValue({});
    downloadFile = vi.fn();
  },
}));

const gateways: WeComGateway[] = [];
const account = 'wecom-person-1';
const now = '2026-09-05T04:00:00.000Z';
function setup(bound = true, role: repo.UserRow['role'] = 'employee') {
  const config = loadGatewayConfig({ WECOM_BOT_ID: 'test-only', WECOM_BOT_SECRET: 'test-only', REPORT_BASE_URL: 'https://portal.example.test' });
  config.databasePath = ':memory:';
  const gateway = new WeComGateway(config, new MockAgent());
  repo.upsertUser(gateway.db, { id: 'staff-1', wecom_userid: bound ? account : 'pending:staff-1', name: '测试张三', role, department: '企业服务组' });
  gateways.push(gateway);
  return gateway;
}
function textFrame(text: string, group = false, userid = account): WsFrame<TextMessage> {
  return { headers: { req_id: 'request' }, body: { msgid: `text-${text}`, from: { userid }, chattype: group ? 'group' : 'single', ...(group ? { chatid: 'chat-group-1' } : {}), msgtype: 'text', text: { content: text } } } as WsFrame<TextMessage>;
}
function enterFrame(group = false): WsFrame<EventMessage> {
  return { headers: { req_id: 'enter' }, body: { msgid: 'enter-1', from: { userid: account }, ...(group ? { chattype: 'group', chatid: 'chat-group-1' } : {}), msgtype: 'event', event: { eventtype: 'enter_chat' } } } as WsFrame<EventMessage>;
}
function bindingFrame(action = 'confirm_binding', userid = account, group = false): WsFrame<EventMessage> {
  return { headers: { req_id: 'binding' }, body: { msgid: 'binding-1', from: { userid }, ...(group ? { chattype: 'group', chatid: 'chat-group-1' } : {}), msgtype: 'event', event: { eventtype: 'template_card_event', event_key: action, task_id: bindingTaskId('activation-1') } } } as WsFrame<EventMessage>;
}
function issueCode(gateway: WeComGateway, expiresAt = '2026-09-06T04:00:00.000Z') {
  repo.createActivationCode(gateway.db, { id: 'activation-1', user_id: 'staff-1', code_hash: createHash('sha256').update('SN-TEST-123').digest('hex'), expires_at: expiresAt, created_at: now });
}
function sourceCount(gateway: WeComGateway): number {
  return (gateway.db.prepare('SELECT COUNT(*) AS total FROM source_message').get() as { total: number }).total;
}
function replyText(gateway: WeComGateway): string { return String(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); });
afterEach(() => { gateways.splice(0).forEach((gateway) => gateway.db.close()); vi.useRealTimers(); });

describe('小助理首次使用与隐私边界', () => {
  it('直接粘贴表内绑定码也能确认绑定，不误存成日报', async () => {
    const gateway = setup(false);
    repo.createActivationCode(gateway.db, { id: 'activation-1', user_id: 'staff-1', code_hash: createHash('sha256').update('SN-TEST-1234').digest('hex'), expires_at: '2026-09-06T04:00:00.000Z', created_at: now });
    await gateway['handleText'](textFrame('sn-test-1234'));
    expect(gateway.client.replyTemplateCard).not.toHaveBeenCalled();
    expect(replyText(gateway)).toContain('回复“确认绑定”');
    expect(repo.getUserByWecomUserid(gateway.db, account)).toBeUndefined();
    await gateway['handleText'](textFrame('确认绑定'));
    expect(repo.getUserByWecomUserid(gateway.db, account)?.id).toBe('staff-1');
    expect(sourceCount(gateway)).toBe(0);
  });
  it('未绑定进入单聊走专用欢迎回复，不记录消息、不下发身份链接', async () => {
    const gateway = setup(false);
    await gateway['handleEnterChat'](enterFrame());
    expect(gateway.client.replyWelcome).toHaveBeenCalledTimes(1);
    const welcome = JSON.stringify(vi.mocked(gateway.client.replyWelcome).mock.calls);
    expect(welcome).toContain('示例企业');
    expect(welcome).toContain('一次性绑定码');
    expect(welcome).not.toContain('测试张三');
    expect(gateway.client.replyStream).not.toHaveBeenCalled();
    expect(sourceCount(gateway)).toBe(0);
  });

  it('欢迎语节流持久化，已绑定用户只简洁欢迎；失败允许重试', async () => {
    const gateway = setup(true, 'team_lead');
    vi.mocked(gateway.client.replyWelcome).mockRejectedValueOnce(new Error('offline'));
    await expect(gateway['handleEnterChat'](enterFrame())).rejects.toThrow('offline');
    await gateway['handleEnterChat'](enterFrame());
    await gateway['handleEnterChat'](enterFrame());
    const persisted = new OnboardingDelivery(gateway.db);
    expect(persisted.reserve(account, 'welcome:bound:staff-1', now, 86_400_000)).toBe(false);
    expect(gateway.client.replyWelcome).toHaveBeenCalledTimes(2);
    const welcome = JSON.stringify(vi.mocked(gateway.client.replyWelcome).mock.lastCall);
    expect(welcome).toContain('测试张三');
    expect(welcome).toContain('团队管理');
    expect(welcome).not.toContain('首次使用');
    vi.setSystemTime(new Date('2026-09-06T04:00:01.000Z'));
    await gateway['handleEnterChat'](enterFrame());
    expect(gateway.client.replyWelcome).toHaveBeenCalledTimes(3);
  });

  it('纯文字核对与确认；重复确认有明确回复但不重复绑定、写审计或签发链接', async () => {
    const gateway = setup(false, 'team_lead');
    issueCode(gateway);
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    expect(gateway.client.replyTemplateCard).not.toHaveBeenCalled();
    expect(replyText(gateway)).toContain('测试张三');
    expect(replyText(gateway)).toContain('组长');
    expect(gateway.client.sendMessage).not.toHaveBeenCalled();
    expect(repo.getUserByWecomUserid(gateway.db, account)).toBeUndefined();
    await gateway['handleText'](textFrame('确认绑定'));
    await gateway['handleText'](textFrame('确认绑定'));
    expect(repo.getUserByWecomUserid(gateway.db, account)?.id).toBe('staff-1');
    expect(gateway.client.updateTemplateCard).not.toHaveBeenCalled();
    expect(replyText(gateway)).toContain('绑定成功');
    expect(replyText(gateway)).toContain('本人日报');
    expect(replyText(gateway)).toContain('确认后才正式入库');
    expect((gateway.db.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action='user.wecom_bound'").get() as { total: number }).total).toBe(1);
    expect((gateway.db.prepare('SELECT COUNT(*) AS total FROM portal_access_grant').get() as { total: number }).total).toBe(0);
    await gateway['handleEnterChat'](enterFrame());
    expect(gateway.client.replyWelcome).not.toHaveBeenCalled();
    expect(sourceCount(gateway)).toBe(0);
  });

  it('已用或过期绑定码不能冒领，回调也不能跨企微账号', async () => {
    const gateway = setup(false);
    issueCode(gateway, '2026-09-05T03:00:00.000Z');
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    expect(replyText(gateway)).toContain('已使用或已过期');
    expect(gateway.client.replyTemplateCard).not.toHaveBeenCalled();
    gateway.db.prepare('UPDATE user_activation_code SET expires_at=?').run('2026-09-06T04:00:00.000Z');
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    await gateway['handleCard'](bindingFrame('confirm_binding', 'intruder'));
    expect(replyText(gateway)).toContain('绑定确认已失效');
    expect(repo.getUserByWecomUserid(gateway.db, account)).toBeUndefined();
    await gateway['handleCard'](bindingFrame());
    await gateway['handleText'](textFrame('绑定 SN-TEST-123', false, 'intruder'));
    expect(replyText(gateway)).toContain('已使用或已过期');
    expect(repo.getUserByWecomUserid(gateway.db, 'intruder')).toBeUndefined();
  });

  it('成功回复发送失败不回滚绑定，再次文字确认明确返回成功', async () => {
    const gateway = setup(false);
    issueCode(gateway);
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    vi.mocked(gateway.client.replyStream).mockRejectedValueOnce(new Error('offline'));
    await expect(gateway['handleText'](textFrame('确认绑定'))).rejects.toThrow('offline');
    await gateway['handleText'](textFrame('确认绑定'));
    expect(replyText(gateway)).toContain('绑定成功');
    expect(gateway.client.updateTemplateCard).not.toHaveBeenCalled();
    expect(repo.getUserByWecomUserid(gateway.db, account)?.id).toBe('staff-1');
  });

  it('取消绑定后不占用账号，可以重新输入有效码', async () => {
    const gateway = setup(false);
    issueCode(gateway);
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    await gateway['handleText'](textFrame('取消绑定'));
    expect(repo.getUserByWecomUserid(gateway.db, account)).toBeUndefined();
    await gateway['handleCard'](bindingFrame());
    expect(replyText(gateway)).toContain('绑定确认已失效');
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    await gateway['handleCard'](bindingFrame());
    expect(repo.getUserByWecomUserid(gateway.db, account)?.id).toBe('staff-1');
  });

  it('没有自己的待确认状态、超过10分钟均不能仅凭文字绑定，重发码可恢复', async () => {
    const gateway=setup(false);issueCode(gateway);
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    await gateway['handleText'](textFrame('确认绑定',false,'intruder'));
    expect(repo.getUserByWecomUserid(gateway.db,'intruder')).toBeUndefined();
    expect(replyText(gateway)).toContain('重新发送绑定码');
    vi.setSystemTime(new Date('2026-09-05T04:10:01.000Z'));
    await gateway['handleText'](textFrame('确认绑定'));
    expect(repo.getUserByWecomUserid(gateway.db,account)).toBeUndefined();
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    await gateway['handleText'](textFrame('确认绑定'));
    expect(repo.getUserByWecomUserid(gateway.db,account)?.id).toBe('staff-1');
    expect(sourceCount(gateway)).toBe(0);
  });

  it('旧卡片已占用的待绑定状态可以直接文字确认；取消不解除已绑定账号',async()=>{
    const gateway=setup(false);issueCode(gateway);
    repo.claimActivationCode(gateway.db,createHash('sha256').update('SN-TEST-123').digest('hex'),account,now);
    await gateway['handleText'](textFrame('确认绑定'));
    expect(replyText(gateway)).toContain('绑定成功');
    await gateway['handleText'](textFrame('取消绑定'));
    expect(repo.getUserByWecomUserid(gateway.db,account)?.id).toBe('staff-1');
    expect(replyText(gateway)).toContain('不会解除');
  });

  it('问候、帮助、工作台和退出修改都不误存日报，帮助不破坏待修改状态', async () => {
    const gateway = setup();
    const id = await gateway.app.submitRecord('staff-1', '2026-09-05', '今天联系A企业');
    gateway.app.completeDailyPresentation('staff-1', gateway.app.prepareDailyPresentation('staff-1', id));
    gateway.app.startDailyEdit('staff-1', id);
    const before = sourceCount(gateway);
    for (const command of ['开始', '你好！', '我能做什么', '帮助', '/help', '我的工作台']) await gateway['handleText'](textFrame(command));
    expect(sourceCount(gateway)).toBe(before);
    expect(gateway.app.getPendingDailyEdit('staff-1')?.reportId).toBe(id);
    await gateway['handleText'](textFrame('退出修改'));
    expect(gateway.app.getPendingDailyEdit('staff-1')).toBeUndefined();
    await gateway['handleText'](textFrame('取消修改'));
    expect(replyText(gateway)).toContain('没有待修改');
    expect(sourceCount(gateway)).toBe(before);
    expect(isHelpCommand('你好，今天我走访了A企业')).toBe(false);
  });

  it('工作台只为发送者签发一次性短时链接，不允许选择他人身份', async () => {
    const gateway = setup();
    await gateway['handleText'](textFrame('打开工作台'));
    expect(replyText(gateway)).toContain('10分钟内有效');
    const token = replyText(gateway).match(/portal\/([A-Za-z0-9_-]+)/u)?.[1];
    expect(token).toBeTruthy();
    const grant = gateway.db.prepare('SELECT * FROM portal_access_grant').get() as { user_id: string; token_hash: string; expires_at: string };
    expect(grant.user_id).toBe('staff-1');
    expect(grant.token_hash).not.toBe(token);
    expect(Date.parse(grant.expires_at) - Date.parse(now)).toBe(600_000);
    expect(sourceCount(gateway)).toBe(0);
  });

  it('群聊不返回真实身份、私有链接或个人日报，也不下载附件', async () => {
    const gateway = setup();
    for (const command of ['你好', '帮助', '我的工作台', '绑定 SN-TEST-123', '今天走访A企业']) {
      await gateway['handleText'](textFrame(command, true));
      expect(replyText(gateway)).toContain('请私聊');
      expect(replyText(gateway)).not.toContain('测试张三');
      expect(replyText(gateway)).not.toContain('http');
    }
    await gateway['handleEnterChat'](enterFrame(true));
    await gateway['handleCard'](bindingFrame('confirm_binding', account, true));
    await gateway['handleFile']({ ...textFrame('', true), body: { ...textFrame('', true).body, msgtype: 'file', file: { url: 'https://unused.test', aeskey: 'not-a-key' } } } as WsFrame<FileMessage>);
    expect(gateway.client.downloadFile).not.toHaveBeenCalled();
    expect(gateway.client.replyWelcome).not.toHaveBeenCalled();
    expect(sourceCount(gateway)).toBe(0);
    expect((gateway.db.prepare('SELECT COUNT(*) AS total FROM portal_access_grant').get() as { total: number }).total).toBe(0);
  });

  it('未绑定发问候或工作内容都先引导；语音无转写不冒充已识别', async () => {
    const gateway = setup(false);
    await gateway['handleText'](textFrame('今天走访A企业'));
    expect(replyText(gateway)).toContain('一次性绑定码');
    expect(sourceCount(gateway)).toBe(0);
    await gateway['handleVoice']({ ...textFrame(''), body: { ...textFrame('').body, msgtype: 'voice', voice: { content: '' } } } as WsFrame<VoiceMessage>);
    expect(replyText(gateway)).toContain('没有可用的企微转写');
    expect(sourceCount(gateway)).toBe(0);
    expect(helpFor(repo.getUser(gateway.db, 'staff-1')!)).toContain('日报不会自动更改企业阶段');
  });

  it('重复的未绑定消息只返回短提示，连续错误绑定会锁定而不写工作记录', async () => {
    const gateway = setup(false);
    await gateway['handleText'](textFrame('今天走访A企业'));
    expect(replyText(gateway)).toContain('示例企业');
    await gateway['handleText'](textFrame('我还没有绑定码'));
    expect(replyText(gateway)).toContain('账号尚未绑定');
    expect(replyText(gateway)).not.toContain('示例企业');
    for (let attempt = 0; attempt < 5; attempt++) await gateway['handleText'](textFrame(`绑定 WRONG-${attempt}`));
    expect(replyText(gateway)).toContain('15分钟后再试');
    issueCode(gateway);
    await gateway['handleText'](textFrame('绑定 SN-TEST-123'));
    expect(replyText(gateway)).toContain('15分钟后再试');
    expect(gateway.client.replyTemplateCard).not.toHaveBeenCalled();
    expect(sourceCount(gateway)).toBe(0);
  });

  it('未配置入口时不签发不可访问链接，停用人员不能通过旧确认卡绑定', async () => {
    const gateway = setup();
    gateway['config'].reportBaseUrl = undefined;
    await gateway['handleText'](textFrame('我的工作台'));
    expect(replyText(gateway)).toContain('入口暂未配置');
    expect((gateway.db.prepare('SELECT COUNT(*) AS total FROM portal_access_grant').get() as { total: number }).total).toBe(0);
    const inactive = setup(false);
    issueCode(inactive);
    await inactive['handleText'](textFrame('绑定 SN-TEST-123'));
    inactive.db.prepare('UPDATE app_user SET active=0 WHERE id=?').run('staff-1');
    await inactive['handleCard'](bindingFrame());
    expect(replyText(inactive)).toContain('人员账号已停用');
    expect(repo.getUserByWecomUserid(inactive.db, account)).toBeUndefined();
  });

  it('部门负责人可反馈给管辖组长，但不能越过汇报树或给自己发管理反馈', async () => {
    const gateway = setup(true, 'dept_head');
    repo.upsertUser(gateway.db, { id: 'lead-2', name: '兼任组长', role: 'team_lead', manager_user_id: 'staff-1' });
    repo.upsertUser(gateway.db, { id: 'other', name: '其他部门员工', role: 'employee' });
    for (const userId of ['lead-2', 'other', 'staff-1']) repo.insertWeeklyReport(gateway.db, {
      id: `weekly-${userId}`, user_id: userId, week_id: '2026-08-31', template_version: 'weekly-v1',
      content: '本周已确认记录汇总', missing_days_json: '[]', generated_at: now,
    });
    await gateway['handleText'](textFrame('反馈 兼任组长：下周继续跟进A企业'));
    expect(replyText(gateway)).toContain('反馈已入库');
    expect(repo.listFeedback(gateway.db, 'weekly-lead-2')).toHaveLength(1);
    await gateway['handleText'](textFrame('反馈 其他部门员工：越权反馈'));
    expect(replyText(gateway)).toContain('管辖员工');
    expect(repo.listFeedback(gateway.db, 'weekly-other')).toHaveLength(0);
    await gateway['handleText'](textFrame('反馈 测试张三：自己反馈'));
    expect(repo.listFeedback(gateway.db, 'weekly-staff-1')).toHaveLength(0);
    expect(sourceCount(gateway)).toBe(0);
  });
});
