import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@wecom/persistence';
import { createKnowledgeEntry, getKnowledgeEntry, insertDailyReport, managedUserIds, updateKnowledgeEntry, upsertUser } from '@wecom/persistence';
import type { Role } from '@wecom/domain';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { authorizedKnowledgeIds, crmRequest, type CrmRequestAccess } from './crm-api';

const at = '2026-09-05T00:00:00.000Z';
const databases: Db[] = [];
function access(db: Db, userId: string, role: Role = 'employee', view: 'personal' | 'team' = 'personal'): CrmRequestAccess {
  return { userId, view, userIds: managedUserIds(db, { userId, role }, view),
    canManage: view === 'team' && role !== 'employee', isAdmin: view === 'team' && role === 'admin' };
}
function setup() {
  const db = openDb(':memory:'); databases.push(db);
  upsertUser(db, { id: 'admin', role: 'admin' });
  upsertUser(db, { id: 'manager', role: 'team_lead' });
  upsertUser(db, { id: 'employee', manager_user_id: 'manager' });
  upsertUser(db, { id: 'other' });
  const store = new CrmStore(db);
  const mine = store.saveCompany({ name: '员工企业', ownerId: 'employee' }, 'admin');
  const joint = store.saveCompany({ name: '共同协作企业', ownerId: 'other', collaboratorIds: ['employee', 'manager'] }, 'admin');
  const outside = store.saveCompany({ name: '其他企业', ownerId: 'other' }, 'admin');
  const managerOwn = store.saveCompany({ name: '组长本人企业', ownerId: 'manager' }, 'admin');
  return { db, store, mine, joint, outside, managerOwn };
}
function knowledge(db: Db, id: string, content = `BODY_${id}`, title = `资料-${id}`) {
  return createKnowledgeEntry(db, { id, kind: 'park_material', title, summary: `SUMMARY_${id}`, content,
    tags_json: '[]', source_name: '', created_at: at, updated_at: at });
}
function report(db: Db, id: string, owner: string, summary: string) {
  insertDailyReport(db, { id, user_id: owner, report_date: '2026-09-04', version: 1, status: 'confirmed',
    summary, progress_json: '[]', confirmed_at: at, created_at: at });
}
function detail(db: Db, id: string, actor: string, scope?: CrmRequestAccess) {
  const result = crmRequest(db, `/api/v1/admin/crm/companies/${id}`, 'GET', {}, actor, scope);
  return result.body as unknown as { events: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> };
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('CRM详情中的个人日报与知识历史隔离', () => {
  it('跨人日报关联的跟进整条过滤，包括跟进正文与嵌套详情，而独立共享跟进可见', () => {
    const { db, store, joint } = setup();
    report(db, 'private-report', 'other', 'PRIVATE_DAILY_BODY');
    const privateEvent = store.followup(joint.id, { content: 'PRIVATE_DAILY_BODY复制到跟进正文', nextAction: 'PRIVATE_NEXT_ACTION', sourceReportId: 'private-report' }, 'admin');
    const sharedEvent = store.followup(joint.id, { content: '独立明确共享的企业事实' }, 'employee');
    for (const scope of [access(db, 'employee'), access(db, 'manager', 'team_lead', 'team')]) {
      const result = detail(db, joint.id, scope.userId, scope);
      expect(result.events.map((entry) => entry.id)).not.toContain(privateEvent);
      expect(result.events.map((entry) => entry.id)).toContain(sharedEvent);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_DAILY_BODY|PRIVATE_NEXT_ACTION|private-report/);
    }
    expect(detail(db, joint.id, 'admin').events.map((entry) => entry.id)).toContain(privateEvent);
  });

  it('停用知识关联事件连标题都不可见，管理员仍能审计原事件与快照', () => {
    const { db, store, mine } = setup();
    knowledge(db, 'disabled', 'DISABLED_SECRET_BODY', '停用的保密资料标题');
    store.link(mine.id, { knowledgeId: 'disabled' }, 'admin');
    db.prepare('UPDATE knowledge_entry SET active=0 WHERE id=?').run('disabled');
    const result = detail(db, mine.id, 'employee', access(db, 'employee'));
    expect(result.links).toEqual([]);
    expect(result.events.some((entry) => entry.kind === 'knowledge_linked')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/DISABLED_SECRET_BODY|停用的保密资料标题/);
    const audited = detail(db, mine.id, 'admin');
    expect(JSON.stringify(audited)).toContain('DISABLED_SECRET_BODY');
    expect(audited.links[0].content_view).toBe('historical');
  });

  it('非admin仅获得当前启用正文与安全元信息，旧标题/正文快照不自动共享', () => {
    const { db, store, mine } = setup();
    const previous = knowledge(db, 'versioned', 'OLD_CONFIDENTIAL_BODY', '旧保密标题');
    store.link(mine.id, { knowledgeId: previous.id }, 'admin');
    updateKnowledgeEntry(db, previous.id, 1, { ...previous, content: '当前授权版本正文', title: '当前资料标题' }, at);
    const result = detail(db, mine.id, 'employee', access(db, 'employee'));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/OLD_CONFIDENTIAL_BODY|旧保密标题/);
    expect(serialized).toContain('当前授权版本正文');
    expect(result.links[0]).toMatchObject({ content_view: 'current', historical_version: 1, current_version: 2 });
    const current = JSON.parse(String(result.links[0].snapshot_json));
    expect(current).toMatchObject({ title: '当前资料标题', version: 2, content_view: 'current' });
    expect(current.content).toContain('非关联时历史快照');
    const event = result.events.find((entry) => entry.kind === 'knowledge_linked')!;
    expect(JSON.parse(String(event.details_json))).toEqual({ knowledgeId: 'versioned', version: 2, contentView: 'current', historicalSnapshotRestricted: true });
    expect(JSON.stringify(detail(db, mine.id, 'admin'))).toContain('OLD_CONFIDENTIAL_BODY');
    expect(String(db.prepare('SELECT snapshot_json FROM crm_knowledge_link WHERE knowledge_id=?').get('versioned')?.snapshot_json)).toContain('OLD_CONFIDENTIAL_BODY');
  });

  it('主管个人视图不会通过企业协作拿到下属日报，team视图才读取管辖范围', () => {
    const { db, store, joint, mine } = setup();
    report(db, 'employee-report', 'employee', 'EMPLOYEE_REPORT_BODY');
    const eventId = store.followup(joint.id, { content: 'EMPLOYEE_REPORT_BODY', sourceReportId: 'employee-report' }, 'employee');
    const personal = access(db, 'manager', 'team_lead', 'personal'), team = access(db, 'manager', 'team_lead', 'team');
    expect(detail(db, joint.id, 'manager', personal).events.map((event) => event.id)).not.toContain(eventId);
    expect(detail(db, joint.id, 'manager', team).events.map((event) => event.id)).toContain(eventId);
    knowledge(db, 'employee-only'); store.link(mine.id, { knowledgeId: 'employee-only' }, 'admin');
    expect(authorizedKnowledgeIds(db, store, personal).has('employee-only')).toBe(false);
    expect(authorizedKnowledgeIds(db, store, team).has('employee-only')).toBe(true);
  });

  it('companyId第四参数收窄资料范围，无权企业不回退为当前视图全部资料', () => {
    const { db, store, mine, joint, outside } = setup();
    for (const [id, company] of [['mine', mine.id], ['joint', joint.id], ['outside', outside.id]]) {
      knowledge(db, id); store.link(company, { knowledgeId: id }, 'admin');
    }
    const personal = access(db, 'employee');
    expect([...authorizedKnowledgeIds(db, store, personal)].sort()).toEqual(['joint', 'mine']);
    expect([...authorizedKnowledgeIds(db, store, personal, joint.id)]).toEqual(['joint']);
    expect([...authorizedKnowledgeIds(db, store, personal, outside.id)]).toEqual([]);
    expect([...authorizedKnowledgeIds(db, store, access(db, 'admin', 'admin', 'team'), mine.id)]).toEqual(['mine']);
    expect([...authorizedKnowledgeIds(db, store, undefined, mine.id)]).toEqual(['mine']);
  });

  it('任意其他事件嵌套的知识/日报快照也不能绕过白名单输出', () => {
    const { db, store, joint } = setup();
    const id = store.followup(joint.id, { content: '可共享独立跟进', nextAction: '继续联系' }, 'employee');
    db.prepare('UPDATE crm_event SET details_json=? WHERE id=?').run(JSON.stringify({ type: 'call', nextAction: '继续联系',
      snapshot: { content: 'UNAUTHORIZED_NESTED_KNOWLEDGE' }, source_summary: 'UNAUTHORIZED_NESTED_DAILY',
      after: { title: '白名单事项名', arbitrary: 'UNAUTHORIZED_ARBITRARY_DATA', snapshot: 'UNAUTHORIZED_NESTED_SNAPSHOT' } }), id);
    const result = detail(db, joint.id, 'employee', access(db, 'employee'));
    expect(JSON.stringify(result)).not.toContain('UNAUTHORIZED_');
    const rendered = result.events.find((event) => event.id === id)!;
    expect(JSON.parse(String(rendered.details_json))).toMatchObject({ type: 'call', nextAction: '继续联系', after: { title: '白名单事项名' } });
  });

  it('管理员个人视图不获得历史快照，仅完整管理端保留审计权限', () => {
    const { db, store, mine } = setup();
    const own = store.saveCompany({ version: mine.version, collaboratorIds: ['admin'], reason: '管理员本人参与服务' }, 'admin', mine.id);
    const old = knowledge(db, 'admin-history', 'OLD_ADMIN_ONLY_SNAPSHOT');
    store.link(own.id, { knowledgeId: old.id }, 'admin');
    updateKnowledgeEntry(db, old.id, 1, { ...old, content: 'CURRENT_AUTHORIZED_BODY' }, at);
    const personal = detail(db, own.id, 'admin', access(db, 'admin', 'admin', 'personal'));
    expect(JSON.stringify(personal)).not.toContain('OLD_ADMIN_ONLY_SNAPSHOT');
    expect(JSON.stringify(personal)).toContain('CURRENT_AUTHORIZED_BODY');
    expect(JSON.stringify(detail(db, own.id, 'admin', access(db, 'admin', 'admin', 'team')))).toContain('OLD_ADMIN_ONLY_SNAPSHOT');
    expect(getKnowledgeEntry(db, old.id)?.version).toBe(2);
  });

  it('资料关联被撤销后，残留历史关联事件不能继续暴露标题或旧内容', () => {
    const { db, store, mine, joint } = setup();
    knowledge(db, 'revoked', 'REVOKED_BODY', '已撤销访问的标题'); store.link(mine.id, { knowledgeId: 'revoked' }, 'admin');
    store.link(joint.id, { knowledgeId: 'revoked' }, 'admin');
    db.prepare('DELETE FROM crm_knowledge_link WHERE company_id=? AND knowledge_id=?').run(mine.id, 'revoked');
    expect(authorizedKnowledgeIds(db, store, access(db, 'employee')).has('revoked')).toBe(true);
    const result = detail(db, mine.id, 'employee', access(db, 'employee'));
    expect(JSON.stringify(result)).not.toMatch(/REVOKED_BODY|已撤销访问的标题/);
    expect(result.events.some((entry) => entry.kind === 'knowledge_linked')).toBe(false);
  });
});
