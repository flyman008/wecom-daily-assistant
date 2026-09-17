import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WSClient,
  generateReqId,
  type BaseMessage,
  type EventMessage,
  type FileContent,
  type FileMessage,
  type ImageContent,
  type ImageMessage,
  type MixedMessage,
  type QuoteContent,
  type TextMessage,
  type VoiceMessage,
  type WsFrame,
} from '@wecom/aibot-node-sdk';
import type { Agent } from '@wecom/agent';
import { weekId } from '@wecom/domain';
import { inTransaction, issuePortalAccessGrant, openDb, type Db } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { DailyAssistantApp } from '../../api/src/app';
import type { GatewayConfig } from './config';
import { activationIdFromBindingTask } from './binding-card';
import { reportIdFromDailyTask } from './daily-card';
import { splitPlanEntry } from '../../api/src/plan-target';
import { logger, privateLabel, sdkLogger } from './logger';
import { StreamReply } from './stream';
import { bindingIntroduction, bindingTextPreview, helpFor, isHelpCommand, isPortalCommand, OnboardingDelivery, PRIVATE_CHAT_GUIDANCE, UNBOUND_GUIDANCE, UNBOUND_REMINDER, welcomeBack } from './onboarding';
import { ProactiveService } from './proactive';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { cancelAction, confirmAction, proposeAction, type AssistantActionInput } from '../../api/src/assistant-actions';
import { actionCard, actionFromTask, parseAssistantCommand, type AssistantCommand } from './assistant-commands';
import { NewCompanyFlow } from './new-company-flow';

function currentDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (name: string) => parts.find((part) => part.type === name)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function quoteText(quote?: QuoteContent): string | undefined {
  if (!quote) return undefined;
  if (quote.text?.content) return quote.text.content;
  if (quote.voice?.content) return quote.voice.content;
  return quote.image ? '[引用图片]' : quote.file ? '[引用文件]' : undefined;
}

function mixedText(message: MixedMessage): string {
  return message.mixed.msg_item.map((item) => item.text?.content ?? (item.image ? '[图片]' : '')).filter(Boolean).join('\n');
}

function safeName(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.\.+/g, '.').trim();
  return normalized.slice(0, 120) || fallback;
}

const BLOCKED_FILE_EXTENSIONS = new Set(['.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.lnk']);

export class WeComGateway {
  readonly client: WSClient;
  readonly db: Db;
  readonly app: DailyAssistantApp;
  private readonly activeByUser = new Map<string, number>();
  private readonly onboarding: OnboardingDelivery;
  private readonly proactive: ProactiveService;
  private readonly newCompanies = new NewCompanyFlow();

  constructor(
    private readonly config: GatewayConfig,
    agent: Agent,
  ) {
    this.db = openDb(config.databasePath);
    this.app = new DailyAssistantApp(this.db, agent, { weekBoundary: config.weekBoundary });
    this.client = new WSClient({
      botId: config.botId,
      secret: config.secret,
      heartbeatInterval: config.heartbeatMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
      maxAuthFailureAttempts: 3,
      logger: sdkLogger,
    });
    this.onboarding = new OnboardingDelivery(this.db, this.app.tenantId);
    this.proactive = new ProactiveService(this.db, this.app, config, this.client);
    this.bindEvents();
  }

  start(): void {
    this.client.connect();
    this.proactive.start();
  }

  stop(): void {
    this.proactive.stop();
    this.client.disconnect();
  }

  get activeTasks(): number {
    return [...this.activeByUser.values()].reduce((sum, count) => sum + count, 0);
  }

  private bindEvents(): void {
    this.client.on('connected', () => logger.info('企微WebSocket已连接'));
    this.client.on('authenticated', () => logger.info('企微机器人认证成功'));
    this.client.on('disconnected', (reason) => logger.warn('企微WebSocket断开', { reason }));
    this.client.on('reconnecting', (attempt) => logger.warn('企微WebSocket重连', { attempt }));
    this.client.on('error', (error) => logger.error('企微SDK错误', error));
    this.client.on('event.enter_chat', (frame) => void this.handleEnterChat(frame).catch((error) => logger.error('欢迎语发送失败', error)));
    this.client.on('message.text', (frame) => void this.handleText(frame).catch((error) => logger.error('文本消息处理失败', error)));
    this.client.on('message.voice', (frame) => void this.handleVoice(frame).catch((error) => logger.error('语音消息处理失败', error)));
    this.client.on('message.mixed', (frame) => void this.handleMixed(frame).catch((error) => logger.error('图文消息处理失败', error)));
    this.client.on('message.image', (frame) => void this.handleImage(frame).catch((error) => logger.error('图片消息处理失败', error)));
    this.client.on('message.file', (frame) => void this.handleFile(frame).catch((error) => logger.error('文件消息处理失败', error)));
    this.client.on('message.video', (frame) => void this.reply(frame, '视频暂不解析，请补充文字说明。').catch((error) => logger.error('视频提示发送失败', error)));
    this.client.on('event.template_card_event', (frame) => void this.handleCard(frame).catch((error) => logger.error('卡片事件处理失败', error)));
  }

