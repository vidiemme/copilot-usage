#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { totalInputTokens, type TokenCounters } from '@vidiemme/copilot-usage-contract';
import {
  API_URL_VAR,
  installRuntimeRouting,
  proxyUrl,
  readRuntimeRouting,
  runningRuntimes,
  uninstallRuntimeRouting,
} from './agentRuntime.js';
import {
  cliEntry,
  installAutostart,
  isAutostartInstalled,
  registeredEntry,
  restartAutostart,
  runsAsService,
  runSupervisor,
  uninstallAutostart,
} from './autostart.js';
import { loadConfig, type ClientConfig, type ConfigSource } from './config.js';
import {
  applyEditorSettings,
  editorSnippet,
  installedEditors,
  isOverrideCommented,
  knownEditors,
  pointsToProxy,
  readOverride,
  type Editor,
} from './editors.js';
import {
  applyLiteLLMRouting,
  copilotModelMatcher,
  findLiteLLMConfigs,
  readCopilotRoutes,
  type CopilotRoute,
} from './litellm.js';
import { configDir, configFile } from './paths.js';
import {
  buildReloadPlan,
  chatModels,
  CLIENT_NAMES,
  developerIdFor,
  fetchRates,
  hasCliProxyOverlap,
  proxyFirstStart,
  readLocalSessions,
  sendEvents,
  type AgentPolicy,
  type RateBook,
  type ReloadOptions,
  type ReloadPlan,
  type ReloadSource,
} from './reload/index.js';
import { SelfUpdater, type UpdateStatus } from './selfUpdate.js';
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
  npx @vidiemme/copilot-proxy reload     carica lo storico delle sessioni gia' fatte
  npx @vidiemme/copilot-proxy restart    riavvia il servizio (dopo un aggiornamento)
  npx @vidiemme/copilot-proxy uninstall  rimuove l'avvio automatico
  npx @vidiemme/copilot-proxy --version

