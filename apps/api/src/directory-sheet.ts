import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { COMPANY_COLUMNS, EMPLOYEE_COLUMNS, tableRows } from './directory-import';

export interface DirectoryData { employees: Record<string, string>[]; companies: Record<string, string>[] }
export type DirectoryReader = (url: string, companyUrl?: string) => Promise<DirectoryData>;

export function simpleDirectory(peopleGrid: unknown, companiesGrid: unknown): DirectoryData {
  const people = tableRows(peopleGrid, ['人员', '角色']);
  const firms = tableRows(companiesGrid, ['企业名称']);
  const key = (name: string) => createHash('sha256').update(name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()).digest('hex').slice(0, 24);
  const bosses = people.filter(row => row['角色'] === '老板');
  const staff = people.filter(row => row['角色'] === '员工');
  if (bosses.length !== 1 || staff.length !== 1 || people.length !== 2) throw new Error('当前演示人员表需有一位老板和一位员工');
  const employees = people.map(row => ({ '员工编号': key(row['人员']), '姓名': row['人员'], '部门': '',
    '角色': row['角色'] === '老板' ? '部门负责人' : '员工', '上级员工编号': row['角色'] === '员工' ? key(bosses[0]['人员']) : '', '状态': '启用' }));
  const companies = firms.map(row => ({ '企业编号': key(row['企业名称']), '企业名称': row['企业名称'], '行业': '', '园区': '',
    '负责员工编号': key(staff[0]['人员']), '联系人': '', '联系电话': '', '企业概况': '', '状态': '潜在', __simple: 'true' }));
  return { employees, companies };
}

export function directoryUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请填写普通企微在线表格链接');
  const text = value.trim();
  if (!text) return '';
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('表格链接格式不正确'); }
  if (url.protocol !== 'https:' || url.hostname !== 'doc.weixin.qq.com' || url.username || url.password || url.port || !/^\/sheet\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error('请使用普通企微在线表格链接（包含 /sheet/）');
  }
  return url.toString();
}

export function createDirectoryReader(env: NodeJS.ProcessEnv): DirectoryReader {
  const exec = promisify(execFile);
  const entry = env.WECOM_CLI_ENTRY || path.join(process.env.APPDATA ?? '', 'npm/node_modules/@wecom/cli/bin/wecom.js');
  async function cli(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(process.execPath, [entry, ...args], {
        env: { ...process.env, WECOM_CLI_CONFIG_DIR: path.resolve('.runtime/wecom-cli') },
        windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.trim();
    } catch { throw new Error('企微读取失败，请检查本项目机器人的文档授权和目标表权限'); }
  }
  async function json(args: string[], payload?: object): Promise<any> {
    let result;
    try { result = JSON.parse(await cli([...args, ...(payload ? ['--json', JSON.stringify(payload)] : [])])); }
    catch { throw new Error('企微读取失败，请检查本项目机器人的文档授权和目标表权限'); }
    if (result?.error || (result?.errcode && result.errcode !== 0)) throw new Error('企微读取失败，请检查本项目机器人的文档授权和目标表权限');
    return result;
  }
  async function readTable(link: string, preferredName?: string) {
    const source = new URL(link);
    const docid = decodeURIComponent(source.pathname.split('/')[2]);
    const info = await json(['sheet', 'get'], { docid });
    const sheets = info.sheets ?? [];
    const tab = source.searchParams.get('tab');
    const matches = tab ? sheets.filter((s: any) => s.sheet_id === tab)
      : preferredName ? sheets.filter((s: any) => s.title === preferredName) : sheets;
    if (matches.length !== 1 || !matches[0].data_range) throw new Error('无法确定子表，请复制含 tab 参数的完整表格链接');
    const sheet = matches[0];
    const result = await json(['sheet', 'ranges', 'get'], { docid, sheet_id: sheet.sheet_id, mode: 'default', range: sheet.data_range });
    if (result.truncated_tip) throw new Error('表格内容未完整返回，已停止同步');
    return result.grid_data;
  }
  return async (input, companyInput) => {
    const url = directoryUrl(input);
    const companyUrl = companyInput ? directoryUrl(companyInput) : '';
    if (!url) throw new Error('请先保存名录表格链接');
    if (!existsSync(entry)) throw new Error('没有找到企微文档工具，请检查本地安装');
    if (!env.WECOM_BOT_ID) throw new Error('尚未配置本地机器人');
    const version = (await cli(['--version'])).match(/(\d+)\.(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 1)) throw new Error('需要企微 CLI 1.1.0 及以上');
    if (await cli(['auth', 'show', '--status']) !== 'authorized') throw new Error('本项目机器人的独立文档授权尚未配置');
    const identity = await json(['identity', 'whoami']);
    const actual = String(identity.extra_identity_context ?? '').match(/机器人身份：[\s\S]*?ID：\s*(\S+)/)?.[1];
    if (actual !== env.WECOM_BOT_ID) throw new Error('文档授权与本项目机器人身份不一致，请重新配置');
    if (companyUrl) return simpleDirectory(await readTable(url), await readTable(companyUrl));
    const tables = [];
    for (const [name, columns] of [['员工', EMPLOYEE_COLUMNS], ['企业', COMPANY_COLUMNS]] as const) {
      // Legacy workbook mode chooses tabs by title, not a link's selected tab.
      const legacy = new URL(url); legacy.searchParams.delete('tab');
      tables.push(tableRows(await readTable(legacy.toString(), name), [...columns]));
    }
    return { employees: tables[0], companies: tables[1] };
  };
}
