#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { installAutostart, isAutostartInstalled, restartAutostart, uninstallAutostart } from './autostart.js';
import { loadConfig, type ClientConfig, type ConfigSource } from './config.js';
import {
  applyEditorSettings,
  editorSnippet,
  installedEditors,
  knownEditors,
  pointsToProxy,
  readOverride,
  type Editor,
} from './editors.js';
import { configDir, configFile } from './paths.js';
import { buildApp } from './server.js';
import { gitIdentity, portStatus } from './setupHelpers.js';
import { CLIENT_VERSION } from './version.js';

const DEFAULT_PORT = 8787;

const USAGE = `
Proxy locale che misura il consumo di token di GitHub Copilot e lo attribuisce
al progetto su cui si sta lavorando.

  npx @vidiemme/copilot-proxy setup      configura la postazione (una volta sola)
  npx @vidiemme/copilot-proxy start      avvia il proxy
  npx @vidiemme/copilot-proxy doctor     verifica che tutto sia a posto
  npx @vidiemme/copilot-proxy status     versione, traffico misurato, eventi in attesa
  npx @vidiemme/copilot-proxy restart    riavvia il servizio (dopo un aggiornamento)
  npx @vidiemme/copilot-proxy uninstall  rimuove l'avvio automatico
  npx @vidiemme/copilot-proxy --version

Opzioni di setup:
  --vscode                  scrive le impostazioni di VS Code e derivati (Insiders,
                            VSCodium, Cursor, Windsurf, Antigravity) installati
  --autostart               avvia il proxy a ogni accesso, senza doverlo lanciare
  --port <n>                porta locale del proxy (default 8787; chiesta se interattivo)
  --name <nome>             nome da mostrare nella dashboard (default: git user.name)
  --email <email>           email associata (default: git user.email)
  --anonymous               non inviare nome ed email: resta solo lo pseudonimo
  --workspace-roots <a,b>   cartelle sotto cui vivono i repository (default: la home)
  --collector-url <url>     endpoint di raccolta, se diverso da quello aziendale
  --salt <valore>           salt degli pseudonimi, se diverso da quello aziendale
  --upstream <url>          endpoint Copilot (default https://api.githubcopilot.com)
  --force                   rifa' il setup partendo dalla configurazione esistente
                            (token compreso: per cambiare porta basta --force --port)

JetBrains, Eclipse, Xcode, Android Studio e Visual Studio non hanno un modo per
indirizzare Copilot al proxy: il loro traffico non viene misurato.

L'unica cosa da procurarsi e' il token di raccolta, uguale per tutta l'azienda.
Non si passa come opzione: finirebbe nella cronologia della shell e nella lista
dei processi. Va nella variabile COLLECTOR_TOKEN, oppure lo chiede il comando in
modo nascosto.

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

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function setOrDelete(values: Record<string, string>, key: string, value: string | undefined): void {
  if (value) values[key] = value;
  else delete values[key];
}

async function commandSetup(flags: Record<string, string | boolean | undefined>): Promise<number> {
  const existing = readConfigFile();
  const reconfigure = Object.keys(existing).length > 0;
  if (reconfigure && flags.force !== true) {
    console.error(`Esiste gia' ${configFile()}. Rilancia con --force per modificarlo.`);
    return 1;
  }
  const interactive = process.stdin.isTTY === true;

  // Con --force si parte dalla configurazione esistente: cambiare porta non deve costare il token.
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) if (value !== undefined) values[key] = value;

  const token =
    process.env.COLLECTOR_TOKEN?.trim() ||
    values.COLLECTOR_TOKEN ||
    (await promptSecret('Token di raccolta: ')).trim();
  if (token.length === 0) {
    console.error('Token vuoto.');
    return 1;
  }

  // Si scrive solo cio' che si discosta dai default del pacchetto: un file
  // corto e' un file che si capisce, e i default restano aggiornabili con una
  // nuova versione invece che postazione per postazione.
  values.COLLECTOR_TOKEN = token;
  const collectorUrl = flags['collector-url'] as string | undefined;
  if (collectorUrl) values.COLLECTOR_URL = collectorUrl;
  const salt = flags.salt as string | undefined;
  if (salt) values.DEVELOPER_ID_SALT = salt;
  const workspaceRoots = flags['workspace-roots'] as string | undefined;
  if (workspaceRoots) values.WORKSPACE_ROOTS = workspaceRoots;
  if (flags.upstream) values.UPSTREAM_BASE_URL = String(flags.upstream);

  let port = flags.port ? String(flags.port) : values.PORT;
  if (!port && interactive) {
    port = (await promptLine(`Porta locale del proxy [${DEFAULT_PORT}]: `)) || undefined;
  }
  if (port && !validPort(port)) {
    console.error(`Porta non valida: ${port}. Serve un intero fra 1 e 65535.`);
    return 1;
  }
  setOrDelete(values, 'PORT', port && Number(port) !== DEFAULT_PORT ? String(Number(port)) : undefined);

  if (flags.anonymous === true) {
    setOrDelete(values, 'DEVELOPER_NAME', undefined);
    setOrDelete(values, 'DEVELOPER_EMAIL', undefined);
  } else {
    const git = gitIdentity();
    let name = (flags.name as string | undefined) ?? values.DEVELOPER_NAME ?? git.name;
    const email = (flags.email as string | undefined) ?? values.DEVELOPER_EMAIL ?? git.email;
    if (interactive && flags.name === undefined) {
      const answer = await promptLine(
        `Nome da mostrare nella dashboard [${name ?? 'nessuno'}] ("-" per restare anonimo): `,
      );
      if (answer === '-') name = undefined;
      else if (answer) name = answer;
    }
    setOrDelete(values, 'DEVELOPER_NAME', name?.slice(0, 100));
    setOrDelete(values, 'DEVELOPER_EMAIL', name ? email?.slice(0, 200) : undefined);
  }

  // Meglio scoprire ora che la configurazione non regge, non al primo avvio.
  let config: ClientConfig;
  try {
    config = loadConfig({ ...values });
  } catch (error) {
    console.error(`Configurazione non valida: ${(error as Error).message}`);
    return 1;
  }

  if ((await portStatus(config.port, config.host)) === 'busy') {
    console.error(
      `La porta ${config.port} e' occupata da un altro programma. Scegline un'altra con --port <n>.`,
    );
    return 1;
  }

  writeConfigFile(values);
  console.log(`Scritto ${configFile()}`);
  console.log(`Proxy su http://127.0.0.1:${config.port}`);
  console.log(`Raccolta verso ${config.collectorUrl}`);
  console.log(`Progetti cercati sotto ${config.workspaceRoots.join(', ')}`);
  console.log(
    config.developerName
      ? `Nella dashboard comparirai come ${config.developerName}`
      : 'Nella dashboard comparirai con uno pseudonimo',
  );

  if (flags.vscode === true) applyEditors(config.port);
  else printEditorSettings(config.port);

  if (flags.autostart === true) {
    try {
      const service = installAutostart();
      console.log(`\nAvvio automatico attivo: ${service.file}`);
      console.log(`Il proxy e' gia' partito e ripartira' a ogni accesso. Per disattivarlo:\n  ${service.removeHint}`);
      if (service.warning) console.log(`\nATTENZIONE: ${service.warning}`);
    } catch (error) {
      console.error(`\nAvvio automatico non riuscito: ${(error as Error).message}`);
      return 1;
    }
    return 0;
  }

  console.log('\nPoi avvia il proxy con:  npx @vidiemme/copilot-proxy start');
  console.log('Per non doverlo fare ogni volta, rilancia il setup con --autostart');
  return 0;
}

