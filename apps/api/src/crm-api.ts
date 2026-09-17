import type { Db } from '@wecom/persistence';
import { CrmError, CrmStore, type CrmEntity } from '../../../packages/persistence/src/crm';
import { companyMemberIds, filterReadableKnowledge, getKnowledgeEntry, getUser, managedUserIds, type WorkspaceView } from '@wecom/persistence';

export interface CrmRequestAccess { userId: string; userIds: string[]; canManage: boolean; isAdmin: boolean; view?: WorkspaceView }

function companyView(store: CrmStore, company: CrmEntity): CrmEntity & { ownerName: string; collaboratorNames: string[] } {
  const names = new Map(store.db.prepare('SELECT id,name FROM app_user WHERE tenant_id=?').all(store.tenantId).map((user) => [String(user.id), String(user.name)]));
  return { ...company, ownerName: typeof company.ownerId === 'string' ? names.get(company.ownerId) ?? '' : '',
    collaboratorNames: Array.isArray(company.collaboratorIds) ? company.collaboratorIds.map((id) => names.get(String(id)) ?? '') : [] };
}

export function visibleCompanies(store: CrmStore, access?: CrmRequestAccess) {
  return store.companies().filter((company) => !access || access.isAdmin || companyMemberIds(company).some((id) => access.userIds.includes(id))).map((company) => companyView(store, company));
}

function permissions(company: Record<string, unknown>, access?: CrmRequestAccess) {
  const inOwnerScope = typeof company.ownerId === 'string' && Boolean(access?.userIds.includes(company.ownerId));
  const canAssign = !access || access.isAdmin || Boolean(access.canManage && inOwnerScope);
  return {
    canEdit: !access || access.isAdmin || Boolean(inOwnerScope && (access.canManage || company.ownerId === access.userId)),
    canAssign,
    canFollowup: !company.archived,
    canLinkKnowledge: !company.archived,
  };
}

export function authorizedKnowledgeIds(db: Db, store: CrmStore, access?: CrmRequestAccess, companyId?: string): Set<string> {
  // An omitted access context is used only behind the server's full-admin route.
  if (!access) {
    const linked = companyId === undefined ? undefined : new Set(db.prepare(`SELECT l.knowledge_id FROM crm_knowledge_link l
      JOIN crm_company c ON c.id=l.company_id AND c.tenant_id=l.tenant_id WHERE l.tenant_id=? AND l.company_id=?`)
      .all(store.tenantId, companyId).map((row) => String(row.knowledge_id)));
    return new Set(store.knowledge().filter((row) => row.active && (!linked || linked.has(String(row.id)))).map((row) => String(row.id)));
  }
  const current = getUser(db, access.userId, store.tenantId);
  const role = current?.role ?? (access.userId === 'poc-admin' && access.isAdmin ? 'admin' : 'employee');
  return new Set(filterReadableKnowledge(db, { userId: access.userId, role, tenantId: store.tenantId },
    undefined, { view: access.view ?? 'team', companyId }).map((entry) => entry.id));
}

const CRM_HISTORY_FIELDS = new Set(['name', 'aliases', 'industry', 'park', 'ownerId', 'collaboratorIds', 'relationship',
  'operatingStatus', 'contactName', 'contactRole', 'contactPhone', 'summary', 'nextAction', 'nextDate', 'risk', 'riskNote',
  'archived', 'title', 'description', 'dueDate', 'stageId', 'status', 'outcome']);
const CRM_HISTORY_KINDS = new Set(['company_created', 'company_updated', 'project_created', 'project_updated',
  'service_created', 'service_updated', 'followup', 'knowledge_linked']);
function parsedObject(value: unknown): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
function safeHistoryObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => CRM_HISTORY_FIELDS.has(key)
    && (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number'
      || (Array.isArray(item) && item.every((entry) => typeof entry === 'string')))));
}
function safeEventDetails(value: unknown): string {
  const parsed = parsedObject(value), safe: Record<string, unknown> = {};
  for (const key of ['type', 'recordId', 'nextAction', 'dueDate', 'stageBefore', 'stageAfter']) if (typeof parsed[key] === 'string') safe[key] = parsed[key];
  if (parsed.before !== undefined) safe.before = safeHistoryObject(parsed.before);
  if (parsed.after !== undefined) safe.after = safeHistoryObject(parsed.after);
  return JSON.stringify(safe);
}

