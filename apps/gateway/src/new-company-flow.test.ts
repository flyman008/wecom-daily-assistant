import {it,expect,vi} from 'vitest';
vi.mock('../../shared/project-env',()=>({readProjectEnv:()=>({})}));
vi.mock('../../api/src/new-companies',async importOriginal=>({...await importOriginal<any>(),newCompanyConfig:()=>({url:'configured'}),searchCompany:async()=> '公开搜索候选，须本人核对'}));
import {NewCompanyFlow} from './new-company-flow';
import {NewCompanySheets} from '../../api/src/new-companies';
it('核对补充后才能写企微表，重复确认不重复写；不同员工隔离',async()=>{
 const sheets=new NewCompanySheets();vi.spyOn(sheets,'snapshot').mockResolvedValue({companies:[],fresh:[]});
 const append=vi.spyOn(sheets,'append').mockResolvedValue('saved');const flow=new NewCompanyFlow(sheets);
 expect(await flow.discover('u1','员工甲','2026-09-09','今天拜访了甲乙科技有限公司，了解扩租需求。')).toContain('未在企业名单');
 expect(append).not.toHaveBeenCalled();
 expect(await flow.command('u2','确认新企业')).toContain('没有待确认');
 expect(await flow.command('u1','确认新企业')).toContain('请先补充');
 await flow.command('u1','补充新企业\n主营业务：软件服务\n所在地：上海\n需求及跟进：需要新增办公室');
 expect(await flow.command('u1','确认新企业')).toContain('已保存');
 expect(append).toHaveBeenCalledTimes(1);
 expect(append.mock.calls[0][0]['所在地']).toBe('上海');
 await flow.command('u1','确认新企业');expect(append).toHaveBeenCalledTimes(1);
});
it('正式名单和已存在新企业不重复提出录入',async()=>{
 const sheets=new NewCompanySheets();vi.spyOn(sheets,'snapshot').mockResolvedValue({companies:[{'企业名称':'甲乙科技有限公司'}],fresh:[]});
 expect(await new NewCompanyFlow(sheets).discover('u1','员工甲','2026-09-09','拜访了甲乙科技有限公司')).toBe('');
});
it('支持招商字段与常见叫法，选填可清空，注册地址满足所在地核对',async()=>{
 const sheets=new NewCompanySheets();vi.spyOn(sheets,'snapshot').mockResolvedValue({companies:[],fresh:[]});
 const append=vi.spyOn(sheets,'append').mockResolvedValue('saved');const flow=new NewCompanyFlow(sheets);
 await flow.discover('u1','员工甲','2026-09-09','拜访了甲乙科技有限公司');
 const preview=await flow.command('u1','补充新企业\n主营业务：软件\n注册地址：上海宝山\n行业：软件服务\n注册资金：人民币500万元\n法人：张先生\n员工规模：40人\n意向区域：示例园区\n用房需求：300平方米\n预计落地时间：第四季度\n跟进阶段：初步接洽\n下一步安排：周五看房\n联系电话：123456\n信息来源：恶意覆盖');
 expect(preview).toContain('所属行业为软件服务');expect(preview).not.toContain('恶意覆盖');
 await flow.command('u1','补充新企业\n员工规模：清空');
 expect(await flow.command('u1','确认新企业')).toContain('已保存');
 expect(append.mock.calls[0][0]).toMatchObject({'注册资本':'人民币500万元','员工规模':'','联系方式':'123456','下一步安排':'周五看房'});
});
