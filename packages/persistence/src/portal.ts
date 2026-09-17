import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inTransaction, type Db } from './db';
import { activeUser } from './access';
import { insertAudit, insertAuthSession, isUserBound, type AuthSessionRow } from './repository';

export const PORTAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS portal_access_grant (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), user_id TEXT NOT NULL REFERENCES app_user(id),
  token_hash TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL, role_snapshot TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_session (
  token_hash TEXT PRIMARY KEY REFERENCES auth_session(token_hash),
  grant_id TEXT NOT NULL REFERENCES portal_access_grant(id)
);
`;
export interface PortalGrantOptions { baseUrl: string; tenantId?: string; ttlMs?: number }
export interface PortalAccessGrant { id: string; token: string; url: string; expiresAt: string }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function issue(db: Db, userId: string, options: PortalGrantOptions, demo: boolean): PortalAccessGrant {
  return inTransaction(db, () => {
    const tenantId = options.tenantId ?? 'poc';
    const user = activeUser(db, userId, tenantId);
    if (!user || (!demo && !isUserBound(user))) throw new Error('人员尚未绑定或已停用');
    const base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('门户基础地址无效');
    const ttlMs = options.ttlMs ?? 10 * 60_000;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000) throw new Error('门户授权有效期无效');
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const now = new Date(), expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    db.prepare(`INSERT INTO portal_access_grant(id,tenant_id,user_id,token_hash,binding_id,role_snapshot,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, tenantId, user.id, hash(token), user.wecom_userid, user.role, expiresAt, now.toISOString());
    insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: user.id, action: 'portal.grant_issued', resource_type: 'portal_grant', resource_id: id,
      details_json: JSON.stringify({ expiresAt, demo }), created_at: now.toISOString() });
    return { id, token, expiresAt, url: `${options.baseUrl.replace(/\/$/, '')}/#/portal/${token}` };
  });
}

export function issuePortalAccessGrant(db: Db, userId: string, options: PortalGrantOptions): PortalAccessGrant {
  return issue(db, userId, options, false);
}

/** Server must require explicit demoMode and a full admin session before invoking. */
export function issueDemoPortalAccessGrant(db: Db, userId: string, options: PortalGrantOptions): PortalAccessGrant {
  return issue(db, userId, options, true);
}

export function exchangePortalAccessGrant(db: Db, token: string, tenantId = 'poc') {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('门户授权无效或已过期');
  return inTransaction(db, () => {
    const now = new Date();
    const grant = db.prepare(`SELECT * FROM portal_access_grant WHERE tenant_id=? AND token_hash=?
      AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(tenantId, hash(token), now.toISOString()) as {
        id: string; user_id: string; binding_id: string; role_snapshot: string;
      } | undefined;
    const user = grant ? activeUser(db, grant.user_id, tenantId) : undefined;
    if (!grant || !user || user.wecom_userid !== grant.binding_id || user.role !== grant.role_snapshot) throw new Error('门户授权无效或身份已变更，请重新获取入口');
    const sessionToken = randomBytes(32).toString('base64url'), tokenHash = hash(sessionToken);
    const expiresAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
    db.prepare('UPDATE portal_access_grant SET used_at=? WHERE id=? AND used_at IS NULL').run(now.toISOString(), grant.id);
    insertAuthSession(db, { tenant_id: tenantId, token_hash: tokenHash, user_id: user.id, role: user.role,
      resource_id: null, expires_at: expiresAt, created_at: now.toISOString() });
    db.prepare('INSERT INTO portal_session(token_hash,grant_id) VALUES(?,?)').run(tokenHash, grant.id);
    insertAudit(db, { id: randomUUID(), tenant_id: tenantId, actor_user_id: user.id, action: 'portal.grant_exchanged', resource_type: 'portal_grant', resource_id: grant.id,
      details_json: JSON.stringify({ expiresAt }), created_at: now.toISOString() });
    return { token: sessionToken, expiresAt, route: '#/workspace', user: { id: user.id, name: user.name, role: user.role, department: user.department } };
  });
}

export function portalSessionIsValid(db: Db, session: AuthSessionRow): boolean {
  const grant = db.prepare(`SELECT g.* FROM portal_session s JOIN portal_access_grant g ON g.id=s.grant_id
    WHERE s.token_hash=? AND g.tenant_id=?`).get(session.token_hash, session.tenant_id) as {
      revoked_at: string | null; user_id: string; binding_id: string; role_snapshot: string;
    } | undefined;
  if (!grant) return true;
  const user = activeUser(db, grant.user_id, session.tenant_id);
  return Boolean(!grant.revoked_at && user && user.id === session.user_id && user.wecom_userid === grant.binding_id && user.role === grant.role_snapshot);
}

export function revokePortalAccess(db: Db, userId: string, tenantId = 'poc'): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE portal_access_grant SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL').run(now, tenantId, userId);
  db.prepare('UPDATE auth_session SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL').run(now, tenantId, userId);
}