  private async handleEnterChat(frame: WsFrame<EventMessage>): Promise<void> {
    const body = frame.body;
    if (!body?.from?.userid || body.chattype === 'group' || body.chatid) return;
    const user = repo.getUserByWecomUserid(this.db, body.from.userid, this.app.tenantId);
    const now = new Date().toISOString();
    const key = user ? `welcome:bound:${user.id}` : 'welcome:unbound';
    if (!this.onboarding.reserve(body.from.userid, key, now, 24 * 60 * 60_000)) return;
    try {
      // enter_chat has its own SDK reply command and short response window; no LLM call here.
      await this.client.replyWelcome(frame, { msgtype: 'text', text: { content: user ? welcomeBack(user) : UNBOUND_GUIDANCE } });
    } catch (error) {
      this.onboarding.release(body.from.userid, key, now);
      throw error;
    }
  }

  private async handleText(frame: WsFrame<TextMessage>): Promise<void> {
    if (!frame.body) return;
    await this.handleRecord(frame, frame.body, frame.body.text.content.trim(), 'text');
  }

  private async replyUnbound(frame: WsFrame<unknown>, wecomUserid: string, explicitHelp = false): Promise<void> {
    const now = new Date().toISOString();
    const reserved = this.onboarding.reserve(wecomUserid, 'welcome:unbound', now, 24 * 60 * 60_000);
    try {
      await this.reply(frame, explicitHelp || reserved ? UNBOUND_GUIDANCE : UNBOUND_REMINDER);
    } catch (error) {
      if (reserved) this.onboarding.release(wecomUserid, 'welcome:unbound', now);
      throw error;
    }
  }

  private async handleVoice(frame: WsFrame<VoiceMessage>): Promise<void> {
    if (!frame.body) return;
    if (frame.body.chattype === 'group' || frame.body.chatid) return this.reply(frame, PRIVATE_CHAT_GUIDANCE);
    if (!frame.body.voice.content?.trim()) return this.reply(frame, '这条语音没有可用的企微转写，暂未记入日报，请改发文字说明。');
    await this.handleRecord(frame, frame.body, frame.body.voice.content.trim(), 'voice');
  }

  private async handleMixed(frame: WsFrame<MixedMessage>): Promise<void> {
    if (!frame.body) return;
    if (frame.body.chattype === 'group' || frame.body.chatid) return this.reply(frame, PRIVATE_CHAT_GUIDANCE);
    if (!repo.getUserByWecomUserid(this.db, frame.body.from.userid, this.app.tenantId)) {
      return this.replyUnbound(frame, frame.body.from.userid);
    }
    const attachments: Array<{ kind: string; name: string; path?: string }> = [];
    for (const item of frame.body.mixed.msg_item) {
      if (item.image) {
        try { attachments.push(await this.storeDownload(item.image, '图片', 'image')); }
        catch (error) { logger.error('图文中的图片下载失败', error); }
      }
    }
    await this.handleRecord(frame, frame.body, mixedText(frame.body), 'mixed', attachments);
  }

  private async handleImage(frame: WsFrame<ImageMessage>): Promise<void> {
    if (!frame.body) return;
    if (frame.body.chattype === 'group' || frame.body.chatid) return this.reply(frame, PRIVATE_CHAT_GUIDANCE);
    if (!repo.getUserByWecomUserid(this.db, frame.body.from.userid, this.app.tenantId)) {
      return this.replyUnbound(frame, frame.body.from.userid);
    }
    try {
      const attachment = await this.storeDownload(frame.body.image, '图片', 'image');
      await this.handleRecord(frame, frame.body, '[图片]', 'image', [attachment]);
    } catch (error) {
      await this.handleRecord(frame, frame.body, '[图片下载失败，原始消息已记录]', 'image');
      logger.error('图片下载失败', error);
    }
  }

