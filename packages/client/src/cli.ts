#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type ClientConfig, type ConfigSource } from './config.js';
import { configDir, configFile, vscodeSettingsFile } from './paths.js';
import { buildApp } from './server.js';

const OVERRIDE_KEY = 'github.copilot.advanced.debug.overrideCapiUrl';
const AUTH_TYPE_KEY = 'github.copilot.advanced.debug.overrideAuthType';

const USAGE = `
Proxy locale che misura il consumo di token di GitHub Copilot e lo attribuisce
al progetto su cui si sta lavorando.

  npx @vidiemme/copilot-proxy setup     configura la postazione (una volta sola)
  npx @vidiemme/copilot-proxy start     avvia il proxy
  npx @vidiemme/copilot-proxy doctor    verifica che tutto sia a posto

Opzioni di setup:
  --collector-url <url>     endpoint del servizio di raccolta (obbligatorio)
  --salt <valore>           salt degli pseudonimi, uguale per tutta l'azienda
  --workspace-roots <a,b>   cartelle sotto cui vivono i repository
  --port <n>                porta locale del proxy (default 8787)
  --upstream <url>          endpoint Copilot (default https://api.githubcopilot.com)
  --vscode                  scrive anche le impostazioni utente di VS Code
  --force                   sovrascrive una configurazione esistente

Il token di raccolta non si passa come opzione: finirebbe nella cronologia della
shell e nella lista dei processi. Va nella variabile COLLECTOR_TOKEN, oppure lo
chiede il comando in modo nascosto.

Opzioni di start:
  --port <n>  --log-level <livello>  --collector-url <url>  --workspace-roots <a,b>
`.trimStart();

/** I valori sul filo usano le stesse chiavi delle variabili d'ambiente: un solo vocabolario da documentare. */
function readConfigFile(): ConfigSource {
  let raw: string;
  try {
    raw = readFileSync(configFile(), 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${configFile()} non e' un JSON valido: correggilo o rilancia "setup --force"`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configFile()} deve contenere un oggetto JSON`);
  }

  const source: ConfigSource = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' || typeof value === 'number') source[key] = String(value);
  }
  return source;
}

