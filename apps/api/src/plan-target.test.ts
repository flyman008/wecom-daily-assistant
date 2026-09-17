import { expect, it } from 'vitest';
import { planTarget, splitPlanEntry } from './plan-target';
it('自然逗号计划与竖线计划一致，不把背景揉进事项名称',()=>{
  for(const separator of ['，','｜',',',':','：'])expect(splitPlanEntry(`企业走访${separator}计划走访5家企业`)).toEqual({name:'企业走访',planBackground:'计划走访5家企业'});
  expect(splitPlanEntry('企业走访，园区服务')).toEqual({name:'企业走访，园区服务',planBackground:''});
});
it('原表四种目标可直接识别',()=>{
  expect(planTarget('企业走访','计划走访5家企业。A企业设备改造背景')).toEqual({total:5,unit:'家'});
  expect(planTarget('开展活动2场','')).toEqual({total:2,unit:'场'});
  expect(planTarget('梳理合同3项','')).toEqual({total:3,unit:'项'});
  expect(planTarget('业务学习2场','')).toEqual({total:2,unit:'场'});
});
it('不从模糊目标、多个数值或背景事实推断分母',()=>{
  for(const value of ['计划走访约5家','计划走访3到5家','计划走访5家开展活动2场','计划走访0家','计划开展1.5场','对接已有5家客户','计划5家以上']) expect(planTarget('走访',value)).toBeUndefined();
});
