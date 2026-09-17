import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { tableRows } from './directory-import';

export const NEW_COMPANY_COLUMNS = ['企业名称','主营业务','所在地','拜访员工','拜访日期','需求及跟进','信息来源','确认时间','所属行业','员工规模','注册资本','法定代表人','注册地址','意向区域','用房需求','预计落地时间','跟进阶段','下一步安排','联系人','联系方式'];
export const COMPANY_INPUT_FIELDS = NEW_COMPANY_COLUMNS.filter(c=>!['拜访员工','拜访日期','信息来源','确认时间'].includes(c));
export function publicCompany(row:NewCompany):NewCompany {
  return Object.fromEntries(Object.entries(row).filter(([key])=>!['联系人','联系方式','信息来源','确认时间'].includes(key)));
}
export type NewCompany = Record<string,string>;
export const companyKey = (name: string) => name.normalize('NFKC').replace(/\s/g, '').replace(/有限公司$/,'').toLowerCase();
export function visitNames(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:拜访|走访)(?:了)?\s*([^，。；、\n：:]{2,60})/gu)].map(m => m[1].trim()).filter(n => !/^(?:企业\d|\d|企业$|客户$)/u.test(n)))];
}
export function newCompanyConfig() {
  const file = path.resolve('.runtime/new-companies.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as {url:string;companyUrl:string} : null;
}
export class NewCompanySheets {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  async cli(args: string[], payload?: unknown): Promise<any> {
    const entry = this.env.WECOM_CLI_ENTRY || (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm/node_modules/@wecom/cli/bin/wecom.js') : '/usr/local/lib/node_modules/@wecom/cli/bin/wecom.js');
    try {
      const {stdout} = await promisify(execFile)(process.execPath, [entry,...args,...(payload ? ['--json', JSON.stringify(payload)] : [])], {env:{...process.env,...this.env,WECOM_CLI_CONFIG_DIR:path.resolve('.runtime/wecom-cli')},windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
      const result=JSON.parse(stdout); if(result.error || result.errcode) throw Error(); return result;
    } catch { throw new Error('企微企业表暂时无法访问，请稍后重试。'); }
  }
  async table(url: string, columns: string[]) {
    const link=new URL(url); if(link.hostname!=='doc.weixin.qq.com'||!link.pathname.startsWith('/sheet/'))throw Error('企业表链接无效');
    const docid=decodeURIComponent(link.pathname.split('/')[2]);
    const info=await this.cli(['sheet','get'],{docid});
    const matches=info.sheets.filter((s:any)=>!link.searchParams.get('tab')||s.sheet_id===link.searchParams.get('tab'));
    if(matches.length!==1)throw Error('请指定企业表子表');
    const sheet=matches[0];
    const data=await this.cli(['sheet','ranges','get'],{docid,sheet_id:sheet.sheet_id,mode:'default',range:sheet.data_range});
    if(data.truncated_tip)throw Error('企业表未完整读取');
    const headers=(data.grid_data.rows[0].values||[]).map((c:any)=>String(c.cell_value?.text||'').trim());
    return {docid,sheet_id:sheet.sheet_id,headers,rows:tableRows(data.grid_data,columns)};
  }
  async snapshot() {
    const config=newCompanyConfig(); if(!config)return {companies:[],fresh:[]};
    const [old,fresh]=await Promise.all([this.table(config.companyUrl,['企业名称']),this.table(config.url,NEW_COMPANY_COLUMNS)]);
    const names=new Set(old.rows.map(r=>companyKey(r['企业名称'])));
    return {companies:old.rows,fresh:fresh.rows.filter(r=>!names.has(companyKey(r['企业名称'])))};
  }
  private tail:Promise<unknown>=Promise.resolve();
  async append(row:NewCompany) {
    const job=this.tail.catch(()=>{}).then(async()=>{
      const config=newCompanyConfig();if(!config)throw Error('尚未配置新企业表');
      const old=await this.table(config.companyUrl,['企业名称']);
      if(old.rows.some(r=>companyKey(r['企业名称'])===companyKey(row['企业名称'])))return 'old';
      const fresh=await this.table(config.url,NEW_COMPANY_COLUMNS);
      if(fresh.rows.some(r=>companyKey(r['企业名称'])===companyKey(row['企业名称'])))return 'exists';
      await this.cli(['sheet','rows','append'],{docid:fresh.docid,sheet_id:fresh.sheet_id,row:{values:fresh.headers.map((c:string)=>({cell_value:{text:row[c]||''},cell_format:{}}))}});
      return 'saved';
    });this.tail=job;return job;
  }
}
export async function searchCompany(name:string):Promise<string> {
  let successful=0;
  for(const query of ['"'+name+'"',name+' 公司']) try {
    const res=await fetch('https://www.bing.com/search?format=rss&mkt=zh-CN&setlang=zh-hans&q='+encodeURIComponent(query),{signal:AbortSignal.timeout(7000)});
    if(!res.ok)throw Error(); const xml=await res.text();
    if(!/<rss[\s>]/i.test(xml))throw Error('not rss');
    successful++;
    const decode=(s:string)=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const term=name.replace(/^(?:上海市?|北京市?|深圳市?)/,'').replace(/(?:股份)?有限公司$/,'');
    const results=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>{
      const title=decode(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]||'');
      const link=decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1]||'');
      const description=decode(m[1].match(/<description>([\s\S]*?)<\/description>/)?.[1]||'');
      return term.length>=2&&(title+description).includes(term)&&/^https?:\/\//.test(link)?title+'\n'+description.slice(0,400)+'\n'+link:'';
    }).filter(Boolean).slice(0,3);
    if(results.length)return results.join('\n\n');
  }catch { /* Retry once; never mistake an outage for no matching company. */ }
  return successful?'未检索到可靠候选。':'网络检索暂不可用。';
}
