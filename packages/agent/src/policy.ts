import type { AgentTaskRequest, AgentStructuredResult } from './contracts';
import { validateAgentResult } from './ark';
import type { Agent } from './mock';

const LIMITS = {
  id: 200,
  inputText: 100_000,
  sourceText: 20_000,
  totalSourceText: 300_000,
  template: 100_000,
  workItems: 128,
  sources: 366,
  attachments: 32,
  attachmentSummary: 10_000,
  knowledgeSnippets: 12,
  knowledgeText: 12_000,
  totalKnowledgeText: 60_000,
} as const;

function requiredText(value: unknown, label: string, max: number = LIMITS.id): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  if (value.length > max) throw new Error(`${label}超过长度限制`);
}

function optionalText(value: unknown, label: string, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  if (value.length > max) throw new Error(`${label}超过长度限制`);
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
}

function optionalArray(value: unknown, label: string, max: number): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > max) throw new Error(`${label}数量超过限制`);
}

function uniqueIds(values: Array<{ id: string }>, label: string): void {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label}包含重复ID`);
}

/**
 * 模型调用前的确定性门禁。它只校验任务边界与上下文体积，不修改业务事实。
 */
export function validateAgentRequest(request: AgentTaskRequest): void {
  object(request, 'Agent任务');
  if (request.schemaVersion !== 1) throw new Error('Agent任务schemaVersion必须为1');
  if (!['daily_record_extract', 'daily_summary_draft', 'weekly_report_generate', 'manager_feedback_parse', 'quality_review'].includes(request.taskType)) {
    throw new Error('taskType无效');
  }
  object(request.actor, 'actor');
  object(request.context, 'context');
  object(request.input, 'input');
  requiredText(request.requestId, 'requestId');
  requiredText(request.idempotencyKey, 'idempotencyKey');
  requiredText(request.tenantId, 'tenantId');
  requiredText(request.actor?.userRef, 'actor.userRef');
  if (!['employee', 'manager', 'admin'].includes(request.actor?.role)) throw new Error('actor.role无效');
  if (request.context?.timezone !== 'Asia/Shanghai') throw new Error('context.timezone必须为Asia/Shanghai');

  optionalText(request.context.weekId, 'context.weekId', LIMITS.id);
  optionalText(request.input.text, 'input.text', LIMITS.inputText);
  optionalText(request.input.quotedText, 'input.quotedText', LIMITS.inputText);

  optionalArray(request.context.workItems, 'context.workItems', LIMITS.workItems);
  const workItems = request.context.workItems ?? [];
  if (workItems.length > LIMITS.workItems) throw new Error('context.workItems数量超过限制');
  for (const [index, item] of workItems.entries()) {
    object(item, `context.workItems[${index}]`);
    requiredText(item.id, `context.workItems[${index}].id`);
    requiredText(item.name, `context.workItems[${index}].name`, 500);
    optionalText(item.planBackground, `context.workItems[${index}].planBackground`, 10_000);
    if (item.metric != null) {
      const metric = item.metric;
      object(metric, `context.workItems[${index}].metric`);
      if (!['count', 'percent'].includes(metric.mode) || !['floor', 'round'].includes(metric.rounding) || !Number.isInteger(metric.version) || metric.version < 1) throw new Error(`context.workItems[${index}].metric无效`);
      if (metric.mode === 'count' && (typeof metric.total !== 'number' || !Number.isInteger(metric.total) || metric.total <= 0 || metric.total > 1_000_000)
        || metric.mode === 'percent' && metric.total !== null) throw new Error(`context.workItems[${index}].metric总数无效`);
      requiredText(metric.unit, `context.workItems[${index}].metric.unit`, 20);
    }
  }
  uniqueIds(workItems, 'context.workItems');

  optionalArray(request.context.progressTypes, 'context.progressTypes', 20);
  if (request.context.progressTypes) {
    if (!request.context.progressTypes.length) throw new Error('context.progressTypes不能为空');
    for (const type of request.context.progressTypes) {
      requiredText(type, 'context.progressTypes类型', 32);
      if (type.trim() !== type || /[\p{Cc}\p{Cf}]/u.test(type)) throw new Error('context.progressTypes类型无效');
    }
    if (new Set(request.context.progressTypes).size !== request.context.progressTypes.length) throw new Error('context.progressTypes包含重复类型');
  }

  optionalArray(request.context.sourceRecords, 'context.sourceRecords', LIMITS.sources);
  const sources = request.context.sourceRecords ?? [];
  if (sources.length > LIMITS.sources) throw new Error('context.sourceRecords数量超过限制');
  let sourceTextLength = 0;
  for (const [index, source] of sources.entries()) {
    object(source, `context.sourceRecords[${index}]`);
    requiredText(source.id, `context.sourceRecords[${index}].id`);
    if (typeof source.text !== 'string') throw new Error(`context.sourceRecords[${index}].text必须是字符串`);
    optionalText(source.text, `context.sourceRecords[${index}].text`, LIMITS.sourceText);
    requiredText(source.date, `context.sourceRecords[${index}].date`, 40);
    sourceTextLength += source.text.length;
  }
  if (sourceTextLength > LIMITS.totalSourceText) throw new Error('context.sourceRecords总文本超过限制');
  uniqueIds(sources, 'context.sourceRecords');

  optionalArray(request.context.knowledgeSnippets, 'context.knowledgeSnippets', LIMITS.knowledgeSnippets);
  const knowledge = request.context.knowledgeSnippets ?? [];
  if (knowledge.length > LIMITS.knowledgeSnippets) throw new Error('context.knowledgeSnippets数量超过限制');
  let knowledgeTextLength = 0;
  for (const [index, snippet] of knowledge.entries()) {
    object(snippet, `context.knowledgeSnippets[${index}]`);
    requiredText(snippet.id, `context.knowledgeSnippets[${index}].id`);
    requiredText(snippet.title, `context.knowledgeSnippets[${index}].title`, 500);
    if (typeof snippet.content !== 'string') throw new Error(`context.knowledgeSnippets[${index}].content必须是字符串`);
    optionalText(snippet.content, `context.knowledgeSnippets[${index}].content`, LIMITS.knowledgeText);
    if (!['service_company', 'park_material', 'policy', 'guide'].includes(snippet.kind)) {
      throw new Error(`context.knowledgeSnippets[${index}].kind无效`);
    }
    if (!Number.isInteger(snippet.version) || snippet.version < 1) throw new Error(`context.knowledgeSnippets[${index}].version无效`);
    knowledgeTextLength += snippet.content.length;
  }
  if (knowledgeTextLength > LIMITS.totalKnowledgeText) throw new Error('context.knowledgeSnippets总文本超过限制');
  uniqueIds(knowledge, 'context.knowledgeSnippets');

  if (request.context.template) {
    object(request.context.template, 'context.template');
    requiredText(request.context.template.version, 'context.template.version');
    optionalText(request.context.template.content, 'context.template.content', LIMITS.template);
  }
  if (request.context.businessRules && !['cumulative', 'incremental', 'subitem'].includes(request.context.businessRules.progressMode)) {
    throw new Error('context.businessRules.progressMode无效');
  }

  optionalArray(request.input.attachments, 'input.attachments', LIMITS.attachments);
  const attachments = request.input.attachments ?? [];
  if (attachments.length > LIMITS.attachments) throw new Error('input.attachments数量超过限制');
  for (const [index, attachment] of attachments.entries()) {
    object(attachment, `input.attachments[${index}]`);
    if (!['image', 'file', 'voice_transcript'].includes(attachment.kind)) throw new Error(`input.attachments[${index}].kind无效`);
    requiredText(attachment.name, `input.attachments[${index}].name`, 500);
    optionalText(attachment.summary, `input.attachments[${index}].summary`, LIMITS.attachmentSummary);
  }
}

/**
 * 为任意模型实现统一增加输入门禁和输出契约校验。
 */
export class GuardedAgent implements Agent {
  constructor(private readonly delegate: Agent) {}

  async run(request: AgentTaskRequest, options: { signal?: AbortSignal } = {}): Promise<AgentStructuredResult> {
    validateAgentRequest(request);
    const response = await this.delegate.run(request, options);
    if (response.taskType !== request.taskType) throw new Error('Agent返回了错误的任务类型');
    return validateAgentResult(request, response.result);
  }
}
