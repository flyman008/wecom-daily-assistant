import { randomUUID } from 'node:crypto';
import { getConfig, setConfig, insertAudit, type Db } from '@wecom/persistence';
import { importDirectory } from './directory-import';
import { directoryUrl, type DirectoryReader } from './directory-sheet';

export class DirectoryBusyError extends Error {}
export class DirectoryService {
  private busy = false;
  constructor(private db: Db, private reader: DirectoryReader, private fallbackUrl = '') {}
  status() {
    return { url: getConfig(this.db, 'directorySheetUrl', this.fallbackUrl), companyUrl: getConfig(this.db, 'directoryCompanySheetUrl', ''), busy: this.busy,
      lastSync: getConfig<{ at: string; employees: number; companies: number } | null>(this.db, 'directoryLastSync', null),
      employeeColumns: ['人员', '绑定码', '角色'], companyColumns: ['企业名称'] };
  }
  configure(value: unknown, actor: string, companyValue?: unknown) {
    if (this.busy) throw new DirectoryBusyError('正在同步，请完成后再修改链接');
    const url = directoryUrl(value);
    const companyUrl = companyValue === undefined ? this.status().companyUrl : directoryUrl(companyValue);
    if (companyUrl && !url) throw new Error('请同时填写人员和企业表格链接');
    if (url !== this.status().url || companyUrl !== this.status().companyUrl) setConfig(this.db, 'directoryLastSync', null);
    setConfig(this.db, 'directorySheetUrl', url);
    setConfig(this.db, 'directoryCompanySheetUrl', companyUrl);
    this.audit('directory.configured', actor, { configured: Boolean(url) });
    return this.status();
  }
  async sync(actor: string) {
    if (this.busy) throw new DirectoryBusyError('正在同步，请勿重复操作');
    const url = this.status().url;
    if (!url) throw new Error('请先保存名录表格链接');
    this.busy = true;
    try {
      const data = await this.reader(url, this.status().companyUrl || undefined);
      const result = { ...importDirectory(this.db, data.employees, data.companies), at: new Date().toISOString() };
      setConfig(this.db, 'directoryLastSync', result);
      this.audit('directory.synced', actor, result);
      return result;
    } finally { this.busy = false; }
  }
  private audit(action: string, actor: string, details: object) {
    insertAudit(this.db, { id: randomUUID(), action, actor_user_id: actor,
      resource_type: 'directory', resource_id: 'directory', details_json: JSON.stringify(details), created_at: new Date().toISOString() });
  }
}