Opzioni di setup:
  --vscode                  scrive le impostazioni di VS Code e derivati (Insiders,
                            VSCodium, Cursor, Windsurf, Antigravity) installati, e
                            imposta COPILOT_API_URL per Copilot CLI e le sessioni
                            agentiche (Copilot CLI / SDK) dentro l'editor
  --autostart               avvia il proxy a ogni accesso, senza doverlo lanciare
  --litellm                 fa passare dal proxy le rotte di LiteLLM verso Copilot
                            (github_copilot/...), impostandone api_base
  --litellm-config <file>   config di LiteLLM, se non e' fra quelle trovate da solo
  --port <n>                porta locale del proxy (default 8787; chiesta se interattivo)
  --name <nome>             nome da mostrare nella dashboard (default: git user.name)
  --email <email>           email associata (default: git user.email)
  --anonymous               non inviare nome, email e hostname: resta lo pseudonimo
  --workspace-roots <a,b>   cartelle sotto cui vivono i repository (default: la home)
  --collector-url <url>     endpoint di raccolta, se diverso da quello aziendale
  --salt <valore>           salt degli pseudonimi, se diverso da quello aziendale
  --upstream <url>          endpoint Copilot (default https://api.githubcopilot.com)
  --no-auto-update          non installare da solo gli aggiornamenti (--auto-update li riattiva)
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

Opzioni di reload:
  reload [cartella]         carica le sessioni dei progetti sotto la cartella
                            (default: le cartelle di lavoro del setup)
  --from <data>             dal giorno indicato (AAAA-MM-GG, ora locale)
  --to <data>               fino al giorno indicato, compreso
  --dry-run                 mostra cosa verrebbe caricato, senza inviare nulla
  --yes                     non chiede conferma (necessario senza terminale)
  --litellm-config <file>   config di LiteLLM con cui riconoscere le chiamate di
                            Claude Code, Cline e opencode passate da Copilot
  --agents-all              carica tutte le chiamate di Claude Code, Cline e
                            opencode del periodo, senza filtro sui modelli

Legge le sessioni di Copilot CLI, le chat di Copilot in VS Code e derivati, e
quelle di Claude Code, Cline (con Roo e Kilo) e opencode passate da Copilot. Si
puo' rilanciare: gli eventi gia' caricati non vengono duplicati.
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
  if (flags['auto-update'] === false) values.AUTO_UPDATE = 'false';
  else if (flags['auto-update'] === true) setOrDelete(values, 'AUTO_UPDATE', undefined);

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

  const litellmFiles = flags['litellm-config'] ? [String(flags['litellm-config'])] : [];
  if (flags.litellm === true || litellmFiles.length > 0) {
    applyLiteLLM(values, config.port, litellmFiles);
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

  if (flags.vscode === true) {
    applyEditors(config.port);
    applyRuntimeRouting(config.port);
  } else {
    printEditorSettings(config.port);
  }
  if (flags.litellm !== true && litellmFiles.length === 0) hintLiteLLM(config.port);

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

/** Config di LiteLLM gia' note (dal setup) piu' quelle indicate o trovate ora. */
function liteLLMConfigs(explicit: string[]): string[] {
  const known = (readConfigFile().LITELLM_CONFIG ?? '').split(',').filter((file) => file.trim().length > 0);
  return findLiteLLMConfigs([...explicit, ...known]);
}

function routesThroughProxy(routes: CopilotRoute[], port: number): boolean {
  return routes.every((route) => route.apiBase !== undefined && pointsToProxy(route.apiBase, port));
}

/**
 * Fa passare dal proxy le rotte di LiteLLM verso Copilot. Il momento resta
 * nella configurazione: da li' in poi `reload` lascia quelle chiamate al
 * traffico misurato dal vivo.
 */
function applyLiteLLM(values: Record<string, string>, port: number, explicit: string[]): void {
  const files = liteLLMConfigs(explicit);
  if (files.length === 0) {
    console.log(
      '\nLiteLLM: nessuna configurazione con modelli github_copilot/ trovata. ' +
        'Indicala con --litellm-config <file> (il file passato a "litellm --config").',
    );
    return;
  }

  let routed = 0;
  for (const file of files) {
    let result: ReturnType<typeof applyLiteLLMRouting>;
    try {
      result = applyLiteLLMRouting(file, port);
    } catch (error) {
      console.log(`\nLiteLLM: non riesco a modificare ${file}: ${(error as Error).message}`);
      continue;
    }
    routed += result.updated + result.already;
    console.log(
      `LiteLLM: ${file}: ${result.updated} modelli Copilot indirizzati al proxy` +
        (result.already > 0 ? `, ${result.already} gia' indirizzati` : '') +
        (result.backup ? ` (backup in ${result.backup})` : ''),
    );
    for (const route of result.foreign) {
      console.log(
        `  ${route.alias} lasciato su ${route.apiBase}: se e' un host Copilot del piano, ` +
          'mettilo in --upstream e rilancia il setup',
      );
    }
  }
  if (routed === 0) return;

  values.LITELLM_CONFIG = files.join(',');
  values.LITELLM_MEASURED_SINCE ??= new Date().toISOString();
  console.log("Riavvia LiteLLM perche' la configurazione abbia effetto.");
}

/** Il setup non tocca LiteLLM senza --litellm, ma lo segnala se lo trova. */
function hintLiteLLM(port: number): void {
  const pending = liteLLMConfigs([]).filter((file) => !routesThroughProxy(readCopilotRoutes(file) ?? [], port));
  if (pending.length === 0) return;
  console.log(
    `\nLiteLLM usa Copilot senza passare dal proxy (${pending.join(', ')}): ` +
      'rilancia il setup con --litellm per misurarne il traffico.',
  );
}

function printEditorSettings(port: number, editor?: Editor): void {
  console.log(
    `\nAggiungi alle impostazioni utente di ${editor?.name ?? 'VS Code (e dei suoi derivati)'} (Preferences: Open User Settings (JSON)):\n` +
      `${JSON.stringify(editorSnippet(port), null, 2)}\n` +
      (editor
        ? ''
        : `Imposta anche ${API_URL_VAR}=${proxyUrl(port)} nell'ambiente utente, per Copilot CLI e le sessioni agentiche.\n` +
          'Oppure rilancia il setup con --vscode per far fare tutto al comando.'),
  );
}

function applyRuntimeRouting(port: number): void {
  try {
    const result = installRuntimeRouting(port);
    console.log(`Copilot CLI e sessioni agentiche: ${API_URL_VAR}=${proxyUrl(port)} (in ${result.persistedIn})`);
  } catch (error) {
    console.log(
      `\nNon riesco a impostare ${API_URL_VAR} (${(error as Error).message}): impostala a mano a ${proxyUrl(port)}, ` +
        'altrimenti Copilot CLI e le sessioni agentiche non vengono misurate.',
    );
  }
}

function applyEditors(port: number): void {
  const found = installedEditors();
  // Nessun editor ancora aperto: si prepara VS Code, che e' il caso piu' comune.
  const targets = found.length > 0 ? found : knownEditors().slice(0, 1);

  for (const editor of targets) {
    const result = applyEditorSettings(editor, port);
    if (result.status === 'unparsable') {
      console.log(
        `\n${editor.name}: non riesco a modificare ${editor.settingsFile} senza rischiare di rovinarlo (non e' JSON valido, nemmeno ammettendo commenti).`,
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

  // Solo il servizio rilancia il processo dopo l'aggiornamento: in primo piano
  // il proxy terminerebbe e basta.
  const updater = new SelfUpdater({
    disabledReason: !config.autoUpdate
      ? 'disattivato dalla configurazione (AUTO_UPDATE)'
      : !runsAsService()
        ? "il proxy non e' avviato dal servizio di avvio automatico"
        : undefined,
    idleSince: () => app.idleSince(),
    restart: () => shutdown('aggiornamento'),
  });
  const app = await buildApp(config, { updateStatus: () => updater.status() });
  await app.server.listen({ port: config.port, host: config.host });
  updater.start(app.server.log);

  const shutdown = (reason: string): void => {
    app.server.log.info({ reason }, 'arresto in corso');
    updater.close();
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
    else if (!value && isOverrideCommented(editor)) notConfigured.push(`${editor.name} (impostazione commentata)`);
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

  const runtimeUrl = readRuntimeRouting();
  if (runtimeUrl && pointsToProxy(runtimeUrl, config.port)) {
    check(true, `Copilot CLI e sessioni agentiche passano dal proxy (${API_URL_VAR})`);
  } else {
    warn(
      runtimeUrl
        ? `${API_URL_VAR} punta a ${runtimeUrl}, atteso ${expected}: rilancia "setup --vscode --force"`
        : `${API_URL_VAR} non impostata: Copilot CLI e le sessioni agentiche in VS Code non vengono misurate. Rilancia "setup --vscode --force"`,
    );
  }
  for (const file of liteLLMConfigs([])) {
    const routes = readCopilotRoutes(file) ?? [];
    if (routesThroughProxy(routes, config.port)) {
      check(true, `LiteLLM passa dal proxy per ${routes.length} modelli Copilot (${file})`);
    } else {
      warn(`LiteLLM usa Copilot senza passare dal proxy (${file}): rilancia "setup --litellm --force"`);
    }
  }

  const stale = staleRuntimes(config.port);
  if (stale.length > 0) {
    warn(
      `${stale.length} processi Copilot CLI / runtime agentico avviati senza ${API_URL_VAR} (pid ${stale.join(', ')}): ` +
        "chiudi e riapri l'editor (non basta ricaricare la finestra) e i terminali con Copilot CLI",
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
    const elsewhere = serviceElsewhere();
    if (elsewhere) {
      warn(`il servizio avvia ${elsewhere}, non questa installazione: ${RELINK_HINT}`);
    } else if (health.version && health.version !== CLIENT_VERSION) {
      warn(`il proxy in esecuzione e' la ${health.version}, questo comando la ${CLIENT_VERSION}: lancia "restart"`);
    }
    if (health.update?.lastError) {
      warn(`aggiornamento automatico non riuscito: ${health.update.lastError}`);
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
  update?: UpdateStatus;
  startedAt?: string;
  spoolBytes?: number;
  usage?: {
    recorded: number;
    delivered: number;
    dropped: number;
    lastEventAt: string | null;
    lastDeliveryAt: string | null;
    lastError: string | null;
    lastEventByClient?: Record<string, string>;
  };
}

/** Pid dei runtime agentici in esecuzione che non passano dal proxy. */
function staleRuntimes(port: number): number[] {
  return (runningRuntimes() ?? [])
    .filter((runtime) => !runtime.apiUrl || !pointsToProxy(runtime.apiUrl, port))
    .map((runtime) => runtime.pid);
}

const CLIENT_LABELS: Record<string, string> = {
  GitHubCopilotChat: 'estensione Copilot Chat',
  copilot: 'Copilot CLI / runtime agentico',
};

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
  const elsewhere = serviceElsewhere();
  if (elsewhere) console.log(`  avvia ${elsewhere}, non questa installazione: ${RELINK_HINT}`);

  // Instradamento: e' cio' che decide se il traffico passa di qui.
  for (const editor of installedEditors()) {
    const value = readOverride(editor);
    const state =
      value && pointsToProxy(value, config.port)
        ? 'passa dal proxy'
        : !value && isOverrideCommented(editor)
          ? 'NON passa dal proxy (impostazione commentata)'
          : value
            ? `NON passa dal proxy (punta a ${value})`
            : 'NON passa dal proxy (impostazione assente)';
    console.log(`${editor.name}: ${state}`);
  }
  const runtimeUrl = readRuntimeRouting();
  console.log(
    `Copilot CLI / sessioni agentiche (${API_URL_VAR}): ${
      runtimeUrl && pointsToProxy(runtimeUrl, config.port) ? 'passano dal proxy' : `NON passano dal proxy (${runtimeUrl ?? 'non impostata'})`
    }`,
  );
  const stale = staleRuntimes(config.port);
  if (stale.length > 0) {
    console.log(`  ${stale.length} processi avviati prima del setup (pid ${stale.join(', ')}): riavvia l'editor`);
  }
  if (!health) {
    console.log(`proxy: non in ascolto sulla porta ${config.port}`);
    return 1;
  }

  const usage = health.usage;
  console.log(`proxy: ${health.version ?? '?'} in ascolto dal ${health.startedAt ?? '?'}`);
  if (usage) {
    console.log(`eventi misurati: ${usage.recorded}, consegnati: ${usage.delivered}, scartati: ${usage.dropped}`);
    console.log(`ultimo evento: ${usage.lastEventAt ?? 'nessuno'}`);
    for (const [family, at] of Object.entries(usage.lastEventByClient ?? {})) {
      console.log(`  ${CLIENT_LABELS[family] ?? family}: ${at}`);
    }
    console.log(`ultima consegna: ${usage.lastDeliveryAt ?? 'nessuna'}`);
    if (usage.lastError) console.log(`ultimo errore del collector: ${usage.lastError}`);
  }
  console.log(`spool: ${health.spoolBytes ?? 0} byte in attesa`);
  console.log(`aggiornamento automatico: ${describeUpdate(health)}`);
  if (health.update?.lastError) console.log(`  ultimo errore: ${health.update.lastError}`);
  return 0;
}

function describeUpdate(health: ProxyHealth): string {
  const update = health.update;
  // I proxy precedenti non lo riportano.
  if (!update) return `non previsto dalla ${health.version ?? 'versione'} in esecuzione`;
  if (!update.enabled) return `no, ${update.reason ?? 'motivo sconosciuto'}`;
  if (update.pending) return `installata la ${update.pending}, riparte appena il proxy e' inattivo`;
  return `attivo per le versioni stabili${update.lastCheckAt ? `, ultimo controllo ${update.lastCheckAt}` : ''}`;
}

/**
 * Data della riga di comando. Un giorno senza orario e' in ora locale, come lo
 * intende chi lo scrive; `endOfDay` lo trasforma nel limite esclusivo del giorno dopo.
 */
function parseDate(value: string, endOfDay: boolean): Date {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dayOnly ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`Data non valida: ${value}. Usa AAAA-MM-GG.`);
  if (dayOnly && endOfDay) date.setDate(date.getDate() + 1);
  return date;
}

function formatTokens(value: number): string {
  return value.toLocaleString('it-IT');
}

function printPlan(plan: ReloadPlan, knowsRoutes: boolean): void {
  const rows = new Map<string, { calls: number; usage: TokenCounters }>();
  for (const event of plan.events) {
    const row = rows.get(event.projectId) ?? {
      calls: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    };
    row.calls += 1;
    row.usage.inputTokens += event.usage.inputTokens;
    row.usage.cachedInputTokens += event.usage.cachedInputTokens;
    row.usage.cacheWriteTokens += event.usage.cacheWriteTokens;
    row.usage.outputTokens += event.usage.outputTokens;
    rows.set(event.projectId, row);
  }

  const ordered = [...rows].sort(([, a], [, b]) => totalInputTokens(b.usage) - totalInputTokens(a.usage));
  for (const [project, { calls, usage }] of ordered) {
    console.log(
      `  ${project}\n    ${calls} chiamate, input ${formatTokens(totalInputTokens(usage))} ` +
        `(cache ${formatTokens(usage.cachedInputTokens)} letti, ${formatTokens(usage.cacheWriteTokens)} scritti), ` +
        `output ${formatTokens(usage.outputTokens)}`,
    );
  }
  console.log(
    `\nCopilot CLI e sessioni agentiche: ${plan.sources['copilot-cli']} chiamate` +
      `\nChat di VS Code: ${plan.sources['vscode-chat']} richieste, ${formatTokens(Math.round(plan.chatCredits))} crediti addebitati`,
  );
  for (const source of AGENT_SOURCES) {
    if (plan.sources[source] > 0) console.log(`${SOURCE_LABELS[source]}: ${plan.sources[source]} chiamate passate da Copilot`);
  }

  const { noBilling, unpriced, noRates } = plan.skippedChat;
  if (noBilling > 0) console.log(`  escluse ${noBilling} richieste salvate senza crediti (editor troppo vecchio)`);
  if (noRates > 0) console.log(`  escluse ${noRates} richieste: senza listino non si possono ricostruire`);
  for (const [model, requests] of unpriced) {
    console.log(`  escluse ${requests} richieste con ${model}: il collector non ha la tariffa`);
  }

  const { notRouted, measured } = plan.skippedAgents;
  if (notRouted.size > 0) {
    const total = [...notRouted.values()].reduce((sum, count) => sum + count, 0);
    console.log(
      knowsRoutes
        ? `\nEscluse ${total} chiamate di harness con modelli che LiteLLM non mandava a Copilot:`
        : `\nEscluse ${total} chiamate di harness: senza una config di LiteLLM non si sa se passavano da Copilot:`,
    );
    for (const [label, count] of [...notRouted].sort(([, a], [, b]) => b - a).slice(0, 10)) {
      console.log(`  ${count}  ${label}`);
    }
    console.log(
      'Se passavano da Copilot: --litellm-config <file> con la config di LiteLLM di allora, ' +
        'oppure --agents-all per caricare tutto il periodo indicato.',
    );
  }
  if (measured > 0) {
    console.log(`\nEscluse ${measured} chiamate di harness da quando LiteLLM passa dal proxy: gia' misurate dal vivo`);
  }

  const { folders, noFolder } = plan.skippedOutside;
  if (noFolder > 0) {
    console.log(`\nEscluse ${noFolder} sessioni senza cartella locale (finestra vuota, WSL, SSH o container)`);
  }
  if (folders.size > 0) {
    const total = [...folders.values()].reduce((sum, count) => sum + count, 0);
    console.log(`\nEscluse ${total} chiamate/richieste fuori dalle cartelle indicate. Le principali:`);
    for (const [folder, count] of [...folders].sort(([, a], [, b]) => b - a).slice(0, 10)) {
      console.log(`  ${count}  ${folder}`);
    }
    console.log('Per includerle: reload <cartella che le contiene>');
  }

  printMonths(plan);
}

const SOURCE_LABELS: Record<ReloadSource, string> = {
  'copilot-cli': 'Copilot CLI',
  'vscode-chat': 'chat di VS Code',
  'claude-code': 'Claude Code',
  cline: 'Cline',
  opencode: 'opencode',
};

const AGENT_SOURCES: ReloadSource[] = ['claude-code', 'cline', 'opencode'];

/** Eventi per mese e per sorgente: un mese vuoto qui e' vuoto anche in dashboard. */
function printMonths(plan: ReloadPlan): void {
  const sourceOf = new Map(Object.entries(CLIENT_NAMES).map(([source, client]) => [client, source as ReloadSource]));
  // Le due sorgenti di Copilot sempre, gli harness solo se ci sono.
  const columns = (Object.keys(SOURCE_LABELS) as ReloadSource[]).filter(
    (source) => !AGENT_SOURCES.includes(source) || plan.sources[source] > 0,
  );
  const months = new Map<string, Map<ReloadSource, number>>();
  for (const event of plan.events) {
    const source = sourceOf.get(event.clientName ?? '');
    if (!source) continue;
    const month = event.occurredAt.slice(0, 7);
    const row = months.get(month) ?? new Map<ReloadSource, number>();
    row.set(source, (row.get(source) ?? 0) + 1);
    months.set(month, row);
  }
  if (months.size === 0) return;
  console.log(`\nEventi per mese (${columns.map((source) => SOURCE_LABELS[source]).join(' / ')}):`);
  for (const [month, row] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${month}  ${columns.map((source) => row.get(source) ?? 0).join(' / ')}`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = await promptLine(`${question} [s/N] `);
  return /^(s|si|sì|y|yes)$/i.test(answer);
}

/** Come riconoscere le chiamate di Claude Code, Cline e opencode passate da Copilot. */
function agentPolicy(flags: Record<string, string | boolean | undefined>): AgentPolicy {
  const files = liteLLMConfigs(flags['litellm-config'] ? [String(flags['litellm-config'])] : []);
  const routes = files.flatMap((file) => readCopilotRoutes(file) ?? []);
  const since = readConfigFile().LITELLM_MEASURED_SINCE;
  const measuredSince = since ? new Date(since) : undefined;
  return {
    matcher: routes.length > 0 ? copilotModelMatcher(routes) : undefined,
    all: flags['agents-all'] === true,
    measuredSince: measuredSince && !Number.isNaN(measuredSince.getTime()) ? measuredSince : undefined,
  };
}

async function commandReload(
  flags: Record<string, string | boolean | undefined>,
  root: string | undefined,
): Promise<number> {
  let config: ClientConfig;
  let options: ReloadOptions;
  try {
    config = loadConfig(mergedSource({}));
    options = {
      roots: root ? [resolvePath(root)] : config.workspaceRoots,
      markers: config.projectMarkers,
      from: flags.from ? parseDate(String(flags.from), false) : undefined,
      to: flags.to ? parseDate(String(flags.to), true) : undefined,
      agents: agentPolicy(flags),
      copilotHome: config.copilotHome,
    };
  } catch (error) {
    console.error(`${(error as Error).message}\n\nSe e' la prima volta:  npx @vidiemme/copilot-proxy setup`);
    return 1;
  }
  const dryRun = flags['dry-run'] === true;

  console.log(`Sessioni dei progetti sotto ${options.roots.join(', ')}`);
  const inputs = readLocalSessions(options);

  let rates: RateBook | undefined;
  try {
    rates = await fetchRates(config, chatModels(inputs.chatRequests));
  } catch (error) {
    console.log(`ATTENZIONE: ${(error as Error).message}`);
  }

  const plan = buildReloadPlan(inputs, options, developerIdFor(config), rates);
  if (plan.events.length === 0) {
    console.log('Nessuna sessione da caricare nel periodo indicato.');
    printPlan(plan, options.agents?.matcher !== undefined);
    return 0;
  }
  printPlan(plan, options.agents?.matcher !== undefined);

  // Le chat di VS Code non hanno un id in comune con il traffico misurato dal
  // vivo: nel periodo in cui il proxy era attivo finirebbero contate due volte.
  const proxySince = proxyFirstStart();
  const overlaps = proxySince && (!options.to || options.to > proxySince) && plan.sources['vscode-chat'] > 0;
  if (overlaps) {
    const day = proxySince.toLocaleDateString('sv-SE');
    console.log(
      `\nATTENZIONE: il proxy misura questa postazione dal ${proxySince.toLocaleString('it-IT')}.` +
        `\nLe chat di VS Code da allora sono probabilmente gia' nel collector e verrebbero contate due volte.` +
        `\nPer escluderle: --to ${day} (o il giorno prima, se quel giorno il proxy non era ancora attivo).`,
    );
  }
  if (hasCliProxyOverlap(plan.events, proxySince)) {
    console.log(
      '\nATTENZIONE: alcune chiamate Copilot CLI ricadono nel periodo misurato dal proxy.' +
        '\nSe misurate prima della correzione degli ID o senza l\'header Copilot, ricaricarle puo\' duplicarle nel collector.' +
        '\nVerifica il periodo prima di inviarle: lo storico non viene riclassificato automaticamente.',
    );
  }

  if (dryRun) {
    console.log(`\n${plan.events.length} eventi pronti. Niente e' stato inviato (--dry-run).`);
    return 0;
  }

  if (flags.yes !== true) {
    if (process.stdin.isTTY !== true) {
      console.error('\nSenza terminale serve --yes per confermare il caricamento.');
      return 1;
    }
    if (!(await confirm(`\nCaricare ${plan.events.length} eventi su ${config.collectorUrl}?`))) {
      console.log('Annullato.');
      return 1;
    }
  }

  const result = await sendEvents(config, plan.events, (sent) => {
    process.stdout.write(`\rinviati ${sent}/${plan.events.length}`);
  });
  process.stdout.write('\n');
  console.log(`Accettati ${result.accepted}, scartati dal collector ${result.rejected}.`);
  if (result.expired > 0) {
    console.log(
      `${result.expired} eventi accolti ma precedenti alla retention del collector: non compaiono nei report.`,
    );
  }
  if (result.error) {
    console.error(`${result.error}: ${result.failed} eventi non inviati. Rilancia lo stesso comando per riprendere.`);
    return 1;
  }
  return 0;
}

const RELINK_HINT = 'rilancia "setup --force --autostart" da questa installazione';

/** Il `cli.js` avviato dal servizio, se non e' quello di questo comando. */
function serviceElsewhere(): string | undefined {
  if (!isAutostartInstalled()) return undefined;
  const registered = registeredEntry();
  if (!registered) return undefined;
  const normalize = (file: string): string => {
    const resolved = resolvePath(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(registered) === normalize(cliEntry()) ? undefined : registered;
}

function commandRestart(): number {
  try {
    restartAutostart();
  } catch (error) {
    console.error(`Riavvio non riuscito: ${(error as Error).message}`);
    return 1;
  }
  console.log('Proxy riavviato.');
  const elsewhere = serviceElsewhere();
  if (elsewhere) console.log(`ATTENZIONE: il servizio avvia ${elsewhere}, non questa installazione: ${RELINK_HINT}`);
  return 0;
}

function commandUninstall(): number {
  // Senza proxy in ascolto il runtime agentico non raggiungerebbe piu' Copilot.
  if (uninstallRuntimeRouting()) {
    console.log(`${API_URL_VAR} rimossa: Copilot CLI e sessioni agentiche tornano a parlare con GitHub.`);
  }
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
    // Per --no-auto-update.
    allowNegative: true,
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
      'auto-update': { type: 'boolean' },
      litellm: { type: 'boolean' },
      'litellm-config': { type: 'string' },
      'agents-all': { type: 'boolean' },
      force: { type: 'boolean' },
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
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
    case 'reload':
      process.exitCode = await commandReload(values, positionals[1]);
      return;
    case 'restart':
      process.exitCode = commandRestart();
      return;
    case 'uninstall':
      process.exitCode = commandUninstall();
      return;
    // Interno: lo lancia l'avvio automatico di Windows.
    case 'supervise':
      runSupervisor();
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
