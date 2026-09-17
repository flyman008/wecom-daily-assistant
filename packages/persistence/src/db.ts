import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';
import { CRM_SCHEMA } from './crm';
import { PORTAL_SCHEMA } from './portal';

export type Db = DatabaseSync;

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function openDb(filePath = ':memory:'): Db {
  if (filePath !== ':memory:') mkdirSync(dirname(resolve(filePath)), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  db.exec(CRM_SCHEMA);
  db.exec(PORTAL_SCHEMA);
  // POC数据库可能由较早的本项目版本创建；只做本项目内的前向兼容迁移。
  ensureColumn(db, 'work_item', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'work_item', 'updated_at', 'TEXT');
  ensureColumn(db, 'weekly_report', 'item_snapshot_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'app_user', 'department', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'daily_report', 'generation_revision', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE work_item SET updated_at = created_at WHERE updated_at IS NULL');
  db.prepare(`
    INSERT INTO tenant (id, name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name
  `).run(
    'poc',
    '示例企业',
    new Date().toISOString(),
  );
  db.exec(`
    INSERT OR IGNORE INTO work_item_revision
      (id, tenant_id, work_item_id, version, change_type, name, plan_background, actor_user_id, created_at)
    SELECT id || ':v' || version, tenant_id, id, version, 'created', name, plan_background, user_id, created_at
    FROM work_item
  `);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO report_template (id, tenant_id, kind, name, version, content, active, created_at)
    VALUES (?, 'poc', 'daily', '默认日报模板', 1, ?, 1, ?)
  `).run('daily-v1', JSON.stringify({ fields: ['工作事项', '当日进展', '问题原因', '下一步计划'] }), now);
  db.prepare(`
    INSERT OR IGNORE INTO report_template (id, tenant_id, kind, name, version, content, active, created_at)
    VALUES (?, 'poc', 'weekly', '默认周报模板', 1, ?, 1, ?)
  `).run('weekly-v1', JSON.stringify({ sections: ['本周计划与进展', '问题与原因', '下周安排', '交流反馈'] }), now);
  return db;
}

export function inTransaction<T>(db: Db, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
