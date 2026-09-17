import type { Db } from './db';

export interface DailyGenerationState {
  revision: number;
  status: 'running' | 'completed' | 'failed';
  updated_at: string;
}

export interface DailyUserState {
  state_version: number;
  displayed_report_id: string | null;
  editing_report_id: string | null;
  last_confirmed_report_id: string | null;
}

export function getDailyGeneration(db: Db, tenantId: string, userId: string, date: string): DailyGenerationState | undefined {
  return db.prepare(`SELECT revision, status, updated_at FROM daily_generation_state
    WHERE tenant_id=? AND user_id=? AND report_date=?`).get(tenantId, userId, date) as DailyGenerationState | undefined;
}

/** Call in the same transaction as the source-message insert. */
export function beginDailyGeneration(db: Db, tenantId: string, userId: string, date: string, now: string): number {
  db.prepare(`INSERT INTO daily_generation_state (tenant_id, user_id, report_date, revision, status, updated_at)
    VALUES (?, ?, ?, 1, 'running', ?)
    ON CONFLICT(tenant_id, user_id, report_date) DO UPDATE SET
      revision=revision+1, status='running', updated_at=excluded.updated_at`).run(tenantId, userId, date, now);
  return getDailyGeneration(db, tenantId, userId, date)!.revision;
}

export function finishDailyGeneration(
  db: Db, tenantId: string, userId: string, date: string, revision: number,
  status: 'completed' | 'failed', now: string,
): boolean {
  return db.prepare(`UPDATE daily_generation_state SET status=?, updated_at=?
    WHERE tenant_id=? AND user_id=? AND report_date=? AND revision=? AND status='running'`)
    .run(status, now, tenantId, userId, date, revision).changes === 1;
}

export function ensureDailyUserState(db: Db, tenantId: string, userId: string, now: string): void {
  db.prepare(`INSERT OR IGNORE INTO daily_user_state (tenant_id, user_id, updated_at) VALUES (?, ?, ?)`)
    .run(tenantId, userId, now);
}

export function getDailyUserState(db: Db, tenantId: string, userId: string): DailyUserState | undefined {
  return db.prepare(`SELECT state_version, displayed_report_id, editing_report_id, last_confirmed_report_id
    FROM daily_user_state WHERE tenant_id=? AND user_id=?`).get(tenantId, userId) as DailyUserState | undefined;
}