export function crmRequest(db: Db, pathname: string, method: string, body: Record<string, unknown>, actor: string, access?: CrmRequestAccess) {
  const store = new CrmStore(db);
  const companies = visibleCompanies(store, access);
  const companyIds = new Set(companies.map((company) => company.id));
  const users = store.users().filter((row) => !access || access.userIds.includes(String(row.id)));
  const knowledgeIds = authorizedKnowledgeIds(db, store, access);
  const readableReports = store.reports().filter((row) => !access || access.userIds.includes(String(row.user_id)));
  const globalPermissions = { canCreate: !access || access.isAdmin || users.some((user) => user.id === actor),
    canAssign: !access || access.isAdmin || access.canManage, canConfigureStages: !access || access.isAdmin };
  const suffix = pathname.slice('/api/v1/admin/crm'.length);
  if (suffix === '' && method === 'GET') return { status: 200, body: { companies, records: store.records().filter((row) => companyIds.has(row.companyId)), stages: store.stages(), users, permissions: globalPermissions } };
  if (suffix === '/options' && method === 'GET') return { status: 200, body: { users, stages: store.stages(), knowledge: store.knowledge().filter((row) => knowledgeIds.has(String(row.id))), reports: readableReports, permissions: globalPermissions } };
  if (suffix === '/stages' && method === 'PUT') {
    if (!globalPermissions.canConfigureStages) throw new CrmError('仅管理员可修改系统阶段配置', 403);
    return { status: 200, body: { stages: store.saveStages(body, actor) } };
  }
  if (access && body.sourceReportId) {
    const source = db.prepare('SELECT user_id FROM daily_report WHERE tenant_id=? AND id=?').get(store.tenantId, String(body.sourceReportId));
    if (!source || !access.userIds.includes(String(source.user_id))) throw new CrmError('无权关联该工作记录', 403);
  }
  if (suffix === '/companies' && method === 'POST') {
    if (!globalPermissions.canCreate) throw new CrmError('当前身份不能建立企业档案', 403);
    const input = access && !access.isAdmin ? { ...body, ownerId: body.ownerId || actor } : body;
    if (access && !access.isAdmin && companyMemberIds(input).some((id) => !access.userIds.includes(id))) throw new CrmError('只能分配本人或管辖成员', 403);
    return { status: 201, body: { company: companyView(store, store.saveCompany(input, actor)) } };
  }
  const match = suffix.match(/^\/companies\/([^/]+)(?:\/(projects|services|followups|knowledge)(?:\/([^/]+))?)?$/);
  if (!match) throw new CrmError('接口不存在', 404);
  const id = decodeURIComponent(match[1]), section = match[2], recordId = match[3] ? decodeURIComponent(match[3]) : undefined;
  if (!companyIds.has(id)) throw new CrmError('企业不存在或无权访问', 404);
  const current = companies.find((company) => company.id === id)!;
  const permission = permissions(current, access);
  if (!section && method === 'GET') {
    const detail = store.detail(id);
    const detailKnowledgeIds = authorizedKnowledgeIds(db, store, access, id);
    const actorRow = getUser(db, actor, store.tenantId);
    const fullAdminIdentity = Boolean(actorRow?.active && actorRow.role === 'admin')
      || (store.tenantId === 'poc' && actor === 'poc-admin' && !actorRow);
    const auditAdmin = fullAdminIdentity && (!access || (access.isAdmin && access.view !== 'personal'));
    const reportUserIds = new Set(access ? managedUserIds(db, { userId: access.userId,
      role: getUser(db, access.userId, store.tenantId)?.role ?? 'employee', tenantId: store.tenantId }, access.view ?? 'team')
      .filter((userId) => access.userIds.includes(userId)) : []);
    const events = detail.events.flatMap((event) => {
      if (auditAdmin) return [event];
      if (!CRM_HISTORY_KINDS.has(String(event.kind))) return [];
      if (event.source_report_id) {
        const source = db.prepare('SELECT user_id FROM daily_report WHERE tenant_id=? AND id=?').get(store.tenantId, event.source_report_id);
        // The event's own prose and nested details may quote the personal report.
        // Redacting source_* alone is insufficient; omit the entire event.
        if (!source || !reportUserIds.has(String(source.user_id))) return [];
      }
      if (event.kind === 'knowledge_linked') {
        const knowledgeId = parsedObject(event.details_json).knowledgeId;
        if (typeof knowledgeId !== 'string' || !detailKnowledgeIds.has(knowledgeId)) return [];
        const entry = getKnowledgeEntry(db, knowledgeId, store.tenantId);
        if (!entry?.active) return [];
        return [{ ...event, content: `关联资料：${entry.title}（当前授权版本 v${entry.version}；历史快照仅管理员可见）`,
          details_json: JSON.stringify({ knowledgeId, version: entry.version, contentView: 'current', historicalSnapshotRestricted: true }) }];
      }
      return [{ ...event, details_json: safeEventDetails(event.details_json) }];
    });
    const links = detail.links.flatMap((link) => {
      if (auditAdmin) return [{ ...link, content_view: 'historical' }];
      if (!detailKnowledgeIds.has(String(link.knowledge_id))) return [];
      const entry = getKnowledgeEntry(db, String(link.knowledge_id), store.tenantId);
      if (!entry?.active) return [];
      const historicalVersion = parsedObject(link.snapshot_json).version;
      return [{ ...link, content_view: 'current', historical_version: typeof historicalVersion === 'number' ? historicalVersion : null,
        current_version: entry.version, current_active: entry.active,
        // Compatibility envelope for the existing UI; the body is explicitly
        // labelled current and never contains the old snapshot's title/content.
        snapshot_json: JSON.stringify({ id: entry.id, title: entry.title, kind: entry.kind, version: entry.version,
          content_view: 'current', summary: '', content: `【当前授权资料 v${entry.version}，非关联时历史快照】\n${entry.content || entry.summary}` }) }];
    });
    return { status: 200, body: { ...detail, company: current, events, links, permissions: permission } };
  }
  if (!section && method === 'PUT') {
    if (!permission.canEdit) throw new CrmError('无权修改企业档案，可新增授权范围内的跟进', 403);
    const changedAssignment = (body.ownerId !== undefined && body.ownerId !== current.ownerId)
      || (body.collaboratorIds !== undefined && JSON.stringify(body.collaboratorIds) !== JSON.stringify(current.collaboratorIds ?? []));
    if (changedAssignment && !permission.canAssign) throw new CrmError('无权变更企业负责人或协作者，请联系管理者', 403);
    if (changedAssignment && access && !access.isAdmin
      && companyMemberIds({ ownerId: body.ownerId ?? current.ownerId, collaboratorIds: body.collaboratorIds ?? current.collaboratorIds }).some((target) => !access.userIds.includes(target))) throw new CrmError('只能分配管辖范围内成员', 403);
    return { status: 200, body: { company: companyView(store, store.saveCompany(body, actor, id)) } };
  }
  if ((section === 'projects' || section === 'services') && ((method === 'POST' && !recordId) || (method === 'PUT' && recordId))) {
    if (!permission.canEdit) throw new CrmError('无权修改该企业的项目或服务，可新增授权范围内的跟进', 403);
    if (!permission.canFollowup) throw new CrmError('该企业已归档', 400);
    const existing = recordId ? store.records(id).find((record) => record.id === recordId) : undefined;
    const input = access && !recordId && body.ownerId === undefined ? { ...body, ownerId: access.isAdmin ? current.ownerId || '' : access.userId } : body;
    const expectedOwner = recordId ? existing?.ownerId : access?.userId;
    const changesOwner = input.ownerId !== undefined && input.ownerId !== expectedOwner;
    if (changesOwner && !permission.canAssign) throw new CrmError('无权变更事项负责人，请联系管理者', 403);
    if (changesOwner && access && !access.isAdmin && input.ownerId && !access.userIds.includes(String(input.ownerId))) throw new CrmError('事项负责人不在管辖范围', 403);
    return { status: recordId ? 200 : 201, body: { record: store.saveRecord(id, section === 'projects' ? 'project' : 'service', input, actor, recordId) } };
  }
  if (section === 'followups' && method === 'POST' && !recordId) return { status: 201, body: { id: store.followup(id, body, actor) } };
  if (section === 'knowledge' && method === 'POST' && !recordId) {
    if (!permission.canLinkKnowledge) throw new CrmError('该企业已归档', 400);
    if (access && !knowledgeIds.has(String(body.knowledgeId))) throw new CrmError('无权访问该资料', 403);
    store.link(id, body, actor); return { status: 200, body: { ok: true } };
  }
  throw new CrmError('操作不支持', 405);
}
