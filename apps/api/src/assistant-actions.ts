import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as repo from '@wecom/persistence';
import type { AccessActor, Db, KnowledgeKind } from '@wecom/persistence';
import { notificationSettings } from './notifications';

export type AssistantAction = 'knowledge.create' | 'crm.followup.add' | 'notifications.schedule.update';
export interface AssistantActionInput { action: AssistantAction; requestId: string; payload: Record<string, unknown> }
export type ActionInput = AssistantActionInput;
export interface ActionProposal {
  id: string; action: AssistantAction; status: 'pending' | 'executed' | 'cancelled'; version: number;
  /** Plain text only. Render with textContent / framework escaping, never innerHTML. */
  preview: { title: string; lines: string[] };
  /** Knowledge proposals expose the complete original text for the confirmation detail view. */
  fullContent?: string;
  expiresAt: string; confirmationToken: string;
}
export interface ActionResult { proposalId: string; status: 'executed'; action: AssistantAction; resourceId: string; replayed: boolean }
export class AssistantActionError extends Error {
  constructor(message: string, readonly code: 'invalid_input' | 'forbidden' | 'not_found' | 'conflict' | 'expired' | 'cancelled' | 'confirmation_required', readonly status = 400) { super(message); }
}
interface StoredProposal {
  id: string; tenant_id: string; actor_id: string; actor_json: string; action: AssistantAction; request_id: string;
  request_hash: string; payload_json: string; snapshot_json: string; preview_json: string; version: number;
  status: ActionProposal['status']; expires_at: string; created_at: string; executed_at: string | null; result_json: string | null;
}
const ACTIONS: AssistantAction[] = ['knowledge.create', 'crm.followup.add', 'notifications.schedule.update'];
const KINDS: KnowledgeKind[] = ['service_company', 'park_material', 'policy', 'guide'];
const SCHEDULE_KEYS = ['planReminderAt', 'dailyReminderAt', 'weeklyGenerateAt'] as const;
const FIELD_LABELS = { planReminderAt: '周一计划提醒', dailyReminderAt: '日报提醒', weeklyGenerateAt: '周报生成' };
const KIND_LABELS: Record<KnowledgeKind, string> = { service_company: '企业资料', park_material: '园区资料', policy: '政策', guide: '办事指南' };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
// Existing CRM names may predate today's input validation. Make hidden formatting visible in labels.
function label(value: unknown): string {
  return String(value ?? '').replace(/[\p{Cf}\p{Cc}]/gu, (char) => {
    const codepoint = char.codePointAt(0)!;
    return codepoint <= 0xffff ? `\\u${codepoint.toString(16).padStart(4, '0')}` : `\\u{${codepoint.toString(16)}}`;
  });
}
function fail(message: string, code: AssistantActionError['code'] = 'invalid_input', status = 400): never { throw new AssistantActionError(message, code, status); }
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('操作参数必须为普通对象');
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!allowed.includes(key)) fail(`不支持的操作字段：${key}`);
  return data;
}
function text(data: Record<string, unknown>, key: string, max: number, required = false, preserve = false): string {
  if (data[key] !== undefined && typeof data[key] !== 'string') fail(`${key}必须是文本`);
  const original = String(data[key] ?? '');
  const value = preserve ? original : original.trim();
  // Invisible direction/control characters must not make the confirmed preview differ from execution.
  if (/[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(original)) fail(`${key}包含不支持的控制字符`);
  if ((required && !value.trim()) || value.length > max) fail(`${key}${required ? '不能为空，且' : ''}最多${max}字`);
  return value;
}
function localDate(now: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
function date(data: Record<string, unknown>, key: string): string {
  const value = text(data, key, 10);
  if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail(`${key}日期无效`);
  return value;
}
function normalize(action: AssistantAction, raw: unknown, now: Date): Record<string, Json> {
  if (action === 'knowledge.create') {
    const p = object(raw, ['kind', 'title', 'summary', 'content', 'tags', 'sourceName']);
    const kind = text(p, 'kind', 40, true) as KnowledgeKind;
    if (!KINDS.includes(kind)) fail('知识类型无效');
    const tags = p.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 12 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) fail('标签最多12个，每个1到40字');
    const cleanedTags = tags.map((tag) => text({ tag }, 'tag', 40, true));
    return { kind, title: text(p, 'title', 120, true), summary: text(p, 'summary', 1000), content: text(p, 'content', 12000, true, true), tags: [...new Set(cleanedTags)], sourceName: text(p, 'sourceName', 200) };
  }
  if (action === 'crm.followup.add') {
    const p = object(raw, ['companyId', 'content', 'type', 'occurredOn', 'recordId', 'nextAction', 'dueDate', 'sourceReportId']);
    const type = text(p, 'type', 20) || 'other';
    if (!['visit', 'call', 'meeting', 'material', 'other'].includes(type)) fail('跟进类型无效');
    const occurredOn = date(p, 'occurredOn') || localDate(now);
    if (occurredOn > localDate(now)) fail('实际跟进日期不能是未来日期');
    return { companyId: text(p, 'companyId', 100, true), content: text(p, 'content', 3000, true), type, occurredOn,
      recordId: text(p, 'recordId', 100), nextAction: text(p, 'nextAction', 500), dueDate: date(p, 'dueDate'), sourceReportId: text(p, 'sourceReportId', 100) };
  }
  const p = object(raw, SCHEDULE_KEYS);
  if (!Object.keys(p).length) fail('至少指定一个提醒时间');
  const result: Record<string, Json> = {};
  for (const key of SCHEDULE_KEYS) if (p[key] !== undefined) {
    const value = text(p, key, 5, true);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`${key}必须是HH:mm`);
    result[key] = value;
  }
  if (!Object.keys(result).length) fail('至少指定一个提醒时间');
  return result;
}

