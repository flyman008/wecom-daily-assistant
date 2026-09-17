import type { DailyExtractResult, SourceRecordContext } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { CrmStore } from '../../../packages/persistence/src/crm';

/** Directory facts, not LLM guesses. Never creates or changes a company. */
export function matchDailyCompanies(db: repo.Db, userId: string, result: DailyExtractResult, sources: SourceRecordContext[], tenantId = 'poc'): DailyExtractResult {
  const companies = new CrmStore(db, tenantId).companies().filter(company => !company.archived && repo.companyMemberIds(company).includes(userId));
  const sourceMap = new Map(sources.map(source => [source.id, source.text]));
  const questions = [...result.missingFields];
  const items = result.items.map(item => {
    const raw = item.sourceRecordRefs.map(id => sourceMap.get(id) ?? '').join('\n');
    const itemText=[item.progressText,...item.issues,...item.nextActions].join('\n');
    const mentioned = companies.filter(company => {
      const labels = [String(company.name), ...(Array.isArray(company.aliases) ? company.aliases.filter((x): x is string => typeof x === 'string') : [])];
      return labels.some(label => label.length >= 2 && raw.includes(label) && itemText.includes(label)
        && companies.filter(other => other.name === label || Array.isArray(other.aliases) && other.aliases.includes(label)).length === 1);
    });
    const companyRefs = mentioned.map(company => ({ id: company.id, name: String(company.name) }));
    // Generic policy learning / common questions do not imply work for a specific company.
    const specificCompany=/走访|拜访|(?:对接|联系|服务|接待|沟通|协商).{0,12}(?:企业|公司)|(?:企业|公司).{0,12}(?:合同|租金|扩租|需求)|有限公司/u.test(itemText);
    if (!companyRefs.length && specificCompany) questions.push(`“${repo.getWorkItem(db,item.workItemRef,tenantId)?.name??'该事项'}”：请补充企业全称（与企业名录一致），方便关联记录`);
    return { ...item, companyRefs };
  });
  return { ...result, items, missingFields: [...new Set(questions)] };
}

/** Called inside the existing confirmation transaction; repeat confirmation is a no-op. */
export function linkConfirmedCompanies(db: repo.Db, report: repo.DailyReportRow): void {
  const companies = new CrmStore(db, report.tenant_id).companies();
  const items = JSON.parse(report.progress_json ?? '[]') as DailyExtractResult['items'];
  const ids = new Set(items.flatMap(item => (item.companyRefs ?? []).map(company => company.id)));
  for (const id of ids) {
    if (!companies.some(company => company.id === id && !company.archived && repo.companyMemberIds(company).includes(report.user_id))) continue;
    const content = items.filter(item => item.companyRefs?.some(company => company.id === id)).map(item => item.progressText).join('\n');
    db.prepare(`INSERT OR IGNORE INTO crm_event(id,tenant_id,company_id,kind,actor_id,content,occurred_on,source_report_id,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`daily-company:${report.id}:${id}`, report.tenant_id, id, 'daily_report_linked', report.user_id, content, report.report_date, report.id, '{}', new Date().toISOString());
  }
}
