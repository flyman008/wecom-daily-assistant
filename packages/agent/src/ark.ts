// 火山方舟 Anthropic-compatible adapter. Credentials are injected from this
// project's environment; this package never reads user-global tool settings.
import type { Agent } from './mock';
import type {
  AgentTaskRequest,
  AgentTaskType,
  AgentStructuredResult,
  DailyExtractResult,
  DailyItemProgress,
  WeeklyReportResult,
} from './contracts';
import { buildAgentPrompt } from './prompt';

export interface ArkConfig {
  model: string;
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export function loadArkConfigFromEnv(env: NodeJS.ProcessEnv = {}): ArkConfig {
  const model = env.ARK_MODEL?.trim() || 'ark-code-latest';
  const baseUrl = (env.ARK_BASE_URL ?? '').trim().replace(/\/$/, '');
  const token = (env.ARK_API_KEY ?? '').trim();
  // Ark coding models can need more than a minute for schema-constrained weekly
  // synthesis. Keep the default below the gateway's 330s stream deadline.
  const timeoutMs = Number(env.ARK_TIMEOUT_MS ?? 180_000);
  const maxTokens = Number(env.ARK_MAX_TOKENS ?? 2_048);
  if (!baseUrl) throw new Error('缺少 ARK_BASE_URL');
  if (!/^https:\/\//i.test(baseUrl) && env.NODE_ENV !== 'test') throw new Error('ARK_BASE_URL 必须使用 HTTPS');
  if (!token) throw new Error('缺少 ARK_API_KEY');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('ARK_TIMEOUT_MS 必须在 1000 到 300000 之间');
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 8_192) {
    throw new Error('ARK_MAX_TOKENS 必须在 256 到 8192 之间');
  }
  return { model, baseUrl, token, timeoutMs, maxTokens };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('模型未返回JSON对象');
  return JSON.parse(candidate.slice(start, end + 1));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label}必须是字符串`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label}必须是字符串数组`);
  return value as string[];
}

function validateDaily(request: AgentTaskRequest, value: unknown): DailyExtractResult {
  const root = record(value, '日报结果');
  if (root.schemaVersion !== 1) throw new Error('日报结果schemaVersion必须为1');
  if (!Array.isArray(root.items)) throw new Error('items必须是数组');
  const allowedItems = new Set((request.context.workItems ?? []).map((item) => item.id));
  const allowedSources = new Set((request.context.sourceRecords ?? []).map((source) => source.id));
  const allowedTypes = request.context.progressTypes ? new Set(request.context.progressTypes) : null;
  const seenItems = new Set<string>();
  if (root.items.length > 128) throw new Error('items数量超过限制');
  const items: DailyItemProgress[] = root.items.map((entry, index) => {
    const item = record(entry, `items[${index}]`);
    const workItemRef = text(item.workItemRef, `items[${index}].workItemRef`, false);
    if (!allowedItems.has(workItemRef)) throw new Error(`items[${index}].workItemRef不在本周事项中`);
    if (seenItems.has(workItemRef)) throw new Error(`items[${index}]包含重复事项，请合并后输出`);
    seenItems.add(workItemRef);
    const progressValue = item.progressValue;
    if (progressValue !== null && (typeof progressValue !== 'number' || !Number.isFinite(progressValue) || progressValue < 0 || progressValue > 100)) {
      throw new Error(`items[${index}].progressValue必须为0到100或null（未知）`);
    }
    const completionKeys = (value: unknown, label: string) => {
      const values = stringArray(value, label);
      if (values.length > 1000 || values.some(key => !key.trim() || key !== key.trim() || key.length > 120 || /[\p{Cc}\p{Cf}]/u.test(key))) throw new Error(`${label}必须是明确、有限的完成事实键`);
      return [...new Set(values)];
    };
    if (item.completedCount !== undefined && item.completedCount !== null && (typeof item.completedCount !== 'number' || !Number.isInteger(item.completedCount) || item.completedCount < 0 || item.completedCount > 1_000_000)) throw new Error(`items[${index}].completedCount必须为非负累计整数或null`);
    const sourceRecordRefs = stringArray(item.sourceRecordRefs, `items[${index}].sourceRecordRefs`);
    if (sourceRecordRefs.some((id) => !allowedSources.has(id))) throw new Error(`items[${index}]引用了未知原始记录`);
    const progressType = text(item.progressType, `items[${index}].progressType`, false);
    if (allowedTypes && !allowedTypes.has(progressType)) throw new Error(`items[${index}].progressType不在已配置类型中`);
    return {
      workItemRef,
      progressText: text(item.progressText, `items[${index}].progressText`),
      progressValue,
      ...(item.completedKeys !== undefined ? { completedKeys: completionKeys(item.completedKeys, `items[${index}].completedKeys`) } : {}),
      ...(item.retractedKeys !== undefined ? { retractedKeys: completionKeys(item.retractedKeys, `items[${index}].retractedKeys`) } : {}),
      ...(item.completedCount !== undefined ? { completedCount: item.completedCount as number | null } : {}),
      progressType,
      issues: stringArray(item.issues, `items[${index}].issues`),
      nextActions: stringArray(item.nextActions, `items[${index}].nextActions`),
      sourceRecordRefs,
    };
  });
  return {
    schemaVersion: 1,
    summary: text(root.summary, 'summary', false),
    items,
    missingFields: stringArray(root.missingFields, 'missingFields'),
    riskFlags: stringArray(root.riskFlags, 'riskFlags'),
  };
}

