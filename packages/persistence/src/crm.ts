import { randomUUID } from 'node:crypto';
import { inTransaction, type Db } from './db';

export const CRM_SCHEMA = `
CREATE TABLE IF NOT EXISTS crm_stage (
  tenant_id TEXT NOT NULL REFERENCES tenant(id), id TEXT NOT NULL, label TEXT NOT NULL,
  position INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'open', PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS crm_company (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), name_key TEXT NOT NULL,
  data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,name_key)
);
CREATE TABLE IF NOT EXISTS crm_record (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), company_id TEXT NOT NULL REFERENCES crm_company(id),
  kind TEXT NOT NULL CHECK(kind IN ('project','service')), data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_record_company ON crm_record(tenant_id,company_id,kind);
CREATE TABLE IF NOT EXISTS crm_event (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), company_id TEXT NOT NULL REFERENCES crm_company(id),
  kind TEXT NOT NULL, actor_id TEXT NOT NULL, content TEXT NOT NULL, occurred_on TEXT NOT NULL,
  source_report_id TEXT REFERENCES daily_report(id), details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_event_company ON crm_event(tenant_id,company_id,occurred_on,created_at);
CREATE TABLE IF NOT EXISTS crm_knowledge_link (
  tenant_id TEXT NOT NULL REFERENCES tenant(id), company_id TEXT NOT NULL REFERENCES crm_company(id),
  knowledge_id TEXT NOT NULL REFERENCES knowledge_entry(id), snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,company_id,knowledge_id)
);
`;

