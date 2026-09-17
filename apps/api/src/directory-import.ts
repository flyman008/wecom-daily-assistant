import { inTransaction, type Db } from '@wecom/persistence';

export const EMPLOYEE_COLUMNS = ['员工编号', '姓名', '部门', '角色', '上级员工编号', '状态'];
export const COMPANY_COLUMNS = ['企业编号', '企业名称', '行业', '园区', '负责员工编号', '联系人', '联系电话', '企业概况', '状态'];
type Row = Record<string, string>;

export function tableRows(grid: unknown, columns: string[]): Row[] {
  const rows = (grid as { rows?: Array<{ values?: Array<{ cell_value?: { text?: string; number?: number } }> }> })?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('表格缺少表头');
  const values = rows.map(row => (row.values ?? []).map(cell => {
    const value = cell.cell_value;
    return String(value?.text ?? value?.number ?? '').trim();
  }));
  const header = values[0];
  for (const column of columns) {
    if (header.filter(h => h === column).length !== 1) throw new Error(`表头缺少或重复：${column}`);
  }
  return values.slice(1).filter(row => row.some(Boolean)).map(row => Object.fromEntries(columns.map(column => [column, row[header.indexOf(column)] ?? ''])));
}

function code(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(value)) throw new Error(`${label}须为1—40位字母、数字、下划线或短横线`);
  return value;
}
function unique(rows: Row[], key: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = code(row[key], key);
    if (seen.has(value)) throw new Error(`${key}重复：${value}`);
    seen.add(value);
  }
}

/** The sheet is maintained by staff; only explicit rows are changed, never deleted by omission. */
export function importDirectory(db: Db, employees: Row[], companies: Row[]) {
  unique(employees, '员工编号');
  unique(companies, '企业编号');
  const roles: Record<string, string> = { '员工': 'employee', '组长': 'team_lead', '部门负责人': 'dept_head' };
  const people = new Map(employees.map(row => [row['员工编号'], row]));
  const companyNames = new Set<string>();
  for (const row of employees) {
    if (!row['姓名'] || row['姓名'].length > 60) throw new Error('员工姓名不能为空或超过60字');
    if (!roles[row['角色']]) throw new Error('员工角色只支持：员工、组长、部门负责人；后台管理员在本地维护');
    if (!['启用', '停用'].includes(row['状态'])) throw new Error('员工状态只支持启用、停用');
    const visited = new Set<string>([row['员工编号']]);
    let manager = row['上级员工编号'];
    while (manager) {
      const superior = people.get(manager);
      if (!superior || superior['状态'] !== '启用' || superior['角色'] === '员工') throw new Error('上级必须是表内启用的组长或部门负责人');
      if (visited.has(manager)) throw new Error('汇报关系不能循环');
      visited.add(manager);
      manager = superior['上级员工编号'];
    }
  }
  for (const row of companies) {
    const name = row['企业名称'];
    const key = name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    if (!name || name.length > 120 || companyNames.has(key)) throw new Error('企业名称不能为空、重复或超过120字');
    companyNames.add(key);
    const owner = row['负责员工编号'];
    if (owner && people.get(owner)?.['状态'] !== '启用') throw new Error('企业负责人必须是员工表内启用的员工');
    if (!['潜在', '服务中', '暂停', '退出'].includes(row['状态'])) throw new Error('企业状态只支持潜在、服务中、暂停、退出');
  }

  const userId = (id: string) => `directory:user:${id}`;
  const companyId = (id: string) => `directory:company:${id}`;
  const relations: Record<string, string> = { '潜在': 'prospect', '服务中': 'serving', '暂停': 'paused', '退出': 'exited' };
  return inTransaction(db, () => {
    const now = new Date().toISOString();
    // Separate passes allow the manager to appear after their staff in the sheet.
    for (const row of employees) {
      const id = userId(row['员工编号']);
      const existing = db.prepare('SELECT tenant_id FROM app_user WHERE id=?').get(id);
      if (existing && existing.tenant_id !== 'poc') throw new Error('人员编号冲突');
      db.prepare(`INSERT INTO app_user(id,tenant_id,wecom_userid,name,role,department,active,created_at)
        VALUES(?,'poc',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,
        department=excluded.department,active=excluded.active`).run(id, `pending:${id}`, row['姓名'], roles[row['角色']], row['部门'], row['状态'] === '启用' ? 1 : 0, now);
    }
    for (const row of employees) db.prepare('UPDATE app_user SET manager_user_id=? WHERE tenant_id=? AND id=?')
      .run(row['上级员工编号'] ? userId(row['上级员工编号']) : null, 'poc', userId(row['员工编号']));
    for (const row of companies) {
      const id = companyId(row['企业编号']);
      const old = db.prepare('SELECT data_json FROM crm_company WHERE tenant_id=? AND id=?').get('poc', id);
      const previous = old ? JSON.parse(String(old.data_json)) : {};
      const data = { aliases: [], collaboratorIds: [], operatingStatus: 'unknown', contactRole: '', nextAction: '', nextDate: '', risk: 'none', riskNote: '', archived: false,
        ...previous, name: row['企业名称'], industry: row['行业'], park: row['园区'], ownerId: row['负责员工编号'] ? userId(row['负责员工编号']) : '',
        contactName: row['联系人'], contactPhone: row['联系电话'], summary: row['企业概况'], relationship: relations[row['状态']] };
      // A names-only source must not erase local follow-up assignments or status.
      if (row.__simple === 'true' && old) Object.assign(data, previous, { name: row['企业名称'] });
      const key = data.name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
      const collision = db.prepare('SELECT id FROM crm_company WHERE tenant_id=? AND name_key=? AND id<>?').get('poc', key, id);
      if (collision) throw new Error('本地已有同名企业，请先核对编号，未自动合并');
      if (old && String(old.data_json) === JSON.stringify(data)) continue;
      db.prepare(`INSERT INTO crm_company(id,tenant_id,name_key,data_json,version,is_demo,created_at,updated_at)
        VALUES(?,'poc',?,?,1,0,?,?) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,data_json=excluded.data_json,
        version=crm_company.version+1,updated_at=excluded.updated_at`).run(id, key, JSON.stringify(data), now, now);
    }
    return { employees: employees.length, companies: companies.length };
  });
}
