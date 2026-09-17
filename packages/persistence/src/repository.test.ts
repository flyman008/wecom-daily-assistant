import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import {
  countDirectReports,
  bindActivationCode,
  claimActivationCode,
  createActivationCode,
  createKnowledgeEntry,
  getLatestDailyReport,
  getUserByWecomUserid,
  getUser,
  insertDailyReport,
  insertWorkItem,
  listWorkItems,
  listKnowledgeEntries,
  updateUserAssignment,
  upsertUser,
} from './repository';

describe('SQLite Repository 冒烟', () => {
  it('事项与日报的写入/查询', () => {
    const db = openDb(':memory:');
    upsertUser(db, { id: 'e001', name: '测试员工' });
    insertWorkItem(db, {
      id: 'wi-1',
      user_id: 'e001',
      week_id: '2026-08-31',
      name: '走访企业',
      plan_background: '',
      created_at: '2026-08-31T04:00:00.000Z',
      deleted: 0,
    });
    expect(listWorkItems(db, 'e001', '2026-08-31')).toHaveLength(1);

    insertDailyReport(db, {
      id: 'dr-1',
      user_id: 'e001',
      report_date: '2026-08-31',
      version: 1,
      status: 'pending_confirmation',
      summary: '草稿',
      progress_json: '[]',
      confirmed_at: null,
      created_at: '2026-08-31T10:00:00.000Z',
    });
    expect(getLatestDailyReport(db, 'e001', '2026-08-31')?.status).toBe('pending_confirmation');
  });

  it('角色与汇报关系更新不会改写企微身份，并可维护姓名', () => {
    const db = openDb(':memory:');
    upsertUser(db, { id: 'manager-id', wecom_userid: 'wm-manager', name: '赵主管', role: 'team_lead' });
    upsertUser(db, { id: 'employee-id', wecom_userid: 'wm-employee', name: '钱员工' });

    const updated = updateUserAssignment(db, 'employee-id', 'employee', 'manager-id', 'poc', '钱同事');

    expect(updated).toMatchObject({
      id: 'employee-id',
      wecom_userid: 'wm-employee',
      name: '钱同事',
      role: 'employee',
      manager_user_id: 'manager-id',
    });
    expect(countDirectReports(db, 'manager-id')).toBe(1);
    expect(getUser(db, 'employee-id')?.wecom_userid).toBe('wm-employee');
  });

  it('一次性绑定码只按哈希核验并在确认后绑定', () => {
    const db = openDb(':memory:');
    const code = 'SN-ABCD-2345';
    const codeHash = createHash('sha256').update(code).digest('hex');
    upsertUser(db, { id: 'person-1', wecom_userid: 'pending:person-1', name: '待绑定员工' });
    createActivationCode(db, {
      id: 'activation-1', user_id: 'person-1', code_hash: codeHash,
      expires_at: '2026-09-12T00:00:00.000Z', created_at: '2026-09-05T00:00:00.000Z',
    });

    const claimed = claimActivationCode(db, codeHash, 'wecom-001', '2026-09-05T01:00:00.000Z');
    expect(claimed?.user_id).toBe('person-1');
    const bound = bindActivationCode(db, 'activation-1', 'wecom-001', '2026-09-05T01:01:00.000Z');
    expect(bound.wecom_userid).toBe('wecom-001');
    expect(getUserByWecomUserid(db, 'wecom-001')?.id).toBe('person-1');
    expect(() => bindActivationCode(db, 'activation-1', 'wecom-001', '2026-09-05T01:02:00.000Z')).toThrow('绑定确认已失效');
  });

  it('知识库支持业务分类、版本更新与停用留存', () => {
    const db = openDb(':memory:');
    createKnowledgeEntry(db, {
      id: 'knowledge-1', kind: 'service_company', title: '示例企业', summary: '重点服务企业',
      content: '企业画像与服务记录', tags_json: '["重点"]', source_name: '企业台账',
      created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    });
    expect(listKnowledgeEntries(db, { kind: 'service_company', active: true })).toMatchObject([
      { id: 'knowledge-1', title: '示例企业', version: 1, active: 1 },
    ]);
  });
});
