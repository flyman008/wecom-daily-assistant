import { openDb } from '../packages/persistence/src/index';
import { readProjectEnv } from '../apps/shared/project-env';
import { createDirectoryReader } from '../apps/api/src/directory-sheet';
import { DirectoryService } from '../apps/api/src/directory-service';

async function main() {
  const env = readProjectEnv();
  const db = openDb(env.DATABASE_PATH ?? '.runtime/data/poc.sqlite');
  try {
    const directory = new DirectoryService(db, createDirectoryReader(env), env.DIRECTORY_SHEET_URL);
    console.log(JSON.stringify({ ok: true, ...await directory.sync('local-cli') }));
  } finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
