import type { Role } from '@wecom/domain';
import type { Db } from './db';
import { getUser, type UserRow } from './repository';

export interface AccessActor { userId: string; role: Role; tenantId?: string; resourceId?: string }
export type WorkspaceView = 'personal' | 'team';

export function activeUser(db: Db, userId: string, tenantId = 'poc'): UserRow | undefined {
  const user = getUser(db, userId, tenantId);
  return user?.active ? user : undefined;
}

export function managedUserIds(db: Db, actor: AccessActor, view: WorkspaceView = 'team'): string[] {
  if (actor.resourceId) return [];
  const tenantId = actor.tenantId ?? 'poc';
  const current = activeUser(db, actor.userId, tenantId);
  // The access-code bootstrap administrator has no directory row. All real
  // identities must still be active and match their current persisted role.
  const bootstrapAdmin = tenantId === 'poc' && actor.userId === 'poc-admin' && actor.role === 'admin' && !getUser(db, actor.userId, tenantId);
  if (!bootstrapAdmin && (!current || current.role !== actor.role)) return [];
  if (view === 'personal') return current ? [actor.userId] : [];
  const users = db.prepare('SELECT * FROM app_user WHERE tenant_id=?').all(tenantId) as unknown as UserRow[];
  if (actor.role === 'admin') return users.map((user) => user.id);
  const visible = new Set([actor.userId]);
  if (actor.role === 'team_lead' || actor.role === 'dept_head') {
    let changed = true;
    while (changed) {
      changed = false;
      for (const user of users) if (user.manager_user_id && visible.has(user.manager_user_id) && !visible.has(user.id)) {
        visible.add(user.id);
        changed = true;
      }
    }
  }
  return [...visible];
}

export function canReadUser(db: Db, actor: AccessActor, targetUserId: string): boolean {
  return managedUserIds(db, actor).includes(targetUserId);
}

export function companyMemberIds(company: Record<string, unknown>): string[] {
  return [...new Set([
    ...(typeof company.ownerId === 'string' && company.ownerId ? [company.ownerId] : []),
    ...(Array.isArray(company.collaboratorIds) ? company.collaboratorIds.filter((id): id is string => typeof id === 'string') : []),
  ])];
}
