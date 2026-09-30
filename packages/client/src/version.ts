import { readFileSync } from 'node:fs';

// Da `src/` (tsx) e da `dist/` (build) il manifest del pacchetto sta un livello sopra.
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { name: string; version: string };

export const CLIENT_VERSION = manifest.version;
export const CLIENT_USER_AGENT = `${manifest.name}/${manifest.version}`;
