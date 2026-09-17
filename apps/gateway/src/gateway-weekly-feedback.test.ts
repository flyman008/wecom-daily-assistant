import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { MockAgent } from '@wecom/agent';
import { weekId } from '@wecom/domain';
import * as repo from '@wecom/persistence';
import { WeComGateway } from './gateway';
import { loadGatewayConfig } from './config';

vi.mock('@wecom/aibot-node-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@wecom/aibot-node-sdk')>(),
  WSClient: class {
    on = vi.fn();
    replyStream = vi.fn().mockResolvedValue({});
    replyStreamWithCard = vi.fn().mockResolvedValue({});
    sendMessage = vi.fn().mockResolvedValue({});
    updateTemplateCard = vi.fn().mockResolvedValue({});
  },
}));
const gateways: WeComGateway[] = [];
const currentWeek = weekId(new Date());
const previousWeek = new Date(new Date(`${currentWeek}T04:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0,10);
function setup() {
  const config = loadGatewayConfig({ WECOM_BOT_ID: 'local-test', WECOM_BOT_SECRET: 'local-test' });
  config.databasePath = ':memory:';
  const gateway = new WeComGateway(config, new MockAgent()); gateways.push(gateway);
  repo.upsertUser(gateway.db, { id: 'lead', wecom_userid: 'wx-lead', name: '组长', role: 'team_lead' });
  repo.upsertUser(gateway.db, { id: 'staff', wecom_userid: 'wx-staff', name: '员工甲', manager_user_id: 'lead' });
  repo.upsertUser(gateway.db, { id: 'other', wecom_userid: 'wx-other', name: '无关员工' });
  return gateway;
}
function report(gateway: WeComGateway, id: string, week: string, version = 1, owner = 'staff') {
  repo.insertWeeklyReport(gateway.db, { id, user_id: owner, week_id: week, version, content: `版本${version}`, template_version: '1', missing_days_json: '[]', generated_at: new Date().toISOString() });
}
function frame(text: string, id: string, sender = 'wx-lead'): WsFrame<TextMessage> {
  return { headers:{req_id:id}, body:{msgid:id,from:{userid:sender},chattype:'single',msgtype:'text',text:{content:text}} } as WsFrame<TextMessage>;
}
afterEach(() => { for (const gateway of gateways.splice(0)) gateway.db.close(); });

describe('主动周报反馈指向明确周次及不可变版本', () => {
  it('上一周推送格式即使当前周有报告，也写指定旧版本；消息重投不重复', async () => {
    const gateway = setup();
    report(gateway,'prior-v1',previousWeek); report(gateway,'prior-v2',previousWeek,2); report(gateway,'current',currentWeek);
    const message = frame(`反馈 员工甲 ${previousWeek} v1：请核对这个版本的原因`, 'feedback-one');
    await gateway['handleText'](message); await gateway['handleText'](message);
    const rows = gateway.db.prepare('SELECT weekly_report_id,content FROM manager_feedback').all();
    expect(rows).toEqual([expect.objectContaining({weekly_report_id:'prior-v1',content:'请核对这个版本的原因'})]);
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM message_outbox').get()?.n).toBe(1);
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain(`${previousWeek}当周第1版`);
  });
  it('无日期旧格式明确按当前周，缺当前周时不偷偷写上一周', async () => {
    const gateway = setup(); report(gateway,'prior',previousWeek);
    await gateway['handleText'](frame('反馈 员工甲：继续跟进','legacy-missing'));
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM manager_feedback').get()?.n).toBe(0);
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('你未指定周次');
    report(gateway,'current',currentWeek);
    await gateway['handleText'](frame('反馈 员工甲：继续跟进','legacy-current'));
    expect(gateway.db.prepare('SELECT weekly_report_id FROM manager_feedback').get()?.weekly_report_id).toBe('current');
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('按当前周处理');
  });
  it('未知版本、非法日期、非周一和非管辖人员拒绝，不回退其他报告', async () => {
    const gateway = setup(); report(gateway,'prior',previousWeek); report(gateway,'other',previousWeek,1,'other');
    const commands = [
      `反馈 员工甲 ${previousWeek} v99：不可替换版本`,
      '反馈 员工甲 2026-02-30 v1：非法日期',
      '反馈 员工甲 2026-09-05 v1：非周一',
      `反馈 无关员工 ${previousWeek} v1：越权`,
      `反馈 员工甲 ${previousWeek}：缺版本`,
    ];
    for (const [index,command] of commands.entries()) await gateway['handleText'](frame(command,`invalid-${index}`));
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM manager_feedback').get()?.n).toBe(0);
  });
  it('重名要求显式人员ID；撤销汇报关系后旧推送格式不能继续反馈', async () => {
    const gateway = setup();
    repo.upsertUser(gateway.db,{id:'same-name',name:'员工甲',manager_user_id:'lead'});
    report(gateway,'prior',previousWeek);
    await gateway['handleText'](frame(`反馈 员工甲 ${previousWeek} v1：重名不猜`,'same-name'));
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM manager_feedback').get()?.n).toBe(0);
    await gateway['handleText'](frame(`反馈 staff ${previousWeek} v1：明确ID`,'explicit-id'));
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM manager_feedback').get()?.n).toBe(1);
    gateway.db.prepare("UPDATE app_user SET manager_user_id=NULL WHERE id='staff'").run();
    await gateway['handleText'](frame(`反馈 staff ${previousWeek} v1：已撤权`,'revoked'));
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM manager_feedback').get()?.n).toBe(1);
  });
});