/** Precedenza: opzioni della riga di comando, poi ambiente, poi file di configurazione. */
function mergedSource(overrides: ConfigSource): ConfigSource {
  const merged: ConfigSource = { ...readConfigFile() };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value.trim().length > 0) merged[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function writeConfigFile(values: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  // Il file contiene il token di raccolta: leggibile solo dal proprietario.
  writeFileSync(configFile(), `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Legge un segreto dal terminale senza mostrarlo.
 *
 * Serve la modalita' raw perche' `readline` non sa nascondere l'eco: si legge
 * carattere per carattere e si stampa nulla.
 */
function promptSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error(
        'COLLECTOR_TOKEN non impostato e nessun terminale interattivo disponibile: esporta la variabile prima di lanciare il comando',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (action: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      action();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value));
        if (char === '\u0003') return finish(() => reject(new Error('interrotto')));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function commandSetup(flags: Record<string, string | boolean | undefined>): Promise<number> {
  const existing = readConfigFile();
  if (Object.keys(existing).length > 0 && flags.force !== true) {
    console.error(`Esiste gia' ${configFile()}. Rilancia con --force per sostituirlo.`);
    return 1;
  }

  const collectorUrl = (flags['collector-url'] as string | undefined) ?? process.env.COLLECTOR_URL;
  if (!collectorUrl) {
    console.error('Manca --collector-url: e\' l\'endpoint del servizio di raccolta aziendale.');
    return 1;
  }

  const salt = (flags.salt as string | undefined) ?? process.env.DEVELOPER_ID_SALT;
  if (!salt) {
    console.error(
      'Manca --salt. Non viene generato a caso di proposito: deve essere identico su tutte le postazioni, altrimenti la stessa persona risulta come developer diversi. Chiedilo a chi gestisce il servizio di raccolta.',
    );
    return 1;
  }

  const token = process.env.COLLECTOR_TOKEN ?? (await promptSecret('Token di raccolta: '));
  if (token.trim().length === 0) {
    console.error('Token vuoto.');
    return 1;
  }

  const values: Record<string, string> = {
    COLLECTOR_URL: collectorUrl,
    COLLECTOR_TOKEN: token.trim(),
    DEVELOPER_ID_SALT: salt,
  };
  const workspaceRoots = flags['workspace-roots'] as string | undefined;
  if (workspaceRoots) values.WORKSPACE_ROOTS = workspaceRoots;
  if (flags.port) values.PORT = String(flags.port);
  if (flags.upstream) values.UPSTREAM_BASE_URL = String(flags.upstream);

  // Meglio scoprire ora che la configurazione non regge, non al primo avvio.
  let config: ClientConfig;
  try {
    config = loadConfig({ ...values });
  } catch (error) {
    console.error(`Configurazione non valida: ${(error as Error).message}`);
    return 1;
  }

  writeConfigFile(values);
  console.log(`Scritto ${configFile()}`);

  if (!workspaceRoots) {
    console.log(
      '\nATTENZIONE: senza --workspace-roots il progetto non viene riconosciuto e il consumo finisce in "unassigned".\n' +
        '  Rilancia con: --workspace-roots ~/Work',
    );
  }

  if (flags.vscode === true) applyVsCodeSettings(config.port);
  else printVsCodeSettings(config.port);

  console.log('\nPoi avvia il proxy con:  npx @vidiemme/copilot-proxy start');
  return 0;
}

function vsCodeSnippet(port: number): Record<string, string> {
  return { [OVERRIDE_KEY]: `http://127.0.0.1:${port}`, [AUTH_TYPE_KEY]: 'token' };
}

function printVsCodeSettings(port: number): void {
  console.log(
    '\nAggiungi alle impostazioni utente di VS Code (Preferences: Open User Settings (JSON)):\n' +
      `${JSON.stringify(vsCodeSnippet(port), null, 2)}\n` +
      'Oppure rilancia il setup con --vscode per farlo scrivere al comando.',
  );
}

function applyVsCodeSettings(port: number): void {
  const file = vscodeSettingsFile();

  let current: Record<string, unknown> = {};
  let exists = true;
  try {
    const raw = readFileSync(file, 'utf-8');
    // `settings.json` ammette commenti e virgole finali: se non e' JSON puro,
    // riscriverlo lo distruggerebbe. Meglio arrendersi e dire cosa aggiungere.
    current = JSON.parse(raw) as Record<string, unknown>;
    copyFileSync(file, `${file}.bak`);
  } catch (error) {
    exists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    if (exists) {
      console.log(`\nNon riesco a modificare ${file} senza rischiare di rovinarlo (contiene commenti o non e' JSON valido).`);
      printVsCodeSettings(port);
      return;
    }
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...current, ...vsCodeSnippet(port) }, null, 2)}\n`);
  console.log(`Aggiornato ${file}${exists ? ` (backup in ${file}.bak)` : ''}`);
  console.log("Riavvia VS Code perche' le impostazioni abbiano effetto.");
}

async function commandStart(flags: Record<string, string | boolean | undefined>): Promise<number> {
  const overrides: ConfigSource = {};
  if (flags.port) overrides.PORT = String(flags.port);
  if (flags['log-level']) overrides.LOG_LEVEL = String(flags['log-level']);
  if (flags['collector-url']) overrides.COLLECTOR_URL = String(flags['collector-url']);
  if (flags['workspace-roots']) overrides.WORKSPACE_ROOTS = String(flags['workspace-roots']);

  let config: ClientConfig;
  try {
    config = loadConfig(mergedSource(overrides));
  } catch (error) {
    console.error(
      `${(error as Error).message}\n\nSe e' la prima volta:  npx @vidiemme/copilot-proxy setup --collector-url <url> --salt <valore>`,
    );
    return 1;
  }

  const app = await buildApp(config);
  await app.server.listen({ port: config.port, host: config.host });

  const shutdown = (signal: string): void => {
    app.server.log.info({ signal }, 'arresto in corso');
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.server.log.error({ err: error }, 'arresto fallito');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return 0;
}

