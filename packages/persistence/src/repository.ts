import type { DailyReportStatus, Role } from '@wecom/domain';
import type { Db } from './db';

const TENANT = 'poc';

export interface UserRow {
  id: string;
  tenant_id: string;
  wecom_userid: string;
  name: string;
  role: Role;
  manager_user_id: string | null;
  active: number;
  created_at: string;
  department: string;
}

export interface ActivationCodeRow {
  id: string;
  tenant_id: string;
  user_id: string;
  code_hash: string;
  expires_at: string;
  pending_wecom_userid: string | null;
  verified_at: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type KnowledgeKind = 'service_company' | 'park_material' | 'policy' | 'guide';

export interface KnowledgeEntryRow {
  id: string;
  tenant_id: string;
  kind: KnowledgeKind;
  title: string;
  summary: string;
  content: string;
  tags_json: string;
  source_name: string;
  active: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemRow {
  id: string;
  tenant_id: string;
  user_id: string;
  week_id: string;
  name: string;
  plan_background: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}

export interface WorkItemRevisionRow {
  id: string;
  tenant_id: string;
  work_item_id: string;
  version: number;
  change_type: 'created' | 'updated' | 'deleted';
  name: string;
  plan_background: string;
  actor_user_id: string | null;
  created_at: string;
}

export interface SourceMessageRow {
  id: string;
  tenant_id: string;
  msg_id: string;
  user_id: string;
  report_date: string;
  content_type: string;
  text_content: string;
  quoted_text: string | null;
  attachments_json: string;
  process_status: string;
  process_error: string | null;
  daily_report_id: string | null;
  created_at: string;
}

export interface DailyReportRow {
  id: string;
  tenant_id: string;
  user_id: string;
  report_date: string;
  version: number;
  generation_revision: number;
  status: DailyReportStatus;
  summary: string | null;
  progress_json: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeeklyReportRow {
  id: string;
  tenant_id: string;
  user_id: string;
  week_id: string;
  version: number;
  template_version: string;
  content: string;
  sections_json: string;
  cited_report_ids_json: string;
  item_snapshot_json: string;
  missing_days_json: string;
  generated_at: string;
}

export interface FeedbackRow {
  id: string;
  tenant_id: string;
  weekly_report_id: string;
  work_item_id: string | null;
  manager_user_id: string;
  to_user_id: string;
  content: string;
  read_at: string | null;
  created_at: string;
}

export interface AccessGrantRow {
  id: string;
  tenant_id: string;
  token_hash: string;
  user_id: string;
  resource_type: 'weekly_report';
  resource_id: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface AuthSessionRow {
  token_hash: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  resource_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  kind: string;
  dedupe_key: string;
  target_user_id: string;
  payload_json: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface TemplateRow {
  id: string;
  tenant_id: string;
  kind: 'daily' | 'weekly';
  name: string;
  version: number;
  content: string;
  active: number;
  created_at: string;
}

export function upsertUser(
  db: Db,
  row: { id: string; wecom_userid?: string; name?: string; role?: Role; manager_user_id?: string | null; department?: string; tenant_id?: string },
): UserRow {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_user (id, tenant_id, wecom_userid, name, role, manager_user_id, active, created_at, department)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      wecom_userid=excluded.wecom_userid,
      name=excluded.name,
      role=excluded.role,
      manager_user_id=excluded.manager_user_id,
      department=excluded.department,
      active=1
  `).run(
    row.id,
    row.tenant_id ?? TENANT,
    row.wecom_userid ?? row.id,
    row.name ?? row.id,
    row.role ?? 'employee',
    row.manager_user_id ?? null,
    now,
    row.department ?? '',
  );
  return getUser(db, row.id, row.tenant_id ?? TENANT)!;
}

export function getUser(db: Db, id: string, tenantId = TENANT): UserRow | undefined {
  return db.prepare('SELECT * FROM app_user WHERE tenant_id = ? AND id = ?').get(tenantId, id) as unknown as UserRow | undefined;
}

export function getUserByWecomUserid(db: Db, wecomUserid: string, tenantId = TENANT): UserRow | undefined {
  return db.prepare('SELECT * FROM app_user WHERE tenant_id = ? AND wecom_userid = ? AND active = 1')
    .get(tenantId, wecomUserid) as unknown as UserRow | undefined;
}

export function isUserBound(user: UserRow): boolean {
  return !user.wecom_userid.startsWith('pending:');
}

export function listUsers(db: Db, tenantId = TENANT): UserRow[] {
  return db.prepare('SELECT * FROM app_user WHERE tenant_id = ? AND active = 1 ORDER BY name').all(tenantId) as unknown as UserRow[];
}

export function countDirectReports(db: Db, managerUserId: string, tenantId = TENANT): number {
  const row = db.prepare(`
    SELECT COUNT(1) AS count
    FROM app_user
    WHERE tenant_id = ? AND active = 1 AND manager_user_id = ?
  `).get(tenantId, managerUserId) as { count: number };
  return row.count;
}

export function updateUserAssignment(
  db: Db,
  userId: string,
  role: Role,
  managerUserId: string | null,
  tenantId = TENANT,
  displayName?: string,
  department?: string,
): UserRow | undefined {
  db.prepare(`
    UPDATE app_user
    SET role = ?, manager_user_id = ?, name = COALESCE(?, name), department = COALESCE(?, department)
    WHERE tenant_id = ? AND id = ? AND active = 1
  `).run(role, managerUserId, displayName ?? null, department ?? null, tenantId, userId);
  return getUser(db, userId, tenantId);
}

export function createActivationCode(
  db: Db,
  row: { id: string; user_id: string; code_hash: string; expires_at: string; created_at: string; tenant_id?: string },
): ActivationCodeRow {
  const tenantId = row.tenant_id ?? TENANT;
  db.prepare(`UPDATE user_activation_code SET revoked_at=? WHERE tenant_id=? AND user_id=? AND used_at IS NULL AND revoked_at IS NULL`)
    .run(row.created_at, tenantId, row.user_id);
  db.prepare(`
    INSERT INTO user_activation_code
      (id, tenant_id, user_id, code_hash, expires_at, pending_wecom_userid, verified_at, used_at, revoked_at, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
  `).run(row.id, tenantId, row.user_id, row.code_hash, row.expires_at, row.created_at);
  return getActivationCodeById(db, row.id, tenantId)!;
}

export function getActivationCodeById(db: Db, id: string, tenantId = TENANT): ActivationCodeRow | undefined {
  return db.prepare('SELECT * FROM user_activation_code WHERE tenant_id=? AND id=?')
    .get(tenantId, id) as unknown as ActivationCodeRow | undefined;
}

export function getLatestActivationCode(db: Db, userId: string, tenantId = TENANT): ActivationCodeRow | undefined {
  return db.prepare('SELECT * FROM user_activation_code WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, userId) as unknown as ActivationCodeRow | undefined;
}

export function claimActivationCode(
  db: Db,
  codeHash: string,
  wecomUserid: string,
  now: string,
  tenantId = TENANT,
): ActivationCodeRow | undefined {
  const staleBefore = new Date(Date.parse(now) - 10 * 60_000).toISOString();
  const result = db.prepare(`
    UPDATE user_activation_code
    SET pending_wecom_userid=?, verified_at=?
    WHERE tenant_id=? AND code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?
      AND (pending_wecom_userid IS NULL OR pending_wecom_userid=? OR verified_at<=?)
  `).run(wecomUserid, now, tenantId, codeHash, now, wecomUserid, staleBefore);
  if (result.changes !== 1) return undefined;
  return db.prepare('SELECT * FROM user_activation_code WHERE tenant_id=? AND code_hash=?')
    .get(tenantId, codeHash) as unknown as ActivationCodeRow;
}

export function cancelActivationClaim(db: Db, id: string, wecomUserid: string, tenantId = TENANT): void {
  db.prepare(`
    UPDATE user_activation_code SET pending_wecom_userid=NULL, verified_at=NULL
    WHERE tenant_id=? AND id=? AND pending_wecom_userid=? AND used_at IS NULL AND revoked_at IS NULL
  `).run(tenantId, id, wecomUserid);
}

export function bindActivationCode(db: Db, id: string, wecomUserid: string, now: string, tenantId = TENANT): UserRow {
  const code = getActivationCodeById(db, id, tenantId);
  if (!code || code.pending_wecom_userid !== wecomUserid || code.used_at || code.revoked_at || code.expires_at <= now) {
    throw new Error('绑定确认已失效，请重新输入绑定码');
  }
  const occupied = getUserByWecomUserid(db, wecomUserid, tenantId);
  if (occupied && occupied.id !== code.user_id) throw new Error('该企微账号已绑定其他人员');
  db.prepare('UPDATE app_user SET wecom_userid=? WHERE tenant_id=? AND id=? AND active=1')
    .run(wecomUserid, tenantId, code.user_id);
  db.prepare('UPDATE user_activation_code SET used_at=? WHERE tenant_id=? AND id=?').run(now, tenantId, id);
  clearBindingFailures(db, wecomUserid, tenantId);
  return getUser(db, code.user_id, tenantId)!;
}

export function unbindUser(db: Db, userId: string, tenantId = TENANT): UserRow | undefined {
  db.prepare('UPDATE app_user SET wecom_userid=? WHERE tenant_id=? AND id=? AND active=1')
    .run(`pending:${userId}`, tenantId, userId);
  return getUser(db, userId, tenantId);
}

export function getBindingLock(db: Db, wecomUserid: string, now: string, tenantId = TENANT): string | undefined {
  const row = db.prepare('SELECT locked_until FROM binding_attempt WHERE tenant_id=? AND wecom_userid=?')
    .get(tenantId, wecomUserid) as { locked_until: string | null } | undefined;
  return row?.locked_until && row.locked_until > now ? row.locked_until : undefined;
}

export function registerBindingFailure(db: Db, wecomUserid: string, now: string, tenantId = TENANT): string | null {
  const existing = db.prepare('SELECT failed_count FROM binding_attempt WHERE tenant_id=? AND wecom_userid=?')
    .get(tenantId, wecomUserid) as { failed_count: number } | undefined;
  const failedCount = (existing?.failed_count ?? 0) + 1;
  const lockedUntil = failedCount >= 5 ? new Date(Date.parse(now) + 15 * 60_000).toISOString() : null;
  db.prepare(`
    INSERT INTO binding_attempt (tenant_id, wecom_userid, failed_count, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, wecom_userid) DO UPDATE SET
      failed_count=excluded.failed_count, locked_until=excluded.locked_until, updated_at=excluded.updated_at
  `).run(tenantId, wecomUserid, lockedUntil ? 0 : failedCount, lockedUntil, now);
  return lockedUntil;
}

export function clearBindingFailures(db: Db, wecomUserid: string, tenantId = TENANT): void {
  db.prepare('DELETE FROM binding_attempt WHERE tenant_id=? AND wecom_userid=?').run(tenantId, wecomUserid);
}

export function insertWorkItem(
  db: Db,
  row: Omit<WorkItemRow, 'tenant_id' | 'version' | 'updated_at'> & {
    tenant_id?: string;
    version?: number;
    updated_at?: string;
    actor_user_id?: string | null;
  },
): void {
  const tenantId = row.tenant_id ?? TENANT;
  const version = row.version ?? 1;
  const updatedAt = row.updated_at ?? row.created_at;
  db.prepare(`
    INSERT INTO work_item (id, tenant_id, user_id, week_id, name, plan_background, version, created_at, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, tenantId, row.user_id, row.week_id, row.name, row.plan_background, version, row.created_at, updatedAt, row.deleted);
  insertWorkItemRevision(db, {
    id: `${row.id}:v${version}`,
    tenant_id: tenantId,
    work_item_id: row.id,
    version,
    change_type: 'created',
    name: row.name,
    plan_background: row.plan_background,
    actor_user_id: row.actor_user_id ?? row.user_id,
    created_at: row.created_at,
  });
}

export function listWorkItems(db: Db, userId: string, weekId: string, tenantId = TENANT): WorkItemRow[] {
  return db.prepare(`
    SELECT * FROM work_item
    WHERE tenant_id = ? AND user_id = ? AND week_id = ? AND deleted = 0
    ORDER BY created_at, id
  `).all(tenantId, userId, weekId) as unknown as WorkItemRow[];
}

export function getWorkItem(db: Db, id: string, tenantId = TENANT): WorkItemRow | undefined {
  return db.prepare('SELECT * FROM work_item WHERE tenant_id = ? AND id = ?').get(tenantId, id) as unknown as WorkItemRow | undefined;
}

function insertWorkItemRevision(db: Db, row: WorkItemRevisionRow): void {
  db.prepare(`
    INSERT INTO work_item_revision
      (id, tenant_id, work_item_id, version, change_type, name, plan_background, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id, row.work_item_id, row.version, row.change_type,
    row.name, row.plan_background, row.actor_user_id, row.created_at,
  );
}

export function updateWorkItem(
  db: Db,
  row: WorkItemRow,
  expectedVersion: number,
  values: { name: string; plan_background: string; actor_user_id?: string | null; updated_at: string },
): WorkItemRow {
  const nextVersion = expectedVersion + 1;
  const result = db.prepare(`
    UPDATE work_item SET name=?, plan_background=?, version=?, updated_at=?
    WHERE tenant_id=? AND id=? AND version=? AND deleted=0
  `).run(values.name, values.plan_background, nextVersion, values.updated_at, row.tenant_id, row.id, expectedVersion);
  if (Number(result.changes) !== 1) throw new Error('事项已被其他操作修改，请刷新后重试');
  insertWorkItemRevision(db, {
    id: `${row.id}:v${nextVersion}`,
    tenant_id: row.tenant_id,
    work_item_id: row.id,
    version: nextVersion,
    change_type: 'updated',
    name: values.name,
    plan_background: values.plan_background,
    actor_user_id: values.actor_user_id ?? null,
    created_at: values.updated_at,
  });
  return getWorkItem(db, row.id, row.tenant_id)!;
}

export function deleteWorkItem(
  db: Db,
  row: WorkItemRow,
  expectedVersion: number,
  actorUserId: string | null,
  updatedAt: string,
): void {
  const nextVersion = expectedVersion + 1;
  const result = db.prepare(`
    UPDATE work_item SET deleted=1, version=?, updated_at=?
    WHERE tenant_id=? AND id=? AND version=? AND deleted=0
  `).run(nextVersion, updatedAt, row.tenant_id, row.id, expectedVersion);
  if (Number(result.changes) !== 1) throw new Error('事项已被其他操作修改，请刷新后重试');
  insertWorkItemRevision(db, {
    id: `${row.id}:v${nextVersion}`,
    tenant_id: row.tenant_id,
    work_item_id: row.id,
    version: nextVersion,
    change_type: 'deleted',
    name: row.name,
    plan_background: row.plan_background,
    actor_user_id: actorUserId,
    created_at: updatedAt,
  });
}

export function listWorkItemRevisions(db: Db, workItemId: string, tenantId = TENANT): WorkItemRevisionRow[] {
  return db.prepare(`
    SELECT * FROM work_item_revision WHERE tenant_id=? AND work_item_id=? ORDER BY version
  `).all(tenantId, workItemId) as unknown as WorkItemRevisionRow[];
}

export function insertSourceMessage(
  db: Db,
  row: Omit<SourceMessageRow, 'tenant_id'> & { tenant_id?: string },
): { row: SourceMessageRow; inserted: boolean } {
  const tenantId = row.tenant_id ?? TENANT;
  db.prepare(`
    INSERT OR IGNORE INTO source_message
      (id, tenant_id, msg_id, user_id, report_date, content_type, text_content, quoted_text,
       attachments_json, process_status, process_error, daily_report_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, tenantId, row.msg_id, row.user_id, row.report_date, row.content_type,
    row.text_content, row.quoted_text, row.attachments_json, row.process_status,
    row.process_error, row.daily_report_id, row.created_at,
  );
  const found = getSourceMessageByMsgId(db, row.msg_id, tenantId);
  if (!found) throw new Error('原始消息写入失败');
  return { row: found, inserted: found.id === row.id };
}

export function getSourceMessageByMsgId(db: Db, msgId: string, tenantId = TENANT): SourceMessageRow | undefined {
  return db.prepare('SELECT * FROM source_message WHERE tenant_id = ? AND msg_id = ?').get(tenantId, msgId) as unknown as SourceMessageRow | undefined;
}

export function listSourceMessages(db: Db, userId: string, reportDate: string, tenantId = TENANT): SourceMessageRow[] {
  return db.prepare(`
    SELECT * FROM source_message
    WHERE tenant_id = ? AND user_id = ? AND report_date = ?
    ORDER BY created_at, id
  `).all(tenantId, userId, reportDate) as unknown as SourceMessageRow[];
}

export function updateSourceMessageResult(
  db: Db,
  id: string,
  status: 'processed' | 'agent_failed',
  dailyReportId: string | null,
  error: string | null,
): void {
  db.prepare(`UPDATE source_message SET process_status = ?, daily_report_id = ?, process_error = ? WHERE id = ?`)
    .run(status, dailyReportId, error, id);
}

export function insertDailyReport(db: Db, row: Omit<DailyReportRow, 'tenant_id' | 'updated_at' | 'generation_revision'> & { tenant_id?: string; updated_at?: string; generation_revision?: number }): void {
  db.prepare(`
    INSERT INTO daily_report
      (id, tenant_id, user_id, report_date, version, status, summary, progress_json,
       confirmed_at, created_at, updated_at, generation_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id ?? TENANT, row.user_id, row.report_date, row.version, row.status,
    row.summary, row.progress_json, row.confirmed_at, row.created_at, row.updated_at ?? row.created_at, row.generation_revision ?? 0,
  );
}

export function getLatestDailyReport(db: Db, userId: string, reportDate: string, tenantId = TENANT): DailyReportRow | undefined {
  return db.prepare(`
    SELECT * FROM daily_report
    WHERE tenant_id = ? AND user_id = ? AND report_date = ?
    ORDER BY version DESC LIMIT 1
  `).get(tenantId, userId, reportDate) as unknown as DailyReportRow | undefined;
}

export function getDailyReportById(db: Db, id: string, tenantId = TENANT): DailyReportRow | undefined {
  return db.prepare('SELECT * FROM daily_report WHERE tenant_id = ? AND id = ?').get(tenantId, id) as unknown as DailyReportRow | undefined;
}

export function updateDailyReportStatus(db: Db, id: string, status: DailyReportStatus, confirmedAt?: string): void {
  db.prepare('UPDATE daily_report SET status = ?, confirmed_at = COALESCE(?, confirmed_at), updated_at = ? WHERE id = ?')
    .run(status, confirmedAt ?? null, new Date().toISOString(), id);
}

export function linkReportSource(db: Db, reportId: string, sourceId: string): void {
  db.prepare('INSERT OR IGNORE INTO daily_report_source (daily_report_id, source_message_id) VALUES (?, ?)')
    .run(reportId, sourceId);
}

export function listDailyReportsInRange(db: Db, userId: string, fromDate: string, toDate: string, tenantId = TENANT): DailyReportRow[] {
  return db.prepare(`
    SELECT * FROM daily_report
    WHERE tenant_id = ? AND user_id = ? AND report_date >= ? AND report_date <= ?
    ORDER BY report_date, version
  `).all(tenantId, userId, fromDate, toDate) as unknown as DailyReportRow[];
}

export function insertWeeklyReport(db: Db, row: Omit<WeeklyReportRow, 'tenant_id' | 'version' | 'sections_json' | 'cited_report_ids_json' | 'item_snapshot_json'> & {
  tenant_id?: string;
  version?: number;
  sections_json?: string;
  cited_report_ids_json?: string;
  item_snapshot_json?: string;
}): void {
  db.prepare(`
    INSERT INTO weekly_report
      (id, tenant_id, user_id, week_id, version, template_version, content, sections_json,
       cited_report_ids_json, item_snapshot_json, missing_days_json, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id ?? TENANT, row.user_id, row.week_id, row.version ?? 1,
    row.template_version, row.content, row.sections_json ?? '[]', row.cited_report_ids_json ?? '[]',
    row.item_snapshot_json ?? '[]', row.missing_days_json, row.generated_at,
  );
}

export function nextWeeklyReportVersion(db: Db, userId: string, weekId: string, tenantId = TENANT): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS version FROM weekly_report
    WHERE tenant_id = ? AND user_id = ? AND week_id = ?
  `).get(tenantId, userId, weekId) as { version: number };
  return Number(row.version) + 1;
}

export function getWeeklyReport(db: Db, userId: string, weekId: string, tenantId = TENANT): WeeklyReportRow | undefined {
  return db.prepare(`
    SELECT * FROM weekly_report
    WHERE tenant_id = ? AND user_id = ? AND week_id = ?
    ORDER BY version DESC LIMIT 1
  `).get(tenantId, userId, weekId) as unknown as WeeklyReportRow | undefined;
}

export function getWeeklyReportById(db: Db, id: string, tenantId = TENANT): WeeklyReportRow | undefined {
  return db.prepare('SELECT * FROM weekly_report WHERE tenant_id = ? AND id = ?').get(tenantId, id) as unknown as WeeklyReportRow | undefined;
}

export function insertFeedback(db: Db, row: Omit<FeedbackRow, 'tenant_id' | 'read_at'> & { tenant_id?: string; read_at?: string | null }): void {
  db.prepare(`
    INSERT INTO manager_feedback
      (id, tenant_id, weekly_report_id, work_item_id, manager_user_id, to_user_id, content, read_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id ?? TENANT, row.weekly_report_id, row.work_item_id,
    row.manager_user_id, row.to_user_id, row.content, row.read_at ?? null, row.created_at,
  );
}

export function listFeedback(db: Db, weeklyReportId: string, tenantId = TENANT): FeedbackRow[] {
  return db.prepare(`SELECT * FROM manager_feedback WHERE tenant_id = ? AND weekly_report_id = ? ORDER BY created_at`)
    .all(tenantId, weeklyReportId) as unknown as FeedbackRow[];
}

export function insertAccessGrant(db: Db, row: Omit<AccessGrantRow, 'tenant_id' | 'used_at'> & { tenant_id?: string; used_at?: string | null }): void {
  db.prepare(`
    INSERT INTO access_grant
      (id, tenant_id, token_hash, user_id, resource_type, resource_id, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id ?? TENANT, row.token_hash, row.user_id, row.resource_type,
    row.resource_id, row.expires_at, row.used_at ?? null, row.created_at,
  );
}

export function consumeAccessGrant(db: Db, tokenHash: string, now: string, tenantId = TENANT): AccessGrantRow | undefined {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`
      SELECT * FROM access_grant
      WHERE tenant_id=? AND token_hash=? AND used_at IS NULL AND expires_at>?
    `).get(tenantId, tokenHash, now) as unknown as AccessGrantRow | undefined;
    if (!row) {
      db.exec('COMMIT');
      return undefined;
    }
    const changed = db.prepare(`
      UPDATE access_grant SET used_at=? WHERE tenant_id=? AND id=? AND used_at IS NULL
    `).run(now, tenantId, row.id);
    if (Number(changed.changes) !== 1) throw new Error('访问授权已被使用');
    db.exec('COMMIT');
    return { ...row, used_at: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function insertAuthSession(db: Db, row: Omit<AuthSessionRow, 'tenant_id' | 'revoked_at'> & { tenant_id?: string; revoked_at?: string | null }): void {
  db.prepare(`
    INSERT INTO auth_session
      (token_hash, tenant_id, user_id, role, resource_id, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.token_hash, row.tenant_id ?? TENANT, row.user_id, row.role, row.resource_id,
    row.expires_at, row.revoked_at ?? null, row.created_at,
  );
}

export function getActiveAuthSession(db: Db, tokenHash: string, now: string, tenantId = TENANT): AuthSessionRow | undefined {
  return db.prepare(`
    SELECT * FROM auth_session
    WHERE tenant_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?
  `).get(tenantId, tokenHash, now) as unknown as AuthSessionRow | undefined;
}

export function revokeAuthSession(db: Db, tokenHash: string, now: string, tenantId = TENANT): void {
  db.prepare('UPDATE auth_session SET revoked_at=? WHERE tenant_id=? AND token_hash=? AND revoked_at IS NULL')
    .run(now, tenantId, tokenHash);
}

export function insertOutbox(db: Db, row: Omit<OutboxRow, 'tenant_id' | 'status' | 'attempts' | 'last_error' | 'sent_at'> & {
  tenant_id?: string;
  status?: OutboxRow['status'];
  attempts?: number;
  last_error?: string | null;
  sent_at?: string | null;
}): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO message_outbox
      (id, tenant_id, kind, dedupe_key, target_user_id, payload_json, status, attempts,
       next_attempt_at, last_error, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id ?? TENANT, row.kind, row.dedupe_key, row.target_user_id,
    row.payload_json, row.status ?? 'pending', row.attempts ?? 0, row.next_attempt_at,
    row.last_error ?? null, row.created_at, row.sent_at ?? null,
  );
  return Number(result.changes) === 1;
}

export function hasOutboxDedupe(db: Db, dedupeKey: string, tenantId = TENANT): boolean {
  return Boolean(db.prepare('SELECT 1 FROM message_outbox WHERE tenant_id=? AND dedupe_key=?').get(tenantId, dedupeKey));
}

export function listDueOutbox(db: Db, now: string, limit = 50): OutboxRow[] {
  return db.prepare(`
    SELECT * FROM message_outbox
    WHERE status IN ('pending','failed') AND next_attempt_at <= ?
    ORDER BY next_attempt_at LIMIT ?
  `).all(now, limit) as unknown as OutboxRow[];
}

export function claimOutbox(db: Db, id: string): boolean {
  const result = db.prepare(`
    UPDATE message_outbox SET status='sending'
    WHERE id=? AND status IN ('pending','failed')
  `).run(id);
  return Number(result.changes) === 1;
}

export function recoverInterruptedOutbox(db: Db, now: string): void {
  db.prepare(`
    UPDATE message_outbox
    SET status='failed', last_error='进程中断，等待人工确认或重试', next_attempt_at=?
    WHERE status='sending'
  `).run(now);
}

export function markOutboxSent(db: Db, id: string, sentAt: string): void {
  db.prepare(`
    UPDATE message_outbox
    SET status='sent', attempts=attempts+1, sent_at=?, last_error=NULL,
        payload_json=CASE WHEN kind='weekly_report' THEN '{"redacted":true}' ELSE payload_json END
    WHERE id=?
  `)
    .run(sentAt, id);
}

export function markOutboxFailed(db: Db, id: string, error: string, nextAttemptAt: string): void {
  db.prepare(`UPDATE message_outbox SET status='failed', attempts=attempts+1, last_error=?, next_attempt_at=? WHERE id=?`)
    .run(error.slice(0, 1000), nextAttemptAt, id);
}

export function insertAudit(
  db: Db,
  row: { id: string; tenant_id?: string; actor_user_id?: string | null; action: string; resource_type: string; resource_id: string; details_json?: string; created_at: string },
): void {
  db.prepare(`
    INSERT INTO audit_log (id, tenant_id, actor_user_id, action, resource_type, resource_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.tenant_id ?? TENANT, row.actor_user_id ?? null, row.action,
    row.resource_type, row.resource_id, row.details_json ?? '{}', row.created_at,
  );
}

export function getConfig<T>(db: Db, key: string, fallback: T, tenantId = TENANT): T {
  const row = db.prepare('SELECT value_json FROM app_config WHERE tenant_id = ? AND config_key = ?')
    .get(tenantId, key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
}

export function hasConfig(db: Db, key: string, tenantId = TENANT): boolean {
  return Boolean(db.prepare('SELECT 1 FROM app_config WHERE tenant_id=? AND config_key=?').get(tenantId, key));
}

export function setConfig(db: Db, key: string, value: unknown, tenantId = TENANT): void {
  db.prepare(`
    INSERT INTO app_config (tenant_id, config_key, value_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, config_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `).run(tenantId, key, JSON.stringify(value), new Date().toISOString());
}

export function listTemplates(db: Db, tenantId = TENANT): TemplateRow[] {
  return db.prepare(`
    SELECT * FROM report_template WHERE tenant_id = ? ORDER BY kind, version DESC
  `).all(tenantId) as unknown as TemplateRow[];
}

export function getActiveTemplate(db: Db, kind: 'daily' | 'weekly', tenantId = TENANT): TemplateRow | undefined {
  return db.prepare(`
    SELECT * FROM report_template WHERE tenant_id = ? AND kind = ? AND active = 1 ORDER BY version DESC LIMIT 1
  `).get(tenantId, kind) as unknown as TemplateRow | undefined;
}

export function createTemplateVersion(
  db: Db,
  row: { id: string; tenant_id?: string; kind: 'daily' | 'weekly'; name: string; content: string; created_at: string },
): TemplateRow {
  const tenantId = row.tenant_id ?? TENANT;
  const current = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS version FROM report_template WHERE tenant_id = ? AND kind = ?
  `).get(tenantId, row.kind) as { version: number };
  const version = Number(current.version) + 1;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE report_template SET active = 0 WHERE tenant_id = ? AND kind = ?').run(tenantId, row.kind);
    db.prepare(`
      INSERT INTO report_template (id, tenant_id, kind, name, version, content, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(row.id, tenantId, row.kind, row.name, version, row.content, row.created_at);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getActiveTemplate(db, row.kind, tenantId)!;
}

export function listKnowledgeEntries(
  db: Db,
  filters: { kind?: KnowledgeKind; active?: boolean; query?: string } = {},
  tenantId = TENANT,
): KnowledgeEntryRow[] {
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (filters.kind) {
    clauses.push('kind = ?');
    params.push(filters.kind);
  }
  if (filters.active != null) {
    clauses.push('active = ?');
    params.push(filters.active ? 1 : 0);
  }
  if (filters.query?.trim()) {
    clauses.push("(title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags_json LIKE ?)");
    const query = `%${filters.query.trim()}%`;
    params.push(query, query, query, query);
  }
  return db.prepare(`
    SELECT * FROM knowledge_entry WHERE ${clauses.join(' AND ')}
    ORDER BY active DESC, updated_at DESC
  `).all(...params) as unknown as KnowledgeEntryRow[];
}

export function getKnowledgeEntry(db: Db, id: string, tenantId = TENANT): KnowledgeEntryRow | undefined {
  return db.prepare('SELECT * FROM knowledge_entry WHERE tenant_id=? AND id=?')
    .get(tenantId, id) as unknown as KnowledgeEntryRow | undefined;
}

export function createKnowledgeEntry(
  db: Db,
  row: Omit<KnowledgeEntryRow, 'tenant_id' | 'active' | 'version'> & { tenant_id?: string; active?: number; version?: number },
): KnowledgeEntryRow {
  const tenantId = row.tenant_id ?? TENANT;
  db.prepare(`
    INSERT INTO knowledge_entry
      (id, tenant_id, kind, title, summary, content, tags_json, source_name, active, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, tenantId, row.kind, row.title, row.summary, row.content, row.tags_json, row.source_name,
    row.active ?? 1, row.version ?? 1, row.created_at, row.updated_at,
  );
  return getKnowledgeEntry(db, row.id, tenantId)!;
}

export function updateKnowledgeEntry(
  db: Db,
  id: string,
  expectedVersion: number,
  values: Pick<KnowledgeEntryRow, 'kind' | 'title' | 'summary' | 'content' | 'tags_json' | 'source_name' | 'active'>,
  now: string,
  tenantId = TENANT,
): KnowledgeEntryRow | undefined {
  const result = db.prepare(`
    UPDATE knowledge_entry
    SET kind=?, title=?, summary=?, content=?, tags_json=?, source_name=?, active=?, version=version+1, updated_at=?
    WHERE tenant_id=? AND id=? AND version=?
  `).run(
    values.kind, values.title, values.summary, values.content, values.tags_json, values.source_name, values.active,
    now, tenantId, id, expectedVersion,
  );
  if (result.changes !== 1) return undefined;
  return getKnowledgeEntry(db, id, tenantId);
}