export const DEFAULT_CRM_STAGES = [
  { id: 'lead', label: '初步接洽', outcome: 'open' },
  { id: 'needs', label: '需求明确', outcome: 'open' },
  { id: 'visit', label: '考察对接', outcome: 'open' },
  { id: 'negotiating', label: '方案洽谈', outcome: 'open' },
  { id: 'signed', label: '签约办理', outcome: 'open' },
  { id: 'landed', label: '已落地', outcome: 'won' },
  { id: 'paused', label: '暂停跟进', outcome: 'open' },
  { id: 'closed', label: '终止推进', outcome: 'lost' },
];
export interface CrmStage { id: string; label: string; position: number; outcome: string }
type Body = Record<string, unknown>;
type Data = Record<string, string | boolean | string[] | number>;
interface Stored { id: string; tenant_id: string; data_json: string; version: number; is_demo?: number; created_at: string; updated_at: string; company_id?: string; kind?: string; last_followup?: string }
export type CrmEntity = Data & { id: string; version: number; isDemo: boolean; createdAt: string; updatedAt: string };
export class CrmError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const now = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function text(body: Body, key: string, max = 200, required = false): string {
  const raw = body[key];
  if (raw !== undefined && typeof raw !== 'string') throw new CrmError(`${key}必须是文字`);
  const value = ((raw as string | undefined) ?? '').trim();
  if ((required && !value) || value.length > max) throw new CrmError(`${key}${required ? '不能为空，且' : ''}不能超过${max}字`);
  return value;
}
function choice(body: Body, key: string, options: string[], fallback: string): string {
  const value = text(body, key) || fallback;
  if (!options.includes(value)) throw new CrmError(`${key}选项无效`);
  return value;
}
function date(body: Body, key: string): string {
  const value = text(body, key, 10);
  if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new CrmError('日期无效');
  return value;
}
function bool(body: Body, key: string): boolean {
  if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new CrmError(`${key}必须为布尔值`);
  return body[key] === true;
}
function entity(row: Stored): CrmEntity {
  return { ...JSON.parse(row.data_json), id: row.id, version: row.version, isDemo: row.is_demo === 1, createdAt: row.created_at, updatedAt: row.updated_at, lastFollowup: row.last_followup || '' };
}
export class CrmStore {
  constructor(readonly db: Db, readonly tenantId = 'poc') {
    for (const [position, stage] of DEFAULT_CRM_STAGES.entries()) {
      // Seed only an entirely unconfigured tenant; reopening must not reset configuration.
      if (position === 0 && this.stages().length) break;
      db.prepare('INSERT OR IGNORE INTO crm_stage(tenant_id,id,label,position,outcome) VALUES(?,?,?,?,?)')
        .run(tenantId, stage.id, stage.label, position, stage.outcome);
    }
  }
  stages(): CrmStage[] { return this.db.prepare('SELECT id,label,position,outcome FROM crm_stage WHERE tenant_id=? ORDER BY position,id').all(this.tenantId) as unknown as CrmStage[]; }
  users() { return this.db.prepare('SELECT id,name,department FROM app_user WHERE tenant_id=? AND active=1 ORDER BY name').all(this.tenantId); }
  knowledge() { return this.db.prepare('SELECT id,title,kind,version,active FROM knowledge_entry WHERE tenant_id=? ORDER BY updated_at DESC').all(this.tenantId); }
  reports() {
    return this.db.prepare(`SELECT d.id,d.user_id,d.report_date,d.version,d.summary,u.name FROM daily_report d
      JOIN app_user u ON u.id=d.user_id AND u.tenant_id=d.tenant_id WHERE d.tenant_id=? AND d.status='confirmed'
      ORDER BY d.report_date DESC LIMIT 100`).all(this.tenantId);
  }
  private owner(body: Body): string {
    const id = text(body, 'ownerId', 100);
    if (id && !this.db.prepare('SELECT id FROM app_user WHERE tenant_id=? AND id=? AND active=1').get(this.tenantId, id)) throw new CrmError('负责人不存在或已停用');
    return id;
  }
  private collaborators(body: Body): string[] {
    const ids = body.collaboratorIds ?? [];
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string')) throw new CrmError('协作者格式无效，最多50人');
    return [...new Set(ids.map((id) => this.owner({ ownerId: id })).filter(Boolean))];
  }
  private source(body: Body): string | null {
    const id = text(body, 'sourceReportId', 100);
    if (id && !this.db.prepare("SELECT id FROM daily_report WHERE tenant_id=? AND id=? AND status='confirmed'").get(this.tenantId, id)) throw new CrmError('只能关联本企业已确认且有效的日报');
    return id || null;
  }
  private row(id: string): Stored {
    const row = this.db.prepare('SELECT * FROM crm_company WHERE tenant_id=? AND id=?').get(this.tenantId, id) as unknown as Stored | undefined;
    if (!row) throw new CrmError('企业不存在', 404);
    return row;
  }
  companies(): CrmEntity[] { return (this.db.prepare(`SELECT c.*,(SELECT MAX(e.occurred_on) FROM crm_event e WHERE e.tenant_id=c.tenant_id AND e.company_id=c.id AND e.kind='followup') AS last_followup
    FROM crm_company c WHERE c.tenant_id=? ORDER BY c.updated_at DESC,c.id`).all(this.tenantId) as unknown as Stored[]).map(entity); }
  records(companyId?: string): Array<CrmEntity & { companyId: string; kind: string }> {
    const rows = this.db.prepare(`SELECT * FROM crm_record WHERE tenant_id=?${companyId ? ' AND company_id=?' : ''} ORDER BY created_at DESC,id`).all(...(companyId ? [this.tenantId, companyId] : [this.tenantId])) as unknown as Stored[];
    return rows.map((row) => ({ ...entity(row), companyId: row.company_id!, kind: row.kind! }));
  }
  detail(id: string) {
    const company = entity(this.row(id));
    const events = this.db.prepare(`SELECT e.*,u.name AS actor_name,d.summary AS source_summary,d.report_date AS source_report_date FROM crm_event e LEFT JOIN app_user u ON u.id=e.actor_id AND u.tenant_id=e.tenant_id
      LEFT JOIN daily_report d ON d.id=e.source_report_id AND d.tenant_id=e.tenant_id
      WHERE e.tenant_id=? AND e.company_id=? ORDER BY e.occurred_on DESC,e.created_at DESC,e.rowid DESC`).all(this.tenantId, id);
    const links = this.db.prepare(`SELECT l.*,k.version AS current_version,k.active AS current_active FROM crm_knowledge_link l
      JOIN knowledge_entry k ON k.id=l.knowledge_id AND k.tenant_id=l.tenant_id WHERE l.tenant_id=? AND l.company_id=?`).all(this.tenantId, id);
    return { company, records: this.records(id), events, links };
  }
  private event(companyId: string, kind: string, actor: string, content: string, details: unknown, body: Body = {}) {
    const id = randomUUID(), time = now();
    const occurred = date(body, 'occurredOn') || today();
    if (occurred > today()) throw new CrmError('跟进日期不能在未来，请将计划填入下一步');
    this.db.prepare(`INSERT INTO crm_event(id,tenant_id,company_id,kind,actor_id,content,occurred_on,source_report_id,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, this.tenantId, companyId, kind, actor, content, occurred, this.source(body), JSON.stringify(details), time);
    this.db.prepare(`INSERT INTO audit_log(id,tenant_id,actor_user_id,action,resource_type,resource_id,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), this.tenantId, actor, `crm.${kind}`, 'crm_company', companyId, JSON.stringify({ eventId: id }), time);
    return id;
  }
  saveCompany(body: Body, actor: string, id?: string, demo = false): CrmEntity {
    return inTransaction(this.db, () => {
      const old = id ? this.row(id) : undefined;
      const previous: Body = old ? JSON.parse(old.data_json) : {};
      if (old && body.version !== old.version) throw new CrmError('档案已被更新，请刷新后再修改', 409);
      const input = { ...previous, ...body };
      const aliases = input.aliases ?? [];
      if (!Array.isArray(aliases) || aliases.length > 12 || aliases.some((a) => typeof a !== 'string' || !a.trim() || a.length > 80)) throw new CrmError('别名最多12个，每个1—80字');
      const data: Data = {
        name: text(input, 'name', 120, true), aliases: [...new Set((aliases as string[]).map((a) => a.trim()))],
        industry: text(input, 'industry', 80), park: text(input, 'park', 80), ownerId: this.owner(input), collaboratorIds: this.collaborators(input),
        relationship: choice(input, 'relationship', ['prospect','serving','paused','exited'], 'prospect'),
        operatingStatus: choice(input, 'operatingStatus', ['unknown','active','suspended','closed'], 'unknown'),
        contactName: text(input, 'contactName', 60), contactRole: text(input, 'contactRole', 60), contactPhone: text(input, 'contactPhone', 60),
        summary: text(input, 'summary', 2000), nextAction: text(input, 'nextAction', 500), nextDate: date(input, 'nextDate'),
        risk: choice(input, 'risk', ['none','watch','high'], 'none'), riskNote: text(input, 'riskNote', 500), archived: bool(input, 'archived'),
      };
      const key = (data.name as string).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
      const duplicate = this.db.prepare('SELECT id FROM crm_company WHERE tenant_id=? AND name_key=? AND id<>?').get(this.tenantId, key, id ?? '');
      if (duplicate) throw new CrmError('同名企业已存在，请打开原档案核对；不会自动合并', 409);
      const reason = text(body, 'reason', 1000, Boolean(old));
      const target = id ?? randomUUID(), time = now();
      if (old) this.db.prepare('UPDATE crm_company SET name_key=?,data_json=?,version=version+1,updated_at=? WHERE tenant_id=? AND id=?').run(key, JSON.stringify(data), time, this.tenantId, target);
      else this.db.prepare('INSERT INTO crm_company(id,tenant_id,name_key,data_json,is_demo,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(target, this.tenantId, key, JSON.stringify(data), demo ? 1 : 0, time, time);
      this.event(target, old ? 'company_updated' : 'company_created', actor, reason || '建立企业档案', { before: old ? previous : null, after: data }, body);
      return entity(this.row(target));
    });
  }
  saveRecord(companyId: string, kind: 'project' | 'service', body: Body, actor: string, recordId?: string) {
    return inTransaction(this.db, () => {
      const company = entity(this.row(companyId));
      if (company.archived) throw new CrmError('该企业已归档，请先恢复档案再修改');
      const old = recordId ? this.db.prepare('SELECT * FROM crm_record WHERE tenant_id=? AND company_id=? AND kind=? AND id=?').get(this.tenantId, companyId, kind, recordId) as unknown as Stored | undefined : undefined;
      if (recordId && !old) throw new CrmError('事项不存在', 404);
      if (old && body.version !== old.version) throw new CrmError('事项已被更新，请刷新后再修改', 409);
      const previous = old ? JSON.parse(old.data_json) : {};
      const input = { ...previous, ...body };
      const data: Data = { title: text(input, 'title', 120, true), ownerId: this.owner(input), description: text(input, 'description', 2000), nextAction: text(input, 'nextAction', 500), dueDate: date(input, 'dueDate') };
      if (kind === 'project') data.stageId = choice(input, 'stageId', this.stages().map((s) => s.id), this.stages()[0].id);
      else {
        data.status = choice(input, 'status', ['pending','working','waiting','resolved','paused'], 'pending');
        data.outcome = text(input, 'outcome', 1000, data.status === 'resolved');
      }
      const reason = text(body, 'reason', 1000, Boolean(old)), target = recordId ?? randomUUID(), time = now();
      if (old) this.db.prepare('UPDATE crm_record SET data_json=?,version=version+1,updated_at=? WHERE tenant_id=? AND id=?').run(JSON.stringify(data), time, this.tenantId, target);
      else this.db.prepare('INSERT INTO crm_record(id,tenant_id,company_id,kind,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(target, this.tenantId, companyId, kind, JSON.stringify(data), time, time);
      this.event(companyId, `${kind}_${old ? 'updated' : 'created'}`, actor, reason || `新增${kind === 'project' ? '招商项目' : '服务事项'}：${data.title}`, {
        recordId: target, before: old ? previous : null, after: data,
        stageBefore: kind === 'project' ? this.stages().find((s) => s.id === previous.stageId)?.label : undefined,
        stageAfter: kind === 'project' ? this.stages().find((s) => s.id === data.stageId)?.label : undefined,
      }, body);
      this.db.prepare('UPDATE crm_company SET updated_at=? WHERE tenant_id=? AND id=?').run(time, this.tenantId, companyId);
      return this.records(companyId).find((r) => r.id === target)!;
    });
  }
  followup(companyId: string, body: Body, actor: string) {
    return inTransaction(this.db, () => {
      if (entity(this.row(companyId)).archived) throw new CrmError('该企业已归档');
      const kind = choice(body, 'type', ['visit','call','meeting','material','other'], 'other');
      const content = text(body, 'content', 3000, true);
      const recordId = text(body, 'recordId', 100);
      if (recordId && !this.records(companyId).some((r) => r.id === recordId)) throw new CrmError('关联事项不属于该企业');
      const id = this.event(companyId, 'followup', actor, content, { type: kind, recordId, nextAction: text(body, 'nextAction', 500), dueDate: date(body, 'dueDate') }, body);
      this.db.prepare('UPDATE crm_company SET updated_at=? WHERE tenant_id=? AND id=?').run(now(), this.tenantId, companyId);
      return id;
    });
  }
  link(companyId: string, body: Body, actor: string) {
    return inTransaction(this.db, () => {
      if (entity(this.row(companyId)).archived) throw new CrmError('该企业已归档，请先恢复档案再关联资料');
      const knowledgeId = text(body, 'knowledgeId', 100, true);
      const entry = this.db.prepare('SELECT * FROM knowledge_entry WHERE tenant_id=? AND id=? AND active=1').get(this.tenantId, knowledgeId);
      if (!entry) throw new CrmError('资料不存在或已停用');
      this.db.prepare(`INSERT INTO crm_knowledge_link(tenant_id,company_id,knowledge_id,snapshot_json,created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(tenant_id,company_id,knowledge_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,created_at=excluded.created_at`).run(this.tenantId, companyId, knowledgeId, JSON.stringify(entry), now());
      this.event(companyId, 'knowledge_linked', actor, `关联资料：${entry.title}（v${entry.version}）`, { knowledgeId, version: entry.version, snapshot: entry });
    });
  }
  saveStages(body: Body, actor: string) {
    const rows = body.stages;
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 20) throw new CrmError('阶段数量应为2—20个');
    const ids = new Set<string>(), labels = new Set<string>();
    const stages = rows.map((raw, position) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CrmError('阶段格式无效');
      const row = raw as Body, id = text(row, 'id', 60, true), label = text(row, 'label', 30, true);
      if (!/^[a-z][a-z0-9_]*$/.test(id) || ids.has(id) || labels.has(label)) throw new CrmError('阶段标识或名称无效、重复');
      ids.add(id); labels.add(label);
      return { id, label, position, outcome: choice(row, 'outcome', ['open','won','lost'], 'open') };
    });
    return inTransaction(this.db, () => {
      const previous = this.stages();
      if (JSON.stringify(body.previousStages) !== JSON.stringify(previous)) throw new CrmError('阶段配置已更新，请重新打开配置', 409);
      // Stable identifiers and semantics retain the interpretation of old timeline entries.
      for (const old of previous) if (!stages.some((s) => s.id === old.id && s.outcome === old.outcome)) throw new CrmError('已有阶段不可删除或改变结果类型，可改名、调整顺序或新增');
      for (const stage of stages) this.db.prepare(`INSERT INTO crm_stage(tenant_id,id,label,position,outcome) VALUES(?,?,?,?,?)
        ON CONFLICT(tenant_id,id) DO UPDATE SET label=excluded.label,position=excluded.position`).run(this.tenantId, stage.id, stage.label, stage.position, stage.outcome);
      this.db.prepare('INSERT INTO audit_log(id,tenant_id,actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(randomUUID(), this.tenantId, actor, 'crm.stages_updated', 'crm_config', 'stages', JSON.stringify({ before: previous, after: stages }), now());
      return stages;
    });
  }
}

export function seedCrmDemo(store: CrmStore): void {
  if (store.companies().length) return;
  const users = store.users();
  const owner = users.find((user) => user.id === 'e001')?.id ?? users[0]?.id ?? '';
  const examples = [
    { name: '示例·澄星数字科技', industry: '数字服务', park: '示例·科创园', relationship: 'prospect', summary: '虚构演示：有办公空间需求，已进行初步沟通。', stageId: 'needs', title: '区域办公中心选址', risk: 'watch', riskNote: '虚构演示：预算口径待确认' },
    { name: '示例·青禾智能设备', industry: '智能制造', park: '示例·产业园', relationship: 'serving', summary: '虚构演示：已有落地项目，正在跟进人才服务诉求。', stageId: 'landed', title: '技术服务中心落地', risk: 'none', riskNote: '' },
    { name: '示例·远川企业服务', industry: '专业服务', park: '待确定', relationship: 'prospect', summary: '虚构演示：正在对接园区考察，未签约。', stageId: 'visit', title: '专业服务机构引入', risk: 'none', riskNote: '' },
  ];
  for (const [index, data] of examples.entries()) {
    const exampleOwner = users.find((user) => user.id === `e00${index + 1}`)?.id ?? owner;
    const company = store.saveCompany({ ...data, ownerId: exampleOwner, aliases: [], nextAction: '演示数据，请按实际情况维护' }, 'demo-system', undefined, true);
    store.saveRecord(company.id, 'project', { title: data.title, stageId: data.stageId, ownerId: exampleOwner, description: '虚构项目，仅供界面演示' }, 'demo-system');
    store.followup(company.id, { content: '虚构演示：完成一次电话沟通，具体诉求需进一步核实。', type: 'call' }, 'demo-system');
    if (data.relationship === 'serving') store.saveRecord(company.id, 'service', { title: '人才政策咨询', status: 'working', ownerId: exampleOwner, description: '虚构服务事项：整理适用政策与办理材料' }, 'demo-system');
  }
}
