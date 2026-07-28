import '../env.js';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.js';
import { createPool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const folder = join(here, 'migrations');
  // Le migrazioni sono idempotenti, quindi si rieseguono tutte in ordine.
  const files = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();

  try {
    for (const file of files) {
      await pool.query(await readFile(join(folder, file), 'utf-8'));
      console.log(`applicata ${file}`);
    }
    console.log(`Migrazioni completate (${files.length}).`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migrazione fallita:', error);
  process.exitCode = 1;
});
