import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { CrmStore } from './crm';
import { createKnowledgeEntry, getKnowledgeEntry, upsertUser } from './repository';
import { canReadKnowledge, filterReadableKnowledge, readableCompanyIds } from './knowledge-access';
import type { AccessActor } from './access';

const at = '2026-09-05T00:00:00.000Z';
const databases: Db[] = [];
const employee: AccessActor = { userId: 'employee', role: 'employee' };
const manager: AccessActor = { userId: 'manager', role: 'dept_head' };
const admin: AccessActor = { userId: 'admin', role: 'admin' };
function setup() {
  const db = openDb(':memory:'); databases.push(db);
  upsertUser(db, { id: 'admin', role: 'admin' });
  upsertUser(db, { id: 'manager', role: 'dept_head' });
  upsertUser(db, { id: 'lead', role: 'team_lead', manager_user_id: 'manager' });
  upsertUser(db, { id: 'employee', manager_user_id: 'lead' });
  upsertUser(db, { id: 'coworker' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', '其他租户', at);
  upsertUser(db, { id: 'other-user', tenant_id: 'other' });
  const crm = new CrmStore(db), otherCrm = new CrmStore(db, 'other');
  const mine = crm.saveCompany({ name: '员工负责企业', ownerId: 'employee' }, 'admin');
  const shared = crm.saveCompany({ name: '协作企业', ownerId: 'coworker', collaboratorIds: ['employee'] }, 'admin');
  const outside = crm.saveCompany({ name: '其他员工企业', ownerId: 'coworker' }, 'admin');
  const foreign = otherCrm.saveCompany({ name: '其他租户企业', ownerId: 'other-user' }, 'other-user');
  for (const [id, tenant] of [['mine', 'poc'], ['shared', 'poc'], ['outside', 'poc'], ['unlinked', 'poc'], ['disabled', 'poc'], ['foreign', 'other']]) {
    createKnowledgeEntry(db, { id, tenant_id: tenant, kind: 'park_material', title: `${id}资料`, summary: '摘要',
      content: `${id}当前原文`, tags_json: '[]', source_name: '', created_at: at, updated_at: at });
  }
  crm.link(mine.id, { knowledgeId: 'mine' }, 'admin');
  crm.link(shared.id, { knowledgeId: 'shared' }, 'admin');
  crm.link(outside.id, { knowledgeId: 'outside' }, 'admin');
  crm.link(mine.id, { knowledgeId: 'disabled' }, 'admin');
  otherCrm.link(foreign.id, { knowledgeId: 'foreign' }, 'other-user');
  db.prepare('UPDATE knowledge_entry SET active=0 WHERE id=?').run('disabled');
  return { db, mine, shared, outside, foreign };
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('知识与企业资料共用读取边界', () => {
  it('员工仅能读取自己负责/协作企业的明确关联且启用资料，普通未关联资料不默认公开', () => {
    const { db, mine, shared } = setup();
    expect(filterReadableKnowledge(db, employee).map((entry) => entry.id).sort()).toEqual(['mine', 'shared']);
    expect(new Set(readableCompanyIds(db, employee))).toEqual(new Set([mine.id, shared.id]));
    expect(canReadKnowledge(db, employee, 'unlinked')).toBe(false);
    expect(canReadKnowledge(db, employee, 'disabled')).toBe(false);
    expect(canReadKnowledge(db, employee, 'foreign')).toBe(false);
  });

  it('主管沿完整汇报树读取资料，不因部门负责人角色获得其他员工企业', () => {
    const { db } = setup();
    expect(filterReadableKnowledge(db, manager).map((entry) => entry.id).sort()).toEqual(['mine', 'shared']);
    expect(canReadKnowledge(db, manager, 'outside')).toBe(false);
  });

  it('真实管理员与合法bootstrap管理员可读本租户全库，但停用知识仍不进入使用内容', () => {
    const { db } = setup();
    const expected = ['mine', 'outside', 'shared', 'unlinked'];
    expect(filterReadableKnowledge(db, admin).map((entry) => entry.id).sort()).toEqual(expected);
    expect(filterReadableKnowledge(db, { userId: 'poc-admin', role: 'admin' }).map((entry) => entry.id).sort()).toEqual(expected);
    expect(filterReadableKnowledge(db, { userId: 'poc-admin', role: 'admin', tenantId: 'other' })).toEqual([]);
    upsertUser(db, { id: 'poc-admin', role: 'employee' });
    expect(filterReadableKnowledge(db, { userId: 'poc-admin', role: 'admin' })).toEqual([]);
  });

  it('角色伪造、停用、资源分享会话、跨租户actor均不能复用读取权限', () => {
    const { db } = setup();
    expect(filterReadableKnowledge(db, { ...employee, role: 'admin' })).toEqual([]);
    expect(filterReadableKnowledge(db, { ...employee, tenantId: 'other' })).toEqual([]);
    expect(filterReadableKnowledge(db, { ...admin, resourceId: 'weekly-1' })).toEqual([]);
    db.prepare('UPDATE app_user SET active=0 WHERE id IN (?,?)').run('employee', 'admin');
    expect(filterReadableKnowledge(db, employee)).toEqual([]);
    expect(filterReadableKnowledge(db, admin)).toEqual([]);
  });

  it('候选只用来选择ID，内容与版本重新读取当前库，不返回旧快照或调用者伪造正文', () => {
    const { db } = setup();
    const stale = getKnowledgeEntry(db, 'mine')!;
    db.prepare('UPDATE knowledge_entry SET content=?,version=2 WHERE id=?').run('更新后的安全原文', 'mine');
    const poisoned = { ...stale, content: '伪造的泄露正文' };
    const rows = filterReadableKnowledge(db, employee, [poisoned]);
    expect(rows).toEqual([{ id: 'mine', title: 'mine资料', kind: 'park_material', content: '更新后的安全原文', version: 2 }]);
    expect(JSON.stringify(rows)).not.toContain('snapshot');
    expect(filterReadableKnowledge(db, employee, [{ id: 'mine', tenant_id: 'other' }])).toEqual([]);
    expect(filterReadableKnowledge(db, employee, [])).toEqual([]);
  });

  it('撤销企业协作关系即时撤销资料读取，而历史资料仍留存', () => {
    const { db, shared } = setup();
    expect(canReadKnowledge(db, employee, 'shared')).toBe(true);
    const data = JSON.parse(String(db.prepare('SELECT data_json FROM crm_company WHERE id=?').get(shared.id)?.data_json));
    db.prepare('UPDATE crm_company SET data_json=? WHERE id=?').run(JSON.stringify({ ...data, collaboratorIds: [] }), shared.id);
    expect(canReadKnowledge(db, employee, 'shared')).toBe(false);
    expect(getKnowledgeEntry(db, 'shared')?.content).toBe('shared当前原文');
  });

  it('伪造跨租户关联行与损坏企业JSON都不能建立读取授权', () => {
    const { db, mine, foreign } = setup();
    db.prepare('INSERT INTO crm_knowledge_link(tenant_id,company_id,knowledge_id,snapshot_json,created_at) VALUES(?,?,?,?,?)')
      .run('poc', foreign.id, 'unlinked', '{}', at);
    expect(canReadKnowledge(db, employee, 'unlinked')).toBe(false);
    db.prepare('UPDATE crm_company SET data_json=? WHERE id=?').run('{malformed', mine.id);
    expect(canReadKnowledge(db, employee, 'mine')).toBe(false);
  });

  it('个人视图严格收窄到本人企业，company范围也不能借管理员身份自动放大', () => {
    const { db, mine, shared } = setup();
    expect(filterReadableKnowledge(db, manager, undefined, { view: 'personal' })).toEqual([]);
    expect(filterReadableKnowledge(db, admin, undefined, { view: 'personal' })).toEqual([]);
    expect(filterReadableKnowledge(db, { userId: 'poc-admin', role: 'admin' }, undefined, { view: 'personal' })).toEqual([]);
    expect(filterReadableKnowledge(db, employee, undefined, { view: 'personal', companyId: mine.id }).map((item) => item.id)).toEqual(['mine']);
    expect(filterReadableKnowledge(db, admin, undefined, { companyId: shared.id }).map((item) => item.id)).toEqual(['shared']);
    expect(filterReadableKnowledge(db, employee, undefined, { companyId: 'no-such-company' })).toEqual([]);
  });
});
