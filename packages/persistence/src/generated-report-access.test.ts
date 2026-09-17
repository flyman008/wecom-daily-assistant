import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { CrmStore } from './crm';
import { createKnowledgeEntry, insertDailyReport, insertWeeklyReport, upsertUser } from './repository';
import { isGeneratedReportReadable, parseGeneratedKnowledgeDependencies } from './generated-report-access';

const at = '2026-09-05T04:00:00Z', databases: Db[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup(metadata = true) {
  const db = openDb(':memory:'); databases.push(db);
  upsertUser(db, { id: 'admin', role: 'admin' });
  upsertUser(db, { id: 'owner', role: 'employee', manager_user_id: 'admin' });
  upsertUser(db, { id: 'outside', role: 'employee' });
  db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('foreign', '其他租户', at);
  upsertUser(db, { id: 'foreign-user', tenant_id: 'foreign' });
  if (metadata) db.exec(`CREATE TABLE generated_report_knowledge (
    tenant_id TEXT NOT NULL,report_kind TEXT NOT NULL,report_id TEXT NOT NULL,user_id TEXT NOT NULL,dependencies_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id,report_kind,report_id))`);
  const crm = new CrmStore(db), company = crm.saveCompany({ name: '负责企业', ownerId: 'owner' }, 'admin');
  for (const id of ['used', 'unused']) {
    createKnowledgeEntry(db, { id, kind: 'park_material', title: id, summary: '', content: `${id} 当前知识原文`, tags_json: '[]', source_name: '', created_at: at, updated_at: at });
    crm.link(company.id, { knowledgeId: id }, 'admin');
  }
  insertDailyReport(db, { id: 'daily', user_id: 'owner', report_date: '2026-09-04', version: 1, status: 'confirmed', summary: '生成的日报', progress_json: '[]', confirmed_at: at, created_at: at });
  insertWeeklyReport(db, { id: 'weekly', user_id: 'owner', week_id: '2026-08-31', template_version: '1', content: '生成的周报', missing_days_json: '[]', generated_at: at });
  return { db, company };
}
function save(db: Db, json: unknown, kind = 'daily', user = 'owner', tenant = 'poc') {
  db.prepare('INSERT OR REPLACE INTO generated_report_knowledge VALUES(?,?,?,?,?,?)').run(tenant, kind, kind, user, typeof json === 'string' ? json : JSON.stringify(json), at);
}

describe('知识衍生报告读取时的当前权限与准确版本门禁', () => {
  it('元数据表缺失或记录缺失保留legacy兼容读取，不写入或伪造无依赖证明', () => {
    for (const metadata of [false, true]) {
      const { db } = setup(metadata), before = db.prepare('SELECT total_changes() n').get()!.n;
      expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(true);
      expect(isGeneratedReportReadable(db, 'owner', 'weekly', 'weekly')).toBe(true);
      expect(db.prepare('SELECT total_changes() n').get()!.n).toBe(before);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='generated_report_knowledge'").get() !== undefined).toBe(metadata);
    }
  });

  it('每日和每周记录均校验准确依赖ID与版本；未被选中的知识更新不影响原结果', () => {
    const { db } = setup(); save(db, [{ id: 'used', version: 1 }]); save(db, [{ id: 'used', version: 1 }], 'weekly');
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(true);
    expect(isGeneratedReportReadable(db, 'owner', 'weekly', 'weekly')).toBe(true);
    db.prepare("UPDATE knowledge_entry SET version=2 WHERE id='unused'").run();
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(true);
    db.prepare("UPDATE knowledge_entry SET version=2 WHERE id='used'").run();
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(false);
    expect(isGeneratedReportReadable(db, 'owner', 'weekly', 'weekly')).toBe(false);
  });

  it('禁用、取消关联或转移企业负责关系即时阻止已生成内容再次读取', () => {
    for (const change of ['disabled', 'unlinked', 'reassigned']) {
      const { db, company } = setup(); save(db, [{ id: 'used', version: 1 }]);
      if (change === 'disabled') db.prepare("UPDATE knowledge_entry SET active=0 WHERE id='used'").run();
      if (change === 'unlinked') db.prepare("DELETE FROM crm_knowledge_link WHERE knowledge_id='used'").run();
      if (change === 'reassigned') {
        const data = JSON.parse(String(db.prepare('SELECT data_json FROM crm_company WHERE id=?').get(company.id)!.data_json));
        db.prepare('UPDATE crm_company SET data_json=? WHERE id=?').run(JSON.stringify({ ...data, ownerId: 'outside', collaboratorIds: [] }), company.id);
      }
      expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(false);
      expect(db.prepare("SELECT summary FROM daily_report WHERE id='daily'").get()!.summary).toBe('生成的日报');
    }
  });

  it('实际owner须活跃且报告kind/tenant/归属匹配，不能靠他人或管理员身份替代', () => {
    const { db } = setup(); save(db, []);
    expect(isGeneratedReportReadable(db, 'outside', 'daily', 'daily')).toBe(false);
    expect(isGeneratedReportReadable(db, 'admin', 'daily', 'daily')).toBe(false);
    expect(isGeneratedReportReadable(db, 'owner', 'missing', 'daily')).toBe(false);
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'weekly')).toBe(false);
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily', 'foreign')).toBe(false);
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'bad' as never)).toBe(false);
    db.prepare("UPDATE app_user SET active=0 WHERE id='owner'").run();
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(false);
  });

  it('metadata存在但owner错配是损坏数据，不得降级当作legacy读取', () => {
    const { db } = setup(); save(db, [], 'daily', 'outside');
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(false);
  });

  it('未知知识、伪造版本、重复ID、额外正文、非数组与损坏JSON均fail closed', () => {
    const { db } = setup();
    for (const data of ['{broken', '{}', 'null', '[null]', [{ id: 'missing', version: 1 }], [{ id: 'used', version: 0 }],
      [{ id: 'used', version: '1' }], [{ id: 'used', version: 1.5 }], [{ id: 'used', version: 1, content: '伪造正文' }],
      [{ id: 'used', version: 1 }, { id: 'used', version: 1 }], [{ id: ' used', version: 1 }], [{ id: 'used\u202e', version: 1 }]]) {
      save(db, data); expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(false);
    }
    save(db, []); expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(true);
  });

  it('即使owner后来成为管理员，报告仍按其个人企业范围而不是全企业权限判断', () => {
    const { db } = setup(); save(db, [{ id: 'used', version: 1 }]);
    db.prepare("UPDATE app_user SET role='admin' WHERE id='owner'").run();
    db.prepare("DELETE FROM crm_knowledge_link WHERE knowledge_id='used'").run();
    expect(isGeneratedReportReadable(db, 'owner', 'daily', 'daily')).toBe(false);
  });

  it('独立依赖解析只保留id/version，无隐式修复、无模型调用', () => {
    expect(parseGeneratedKnowledgeDependencies('[{"id":"k1","version":2}]')).toEqual([{ id: 'k1', version: 2 }]);
    expect(parseGeneratedKnowledgeDependencies([])).toBeUndefined();
    expect(parseGeneratedKnowledgeDependencies('[]')).toEqual([]);
    expect(parseGeneratedKnowledgeDependencies(JSON.stringify([{ id: 'k'.repeat(201), version: 1 }]))).toBeUndefined();
  });
});
