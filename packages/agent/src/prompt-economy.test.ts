import {it,expect} from 'vitest';
import {buildAgentPrompt} from './prompt';
import type {AgentTaskRequest} from './contracts';
it('重复原文只发送一次，引用及不同输入保留',()=>{
 const req:AgentTaskRequest={schemaVersion:1,requestId:'r',idempotencyKey:'k',tenantId:'t',taskType:'daily_record_extract',actor:{role:'employee',userRef:'u'},context:{timezone:'Asia/Shanghai',sourceRecords:[{id:'s',date:'2026-09-09',text:'唯一原文'}]},input:{text:'唯一原文',quotedText:'引用'}};
 const prompt=buildAgentPrompt(req);expect(prompt.user.split('唯一原文').length-1).toBe(1);expect(prompt.user).toContain('引用');expect(req.input.text).toBe('唯一原文');
 req.input.text='独立指令数据';expect(buildAgentPrompt(req).user).toContain('独立指令数据');
});
