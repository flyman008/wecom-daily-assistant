import { NewCompanySheets, COMPANY_INPUT_FIELDS, companyKey, newCompanyConfig, searchCompany, visitNames, type NewCompany } from '../../api/src/new-companies';
import {lookupCompany} from '../../api/src/deepseek-company';
import {readProjectEnv} from '../../shared/project-env';

type Pending = {row:NewCompany;expires:number;searchedKeys?:string[]};
export class NewCompanyFlow {
  private pending=new Map<string,Pending>();
  constructor(private sheets=new NewCompanySheets()) {}
  async discover(user:string,name:string,date:string,text:string) {
    if(!newCompanyConfig())return '';
    const names=visitNames(text); if(!names.length)return '';
    const snapshot=await this.sheets.snapshot();
    const known=new Set([...snapshot.companies,...snapshot.fresh].map(r=>companyKey(r['企业名称'])));
    const unknown=names.filter(n=>!known.has(companyKey(n)));
    if(!unknown.length)return '';
    if(this.pending.has(user))return '\n另有企业待核对，请先发送“查看新企业”完成当前企业确认。';
    const firm=unknown[0];
    let source:string,fields:NewCompany={};
    if(readProjectEnv().COMPANY_SEARCH_PROVIDER==='deepseek') {
      try {const found=await lookupCompany(firm);source=found.source;fields=found.fields;}catch{source='网络检索暂不可用。';}
    }else source=await searchCompany(firm);
    this.pending.set(user,{expires:Date.now()+24*3600000,searchedKeys:Object.keys(fields),row:{'企业名称':firm,'主营业务':'','所在地':'',...fields,'拜访员工':name,'拜访日期':date,'需求及跟进':text,'信息来源':source,'确认时间':''}});
    if(Object.keys(fields).length) return '\n\n新企业资料（待核对）\n'+this.companyText(fields)+'\n回复“确认新企业”；有误回复“补充新企业”＋字段。';
    const searchNote=source.startsWith('未检索')?'暂未找到匹配资料':source.startsWith('网络检索')?'搜索暂不可用':'找到待核实线索：'+source.split('\n').slice(0,2).join(' ').slice(0,160);
    return '\n\n新企业：'+firm+'（未在企业名单中）。'+searchNote+'。\n请回复：\n补充新企业\n主营业务：…\n所在地：…\n\n需求已记下，无需重复填；暂不建档回复“取消新企业”。';
  }
  async command(user:string,text:string):Promise<string|null> {
    if(!/^(查看新企业|补充新企业|确认新企业|取消新企业)/.test(text))return null;
    const pending=this.pending.get(user);
    if(!pending||pending.expires<Date.now()){this.pending.delete(user);return '当前没有待确认的新企业，或确认已过期。请重新发送企业拜访记录。';}
    if(text.trim()==='取消新企业'){this.pending.delete(user);return '暂不建档，日报草稿保留。无误回复“确认日报”。';}
    if(text.startsWith('补充新企业')) {
      const previousName=pending.row['企业名称'];
      const supplied=new Set<string>();
      for(const line of text.split('\n').slice(1)) {
        const pair=line.trim().match(/^([^：:]+)[：:]\s*(.+)$/);
        const aliases:Record<string,string>={'行业':'所属行业','注册资金':'注册资本','法人':'法定代表人','法人信息':'法定代表人','联系电话':'联系方式','进展阶段':'跟进阶段'};
        if(pair) {const key=aliases[pair[1]]||pair[1];if(COMPANY_INPUT_FIELDS.includes(key)){pending.row[key]=pair[2]==='清空'?'':pair[2].slice(0,2000);supplied.add(key);}}
      }
      if(previousName!==pending.row['企业名称']) {
        for(const key of pending.searchedKeys||[])if(key!=='企业名称'&&!supplied.has(key))delete pending.row[key];
        pending.searchedKeys=[];
        pending.row['信息来源']='企业名称经员工更正，原检索资料已清除。';
      }
      return this.preview(pending.row);
    }
    if(text.trim()==='查看新企业')return this.preview(pending.row);
    if(text.trim()!=='确认新企业')return '请回复“确认新企业”或“补充新企业”。';
    if(!pending.row['主营业务']||!(pending.row['所在地']||pending.row['注册地址']))return '请先补充主营业务和所在地（或注册地址），核对无误后再确认。';
    pending.row['确认时间']=new Date().toISOString();
    const result=await this.sheets.append(pending.row); this.pending.delete(user);
    return result==='saved'?'新企业资料已确认，已保存到企微“新企业”表。日报仍需单独回复“确认日报”。':result==='old'?'该企业已进入正式企业名单，按老企业处理，不再新增资料。':'该企业已在“新企业”表中，未重复录入。';
  }
  private companyText(row:NewCompany) {
    const parts=[row['企业名称'],row['所属行业']&&('所属行业为'+row['所属行业']),row['主营业务'],row['员工规模']&&('员工规模'+row['员工规模']),row['注册资本']&&('注册资本'+row['注册资本']),row['法定代表人']&&('法定代表人为'+row['法定代表人']),row['注册地址']?('注册地址为'+row['注册地址']):row['所在地']&&('位于'+row['所在地'])];
    return parts.filter(Boolean).map(x=>x.replace(/[。；;]+$/,'')).join('。')+'。';
  }
  private preview(row:NewCompany) {
    const needs=[row['需求及跟进'],...['意向区域','用房需求','预计落地时间','跟进阶段'].filter(k=>row[k]).map(k=>k+'为'+row[k])].filter(Boolean).join('；');
    return '企业情况（待确认）\n'+this.companyText(row)+(needs?'\n\n企业需求\n'+needs:'')+(row['下一步安排']?'\n\n下一步安排\n'+row['下一步安排']:'')+(row['联系人']||row['联系方式']?'\n联系人：'+(row['联系人']||'')+' '+(row['联系方式']||''):'')+'\n\n回复“确认新企业”；修改用“补充新企业”＋字段。';
  }
}