  private async handleFile(frame: WsFrame<FileMessage>): Promise<void> {
    if (!frame.body) return;
    if (frame.body.chattype === 'group' || frame.body.chatid) return this.reply(frame, PRIVATE_CHAT_GUIDANCE);
    if (!repo.getUserByWecomUserid(this.db, frame.body.from.userid, this.app.tenantId)) {
      return this.replyUnbound(frame, frame.body.from.userid);
    }
    try {
      const attachment = await this.storeDownload(frame.body.file, '文件', 'file');
      await this.handleRecord(frame, frame.body, `[文件] ${attachment.name}`, 'file', [attachment]);
    } catch (error) {
      await this.handleRecord(frame, frame.body, '[文件下载失败，原始消息已记录]', 'file');
      logger.error('文件下载失败', error);
    }
  }

  private async handleCard(frame: WsFrame<EventMessage>): Promise<void> {
    const body = frame.body;
    if (!body || !('event_key' in body.event)) return;
    if (body.chattype === 'group' || body.chatid) return this.reply(frame, PRIVATE_CHAT_GUIDANCE);
    const action = body.event.event_key;
    if (action && ['confirm_action', 'cancel_action', 'edit_action'].includes(action)) {
      const user = repo.getUserByWecomUserid(this.db, body.from.userid, this.app.tenantId);
      const task = actionFromTask(body.event.task_id);
      if (!user || !task) return this.reply(frame, '操作确认已失效，请重新发送要求。');
      const actor = { userId: user.id, role: user.role, tenantId: this.app.tenantId };
      let message: string;
      try {
        if (action === 'confirm_action') {
          const result = confirmAction(this.db, actor, task.id, task.token);
          message = result.replayed ? '这项操作已执行过，没有重复保存。请在后台查看结果。' : '已按你确认的预览保存，后台已同步，操作记录已留存。';
        } else {
          cancelAction(this.db, actor, task.id);
          message = action === 'edit_action' ? '原操作提案已取消，未执行。请重新发送完整要求，我会重新生成预览；这不会记入日报。' : '已取消该操作，未写入业务数据。';
        }
      } catch (error) { message = error instanceof Error ? error.message : '操作失败，请重新核对。'; }
      // A failed reply must not turn an already committed action into a second write.
      await this.reply(frame, message);
      return;
    }
    if (action === 'confirm_binding' || action === 'cancel_binding') {
      const activationId = activationIdFromBindingTask(body.event.task_id);
      if(!activationId) return this.reply(frame,'旧卡片已停用，请重新发送绑定码，再回复“确认绑定”。');
      // Already-issued cards remain compatible, but all responses are plain text.
      return this.handleTextBinding(frame,body.from.userid,action==='cancel_binding',activationId);
    }
    if (action !== 'confirm_daily' && action !== 'edit_daily' && action !== 'cancel_edit_daily') return;
    try {
      const user = repo.getUserByWecomUserid(this.db, body.from.userid, this.app.tenantId);
      if (!user) throw new Error('账号尚未绑定，请先私聊发送“绑定 绑定码”');
      const reportId = reportIdFromDailyTask(body.event.task_id);
      if (!reportId || !body.event.task_id) throw new Error('这张旧卡片已失效，请发送“我的日报”查看文字草稿');
      const report = repo.getDailyReportById(this.db, reportId, this.app.tenantId);
      if (!report || report.user_id !== user.id) throw new Error('日报不存在或无权操作');
      if (action === 'cancel_edit_daily') {
        const latest = repo.getLatestDailyReport(this.db, user.id, report.report_date, this.app.tenantId);
        if (latest?.id !== reportId || report.status !== 'pending_confirmation') throw new Error('这张卡片已失效，请查看最新日报草稿');
        this.app.cancelDailyEdit(user.id, reportId);
        await this.reply(frame,'已取消修改。请发送“我的日报”查看原稿，核对后回复“确认日报”。');
        return;
      }
      if (action === 'edit_daily') {
        this.app.startDailyEdit(user.id, reportId);
        await this.reply(frame,'请直接发送需要更正的内容，或回复“取消修改”。修改后会生成新的文字草稿。');
        return;
      }
      this.app.confirmReport(user.id, reportId, 'button', body.msgid);
      await this.reply(frame,`${report.report_date}日报已确认保存。`);
    } catch (error) {
      await this.reply(frame, error instanceof Error ? error.message : '卡片操作失败');
    }
  }

