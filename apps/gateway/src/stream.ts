import type { TemplateCard, WSClient, WsFrameHeaders } from '@wecom/aibot-node-sdk';

function truncate(value: string, maxBytes = 19_500): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes - 3).toString('utf8').replace(/\uFFFD$/u, '') + '…';
}

function completeChunks(value: string, maxBytes = 19_000): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class StreamReply {
  private closed = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly client: WSClient,
    private readonly frame: WsFrameHeaders,
    private readonly streamId: string,
    private readonly timeoutMs: number,
    private readonly proactiveTarget?: string,
  ) {}

  async open(content = '正在整理今天的工作记录…'): Promise<void> {
    await this.client.replyStream(this.frame, this.streamId, content, false);
    this.timer = setTimeout(() => void this.detach(), this.timeoutMs);
  }

  async complete(content: string, templateCard?: TemplateCard, options?: { cardFailureText: string; longContentText: string }): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const wasClosed = this.closed;
    this.closed = true;
    const target = this.proactiveTarget;
    // 部分企微客户端不会渲染附加在流式末帧中的 template_card。
    // 用主动消息发送独立卡片，保留流式总结，同时确保确认按钮稳定可见。
    if (!target && Buffer.byteLength(content, 'utf8') > 19_500) throw new Error('内容过长，未能完整展示，暂不能确认');
    if (wasClosed) {
      await this.sendProactive(content);
    } else if (templateCard && !target) {
      await this.client.replyStreamWithCard(this.frame, this.streamId, content, true, { templateCard });
      return;
    } else if (Buffer.byteLength(content, 'utf8') > 19_500) {
      await this.client.replyStream(this.frame, this.streamId, options?.longContentText ?? '日报内容较长，完整草稿将分条发送，请核对全部内容后确认。', true);
      await this.sendProactive(content);
    } else {
      await this.client.replyStream(this.frame, this.streamId, content, true);
    }
    if (!templateCard) return;
    if (!target) return;
    try {
      await this.client.sendMessage(target, {
        msgtype: 'template_card',
        template_card: templateCard,
      });
    } catch {
      await this.client.sendMessage(target, {
        msgtype: 'markdown',
        markdown: { content: options?.cardFailureText ?? '操作卡片发送失败。如需调整请继续发送修改内容；确认无误请回复“确认日报”完成入库。' },
      });
    }
  }

  async fail(content: string, rawRecordSaved = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const rendered = truncate(rawRecordSaved
      ? `这次没有整理成功，但原始记录已经保存。\n${content}`
      : `这次操作没有完成。\n${content}`);
    if (this.closed) return this.sendProactive(rendered);
    this.closed = true;
    try {
      await this.client.replyStream(this.frame, this.streamId, rendered, true);
    } catch (error) {
      if (!this.proactiveTarget) throw error;
      await this.sendProactive(rendered);
    }
  }

  private async detach(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.replyStream(this.frame, this.streamId, '还在整理，完成后我会主动告诉你。', true);
  }

  private async sendProactive(content: string): Promise<void> {
    if (!this.proactiveTarget) throw new Error('缺少主动消息接收人，内容尚未完整展示');
    for (const chunk of completeChunks(content)) {
      await this.client.sendMessage(this.proactiveTarget, { msgtype: 'markdown', markdown: { content: chunk } });
    }
  }
}
