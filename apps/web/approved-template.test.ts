import {readFileSync} from 'node:fs';
import {Script,runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';

const base=new URL('../../templates/approved/',import.meta.url);
const contract=JSON.parse(readFileSync(new URL('contract.json',base),'utf8'));
const runtime=readFileSync(new URL('reporting.js',import.meta.url),'utf8');
it('运行时分类与客户确认的模板契约一致',()=>{
  expect(runInNewContext(runtime+';JSON.stringify(RP_CATEGORIES)')).toBe(JSON.stringify(contract.categories));
  expect(contract.categoryCardRows).toEqual([1,2,2]);
  expect(runInNewContext(runtime+`;rpTaskName('业务学习')`)).toBe('培训与活动');
  expect(runInNewContext(runtime+`;rpTaskName('综合事务')`)).toBe('综合事务');
  expect(runInNewContext(runtime+`;rpTaskName('临时工作')`)).toBe('其他工作');
});
for(const filename of ['manager-weekly.html','employee-weekly.html'])it(`${filename}自包含且脚本可解析`,()=>{
  const html=readFileSync(new URL(filename,base),'utf8');
  expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/);
  for(const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)){
    if(script[1].includes('application/json'))expect(()=>JSON.parse(script[2])).not.toThrow();
    else expect(()=>new Script(script[2])).not.toThrow();
  }
  expect(html).toContain('已完成');expect(html).toContain('未完成');expect(html).toContain('计划外');
});