  private async handleTextBinding(frame: WsFrame<unknown>, wecomUserid: string, cancel: boolean, activationId?: string): Promise<void> {
    let message: string;
    try {
      message = inTransaction(this.db,()=>{
        const now=new Date().toISOString(), tenant=this.app.tenantId;
        if(activationId&&repo.getActivationCodeById(this.db,activationId,tenant)?.pending_wecom_userid!==wecomUserid) throw new Error('绑定确认已失效，请重新发送绑定码');
        const existing=repo.getUserByWecomUserid(this.db,wecomUserid,tenant);
        if(existing) return cancel?`当前已绑定：${existing.name}。取消绑定不会解除已绑定身份，如需更换请联系管理员。`:`绑定成功：${existing.name}。\n${bindingIntroduction(existing)}\n发送“帮助”查看用法。`;
        const claims=this.db.prepare(`SELECT id,verified_at FROM user_activation_code WHERE tenant_id=? AND pending_wecom_userid=? AND used_at IS NULL AND revoked_at IS NULL${activationId?' AND id=?':''}`)
          .all(...(activationId?[tenant,wecomUserid,activationId]:[tenant,wecomUserid])) as Array<{id:string;verified_at:string|null}>;
        if(cancel) {
          for(const claim of claims) repo.cancelActivationClaim(this.db,claim.id,wecomUserid,tenant);
          return '已取消本次绑定。账号尚未关联，可重新发送绑定码。';
        }
        if(claims.length!==1||!claims[0].verified_at||Date.parse(claims[0].verified_at)<=Date.parse(now)-10*60_000) throw new Error('绑定确认已失效，请重新发送绑定码，核对姓名后回复“确认绑定”。');
        const claim=repo.getActivationCodeById(this.db,claims[0].id,tenant)!;
        if(!repo.getUser(this.db,claim.user_id,tenant)?.active) throw new Error('人员账号已停用，请联系管理员。');
        const user=repo.bindActivationCode(this.db,claim.id,wecomUserid,now,tenant);
        repo.insertAudit(this.db,{id:randomUUID(),tenant_id:tenant,actor_user_id:user.id,action:'user.wecom_bound',resource_type:'app_user',resource_id:user.id,details_json:JSON.stringify({activationId:claim.id,confirmation:activationId?'legacy_card':'text'}),created_at:now});
        this.onboarding.reserve(wecomUserid,`welcome:bound:${user.id}`,now,24*60*60_000);
        return `绑定成功：${user.name}。\n${bindingIntroduction(user)}\n发送“帮助”查看用法，或先发“周计划：企业走访｜计划走访5家企业”。`;
      });
    } catch(error) { message=error instanceof Error?error.message:'绑定失败，请重新发送绑定码'; }
    // Delivery failure must not roll back or mislabel a successfully committed binding.
    await this.reply(frame,message);
  }