function printEditorSettings(port: number, editor?: Editor): void {
  console.log(
    `\nAggiungi alle impostazioni utente di ${editor?.name ?? 'VS Code (e dei suoi derivati)'} (Preferences: Open User Settings (JSON)):\n` +
      `${JSON.stringify(editorSnippet(port), null, 2)}\n` +
      (editor ? '' : 'Oppure rilancia il setup con --vscode per farlo scrivere al comando.'),
  );
}

function applyEditors(port: number): void {
  const found = installedEditors();
  // Nessun editor ancora aperto: si prepara VS Code, che e' il caso piu' comune.
  const targets = found.length > 0 ? found : knownEditors().slice(0, 1);

  for (const editor of targets) {
    const result = applyEditorSettings(editor, port);
    if (result.status === 'unparsable') {
      console.log(
        `\n${editor.name}: non riesco a modificare ${editor.settingsFile} senza rischiare di rovinarlo (contiene commenti o non e' JSON valido).`,
      );
      printEditorSettings(port, editor);
      continue;
    }
    console.log(
      `${editor.name}: aggiornato ${editor.settingsFile}${result.backup ? ` (backup in ${result.backup})` : ''}`,
    );
  }
  console.log("Riavvia gli editor perche' le impostazioni abbiano effetto.");
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
      `${(error as Error).message}\n\nSe e' la prima volta:  npx @vidiemme/copilot-proxy setup`,
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
  const results: [Level, string][] = [];
  const check = (ok: boolean, message: string): void => {
    results.push([ok ? 'ok' : 'fail', message]);
  };
  const warn = (message: string): void => {
    results.push(['warn', message]);
  };

  let config: ClientConfig;
  try {
    config = loadConfig(mergedSource({}));
    check(true, 'configurazione leggibile e completa');
  } catch (error) {
    check(false, `configurazione: ${(error as Error).message}`);
    report(results);
    console.log('\nLancia prima:  npx @vidiemme/copilot-proxy setup');
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

  // Basta un editor che punti al proxy; gli altri sono solo segnalati, perche'
  // non tutti usano Copilot in ogni editor installato.
  const editors = installedEditors();
  const expected = `http://127.0.0.1:${config.port}`;
  const configured: string[] = [];
  const notConfigured: string[] = [];
  for (const editor of editors) {
    const value = readOverride(editor);
    if (value && pointsToProxy(value, config.port)) configured.push(editor.name);
    else notConfigured.push(value ? `${editor.name} (punta a ${value}, atteso ${expected})` : editor.name);
  }
  if (configured.length > 0) {
    check(true, `passano dal proxy: ${configured.join(', ')}`);
    if (notConfigured.length > 0) warn(`non passano dal proxy: ${notConfigured.join(', ')}`);
  } else {
    check(
      false,
      editors.length > 0
        ? `nessun editor passa dal proxy (${notConfigured.join(', ')}): rilancia "setup --vscode --force"`
        : 'nessun editor della famiglia VS Code trovato su questa macchina',
    );
  }

  const pending = spoolSize(config.spoolPath);
  check(pending === 0, pending === 0 ? 'nessun evento in attesa di consegna' : `${pending} byte di eventi in attesa nello spool`);

  // L'avvio automatico interessa solo se il proxy non sta gia' girando: chi
  // preferisce lanciarlo a mano non deve vedere un errore.
  const health = await readHealth(config.port);
  const proxyUp = health !== undefined;
  check(
    proxyUp,
    proxyUp
      ? `proxy ${health.version ?? ''} in ascolto${isAutostartInstalled() ? ', con avvio automatico' : ''}`
      : `nessun proxy in ascolto sulla porta ${config.port}: attivalo per sempre con "setup --autostart --force", o una volta sola con "start"`,
  );

  if (health) {
    if (health.version && health.version !== CLIENT_VERSION) {
      warn(`il proxy in esecuzione e' la ${health.version}, questo comando la ${CLIENT_VERSION}: lancia "restart"`);
    }
    // L'impostazione di VS Code e' di debug: un aggiornamento dell'estensione
    // puo' ignorarla senza avvisare, e lo si vede solo dall'assenza di traffico.
    const silence = trafficSilence(health);
    if (silence) warn(silence);
  }

  report(results);
  return results.every(([level]) => level !== 'fail') ? 0 : 1;
}

type Level = 'ok' | 'warn' | 'fail';

interface ProxyHealth {
  version?: string;
  startedAt?: string;
  spoolBytes?: number;
  usage?: {
    recorded: number;
    delivered: number;
    dropped: number;
    lastEventAt: string | null;
    lastDeliveryAt: string | null;
    lastError: string | null;
  };
}

async function readHealth(port: number): Promise<ProxyHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok ? ((await response.json()) as ProxyHealth) : undefined;
  } catch {
    return undefined;
  }
}

