import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const envFile = path.join(root, '.runtime', 'wecom.env');
const projectEnv = {};
for (const file of [envFile, path.join(root, '.runtime', 'local-poc.env')]) {
  if (!existsSync(file)) continue;
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = sourceLine.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    projectEnv[match[1]] = value;
  }
}
const sourcePath = path.resolve(projectEnv.DATABASE_PATH ?? path.join(root, '.runtime', 'data', 'poc.sqlite'));
if (!existsSync(sourcePath)) throw new Error(`数据库不存在：${sourcePath}`);
const backupDir = path.resolve(projectEnv.BACKUP_DIR ?? path.join(root, '.runtime', 'backups'));
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(backupDir, `poc-${stamp}.sqlite`);
const db = new DatabaseSync(sourcePath);
try {
  await backup(db, destination);
} finally {
  db.close();
}
const check = new DatabaseSync(destination, { readOnly: true });
try {
  const result = check.prepare('PRAGMA integrity_check').get();
  if (result.integrity_check !== 'ok') throw new Error(`备份完整性检查失败：${JSON.stringify(result)}`);
} finally {
  check.close();
}
console.log(destination);
