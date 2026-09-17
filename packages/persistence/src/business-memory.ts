import type { AccessActor } from './access';
import type { Db } from './db';
import { resolveBusinessReadScope, type BusinessReadOptions } from './knowledge-access';
import { isGeneratedReportReadable } from './generated-report-access';

export interface BusinessMemoryOptions extends BusinessReadOptions {
  query: string;
  limit?: number;
  maxChars?: number;
  fromDate?: string;
  toDate?: string;
}
export interface BusinessMemoryItem {
  sourceId: string;
  sourceType: 'crm_followup' | 'confirmed_daily';
  date: string;
  version: number;
  content: string;
  companyId?: string;
}
export interface BusinessMemoryResult { query: string; items: BusinessMemoryItem[]; truncated: boolean }
const MAX_RESULTS = 20;
const MAX_CHARS = 12_000;
const PER_SOURCE_CHARS = 1_500;
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(maximum, Math.floor(value)));
}
function validDate(value: string | undefined): boolean {
  return value === undefined || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
}
function excerpt(content: string, query: string, budget: number): string {
  if (content.length <= budget) return content;
  if (budget <= 2) return content.slice(0, budget);
  const match = content.toLocaleLowerCase().indexOf(query);
  const start = Math.max(0, match - Math.min(100, Math.floor(budget / 4)));
  const leading = start > 0 ? '…' : '';
  const body = content.slice(start, start + budget - leading.length - 1);
  return `${leading}${body}…`;
}

/**
 * Bounded, explicit retrieval of saved facts. This is not automatic learning.
 * Enterprise sharing never grants access to somebody else's daily report.
 * CRM details_json, linked knowledge snapshots and report progress_json are
 * deliberately excluded: their nested historical fields have independent ACLs.
 */
export function searchBusinessMemory(db: Db, actor: AccessActor, options: BusinessMemoryOptions): BusinessMemoryResult {
  const query = typeof options.query === 'string' ? options.query.trim().normalize('NFKC').toLocaleLowerCase() : '';
  const empty: BusinessMemoryResult = { query, items: [], truncated: false };
  if (!query || query.length > 160 || !validDate(options.fromDate) || !validDate(options.toDate)
    || (options.fromDate && options.toDate && options.fromDate > options.toDate)) return empty;
  const scope = resolveBusinessReadScope(db, actor, { view: options.view, companyId: options.companyId });
  if (!scope || (options.companyId !== undefined && !scope.companyIds.includes(options.companyId))) return empty;
  const limit = bounded(options.limit, 8, MAX_RESULTS);
  const maxChars = bounded(options.maxChars, 6_000, MAX_CHARS);
  const companies = options.companyId === undefined ? scope.companyIds : [options.companyId];
  const params = {
    tenant: scope.tenantId, users: JSON.stringify(scope.userIds), companies: JSON.stringify(companies),
    query, from: options.fromDate ?? '0000-00-00', to: options.toDate ?? '9999-12-31',
  };
  type Candidate = BusinessMemoryItem & { ownerUserId: string | null; derivedReportId: string | null };
  const readability = new Map<string, boolean>();
  const readableCandidates = (values: Iterable<Record<string, unknown>>): BusinessMemoryItem[] => {
    const result: BusinessMemoryItem[] = [];
    for (const value of values) {
      const { ownerUserId, derivedReportId, ...candidate } = value as unknown as Candidate;
      if (derivedReportId !== null) {
        if (!ownerUserId) continue;
        const key = JSON.stringify([ownerUserId, derivedReportId]);
        if (!readability.has(key)) readability.set(key, isGeneratedReportReadable(db, ownerUserId, derivedReportId, 'daily', scope.tenantId));
        if (!readability.get(key)) continue;
      }
      result.push(candidate);
      if (result.length > limit) break;
    }
    return result;
  };
  // SQL first narrows person/company visibility. Stream that ordered candidate
  // set through current knowledge grants before applying the result limit, so
  // revoked new reports cannot crowd out older authorized facts. No LIKE expansion.
  const followups = readableCandidates(db.prepare(`SELECT e.id AS sourceId,'crm_followup' AS sourceType,
      e.occurred_on AS date,1 AS version,e.content,e.company_id AS companyId,
      source.user_id AS ownerUserId,e.source_report_id AS derivedReportId
    FROM crm_event e JOIN crm_company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
    LEFT JOIN daily_report source ON source.id=e.source_report_id AND source.tenant_id=e.tenant_id
    WHERE e.tenant_id=$tenant AND e.kind='followup' AND trim(e.content)<>''
      AND e.company_id IN (SELECT value FROM json_each($companies))
      AND e.occurred_on BETWEEN $from AND $to
      AND (instr(lower(e.content),$query)>0 OR instr(lower(json_extract(CASE WHEN json_valid(c.data_json) THEN c.data_json ELSE '{}' END,'$.name')),$query)>0)
      AND (e.source_report_id IS NULL OR EXISTS (
        SELECT 1 FROM daily_report d WHERE d.tenant_id=e.tenant_id AND d.id=e.source_report_id
          AND d.user_id IN (SELECT value FROM json_each($users)) AND d.status='confirmed' AND d.confirmed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM daily_report newer WHERE newer.tenant_id=d.tenant_id
            AND newer.user_id=d.user_id AND newer.report_date=d.report_date AND newer.status='confirmed' AND newer.version>d.version)
      )) ORDER BY e.occurred_on DESC,e.created_at DESC,e.id`).iterate(params));
  const dailyParams = { ...params, filterCompany: options.companyId === undefined ? 0 : 1 };
  const dailies = readableCandidates(db.prepare(`SELECT d.id AS sourceId,'confirmed_daily' AS sourceType,
      d.report_date AS date,d.version,d.summary AS content,d.user_id AS ownerUserId,d.id AS derivedReportId
    FROM daily_report d WHERE d.tenant_id=$tenant AND d.status='confirmed' AND d.confirmed_at IS NOT NULL
      AND d.user_id IN (SELECT value FROM json_each($users)) AND trim(COALESCE(d.summary,''))<>''
      AND d.report_date BETWEEN $from AND $to AND instr(lower(d.summary),$query)>0
      AND NOT EXISTS (SELECT 1 FROM daily_report newer WHERE newer.tenant_id=d.tenant_id
        AND newer.user_id=d.user_id AND newer.report_date=d.report_date AND newer.status='confirmed' AND newer.version>d.version)
      AND ($filterCompany=0 OR EXISTS (SELECT 1 FROM crm_event e WHERE e.tenant_id=d.tenant_id
        AND e.source_report_id=d.id AND e.company_id IN (SELECT value FROM json_each($companies))))
    ORDER BY d.report_date DESC,d.version DESC,d.id`).iterate(dailyParams));
  const candidates = [...followups, ...dailies].sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version || a.sourceId.localeCompare(b.sourceId));
  const result: BusinessMemoryResult = { query, items: [], truncated: candidates.length > limit };
  let remaining = maxChars;
  for (const candidate of candidates.slice(0, limit)) {
    if (remaining === 0) { result.truncated = true; break; }
    const content = excerpt(candidate.content, query, Math.min(remaining, PER_SOURCE_CHARS));
    if (content !== candidate.content) result.truncated = true;
    result.items.push({ ...candidate, content });
    remaining -= content.length;
  }
  return result;
}
