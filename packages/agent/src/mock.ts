// 无模型的确定性 Mock Agent：把输入原样组织成结构化结果，用于先跑通业务闭环。
// 方案 §15：先用 Mock Agent 把「模型效果问题」和「业务系统错误」分开排查。
import type {
  AgentTaskRequest,
  AgentStructuredResult,
  DailyExtractResult,
  WeeklyReportResult,
} from './contracts';

export interface Agent {
  run(request: AgentTaskRequest, options?: { signal?: AbortSignal }): Promise<AgentStructuredResult>;
}

export class MockAgent implements Agent {
  async run(request: AgentTaskRequest): Promise<AgentStructuredResult> {
    switch (request.taskType) {
      case 'daily_record_extract':
        return this.extract(request, 'daily_record_extract');
      case 'daily_summary_draft':
        return this.extract(request, 'daily_summary_draft');
      case 'weekly_report_generate':
        return this.weekly(request);
      case 'manager_feedback_parse':
        return {
          taskType: 'manager_feedback_parse',
          result: { feedbackText: request.input.text ?? '', targetItemIds: [], toUserRefs: [] },
        };
      case 'quality_review':
        return { taskType: 'quality_review', result: { flags: [], suggestedQuestions: [] } };
    }
  }

  private extract(
    request: AgentTaskRequest,
    taskType: 'daily_record_extract' | 'daily_summary_draft',
  ): AgentStructuredResult {
    const text = request.input.text ?? '';
    const workItems = request.context.workItems ?? [];
    const sourceRefs = (request.context.sourceRecords ?? []).map((r) => r.id);
    const percentages = [...text.matchAll(/(?:完成|进度)?\s*(\d{1,3})\s*%/gu)];
    const percentage = percentages.at(-1);
    const progressValue = percentage ? Math.max(0, Math.min(100, Number(percentage[1]))) : null;
    const matchedItems = workItems.filter((item) => text.includes(item.name));
    const selectedItems = matchedItems.length ? matchedItems : workItems.length === 1 ? workItems : [];
    const configuredTypes = request.context.progressTypes ?? ['其他'];
    const progressType = configuredTypes.find(type => type !== '其他' && text.includes(type))
      ?? (configuredTypes.includes('其他') ? '其他' : configuredTypes.length === 1 ? configuredTypes[0] : undefined);
    const result: DailyExtractResult = {
      schemaVersion: 1,
      summary: text ? `[Mock] ${text}` : '[Mock] 无进展',
      items: (progressType ? selectedItems : []).map((wi) => ({
        workItemRef: wi.id,
        progressText: text,
        progressValue,
        progressType: progressType!,
        issues: [],
        nextActions: [],
        sourceRecordRefs: sourceRefs,
      })),
      missingFields: [
        ...(workItems.length > 1 && !matchedItems.length ? ['请明确本条工作对应的事项'] : []),
        ...(!progressType ? ['请从已配置类型中明确本条进展类型'] : []),
      ],
      riskFlags: [],
    };
    return { taskType, result };
  }

  private weekly(request: AgentTaskRequest): AgentStructuredResult {
    const records = request.context.sourceRecords ?? [];
    const workItems = request.context.workItems ?? [];
    const confirmedFacts = records.length
      ? records.map((record) => `${record.date}：${record.text.split('\n')[0]}`).join('\n')
      : '本周暂无已确认日报。';
    let sectionTitles = ['本周计划与进展', '问题与原因', '下周安排', '交流反馈'];
    try {
      const template = JSON.parse(request.context.template?.content ?? '{}') as { sections?: unknown };
      if (Array.isArray(template.sections)) {
        const normalized = template.sections.flatMap((section) => {
          if (typeof section === 'string') return [section];
          if (section && typeof section === 'object' && !Array.isArray(section) && typeof (section as { title?: unknown }).title === 'string') {
            return [(section as { title: string }).title];
          }
          return [];
        });
        if (normalized.length) sectionTitles = normalized;
      }
    } catch {
      // 模板校验由后台负责；Mock保留默认结构，避免演示被异常模板阻断。
    }
    const result: WeeklyReportResult = {
      schemaVersion: 1,
      summary: `[Mock] 本周周报共汇总 ${records.length} 天已确认日报，涉及 ${workItems.length} 项周计划。`,
      sections: sectionTitles.map((title) => ({
        title,
        body: title.includes('计划') || title.includes('进展')
          ? confirmedFacts
          : title.includes('交流') || title.includes('反馈')
            ? '待领导反馈。'
            : '已确认日报中暂无可核实内容。',
      })),
      citedReportIds: records.map((r) => r.id),
    };
    return { taskType: 'weekly_report_generate', result };
  }
}
