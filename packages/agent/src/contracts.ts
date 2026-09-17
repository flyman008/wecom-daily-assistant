// Agent 任务与结构化结果契约，对应方案 §7.3 / §7.4。
// 业务系统通过 HTTP 调用 Agent；这里先定义内存契约，后续映射到 HTTP 边界。

export type AgentTaskType =
  | 'daily_record_extract'
  | 'daily_summary_draft'
  | 'weekly_report_generate'
  | 'manager_feedback_parse'
  | 'quality_review';

export interface WorkItemContext {
  id: string;
  name: string;
  planBackground: string;
  metric?: { mode: 'count' | 'percent'; total: number | null; unit: string; rounding: 'floor' | 'round'; version: number } | null;
}

export interface SourceRecordContext {
  id: string;
  text: string;
  date: string;
}

export interface KnowledgeSnippetContext {
  id: string;
  kind: 'service_company' | 'park_material' | 'policy' | 'guide';
  title: string;
  content: string;
  version: number;
}

export interface AgentTaskRequest {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  tenantId: string;
  taskType: AgentTaskType;
  actor: { role: 'employee' | 'manager' | 'admin'; userRef: string };
  context: {
    timezone: 'Asia/Shanghai';
    weekId?: string;
    workItems?: WorkItemContext[];
    progressTypes?: string[];
    template?: { version: string; content: string };
    sourceRecords?: SourceRecordContext[];
    knowledgeSnippets?: KnowledgeSnippetContext[];
    businessRules?: { progressMode: 'cumulative' | 'incremental' | 'subitem' };
  };
  input: {
    text?: string;
    quotedText?: string;
    attachments?: Array<{ kind: 'image' | 'file' | 'voice_transcript'; name: string; summary: string }>;
  };
}

export interface DailyItemProgress {
  /** Assigned by the business service after validating against the local roster. */
  companyRefs?: Array<{ id: string; name: string }>;
  workItemRef: string;
  progressText: string;
  progressValue: number | null;
  /** Exact source-backed completion identities, never generated indexes or message IDs. */
  completedKeys?: string[];
  retractedKeys?: string[];
  /** Confirmed cumulative count, NOT the day's increment. */
  completedCount?: number | null;
  progressType: string;
  issues: string[];
  nextActions: string[];
  sourceRecordRefs: string[];
}

export interface DailyExtractResult {
  schemaVersion: 1;
  summary: string;
  items: DailyItemProgress[];
  missingFields: string[];
  riskFlags: string[];
}

export interface WeeklyReportResult {
  schemaVersion: 1;
  summary: string;
  sections: Array<{ title: string; body: string }>;
  citedReportIds: string[];
}

export type AgentStructuredResult =
  | { taskType: 'daily_record_extract'; result: DailyExtractResult }
  | { taskType: 'daily_summary_draft'; result: DailyExtractResult }
  | { taskType: 'weekly_report_generate'; result: WeeklyReportResult }
  | { taskType: 'manager_feedback_parse'; result: { feedbackText: string; targetItemIds: string[]; toUserRefs: string[] } }
  | { taskType: 'quality_review'; result: { flags: string[]; suggestedQuestions: string[] } };