function validateWeekly(request: AgentTaskRequest, value: unknown): WeeklyReportResult {
  const root = record(value, '周报结果');
  if (root.schemaVersion !== 1) throw new Error('周报结果schemaVersion必须为1');
  if (!Array.isArray(root.sections)) throw new Error('sections必须是数组');
  const allowedReports = new Set((request.context.sourceRecords ?? []).map((source) => source.id));
  const citedReportIds = stringArray(root.citedReportIds, 'citedReportIds');
  if (citedReportIds.some((id) => !allowedReports.has(id))) throw new Error('周报引用了未提供的日报');
  return {
    schemaVersion: 1,
    summary: text(root.summary, 'summary', false),
    sections: root.sections.map((entry, index) => {
      const section = record(entry, `sections[${index}]`);
      return { title: text(section.title, `sections[${index}].title`, false), body: text(section.body, `sections[${index}].body`) };
    }),
    citedReportIds,
  };
}

export function validateAgentResult(
  request: AgentTaskRequest,
  value: unknown,
): AgentStructuredResult {
  switch (request.taskType) {
    case 'daily_record_extract':
    case 'daily_summary_draft':
      return { taskType: request.taskType, result: validateDaily(request, value) };
    case 'weekly_report_generate':
      return { taskType: request.taskType, result: validateWeekly(request, value) };
    case 'manager_feedback_parse': {
      const root = record(value, '反馈结果');
      return {
        taskType: request.taskType,
        result: {
          feedbackText: text(root.feedbackText, 'feedbackText', false),
          targetItemIds: stringArray(root.targetItemIds, 'targetItemIds'),
          toUserRefs: stringArray(root.toUserRefs, 'toUserRefs'),
        },
      };
    }
    case 'quality_review': {
      const root = record(value, '质量检查结果');
      return {
        taskType: request.taskType,
        result: { flags: stringArray(root.flags, 'flags'), suggestedQuestions: stringArray(root.suggestedQuestions, 'suggestedQuestions') },
      };
    }
  }
}

export class ArkAgent implements Agent {
  constructor(
    private readonly config: ArkConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async run(request: AgentTaskRequest, options: { signal?: AbortSignal } = {}): Promise<AgentStructuredResult> {
    const prompt = buildAgentPrompt(request);
    let maxTokens = this.config.maxTokens ?? 2_048;
    // Retry model formatting only, inside one task: never insert another source or confirm a draft.
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted();
      const raw = await this.chat(prompt.system, prompt.user + (attempt ? '\n请重新根据上述原始资料输出完整、合法的JSON对象，不要代码围栏或解释，数组元素必须用逗号分隔。不要省略字段，不要推测原文未提供的事实。' : ''), maxTokens, options.signal);
      options.signal?.throwIfAborted();
      try {
        if (raw.truncated) throw new Error('模型输出达到长度上限');
        return validateAgentResult(request, extractJson(raw.text));
      } catch (error) {
        console.warn(JSON.stringify({event:'ark_output_retry',taskType:request.taskType,attempt:attempt+1,truncated:raw.truncated,maxTokens,exhausted:attempt===2}));
        if (attempt === 2) throw new Error('整理结果格式异常，自动重试后仍未成功。原始内容无需重发。');
        maxTokens = Math.min(8_192, maxTokens * 2);
      }
    }
    throw new Error('整理未完成');
  }

  private async chat(system: string, prompt: string, maxTokens: number, callerSignal?: AbortSignal): Promise<{text:string;truncated:boolean}> {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs ?? 180_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchFn(`${this.config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${this.config.token}`,
        'x-api-key': this.config.token,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Ark请求失败：HTTP ${response.status}`);
    let body: { content?: Array<{ type?: string; text?: string }>; stop_reason?:string };
    try { body = JSON.parse(responseText); }
    catch { return {text:'',truncated:false}; }
    if (!body || !Array.isArray(body.content)) return {text:'',truncated:false};
    const output = (body.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('');
    return {text:output,truncated:body.stop_reason==='max_tokens'};
  }

}
