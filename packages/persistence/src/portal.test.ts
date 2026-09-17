import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { canReadUser, companyMemberIds, managedUserIds } from './access';
import { exchangePortalAccessGrant, issueDemoPortalAccessGrant, issuePortalAccessGrant, portalSessionIsValid, revokePortalAccess } from './portal';
import { getActiveAuthSession, getUser, unbindUser, updateUserAssignment, upsertUser } from './repository';

const databases: Db[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const options = { baseUrl: 'https://portal.example.test' };
function setup() {
  const db = openDb(':memory:');
  databases.push(db);
  upsertUser(db, { id: 'head', role: 'dept_head' });
  upsertUser(db, { id: 'lead', role: 'team_lead', manager_user_id: 'head' });
  upsertUser(db, { id: 'member', manager_user_id: 'lead' });
  upsertUser(db, { id: 'outside' });
  return db;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('个人业务与动态管理范围', () => {
  it('组长同时拥有本人业务与汇报树，部门领导不按角色获得全员权限', () => {
    const db = setup(), lead = { userId: 'lead', role: 'team_lead' as const };
    expect(managedUserIds(db, lead, 'personal')).toEqual(['lead']);
    expect(managedUserIds(db, lead)).toEqual(['lead', 'member']);
    expect(canReadUser(db, lead, 'outside')).toBe(false);
    expect(managedUserIds(db, { userId: 'head', role: 'dept_head' })).toEqual(['head', 'lead', 'member']);
    expect(managedUserIds(db, { userId: 'outside', role: 'employee' })).toEqual(['outside']);
    expect(managedUserIds(db, { ...lead, resourceId: 'one-weekly-report' })).toEqual([]);
    expect(managedUserIds(db, { userId: 'poc-admin', role: 'admin' })).toHaveLength(4);
    updateUserAssignment(db, 'member', 'employee', 'head');
    expect(managedUserIds(db, lead)).toEqual(['lead']);
    expect(companyMemberIds({ ownerId: 'lead', collaboratorIds: ['member', 'lead', 'member'] })).toEqual(['lead', 'member']);
  });

  it('旧角色、停用身份和伪造管理者不能通过公共权限函数扩大范围', () => {
    const db = setup();
    expect(managedUserIds(db, { userId: 'outside', role: 'admin' })).toEqual([]);
    expect(managedUserIds(db, { userId: 'missing', role: 'admin' })).toEqual([]);
    updateUserAssignment(db, 'lead', 'employee', 'head');
    expect(managedUserIds(db, { userId: 'lead', role: 'team_lead' })).toEqual([]);
    db.prepare("UPDATE app_user SET active=0 WHERE id='head'").run();
    expect(managedUserIds(db, { userId: 'head', role: 'dept_head' })).toEqual([]);
  });
});

describe('一次性本人门户授权', () => {
  it('只持久化哈希，兑换后生成独立的非报告限定短期会话，授权不能重放', () => {
    const db = setup(), grant = issuePortalAccessGrant(db, 'lead', options);
    expect(grant.url).toBe(`${options.baseUrl}/#/portal/${grant.token}`);
    const stored = db.prepare('SELECT * FROM portal_access_grant WHERE id=?').get(grant.id)!;
    expect(stored.token_hash).toBe(hash(grant.token));
    expect(JSON.stringify(stored)).not.toContain(grant.token);
    const exchanged = exchangePortalAccessGrant(db, grant.token);
    expect(exchanged).toMatchObject({ user: { id: 'lead', role: 'team_lead' }, route: '#/workspace' });
    expect(exchanged.token).not.toBe(grant.token);
    const session = getActiveAuthSession(db, hash(exchanged.token), new Date().toISOString())!;
    expect(session).toMatchObject({ user_id: 'lead', role: 'team_lead', resource_id: null });
    expect(portalSessionIsValid(db, session)).toBe(true);
    expect(Date.parse(session.expires_at) - Date.now()).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(() => exchangePortalAccessGrant(db, grant.token)).toThrow();
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(grant.token);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(exchanged.token);
    // Grant expiry limits redemption; an already exchanged session has its own expiry.
    db.prepare("UPDATE portal_access_grant SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(grant.id);
    expect(portalSessionIsValid(db, session)).toBe(true);
    expect(getActiveAuthSession(db, hash(exchanged.token), '2999-01-01T00:00:00.000Z')).toBeUndefined();
  });

  it('未绑定/停用不能签发，租户、期限与URL校验生效，demo签发仍需有效人员', () => {
    const db = setup();
    unbindUser(db, 'member');
    expect(() => issuePortalAccessGrant(db, 'member', options)).toThrow('绑定');
    expect(issueDemoPortalAccessGrant(db, 'member', options).token).toHaveLength(43);
    expect(() => issueDemoPortalAccessGrant(db, 'missing', options)).toThrow();
    expect(() => issuePortalAccessGrant(db, 'lead', { ...options, tenantId: 'other' })).toThrow();
    expect(() => issuePortalAccessGrant(db, 'lead', { ...options, ttlMs: 999 })).toThrow();
    expect(() => issuePortalAccessGrant(db, 'lead', { ...options, ttlMs: 31 * 60_000 })).toThrow();
    for (const baseUrl of ['javascript:alert(1)', 'https://user:password@example.test', 'https://example.test?token=secret', 'https://example.test/#old']) {
      expect(() => issuePortalAccessGrant(db, 'lead', { baseUrl })).toThrow();
    }
    db.prepare("UPDATE app_user SET active=0 WHERE id='lead'").run();
    expect(() => issuePortalAccessGrant(db, 'lead', options)).toThrow();
  });

  it('过期、撤销、错误租户、角色或绑定变化均不能兑换；现有会话同步失效', () => {
    const db = setup();
    const expired = issuePortalAccessGrant(db, 'lead', options);
    db.prepare("UPDATE portal_access_grant SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.id);
    expect(() => exchangePortalAccessGrant(db, expired.token)).toThrow();
    const grant = issuePortalAccessGrant(db, 'member', options);
    expect(() => exchangePortalAccessGrant(db, grant.token, 'other')).toThrow();
    const exchanged = exchangePortalAccessGrant(db, grant.token);
    const session = getActiveAuthSession(db, hash(exchanged.token), new Date().toISOString())!;
    const unused = issuePortalAccessGrant(db, 'member', options);
    updateUserAssignment(db, 'member', 'team_lead', 'lead');
    expect(portalSessionIsValid(db, session)).toBe(false);
    expect(() => exchangePortalAccessGrant(db, unused.token)).toThrow();
    updateUserAssignment(db, 'member', 'employee', 'lead');
    unbindUser(db, 'member');
    expect(portalSessionIsValid(db, session)).toBe(false);
    expect(() => exchangePortalAccessGrant(db, unused.token)).toThrow();
    expect(getUser(db, 'member')!.wecom_userid).toMatch(/^pending:/);
    const activeGrant = issuePortalAccessGrant(db, 'lead', options);
    const activeSession = exchangePortalAccessGrant(db, activeGrant.token);
    const yetUnused = issuePortalAccessGrant(db, 'lead', options);
    revokePortalAccess(db, 'lead');
    expect(() => exchangePortalAccessGrant(db, yetUnused.token)).toThrow();
    expect(getActiveAuthSession(db, hash(activeSession.token), new Date().toISOString())).toBeUndefined();
  });

  it('兑换审计失败时事务回滚，令牌未消费且没有半条会话，重试可成功', () => {
    const db = setup(), grant = issuePortalAccessGrant(db, 'lead', options);
    db.exec("CREATE TRIGGER test_portal_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='portal.grant_exchanged' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END");
    expect(() => exchangePortalAccessGrant(db, grant.token)).toThrow('test audit unavailable');
    expect(db.prepare('SELECT used_at FROM portal_access_grant WHERE id=?').get(grant.id)!.used_at).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_session').get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM portal_session').get()!.n).toBe(0);
    db.exec('DROP TRIGGER test_portal_audit_failure');
    expect(exchangePortalAccessGrant(db, grant.token).user.id).toBe('lead');
  });

  it('签发审计失败不留有效授权', () => {
    const db = setup();
    db.exec("CREATE TRIGGER test_issue_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='portal.grant_issued' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END");
    expect(() => issuePortalAccessGrant(db, 'lead', options)).toThrow('test audit unavailable');
    expect(db.prepare('SELECT COUNT(*) AS n FROM portal_access_grant').get()!.n).toBe(0);
  });
});
