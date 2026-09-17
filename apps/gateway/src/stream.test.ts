import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateCard, WSClient, WsFrameHeaders } from '@wecom/aibot-node-sdk';
import { StreamReply } from './stream';

const frame = { req_id: 'req-1' } as unknown as WsFrameHeaders;
const card: TemplateCard = {
  card_type: 'button_interaction',
  main_title: { title: '今日日报待确认' },
  button_list: [{ text: '确认入库', key: 'confirm_daily' }],
  task_id: 'daily_report-1',
};

function fakeClient(overrides: Record<string, unknown> = {}): WSClient {
  return {
    replyStream: vi.fn().mockResolvedValue({}),
    replyStreamWithCard: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as WSClient;
}

describe('StreamReply确认卡片', () => {
  afterEach(() => vi.useRealTimers());

  it('流式总结结束后主动发送独立模板卡片', async () => {
    const client = fakeClient();
    const reply = new StreamReply(client, frame, 'stream-1', 60_000, 'employee-1');

    await reply.open();
    await reply.complete('日报草稿', card);

    expect(client.replyStream).toHaveBeenNthCalledWith(1, frame, 'stream-1', '正在整理今天的工作记录…', false);
    expect(client.replyStream).toHaveBeenNthCalledWith(2, frame, 'stream-1', '日报草稿', true);
    expect(client.sendMessage).toHaveBeenCalledWith('employee-1', {
      msgtype: 'template_card',
      template_card: card,
    });
    expect(client.replyStreamWithCard).not.toHaveBeenCalled();
  });

  it('模板卡片主动发送失败时回退为明确的文字确认指令', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('card rejected'))
      .mockResolvedValueOnce({});
    const client = fakeClient({ sendMessage });
    const reply = new StreamReply(client, frame, 'stream-1', 60_000, 'employee-1');

    await reply.open();
    await reply.complete('日报草稿', card);

    expect(sendMessage).toHaveBeenNthCalledWith(2, 'employee-1', {
      msgtype: 'markdown',
      markdown: { content: '操作卡片发送失败。如需调整请继续发送修改内容；确认无误请回复“确认日报”完成入库。' },
    });
  });

  it('流式超时后仍完整主动发送草稿与对应确认卡片', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const reply = new StreamReply(client, frame, 'stream-1', 1_000, 'employee-1');
    await reply.open();
    await vi.advanceTimersByTimeAsync(1_000);
    await reply.complete('延迟完成的草稿', card);
    expect(client.sendMessage).toHaveBeenNthCalledWith(1, 'employee-1', {
      msgtype: 'markdown', markdown: { content: '延迟完成的草稿' },
    });
    expect(client.sendMessage).toHaveBeenNthCalledWith(2, 'employee-1', { msgtype: 'template_card', template_card: card });
  });

  it('超长中文草稿分条完整发送，不允许截断后仍给整份草稿确认', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const client = fakeClient({ sendMessage });
    const reply = new StreamReply(client, frame, 'stream-1', 60_000, 'employee-1');
    const full = '完整日报😀'.repeat(3_000);
    await reply.open();
    await reply.complete(full, card);
    const chunks = sendMessage.mock.calls.map((call) => call[1]).filter((message) => message.msgtype === 'markdown');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((message) => message.markdown.content).join('')).toBe(full);
    expect(chunks.every((message) => Buffer.byteLength(message.markdown.content, 'utf8') <= 19_000)).toBe(true);
    expect(sendMessage.mock.lastCall?.[1]).toEqual({ msgtype: 'template_card', template_card: card });
  });
});
