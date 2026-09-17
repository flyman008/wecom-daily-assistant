import { describe,it,expect,vi,afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { visitNames,companyKey,searchCompany,NewCompanySheets,publicCompany } from './new-companies';
afterEach(()=>vi.unstubAllGlobals());
it('搜索无匹配时重查一次，网络异常区别提示',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,text:async()=>'<rss></rss>'});vi.stubGlobal('fetch',fetcher);
 expect(await searchCompany('示例甲信息科技')).toContain('未检索');expect(fetcher).toHaveBeenCalledTimes(2);
 fetcher.mockRejectedValue(Error('network'));expect(await searchCompany('示例甲信息科技')).toContain('暂不可用');
});
it('周报不返回联系人联系方式和来源审计字段',()=>{
 expect(publicCompany({'企业名称':'甲','联系人':'张','联系方式':'123','信息来源':'source','确认时间':'now','主营业务':'软件'})).toEqual({'企业名称':'甲','主营业务':'软件'});
});
describe('新企业识别和检索',()=>{
  it('提取拜访名称，不把计数当企业',()=>{expect(visitNames('今天拜访了上海某某有限公司，了解扩租需求。')).toEqual(['上海某某有限公司']);expect(visitNames('走访5家企业')).toEqual([]);expect(companyKey('Ａ 企业')).toBe('a企业');});
  it('过滤与企业名称无关的搜索结果',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,text:async()=>'<rss><item><title>无关房产</title><link>https://example.com</link></item></rss>'}));expect(await searchCompany('上海某某有限公司')).toContain('未检索到可靠候选');});
  it('保留搜索来源但不认定身份',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,text:async()=>'<rss><item><title>某某有限公司主页</title><description>某某主营软件</description><link>https://example.com</link></item></rss>'}));expect(await searchCompany('上海某某有限公司')).toContain('https://example.com');});
  it('名单读取失败不返回过期新企业',async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'company-test-'));
    mkdirSync(path.join(dir,'.runtime'));
    writeFileSync(path.join(dir,'.runtime/new-companies.json'),JSON.stringify({url:'https://doc.weixin.qq.com/sheet/test-new',companyUrl:'https://doc.weixin.qq.com/sheet/test-old'}));
    const cwd=vi.spyOn(process,'cwd').mockReturnValue(dir);
    try {
      const service=new NewCompanySheets();
      vi.spyOn(service,'table').mockRejectedValue(Error('offline'));
      await expect(service.snapshot()).rejects.toThrow('offline');
    } finally { cwd.mockRestore(); rmSync(dir,{recursive:true,force:true}); }
  });
});