const HOUR_MS = 60 * 60 * 1000;

function trafficSilence(health: ProxyHealth, now = Date.now()): string | undefined {
  const last = health.usage?.lastEventAt;
  if (last) {
    const hours = Math.floor((now - Date.parse(last)) / HOUR_MS);
    return hours >= 24 ? `nessun traffico Copilot misurato nelle ultime ${hours} ore` : undefined;
  }
  const uptime = health.startedAt ? now - Date.parse(health.startedAt) : 0;
  return uptime >= HOUR_MS
    ? "nessun traffico Copilot misurato dall'avvio del proxy: controlla che l'editor passi davvero di qui"
    : undefined;
}

async function commandStatus(): Promise<number> {
  let config: ClientConfig;
  try {
    config = loadConfig(mergedSource({}));
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const health = await readHealth(config.port);
  console.log(`copilot-proxy ${CLIENT_VERSION}`);
  console.log(`nome in dashboard: ${config.developerName ?? 'nessuno (pseudonimo)'}`);
  console.log(`avvio automatico: ${isAutostartInstalled() ? 'attivo' : 'non installato'}`);
  if (!health) {
    console.log(`proxy: non in ascolto sulla porta ${config.port}`);
    return 1;
  }

  const usage = health.usage;
  console.log(`proxy: ${health.version ?? '?'} in ascolto dal ${health.startedAt ?? '?'}`);
  if (usage) {
    console.log(`eventi misurati: ${usage.recorded}, consegnati: ${usage.delivered}, scartati: ${usage.dropped}`);
    console.log(`ultimo evento: ${usage.lastEventAt ?? 'nessuno'}`);
    console.log(`ultima consegna: ${usage.lastDeliveryAt ?? 'nessuna'}`);
    if (usage.lastError) console.log(`ultimo errore del collector: ${usage.lastError}`);
  }
  console.log(`spool: ${health.spoolBytes ?? 0} byte in attesa`);
  return 0;
}

function commandRestart(): number {
  try {
    restartAutostart();
  } catch (error) {
    console.error(`Riavvio non riuscito: ${(error as Error).message}`);
    return 1;
  }
  console.log('Proxy riavviato.');
  return 0;
}

function commandUninstall(): number {
  if (!uninstallAutostart()) {
    console.log('Avvio automatico non installato: niente da rimuovere.');
    return 0;
  }
  console.log(`Avvio automatico rimosso. Configurazione lasciata in ${configFile()}.`);
  console.log("Ricordati di togliere le impostazioni del proxy da VS Code, altrimenti Copilot non raggiunge piu' l'upstream.");
  return 0;
}

function report(results: [Level, string][]): void {
  const labels: Record<Level, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  for (const [level, message] of results) console.log(`${labels[level]} ${message}`);
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
      name: { type: 'string' },
      email: { type: 'string' },
      anonymous: { type: 'boolean' },
      vscode: { type: 'boolean' },
      autostart: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  const command = positionals[0] ?? 'start';
  if (values.version === true || command === 'version') {
    console.log(CLIENT_VERSION);
    return;
  }
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
    case 'status':
      process.exitCode = await commandStatus();
      return;
    case 'restart':
      process.exitCode = commandRestart();
      return;
    case 'uninstall':
      process.exitCode = commandUninstall();
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