/** SAVEPOINT composes with callers' BEGIN IMMEDIATE, without nested BEGIN or async work. */
function atomic<T>(db: Db, operation: () => T): T {
  const savepoint = `assistant_${randomUUID().replace(/-/g, '')}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try { const result = operation(); db.exec(`RELEASE SAVEPOINT ${savepoint}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); throw error; }
}
export function ensureActionSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_action_proposal (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), actor_id TEXT NOT NULL,
    actor_json TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('knowledge.create','crm.followup.add','notifications.schedule.update')),
    request_id TEXT NOT NULL, request_hash TEXT NOT NULL, payload_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    preview_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executed','cancelled')),
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL, executed_at TEXT, result_json TEXT,
    UNIQUE(tenant_id,actor_id,request_id)
  );`);
}
function identity(db: Db, actor: AccessActor) {
  const tenantId = actor.tenantId ?? 'poc';
  if (actor.resourceId) fail('只读报告入口不能执行后台操作', 'forbidden', 403);
  const user = repo.activeUser(db, actor.userId, tenantId);
  const bootstrap = tenantId === 'poc' && actor.userId === 'poc-admin' && actor.role === 'admin' && !repo.getUser(db, actor.userId, tenantId);
  if (!bootstrap && (!user || user.role !== actor.role)) fail('当前身份已失效或角色已变化，请重新登录', 'forbidden', 403);
  return { tenantId, userId: actor.userId, role: actor.role, bindingId: user?.wecom_userid ?? 'bootstrap-admin', managerId: user?.manager_user_id ?? null };
}
interface CompanyRow { id: string; data_json: string; version: number; updated_at: string }
function snapshot(db: Db, actor: AccessActor, action: AssistantAction, p: Record<string, Json>): { state: unknown; preview: ActionProposal['preview'] } {
  const who = identity(db, actor), tenantId = who.tenantId;
  if (action === 'knowledge.create') {
    if (who.role !== 'admin') fail('仅管理员可以创建知识资料', 'forbidden', 403);
    const duplicates = db.prepare('SELECT id,version FROM knowledge_entry WHERE tenant_id=? AND kind=? AND title=? ORDER BY id').all(tenantId, String(p.kind), String(p.title));
    if (duplicates.length) fail('同类型同名资料已存在，请先查看现有资料', 'conflict', 409);
    const content = String(p.content);
    return { state: { duplicates }, preview: { title: '新增并启用文本知识资料', lines: [`类型：${KIND_LABELS[p.kind as KnowledgeKind]}`, `名称：${label(p.title)}`, `来源标注：${label(p.sourceName) || '未填写'}`, `标签：${(p.tags as string[]).map(label).join('、') || '无'}`, `摘要：${p.summary || '未填写'}`, `正文共${content.length}字符；${content.length > 350 ? '以下仅预览前350字符，已截断，请展开完整正文核对后再确认' : '以下为完整正文'}：\n${content.slice(0, 350)}`, `正文校验摘要：${createHash('sha256').update(content).digest('hex').slice(0, 16)}`, '确认后保存你原提交的完整正文，不改写、不解析文件、不覆盖已有资料。'] } };
  }
  if (action === 'notifications.schedule.update') {
    if (who.role !== 'admin') fail('仅管理员可以修改提醒时间', 'forbidden', 403);
    const settings = notificationSettings(db, tenantId);
    const old = db.prepare("SELECT config_key,value_json,updated_at FROM app_config WHERE tenant_id=? AND config_key IN ('notifications','planReminderAt','dailyReminderAt','weeklyGenerateAt') ORDER BY config_key").all(tenantId);
    return { state: { settings, old }, preview: { title: '调整主动消息时间', lines: [...SCHEDULE_KEYS.filter((key) => p[key] !== undefined).map((key) => `${FIELD_LABELS[key]}：${settings[key]} → ${p[key]}（上海时间）`), '只修改上述时间；开关、星期、免打扰、收件人和权限保持不变。'] } };
  }
  const company = db.prepare('SELECT id,data_json,version,updated_at FROM crm_company WHERE tenant_id=? AND id=?').get(tenantId, String(p.companyId)) as unknown as CompanyRow | undefined;
  if (!company) fail('企业不存在或无权访问', 'not_found', 404);
  const data = JSON.parse(company.data_json) as Record<string, unknown>;
  const userIds = repo.managedUserIds(db, actor).sort();
  if (who.role !== 'admin' && !repo.companyMemberIds(data).some((id) => userIds.includes(id))) fail('企业不存在或无权访问', 'not_found', 404);
  if (data.archived) fail('企业已归档，请重新选择可跟进的企业', 'conflict', 409);
  const record = p.recordId ? db.prepare('SELECT id,kind,data_json,version,updated_at FROM crm_record WHERE tenant_id=? AND company_id=? AND id=?').get(tenantId, String(p.companyId), String(p.recordId)) : null;
  if (p.recordId && !record) fail('关联事项不属于该企业', 'conflict', 409);
  const source = p.sourceReportId ? db.prepare('SELECT id,user_id,status,version,updated_at FROM daily_report WHERE tenant_id=? AND id=?').get(tenantId, String(p.sourceReportId)) : null;
  if (p.sourceReportId && (!source || source.status !== 'confirmed' || !repo.canReadUser(db, actor, String(source.user_id)))) fail('只能关联有权查看的有效已确认日报', 'forbidden', 403);
  const lastEvent = db.prepare('SELECT id FROM crm_event WHERE tenant_id=? AND company_id=? ORDER BY rowid DESC LIMIT 1').get(tenantId, String(p.companyId));
  const recordData = record ? JSON.parse(String(record.data_json)) as Record<string, unknown> : null;
  return { state: { userIds, company, record, source, lastEvent }, preview: { title: '新增企业跟进记录', lines: [`企业：${label(data.name)}`, `关联事项：${label(recordData?.title ?? '企业级跟进')}`, `实际日期：${p.occurredOn}`, `类型：${({ visit: '走访', call: '电话', meeting: '会议', material: '资料', other: '其他' } as Record<string, string>)[String(p.type)]}`, `跟进内容：\n${p.content}`, `后续计划（历史记录）：${p.nextAction || '未填写'}`, `计划日期（历史记录）：${p.dueDate || '未填写'}`, `关联已确认日报：${label(p.sourceReportId) || '无'}`, '以本人身份追加历史记录；不改变负责人、阶段、事项状态或当前下一步提醒。'] } };
}
function token(row: StoredProposal): string {
  return digest({ id: row.id, tenantId: row.tenant_id, actorId: row.actor_id, action: row.action, payload: row.payload_json, snapshot: row.snapshot_json, version: row.version, expiresAt: row.expires_at });
}
function view(row: StoredProposal): ActionProposal { return { id: row.id, action: row.action, status: row.status, version: row.version, preview: JSON.parse(row.preview_json),
  ...(row.action === 'knowledge.create' ? { fullContent: String(JSON.parse(row.payload_json).content) } : {}), expiresAt: row.expires_at, confirmationToken: token(row) }; }
function audit(db: Db, row: Pick<StoredProposal, 'id' | 'tenant_id' | 'actor_id' | 'action'>, event: string, now: Date, details: unknown = {}): void {
  repo.insertAudit(db, { id: randomUUID(), tenant_id: row.tenant_id, actor_user_id: row.actor_id, action: `assistant_action.${event}`, resource_type: 'assistant_action_proposal', resource_id: row.id,
    details_json: JSON.stringify({ action: row.action, ...details as object }), created_at: now.toISOString() });
}
/** actor is a server-authenticated identity, never values selected by a model or request payload. */
export function proposeAction(db: Db, actor: AccessActor, input: AssistantActionInput, now = new Date()): ActionProposal {
  ensureActionSchema(db);
  const raw = object(input, ['action', 'requestId', 'payload']);
  if (!ACTIONS.includes(raw.action as AssistantAction)) fail('操作不在允许清单内');
  const requestId = text(raw, 'requestId', 200, true), action = raw.action as AssistantAction;
  const p = normalize(action, raw.payload, now), requestHash = digest({ action, payload: raw.payload });
  return atomic(db, () => {
    const who = identity(db, actor);
    const existing = db.prepare('SELECT * FROM assistant_action_proposal WHERE tenant_id=? AND actor_id=? AND request_id=?').get(who.tenantId, who.userId, requestId) as unknown as StoredProposal | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) fail('同一请求标识不能用于不同操作内容', 'conflict', 409);
      if (existing.actor_json !== canonical(who)) fail('提案身份已变化，请重新提出操作', 'forbidden', 403);
      return view(existing);
    }
    const captured = snapshot(db, actor, action, p);
    const row: StoredProposal = { id: randomUUID(), tenant_id: who.tenantId, actor_id: who.userId, actor_json: canonical(who), action,
      request_id: requestId, request_hash: requestHash, payload_json: canonical(p), snapshot_json: canonical(captured.state), preview_json: JSON.stringify(captured.preview), version: 1,
      status: 'pending', expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(), created_at: now.toISOString(), executed_at: null, result_json: null };
    db.prepare(`INSERT INTO assistant_action_proposal(id,tenant_id,actor_id,actor_json,action,request_id,request_hash,payload_json,snapshot_json,preview_json,version,status,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.tenant_id, row.actor_id, row.actor_json, row.action, row.request_id, row.request_hash, row.payload_json, row.snapshot_json, row.preview_json, row.version, row.status, row.expires_at, row.created_at);
    audit(db, row, 'proposed', now, { version: row.version, expiresAt: row.expires_at });
    return view(row);
  });
}
function owned(db: Db, actor: AccessActor, id: string): StoredProposal {
  const who = identity(db, actor);
  const row = db.prepare('SELECT * FROM assistant_action_proposal WHERE id=? AND tenant_id=? AND actor_id=?').get(id, who.tenantId, who.userId) as unknown as StoredProposal | undefined;
  if (!row) fail('提案不存在或不属于当前人员', 'not_found', 404);
  if (row.actor_json !== canonical(who)) fail('提案身份或角色已变化，请重新提出操作', 'forbidden', 403);
  return row;
}
function execute(db: Db, actor: AccessActor, row: StoredProposal, p: Record<string, Json>, now: Date): string {
  const id = randomUUID(), time = now.toISOString();
  if (row.action === 'knowledge.create') {
    repo.createKnowledgeEntry(db, { id, tenant_id: row.tenant_id, kind: p.kind as KnowledgeKind, title: String(p.title), summary: String(p.summary), content: String(p.content), tags_json: JSON.stringify(p.tags), source_name: String(p.sourceName), created_at: time, updated_at: time });
    repo.insertAudit(db, { id: randomUUID(), tenant_id: row.tenant_id, actor_user_id: actor.userId, action: 'admin.knowledge_created', resource_type: 'knowledge_entry', resource_id: id,
      details_json: JSON.stringify({ kind: p.kind, title: p.title, proposalId: row.id }), created_at: time });
    return id;
  }
  if (row.action === 'notifications.schedule.update') {
    const settings = notificationSettings(db, row.tenant_id);
    const next = { ...settings, ...p };
    repo.setConfig(db, 'notifications', next, row.tenant_id);
    for (const key of SCHEDULE_KEYS) if (p[key] !== undefined) repo.setConfig(db, key, p[key], row.tenant_id);
    repo.insertAudit(db, { id, tenant_id: row.tenant_id, actor_user_id: actor.userId, action: 'notifications.settings_updated', resource_type: 'config', resource_id: 'notifications', details_json: JSON.stringify({ before: settings, after: next, proposalId: row.id }), created_at: time });
    return 'notifications';
  }
  // Deliberately append history only. No owner, stage, current task or arbitrary column changes.
  const details = { type: p.type, recordId: p.recordId, nextAction: p.nextAction, dueDate: p.dueDate, proposalId: row.id };
  db.prepare(`INSERT INTO crm_event(id,tenant_id,company_id,kind,actor_id,content,occurred_on,source_report_id,details_json,created_at)
    VALUES(?,?,?,'followup',?,?,?,?,?,?)`).run(id, row.tenant_id, String(p.companyId), actor.userId, String(p.content), String(p.occurredOn), p.sourceReportId ? String(p.sourceReportId) : null, JSON.stringify(details), time);
  db.prepare('UPDATE crm_company SET updated_at=? WHERE tenant_id=? AND id=?').run(time, row.tenant_id, String(p.companyId));
  repo.insertAudit(db, { id: randomUUID(), tenant_id: row.tenant_id, actor_user_id: actor.userId, action: 'crm.followup', resource_type: 'crm_company', resource_id: String(p.companyId), details_json: JSON.stringify({ eventId: id, proposalId: row.id }), created_at: time });
  return id;
}
export function confirmAction(db: Db, actor: AccessActor, proposalId: string, confirmationToken?: string, now = new Date()): ActionResult {
  ensureActionSchema(db);
  return atomic(db, () => {
    const row = owned(db, actor, proposalId), expected = token(row);
    if (typeof confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(confirmationToken) || !timingSafeEqual(Buffer.from(confirmationToken), Buffer.from(expected))) fail('请先查看提案并明确确认该版本', 'confirmation_required', 409);
    if (row.status === 'executed') return { ...JSON.parse(row.result_json!), replayed: true } as ActionResult;
    if (row.status === 'cancelled') fail('提案已取消，请重新提出操作', 'cancelled', 409);
    if (row.expires_at <= now.toISOString()) fail('提案已过期，请重新生成并确认', 'expired', 409);
    const p = JSON.parse(row.payload_json) as Record<string, Json>;
    const current = snapshot(db, actor, row.action, p);
    if (row.snapshot_json !== canonical(current.state)) fail('目标、配置或授权范围已变化，请重新提出操作', 'conflict', 409);
    const resourceId = execute(db, actor, row, p, now);
    const result: ActionResult = { proposalId: row.id, status: 'executed', action: row.action, resourceId, replayed: false };
    const changed = db.prepare("UPDATE assistant_action_proposal SET status='executed',executed_at=?,result_json=? WHERE id=? AND tenant_id=? AND actor_id=? AND status='pending' AND version=?")
      .run(now.toISOString(), JSON.stringify(result), row.id, row.tenant_id, row.actor_id, row.version);
    if (changed.changes !== 1) fail('提案状态已变化，请刷新', 'conflict', 409);
    audit(db, row, 'executed', now, { resourceId, version: row.version, payloadHash: digest(p), snapshotHash: digest(current.state) });
    return result;
  });
}
export function cancelAction(db: Db, actor: AccessActor, proposalId: string, now = new Date()): { proposalId: string; status: 'cancelled'; replayed: boolean } {
  ensureActionSchema(db);
  return atomic(db, () => {
    const row = owned(db, actor, proposalId);
    if (row.status === 'executed') fail('已执行操作不能通过取消提案撤销', 'conflict', 409);
    if (row.status === 'cancelled') return { proposalId: row.id, status: 'cancelled', replayed: true };
    db.prepare("UPDATE assistant_action_proposal SET status='cancelled' WHERE id=? AND tenant_id=? AND actor_id=? AND status='pending'").run(row.id, row.tenant_id, row.actor_id);
    audit(db, row, 'cancelled', now);
    return { proposalId: row.id, status: 'cancelled', replayed: false };
  });
}
