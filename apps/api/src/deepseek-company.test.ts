import {it,expect} from 'vitest';
import {lookupCompany} from './deepseek-company';
it('成功检索复用并合并并发，返回副本防止员工修改污染缓存',async()=>{
 let calls=0;const base=mock({'企业名称':'上海甲科技有限公司','主营业务':'软件'});
 const fetcher=(async(...args:Parameters<typeof fetch>)=>{calls++;return base(...args);}) as typeof fetch;
 const [a,b]=await Promise.all([lookupCompany('上海甲科技',{OPENAI_COMPATIBLE_API_KEY:'test'},fetcher),lookupCompany('上海甲科技',{OPENAI_COMPATIBLE_API_KEY:'test'},fetcher)]);
 expect(calls).toBe(2);a.fields['主营业务']='更改';expect(b.fields['主营业务']).toBe('软件');
 expect((await lookupCompany('上海甲科技',{OPENAI_COMPATIBLE_API_KEY:'test'},fetcher)).fields['主营业务']).toBe('软件');expect(calls).toBe(2);
});
const mock=(fields:unknown,search=true)=> (async(url:any)=>new Response(JSON.stringify(String(url).endsWith('/chat/completions')?{choices:[{message:{content:JSON.stringify({fields,sources:['https://example.com'],note:'待核对'})}}]}:{status:'completed',output:[...(search?[{type:'web_search_call',status:'completed'}]:[]),{type:'message',content:[{type:'output_text',text:JSON.stringify({fields,sources:['https://example.com'],note:'待核对'})}]}]}))) as typeof fetch;
it('联网完成且同一企业才接受候选字段，不导入联系人或指令',async()=>{
 const r=await lookupCompany('上海甲科技',{OPENAI_COMPATIBLE_API_KEY:'test'},mock({'企业名称':'上海甲科技有限公司','主营业务':'软件','联系人':'不应导入'}));
 expect(r.fields).toEqual({'企业名称':'上海甲科技有限公司','主营业务':'软件'});
 expect((await lookupCompany('上海甲科技',{OPENAI_COMPATIBLE_API_KEY:'test'},mock({'企业名称':'北京甲科技有限公司'}))).fields).toEqual({});
 await expect(lookupCompany('上海甲科技',{OPENAI_COMPATIBLE_API_KEY:'test'},mock({},false))).rejects.toThrow('搜索未完成');
});
