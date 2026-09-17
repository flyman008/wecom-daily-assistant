import { activeUser } from './access';
import type { Db } from './db';
import { filterReadableKnowledge } from './knowledge-access';
import { getDailyReportById, getWeeklyReportById } from './repository';

export interface GeneratedKnowledgeDependency { id: string; version: number }
/** Only the exact stored ID/version contract is accepted; no caller-supplied body or ACL. */
export function parseGeneratedKnowledgeDependencies(value: unknown): GeneratedKnowledgeDependency[] | undefined {
  if (typeof value !== 'string' || value.length > 500_000) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length > 1000) return undefined;
  const result: GeneratedKnowledgeDependency[] = [], ids = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'version'].includes(key))) return undefined;
    const { id, version } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.trim() !== id || id.length > 200 || /[\p{Cc}\p{Cf}]/u.test(id)
      || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || ids.has(id)) return undefined;
    ids.add(id); result.push({ id, version });
  }
  return result;
}

/**
 * Content-derived knowledge grants must still hold for the active report owner
 * in their personal scope, at the exact selected versions. Caller-to-owner
 * authorization remains the caller's responsibility. Legacy missing metadata
 * stays readable for compatibility; this does NOT prove it used no knowledge.
 */
export function isGeneratedReportReadable(db: Db, userId: string, reportId: string, kind: 'daily' | 'weekly', tenantId = 'poc'): boolean {
  if (!['daily', 'weekly'].includes(kind) || typeof userId !== 'string' || typeof reportId !== 'string' || !userId || !reportId) return false;
  const owner = activeUser(db, userId, tenantId);
  if (!owner) return false;
  const report = kind === 'daily' ? getDailyReportById(db, reportId, tenantId) : getWeeklyReportById(db, reportId, tenantId);
  if (!report || report.user_id !== userId) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generated_report_knowledge'").get()) return true;
  // Do not prefilter by user_id: a mismatched stored owner is corrupt metadata,
  // not a legacy report with missing metadata.
  const stored = db.prepare('SELECT user_id,dependencies_json FROM generated_report_knowledge WHERE tenant_id=? AND report_kind=? AND report_id=?')
    .get(tenantId, kind, reportId);
  if (!stored) return true;
  if (stored.user_id !== userId) return false;
  const dependencies = parseGeneratedKnowledgeDependencies(stored.dependencies_json);
  if (!dependencies) return false;
  if (!dependencies.length) return true;
  const allowed = new Map(filterReadableKnowledge(db, { userId, role: owner.role, tenantId },
    dependencies.map(entry => ({ id: entry.id, tenant_id: tenantId })), { view: 'personal' }).map(entry => [entry.id, entry.version]));
  return dependencies.every(entry => allowed.get(entry.id) === entry.version);
}