  private async handleRecord<T extends BaseMessage>(
    frame: WsFrame<T>,
    body: T,
    rawText: string,
    contentType: 'text' | 'voice' | 'mixed' | 'image' | 'file',
    attachments: Array<{ kind: string; name: string; path?: string }> = [],
  ): Promise<void> {
    if (body.chattype === 'group' || body.chatid) return this.reply(frame, PRIVATE_CHAT_GUIDANCE);
    const wecomUserid = body.from.userid;
    if(/^(确认绑定|取消绑定)[。！!\s]*$/u.test(rawText.trim())) return this.handleTextBinding(frame,wecomUserid,rawText.trim().startsWith('取消'));
    const binding = rawText.match(/^绑定\s+([A-Za-z0-9-]+)$/u) ?? rawText.trim().match(/^(SN-[A-Z0-9]{4}-[A-Z0-9]{4})$/iu);
    if (binding) {
      const existing = repo.getUserByWecomUserid(this.db, wecomUserid, this.app.tenantId);
      if (existing) return this.reply(frame, `当前企微账号已绑定：${existing.name}。如需更换，请联系管理员先解除绑定。`);
      const now = new Date().toISOString();
      const lockedUntil = repo.getBindingLock(this.db, wecomUserid, now, this.app.tenantId);
      if (lockedUntil) return this.reply(frame, '绑定尝试次数过多，请15分钟后再试。');
      const activation = repo.claimActivationCode(
        this.db,
        createHash('sha256').update(binding[1].toUpperCase()).digest('hex'),
        wecomUserid,
        now,
        this.app.tenantId,
      );
      if (!activation) {
        const blocked = repo.registerBindingFailure(this.db, wecomUserid, now, this.app.tenantId);
        return this.reply(frame, blocked ? '绑定尝试次数过多，请15分钟后再试。' : '绑定码无效、已使用或已过期，请联系管理员重新生成。');
      }
      repo.clearBindingFailures(this.db, wecomUserid, this.app.tenantId);
      this.db.prepare(`UPDATE user_activation_code SET pending_wecom_userid=NULL,verified_at=NULL WHERE tenant_id=? AND pending_wecom_userid=? AND id<>? AND used_at IS NULL`).run(this.app.tenantId,wecomUserid,activation.id);
      const user = repo.getUser(this.db, activation.user_id, this.app.tenantId)!;
      await this.reply(frame, bindingTextPreview(user));
      return;
    }
    const user = repo.getUserByWecomUserid(this.db, wecomUserid, this.app.tenantId);
    if (!user) return this.replyUnbound(frame, wecomUserid, isHelpCommand(rawText));
    if (/^绑定\s*$/u.test(rawText)) return this.reply(frame, `当前企微账号已绑定：${user.name}。如需更换，请联系管理员先解除绑定。`);
    if (!rawText || isHelpCommand(rawText)) return this.reply(frame, helpFor(user));
    try {
      const response = await this.newCompanies.command(user.id, rawText);
      if (response !== null) return this.reply(frame, response);
    } catch { return this.reply(frame, '新企业资料未能确认保存，请稍后重试“确认新企业”；不要重复录入。'); }
    if (isPortalCommand(rawText)) {
      if (!this.config.reportBaseUrl) return this.reply(frame, '工作台入口暂未配置，请联系管理员。你仍可在这里记录工作、查看日报和生成周报。');
      const portal = issuePortalAccessGrant(this.db, user.id, { baseUrl: this.config.reportBaseUrl, tenantId: this.app.tenantId });
      return this.reply(frame, `你的工作台入口（10分钟内有效、仅可兑换一次，请勿转发）：\n${portal.url}\n页面只开放本人及授权范围，过期后可重新发送“我的工作台”。`);
    }
    const assistantCommand = parseAssistantCommand(rawText);
    if (assistantCommand) {
      try { await this.handleAssistantCommand(frame, body, user, assistantCommand); }
      catch (error) { await this.reply(frame, error instanceof Error ? error.message : '操作或查询失败，请核对后重试。'); }
      return;
    }
    if (/^(取消修改|退出修改)$/u.test(rawText)) {
      try {
      const pendingEdit = this.app.getPendingDailyEdit(user.id);
      if (pendingEdit) this.app.cancelDailyEdit(user.id, pendingEdit.reportId);
      return this.reply(frame, pendingEdit ? '已退出修改，原日报草稿仍保持待确认状态。' : '当前没有待修改的日报。发送“我的日报”可查看草稿。');
      } catch(error) { return this.reply(frame,error instanceof Error?error.message:'修改状态已变化，请重新查看日报。'); }
    }
    const userId = user.id;
    const active = this.activeByUser.get(userId) ?? 0;
    if (active >= this.config.maxActiveTasksPerUser) return this.reply(frame, '你已有任务在处理中，请稍后再试。');
    this.activeByUser.set(userId, active + 1);
    const target = wecomUserid;
    const stream = new StreamReply(this.client, frame, generateReqId('stream'), this.config.streamTimeoutMs, target);
    try {
      let date = currentDate();
      let recordText = rawText;
      let pendingEdit = this.app.getPendingDailyEdit(userId);
      if (/^(确认日报|确认今天日报|确认)$/u.test(rawText)) {
        const confirmed = this.app.confirmDisplayedReport(userId, 'explicit_command', body.msgid, rawText === '确认今天日报' ? date : undefined);
        return await this.reply(frame, `${confirmed.report_date}日报已确认保存。后续补充内容会合并整理，再请你核对。`);
      }
      const editDaily=rawText.match(/^修改日报(?:[：:]\s*([\s\S]+))?$/u);
      if(editDaily) {
        const displayed=repo.getDailyUserState(this.db,this.app.tenantId,userId)?.displayed_report_id;
        if(!displayed)return await this.reply(frame,'请先发送“我的日报”查看草稿，再发送修改内容。');
        this.app.startDailyEdit(userId,displayed);
        if(!editDaily[1])return await this.reply(frame,'请发送要补充或更正的内容；原始记录会保留，修改稿仍需你确认。退出请回复“取消修改”。');
        recordText=editDaily[1].trim();pendingEdit=this.app.getPendingDailyEdit(userId);
      }
      if(/^重新整理日报$/u.test(rawText)) {
        const latest=repo.getLatestDailyReport(this.db,userId,date,this.app.tenantId);
        if(!latest||latest.status!=='pending_confirmation')return await this.reply(frame,'今天没有待确认草稿。请先发送工作记录；已确认日报请用“补记 日期：更正内容”修改。');
        const source=repo.listSourceMessages(this.db,userId,date,this.app.tenantId).at(-1);
        if(!source)return await this.reply(frame,'未找到原始工作记录，请先发送文字记录。');
        await stream.open('正在按已有原始记录重新整理，不新增工作事实…');
        const id=await this.app.submitRecord(userId,date,source.text_content,{messageId:source.msg_id,reprocess:true,reprocessKey:body.msgid,editingReportId:latest.id});
        const presentation=this.app.prepareDailyPresentation(userId,id);
        await stream.complete(`已更新今日日报：\n${this.app.dailyPreview(presentation.report)}`);
        this.app.completeDailyPresentation(userId,presentation);return;
      }
      const viewDaily = rawText.match(/^我的日报(?:\s+(\d{4}-\d{2}-\d{2}))?$/u);
      if (viewDaily) {
        const requestedDate = viewDaily[1] ?? date;
        const report = repo.getLatestDailyReport(this.db, userId, requestedDate, this.app.tenantId);
        if (!report) return await this.reply(frame, `${requestedDate}还没有日报草稿。`);
        const presentation = this.app.prepareDailyPresentation(userId, report.id);
        await stream.open('正在读取日报…');
        await stream.complete(`${report.report_date}日报（${report.status === 'confirmed' ? '已确认' : '待确认'}）：\n${this.app.dailyPreview(report)}`);
        this.app.completeDailyPresentation(userId, presentation);
        return;
      }
      const feedback = rawText.match(/^反馈(?:\s+([^：:\n]+))?[：:]\s*([\s\S]+)$/u);
      if (feedback) {
        const manager = repo.getUser(this.db, userId, this.app.tenantId);
        if (!manager || !['team_lead', 'dept_head', 'admin'].includes(manager.role)) {
          return await this.reply(frame, '当前账号尚未配置管理者权限，请联系管理员维护人员与汇报关系。');
        }
        const employees = repo.listUsers(this.db, this.app.tenantId).filter((target) => target.id !== manager.id && repo.canReadUser(
          this.db, { userId: manager.id, role: manager.role, tenantId: this.app.tenantId }, target.id,
        ));
        const header = feedback[1]?.trim();
        const explicit = header?.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2})\s+v([1-9]\d*)$/iu);
        const targetText = explicit ? explicit[1].trim() : header;
        const targets = targetText
          ? employees.filter((user) => user.id === targetText || user.name === targetText)
          : employees;
        if (targets.length !== 1) {
          return await this.reply(frame, '请用“反馈 员工姓名 周一日期 v版本：反馈内容”明确指定一名管辖员工及周报，例如“反馈 张三 2026-08-31 v1：请补充下一步”。重名时请用后台人员ID。');
        }
        const selectedWeek = explicit?.[2] ?? weekId(new Date());
        const selectedDate = new Date(`${selectedWeek}T04:00:00Z`);
        if (!Number.isFinite(selectedDate.getTime()) || selectedDate.toISOString().slice(0,10) !== selectedWeek || weekId(selectedDate) !== selectedWeek) {
          return await this.reply(frame, '周次必须填写真实的周一日期，请复制周报通知中的反馈格式。');
        }
        const report = explicit
          ? this.db.prepare('SELECT * FROM weekly_report WHERE tenant_id=? AND user_id=? AND week_id=? AND version=?').get(this.app.tenantId, targets[0].id, selectedWeek, Number(explicit[3])) as unknown as repo.WeeklyReportRow | undefined
          : repo.getWeeklyReport(this.db, targets[0].id, selectedWeek, this.app.tenantId);
        if (!report) return await this.reply(frame, explicit ? '指定周次及版本的周报不存在，请核对通知中的反馈格式；不会改写到其他周报。' : `你未指定周次，按当前周（${selectedWeek}）查找，但该员工本周尚未生成周报。反馈上一周请复制通知中的“反馈 姓名 周一日期 v版本：内容”。`);
        this.app.addFeedback(report.id, feedback[2], null, manager.id,`wecom-feedback:${body.msgid}`);
        return await this.reply(frame, `${explicit?'':'你未指定周次，按当前周处理。\n'}给${targets[0].name} ${report.week_id}当周第${report.version}版周报的反馈已入库，并将通过日报助手通知本人。`);
      }
      const plan = rawText.match(/^周计划[：:]\s*([\s\S]+)$/u);
      if (plan) {
        const items = plan[1].split(/[；;\n]+/).map(splitPlanEntry).filter((item) => item.name);
        this.app.createWeeklyPlan(userId, weekId(new Date()), items);
        return await this.reply(frame, `本周计划已保存，共 ${items.length} 项。\n${items.map(item=>`• ${item.name}${item.planBackground?`｜${item.planBackground}`:''}`).join('\n')}\n日报请写事项名称、企业全称和本周累计完成量，例如“企业走访：今天走访某某有限公司，本周累计走访1家”。明确的数量目标会自动作为进度分母。`);
      }
      if (/^生成周报$/u.test(rawText)) {
        await stream.open('正在汇总本周已确认日报…');
        const wk = weekId(new Date());
        const id = await this.app.generateWeeklyReport(userId, wk, {notifyManager:true});
        const report = repo.getWeeklyReportById(this.db, id)!;
        const accessUrl = this.createReportAccessUrl(userId, report.id);
        const link = accessUrl ? `\n${accessUrl}` : '';
        return await stream.complete(`本周周报已生成：\n${report.content}${link}`);
      }

      const backfill = rawText.match(/^补记\s*(\d{4}-\d{2}-\d{2})[：:]\s*([\s\S]+)$/u);
      if (backfill) {
        const requestedDate = backfill[1];
        const requestedInstant = new Date(`${requestedDate}T04:00:00Z`);
        if (!Number.isFinite(requestedInstant.getTime()) || requestedInstant.toISOString().slice(0, 10) !== requestedDate) {
          return await this.reply(frame, '日期无效，请填写真实的日历日期，例如“补记 2026-09-04：工作内容”。');
        }
        if (requestedDate > currentDate()) return await this.reply(frame, '不能把未来计划作为已经发生的工作补记，请填写今天或本周之前日期的实际工作。');
        if (weekId(requestedInstant) !== weekId(new Date())) {
          return await this.reply(frame, '只能补记或更正本周内的日报。');
        }
        date = requestedDate;
        recordText = backfill[2].trim();
        if (!recordText) return await this.reply(frame, '请在日期后补充工作内容。');
        if (pendingEdit) this.app.cancelDailyEdit(userId, pendingEdit.reportId);
      } else if (pendingEdit) {
        const report = repo.getDailyReportById(this.db, pendingEdit.reportId, this.app.tenantId);
        const latest = repo.getLatestDailyReport(this.db, userId, pendingEdit.date, this.app.tenantId);
        if (!report || report.user_id !== userId || latest?.id !== pendingEdit.reportId) {
          this.app.cancelDailyEdit(userId, pendingEdit.reportId);
          return await this.reply(frame, '原日报草稿已失效，请重新发送工作记录。');
        }
        date = pendingEdit.date;
      }

      await stream.open();
      const reportId = await this.app.submitRecord(userId, date, recordText, {
        messageId: body.msgid,
        contentType,
        quotedText: quoteText(body.quote),
        attachments,
        editingReportId: backfill ? undefined : pendingEdit?.reportId,
      });
      const presentation = this.app.prepareDailyPresentation(userId, reportId);
      const report = presentation.report;
      logger.info('日报草稿已生成', { user: privateLabel(userId), report: privateLabel(reportId) });
      let newCompanyNote = '';
      try { newCompanyNote = await this.newCompanies.discover(userId, user.name, date, recordText); }
      catch { newCompanyNote = '\n企业名单暂时无法核对，新企业资料尚未录入，请稍后重新发送拜访记录。'; }
      await stream.complete(
        `${contentType === 'image' || contentType === 'file' || attachments.length ? '附件正文未解析，请补充文字。\n' : ''}${date === currentDate() ? '今日日报' : date+'日报'}（待确认）\n${this.app.dailyPreview(report,{newCompanyPending:/补充新企业|查看新企业/.test(newCompanyNote)})}${newCompanyNote}`,
      );
      this.app.completeDailyPresentation(userId, presentation);
    } catch (error) {
      logger.error('企微消息处理失败', error, { user: privateLabel(userId), type: contentType });
      const savedSource = repo.getSourceMessageByMsgId(this.db, body.msgid, this.app.tenantId);
      await stream.fail(error instanceof Error ? error.message : '未知错误', savedSource?.user_id === userId);
    } finally {
      const remaining = (this.activeByUser.get(userId) ?? 1) - 1;
      if (remaining <= 0) this.activeByUser.delete(userId);
      else this.activeByUser.set(userId, remaining);
    }
  }

  private async storeDownload(content: FileContent | ImageContent, fallback: string, kind: 'file' | 'image'): Promise<{ kind: string; name: string; path: string }> {
    const downloaded = await this.client.downloadFile(content.url, content.aeskey);
    if (downloaded.buffer.length > this.config.attachmentMaxBytes) throw new Error('附件超过大小限制');
    const name = safeName(downloaded.filename, fallback);
    if (kind === 'file' && BLOCKED_FILE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      throw new Error('不接受可执行文件或脚本附件，请改为PDF、Office文档、图片或文本');
    }
    const month = currentDate().slice(0, 7);
    const directory = path.join(this.config.attachmentDir, month);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${randomUUID()}-${name}`);
    await writeFile(filePath, downloaded.buffer, { flag: 'wx' });
    return { kind, name, path: filePath };
  }

  private async handleAssistantCommand(frame: WsFrame<unknown>, body: BaseMessage, user: repo.UserRow, command: AssistantCommand): Promise<void> {
    const actor = { userId: user.id, role: user.role, tenantId: this.app.tenantId };
    if (command.type === 'invalid') return this.reply(frame, command.message);
    if (command.type === 'lookup') {
      if (command.scope === 'knowledge') {
        const query = command.query.toLocaleLowerCase();
        const rows = repo.filterReadableKnowledge(this.db, actor).filter((row) => `${row.title}\n${row.content}`.toLocaleLowerCase().includes(query)).slice(0, 5);
        return this.reply(frame, rows.length ? ['以下是你有权读取的当前资料摘录（不是新增工作事实）：', ...rows.map(row => `【${row.title} · v${row.version}】\n${row.content.slice(0, 300)}${row.content.length > 300 ? '…（摘录）' : ''}`)].join('\n\n') : '未找到你有权读取的匹配资料。未关联或已停用的资料不会返回。');
      }
      const result = repo.searchBusinessMemory(this.db, actor, { query: command.query, limit: 5, maxChars: 1800 });
      return this.reply(frame, result.items.length ? ['以下是已留存事实的摘录，不是新生成的日报：', ...result.items.map(row => `【${row.sourceType === 'confirmed_daily' ? '已确认日报' : '企业跟进'} · ${row.date} · v${row.version}】\n${row.content}`), ...(result.truncated ? ['结果已截取，请增加关键词缩小范围。'] : [])].join('\n\n') : '未找到你有权读取的匹配历史。仅检索企业跟进与已确认日报摘要，不包含未确认草稿。');
    }
    let input: AssistantActionInput;
    if (command.type === 'knowledge') input = { action: 'knowledge.create', requestId: body.msgid, payload: command.payload };
    else if (command.type === 'schedule') input = { action: 'notifications.schedule.update', requestId: body.msgid, payload: command.payload };
    else {
      const allowed = new Set(repo.readableCompanyIds(this.db, actor));
      const candidates = new CrmStore(this.db, this.app.tenantId).companies().filter(company => allowed.has(company.id) && company.name === command.companyName && !company.archived);
      if (candidates.length !== 1) return this.reply(frame, '企业名称不唯一、不存在或你无权访问。请在工作台核对企业全称后重发。');
      input = { action: 'crm.followup.add', requestId: body.msgid, payload: { companyId: candidates[0].id, content: command.content } };
    }
    const proposal = proposeAction(this.db, actor, input);
    if (proposal.status !== 'pending') return this.reply(frame, proposal.status === 'executed' ? '这条要求已经执行，没有重复保存。' : '这条要求已经取消，请重新发送新的要求。');
    const stream = new StreamReply(this.client, frame, generateReqId('stream'), this.config.streamTimeoutMs, user.wecom_userid ?? undefined);
    await stream.open('正在展示操作预览，尚未写入业务数据…');
    await stream.complete([
      proposal.preview.title, ...proposal.preview.lines,
      ...(proposal.fullContent ? ['——待保存正文全文开始——', proposal.fullContent, '——待保存正文全文结束——'] : []),
      '请核对全部内容后点击下方按钮；未确认不会执行，也不会作为日报记录。',
    ].join('\n'), actionCard(proposal.id, proposal.confirmationToken), {
      longContentText: '操作预览较长，将分条展示全文。请核对全部内容后再点击最后的确认按钮。',
      cardFailureText: '操作确认卡片发送失败，本次操作尚未执行。请重新发送完整操作要求获取新预览；普通文字确认不会执行此操作。',
    });
  }

  private async reply(frame: WsFrame<unknown>, content: string): Promise<void> {
    await this.client.replyStream(frame, generateReqId('stream'), content, true);
  }

  private createReportAccessUrl(recipientUserId: string, reportId: string): string | undefined {
    if (!this.config.reportBaseUrl) return undefined;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    repo.insertAccessGrant(this.db, {
      id: randomUUID(),
      token_hash: createHash('sha256').update(token).digest('hex'),
      user_id: recipientUserId,
      resource_type: 'weekly_report',
      resource_id: reportId,
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: now.toISOString(),
    });
    repo.insertAudit(this.db, {
      id: randomUUID(), actor_user_id: null, action: 'access_grant.issued',
      resource_type: 'weekly_report', resource_id: reportId,
      details_json: JSON.stringify({ recipientUserId, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() }),
      created_at: now.toISOString(),
    });
    return `${this.config.reportBaseUrl.replace(/\/$/, '')}/#/access/${token}`;
  }

}
