/** Only one explicit positive integer target; background anecdotes are not targets. */
export function planTarget(name: string, background: string): {total:number;unit:string}|undefined {
  const text = /\d\s*(?:家|场|项|次|份|个)/u.test(name) ? name : background.split(/[。；;\n]/u)[0];
  if (!/计划|目标|本周|走访|活动|开展|梳理|学习|完成/u.test(text) || /已|上周|去年|曾|历史|至少|以上|以下|约|预计|或|至|到|[~～—\-]/u.test(text)) return;
  const matches=[...text.matchAll(/(?<![\d.])([1-9]\d*)\s*(家|场|项|次|份|个)(?!\d)/gu)];
  if(matches.length!==1||Number(matches[0][1])>1_000_000) return;
  return {total:Number(matches[0][1]),unit:matches[0][2]};
}
/** Split explicit plan prose without rewriting existing stored item IDs or history. */
export function splitPlanEntry(entry: string): {name:string;planBackground:string} {
  const parts=entry.trim().split(/[｜|]/u);
  if(parts.length>1) return {name:parts[0].trim(),planBackground:parts.slice(1).join('｜').trim()};
  const match=entry.trim().match(/^(.+?)[，,:：]\s*((?:计划|目标|本周计划)[\s\S]+)$/u);
  return match?{name:match[1].trim(),planBackground:match[2].trim()}:{name:entry.trim(),planBackground:''};
}
