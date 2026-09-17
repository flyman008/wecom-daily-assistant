import { describe, expect, it } from 'vitest';
import { openDb } from '@wecom/persistence';
import { EMPLOYEE_COLUMNS, importDirectory, tableRows } from './directory-import';
import { simpleDirectory } from './directory-sheet';

const staff = (id = 'RY001', manager = '') => ({ '员工编号': id, '姓名': id, '部门': '一组', '角色': manager ? '员工' : '组长', '上级员工编号': manager, '状态': '启用' });
const company = (owner = 'RY001') => ({ '企业编号': 'QY001', '企业名称': '测试企业', '行业': '', '园区': '', '负责员工编号': owner, '联系人': '', '联系电话': '', '企业概况': '', '状态': '服务中' });

describe('普通企微表格的最小名录同步', () => {
  it('两张精简表建立老板员工关系，重排及重新同步不影响绑定和企业跟进状态', () => {
    const grid = (rows: string[][]) => ({ rows: rows.map(row => ({ values: row.map(text => ({ cell_value: { text } })) })) });
    const people = grid([['人员','绑定码','角色'],['老板甲','','老板'],['员工乙','','员工']]);
    const firms = grid([['企业名称'],['企业甲'],['企业乙']]);
    const db = openDb();
    try {
      const first = simpleDirectory(people, firms);
      importDirectory(db, first.employees, first.companies);
      const employee = db.prepare("SELECT * FROM app_user WHERE role='employee'").get()!;
      const boss = db.prepare("SELECT * FROM app_user WHERE role='dept_head'").get()!;
      expect(employee.manager_user_id).toBe(boss.id);
      db.prepare('UPDATE app_user SET wecom_userid=? WHERE id=?').run('bound-test', employee.id);
      const company = db.prepare('SELECT * FROM crm_company LIMIT 1').get()!;
      const content = JSON.parse(String(company.data_json));
      expect(content.ownerId).toBe(employee.id);
      content.relationship = 'serving'; content.nextAction = '继续跟进';
      db.prepare('UPDATE crm_company SET data_json=? WHERE id=?').run(JSON.stringify(content), company.id);
      const reordered = simpleDirectory(grid([['人员','绑定码','角色'],['员工乙','SN-TEST-ONLY','员工'],['老板甲','','老板']]), firms);
      importDirectory(db, reordered.employees, reordered.companies);
      expect(db.prepare('SELECT wecom_userid FROM app_user WHERE id=?').get(employee.id)?.wecom_userid).toBe('bound-test');
      expect(JSON.parse(String(db.prepare('SELECT data_json FROM crm_company WHERE id=?').get(company.id)?.data_json))).toMatchObject({relationship:'serving',nextAction:'继续跟进'});
      expect(() => simpleDirectory(grid([['人员','角色'],['甲','老板'],['乙','老板']]), firms)).toThrow('一位老板');
    } finally { db.close(); }
  });
  it('乱序上级可解析；再次导入保留绑定身份，未变化企业不增加版本', () => {
    const db = openDb();
    try {
      const rows = [staff('RY002', 'RY001'), staff()];
      importDirectory(db, rows, [company()]);
      db.prepare('UPDATE app_user SET wecom_userid=? WHERE id=?').run('bound-test-user', 'directory:user:RY002');
      rows[0]['姓名'] = '更新姓名';
      importDirectory(db, rows, [company()]);
      const row = db.prepare('SELECT * FROM app_user WHERE id=?').get('directory:user:RY002')!;
      expect(row.wecom_userid).toBe('bound-test-user');
      expect(row.name).toBe('更新姓名');
      expect(row.manager_user_id).toBe('directory:user:RY001');
      expect(db.prepare('SELECT version FROM crm_company').get()?.version).toBe(1);
      rows[0]['状态'] = '停用';
      importDirectory(db, rows, [company()]);
      expect(db.prepare('SELECT active FROM app_user WHERE id=?').get('directory:user:RY002')?.active).toBe(0);
    } finally { db.close(); }
  });
  it('拒绝循环、缺失负责人、重复编号，并且不部分写入', () => {
    const db = openDb();
    try {
      const a = { ...staff('A', 'B'), '角色': '组长' };
      const b = { ...staff('B', 'A'), '角色': '组长' };
      expect(() => importDirectory(db, [a, b], [])).toThrow('循环');
      expect(() => importDirectory(db, [staff()], [company('missing')])).toThrow('负责人');
      expect(() => importDirectory(db, [staff(), staff()], [])).toThrow('重复');
      expect(db.prepare('SELECT COUNT(*) AS n FROM app_user').get()?.n).toBe(0);
    } finally { db.close(); }
  });
  it('与已有企业冲突时回滚人员变更；删行不删除本地历史主体', () => {
    const db = openDb();
    try {
      importDirectory(db, [staff()], [company()]);
      const renamed = { ...staff(), '姓名': '不应保存' };
      expect(() => importDirectory(db, [renamed], [{ ...company(), '企业编号': 'QY002' }])).toThrow('同名企业');
      expect(db.prepare('SELECT name FROM app_user').get()?.name).toBe('RY001');
      importDirectory(db, [], []);
      expect(db.prepare('SELECT COUNT(*) AS n FROM crm_company').get()?.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM app_user').get()?.n).toBe(1);
    } finally { db.close(); }
  });
  it('按中文表头定位列，保留文本编号和电话的前导零，拒绝重复表头', () => {
    const cell = (text: string) => ({ cell_value: { text } });
    const headers = [...EMPLOYEE_COLUMNS].reverse();
    const grid = { rows: [{ values: headers.map(cell) }, { values: headers.map(h => cell(h === '员工编号' ? '001' : '内容')) }] };
    expect(tableRows(grid, EMPLOYEE_COLUMNS)[0]['员工编号']).toBe('001');
    grid.rows[0].values.push(cell('员工编号'));
    expect(() => tableRows(grid, EMPLOYEE_COLUMNS)).toThrow('重复');
  });
});
