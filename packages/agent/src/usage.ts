import {appendFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
/** Operational metadata only: never record prompts, outputs, people, or credentials. */
export function recordModelUsage(task:string,model:string,usage:any,attempt=1) {
  const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
  try {
    const dir=path.resolve('.runtime/metrics');mkdirSync(dir,{recursive:true});
    appendFileSync(path.join(dir,'model-usage.jsonl'),JSON.stringify({time:new Date().toISOString(),task,model,attempt,inputTokens:number(usage?.prompt_tokens??usage?.input_tokens),outputTokens:number(usage?.completion_tokens??usage?.output_tokens),cachedTokens:number(usage?.prompt_cache_hit_tokens??usage?.input_tokens_details?.cached_tokens),totalTokens:number(usage?.total_tokens)})+'\n');
  }catch { /* Telemetry must not interrupt confirmation workflows. */ }
}