async function commandDoctor(): Promise<number> {
  const results: [boolean, string][] = [];
  const check = (ok: boolean, message: string): void => {
    results.push([ok, message]);
  };

  let config: ClientConfig;
  try {
    config = loadConfig(mergedSource({}));
    check(true, 'configurazione leggibile e completa');
  } catch (error) {
    check(false, `configurazione: ${(error as Error).message}`);
    report(results);
    console.log('\nLancia prima:  npx @vidiemme/copilot-proxy setup --collector-url <url> --salt <valore>');
    return 1;
  }

  const roots = config.workspaceRoots;
  if (roots.length === 0) {
    check(false, 'WORKSPACE_ROOTS non impostato: il progetto finira\' in "unassigned"');
  } else {
    const missing = roots.filter((root) => !existsDir(root));
    check(
      missing.length === 0,
      missing.length === 0
        ? `cartelle di lavoro raggiungibili (${roots.join(', ')})`
        : `cartelle di lavoro inesistenti: ${missing.join(', ')}`,
    );
  }

  // Un batch vuoto viene rifiutato dalla validazione, che pero' gira *dopo*
  // l'autenticazione: un 400 dimostra quindi che il token e' stato accettato.
  try {
    const response = await fetch(config.collectorUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.collectorToken}`,
      },
      body: JSON.stringify({ events: [] }),
      signal: AbortSignal.timeout(config.collectorTimeoutMs),
    });
    if (response.status === 401) check(false, 'il servizio di raccolta rifiuta il token');
    else if (response.status === 400) check(true, 'servizio di raccolta raggiungibile, token valido');
    else check(false, `il servizio di raccolta risponde ${response.status}, inatteso`);
  } catch (error) {
    check(false, `servizio di raccolta irraggiungibile: ${(error as Error).message}`);
  }

  // Ricerca testuale e non `JSON.parse`: `settings.json` ammette commenti e
  // virgole finali, e una diagnostica non deve fallire per quello.
  try {
    const raw = readFileSync(vscodeSettingsFile(), 'utf-8');
    const match = new RegExp(`"${OVERRIDE_KEY.replace(/\./g, '\\.')}"\\s*:\\s*"([^"]*)"`).exec(raw);
    const expected = `http://127.0.0.1:${config.port}`;
    // `localhost` e `127.0.0.1` sono equivalenti: non vale la pena segnalarlo.
    const ok = match !== null && new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${config.port}/?$`).test(match[1] ?? '');
    check(
      ok,
      ok
        ? `VS Code punta al proxy (${match?.[1] ?? expected})`
        : match
          ? `VS Code punta a ${match[1]}, atteso ${expected}`
          : "VS Code non e' configurato per passare dal proxy",
    );
  } catch {
    check(false, `impostazioni di VS Code non trovate in ${vscodeSettingsFile()}`);
  }

  const pending = spoolSize(config.spoolPath);
  check(pending === 0, pending === 0 ? 'nessun evento in attesa di consegna' : `${pending} byte di eventi in attesa nello spool`);

  try {
    const health = await fetch(`http://127.0.0.1:${config.port}/_health`, {
      signal: AbortSignal.timeout(2000),
    });
    check(health.ok, 'proxy in ascolto');
  } catch {
    check(false, `nessun proxy in ascolto sulla porta ${config.port}: avvialo con "start"`);
  }

  report(results);
  return results.every(([ok]) => ok) ? 0 : 1;
}

function report(results: [boolean, string][]): void {
  for (const [ok, message] of results) console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function spoolSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'collector-url': { type: 'string' },
      salt: { type: 'string' },
      'workspace-roots': { type: 'string' },
      port: { type: 'string' },
      upstream: { type: 'string' },
      'log-level': { type: 'string' },
      vscode: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0] ?? 'start';
  if (values.help === true || command === 'help') {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'setup':
      process.exitCode = await commandSetup(values);
      return;
    case 'start':
      process.exitCode = await commandStart(values);
      return;
    case 'doctor':
      process.exitCode = await commandDoctor();
      return;
    default:
      console.error(`Comando sconosciuto: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
