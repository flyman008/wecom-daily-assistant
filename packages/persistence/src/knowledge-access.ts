import { activeUser, companyMemberIds, managedUserIds, type AccessActor, type WorkspaceView } from './access';
import type { Db } from './db';
import { getUser, type KnowledgeEntryRow } from './repository';

export type ReadableKnowledge = Pick<KnowledgeEntryRow, 'id' | 'title' | 'kind' | 'content' | 'version'>;
export type KnowledgeCandidate = Pick<KnowledgeEntryRow, 'id' | 'tenant_id'>;
export interface BusinessReadOptions { view?: WorkspaceView; companyId?: string }
export interface BusinessReadScope { tenantId: string; admin: boolean; userIds: string[]; companyIds: string[] }

/** Read-only scope resolution. Callers must pass their server-authenticated actor. */
export function resolveBusinessReadScope(db: Db, actor: AccessActor, options: BusinessReadOptions = {}): BusinessReadScope | undefined {
  if (actor.resourceId) return undefined;
  const view = options.view ?? 'team';
  if (view !== 'personal' && view !== 'team') return undefined;
  const tenantId = actor.tenantId ?? 'poc';
  const current = activeUser(db, actor.userId, tenantId);
  const bootstrapAdmin = tenantId === 'poc' && actor.userId === 'poc-admin' && actor.role === 'admin'
    && !getUser(db, actor.userId, tenantId);
  if (!bootstrapAdmin && (!current || current.role !== actor.role)) return undefined;
  const userIds = managedUserIds(db, actor, view);
  const memberScope = new Set(userIds);
  const admin = actor.role === 'admin' && view === 'team';
  const companies = db.prepare('SELECT id,data_json FROM crm_company WHERE tenant_id=?')
    .all(tenantId) as Array<{ id: string; data_json: string }>;
  const companyIds: string[] = [];
  for (const row of companies) {
    try {
      const data: unknown = JSON.parse(row.data_json);
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      if (admin || companyMemberIds(data as Record<string, unknown>).some((id) => memberScope.has(id))) companyIds.push(row.id);
    } catch { /* Malformed company data cannot establish a non-admin access grant. */ }
  }
  if (options.companyId !== undefined && !companyIds.includes(options.companyId)) return undefined;
  return { tenantId, admin: admin && options.companyId === undefined, userIds,
    companyIds: options.companyId === undefined ? companyIds : [options.companyId] };
}

export function readableCompanyIds(db: Db, actor: AccessActor, options: BusinessReadOptions = {}): string[] {
  return resolveBusinessReadScope(db, actor, options)?.companyIds ?? [];
}

/**
 * Current, enabled knowledge only. Association is explicit; unlinked documents
 * are not public. Never trust a caller's candidate content or a stored link snapshot.
 */
export function filterReadableKnowledge(db: Db, actor: AccessActor, candidates?: readonly KnowledgeCandidate[], options: BusinessReadOptions = {}): ReadableKnowledge[] {
  const scope = resolveBusinessReadScope(db, actor, options);
  if (!scope) return [];
  const selected = candidates === undefined ? undefined : new Set(candidates
    .filter((entry) => entry.tenant_id === scope.tenantId && typeof entry.id === 'string')
    .map((entry) => entry.id));
  if (selected?.size === 0) return [];
  const rows = db.prepare(`SELECT k.id,k.title,k.kind,k.content,k.version FROM knowledge_entry k
    WHERE k.tenant_id=? AND k.active=1 AND (?=0 OR k.id IN (SELECT value FROM json_each(?))) AND (?=1 OR EXISTS (
      SELECT 1 FROM crm_knowledge_link l JOIN crm_company c ON c.id=l.company_id AND c.tenant_id=l.tenant_id
      WHERE l.tenant_id=k.tenant_id AND l.knowledge_id=k.id
        AND l.company_id IN (SELECT value FROM json_each(?))
    )) ORDER BY k.updated_at DESC,k.id`).all(scope.tenantId, selected ? 1 : 0, JSON.stringify(selected ? [...selected] : []),
      scope.admin ? 1 : 0, JSON.stringify(scope.companyIds)) as ReadableKnowledge[];
  return rows;
}

export function canReadKnowledge(db: Db, actor: AccessActor, knowledgeId: string, options: BusinessReadOptions = {}): boolean {
  return filterReadableKnowledge(db, actor, [{ id: knowledgeId, tenant_id: actor.tenantId ?? 'poc' }], options).length === 1;
}
