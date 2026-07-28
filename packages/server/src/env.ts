/**
 * Carica il file `.env` se presente.
 *
 * Va importato per primo dagli entrypoint, prima di qualsiasi modulo che
 * legga `process.env`. In produzione il file di solito non esiste perche' le
 * variabili arrivano dall'orchestratore: l'assenza non e' un errore.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
