import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './paths.js';

const LABEL = 'com.vidiemme.copilot-proxy';
const UNIT = 'copilot-proxy.service';
/** Segnala al supervisore Windows che e' gia' staccato dalla finestra di avvio. */
const SUPERVISED_VAR = 'COPILOT_PROXY_SUPERVISED';
/** Pausa prima di rilanciare il proxy terminato, come `RestartSec` di systemd. */
const RESTART_DELAY_MS = 5000;

export interface AutostartResult {
  file: string;
  /** Comando per disattivarlo: va stampato, cosi' chi installa sa come tornare indietro. */
  removeHint: string;
  /** Avvertenza se il percorso registrato potrebbe non sopravvivere. */
  warning?: string;
}

export function autostartFile(): string | undefined {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  }
  if (process.platform === 'linux') {
    return join(homedir(), '.config', 'systemd', 'user', UNIT);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'copilot-proxy.cmd');
  }
  return undefined;
}

/**
 * Vero se il processo e' stato lanciato dal servizio, che lo rilancia quando
 * termina. Si riconosce dall'ambiente, cosi' vale anche per i servizi
 * registrati da versioni precedenti.
 */
export function runsAsService(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (platform === 'darwin') return env.XPC_SERVICE_NAME === LABEL;
  if (platform === 'linux') return Boolean(env.INVOCATION_ID);
  if (platform === 'win32') return env[SUPERVISED_VAR] === '1';
  return false;
}

export function isAutostartInstalled(): boolean {
  const file = autostartFile();
  return file !== undefined && existsSync(file);
}

/**
 * Percorso del `cli.js` compilato, risolto rispetto a questo modulo.
 *
 * Non si usa `process.argv[1]`: con un `bin` di npm quello e' uno shim, e il
 * servizio deve puntare al file vero.
 */
function cliEntry(): string {
  return fileURLToPath(new URL('cli.js', import.meta.url));
}

function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

function environmentOverrides(): Record<string, string> {
  const home = process.env.COPILOT_PROXY_HOME?.trim();
  // Il servizio parte senza l'ambiente della shell: se la configurazione non e'
  // nella posizione di default, il percorso va inciso nel servizio stesso.
  return home ? { COPILOT_PROXY_HOME: home } : {};
}

export function installAutostart(): AutostartResult {
  const file = autostartFile();
  if (file === undefined) {
    throw new Error(`Avvio automatico non gestito su ${process.platform}.`);
  }

  const entry = cliEntry();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });

  const result: AutostartResult =
    process.platform === 'darwin'
      ? installLaunchd(file, entry)
      : process.platform === 'win32'
        ? installStartup(file, entry)
        : installSystemd(file, entry);

  // La cache di npx non e' una posizione stabile: `npm cache clean` la svuota e
  // il servizio resterebbe a puntare nel vuoto.
  const warnings: string[] = [];
  if (/[\\/]_npx[\\/]/.test(entry)) {
    warnings.push(
      'Il servizio punta dentro la cache di npx, che puo\' essere ripulita. Per un avvio automatico stabile: npm i -g @vidiemme/copilot-proxy, poi rilancia il setup con --autostart',
    );
  }
  if (VERSION_MANAGER_PATH.test(process.execPath)) {
    warnings.push(
      `Il servizio usa ${process.execPath}, gestito da un version manager: se quella versione di Node viene disinstallata il proxy non riparte. Dopo un cambio di versione rilancia il setup con --autostart --force`,
    );
  }
  if (warnings.length > 0) result.warning = warnings.join('\n');
  return result;
}

/** Node installato da nvm, fnm, asdf, mise, n o volta: il percorso cambia a ogni versione. */
const VERSION_MANAGER_PATH =
  /[\\/](\.nvm|\.?fnm|\.asdf|\.volta[\\/]tools|n[\\/]versions|mise[\\/]installs)[\\/]/;

function launchdTarget(): string {
  return `gui/${process.getuid?.() ?? ''}/${LABEL}`;
}

/** Rimuove il servizio; `false` se non era installato. */
export function uninstallAutostart(): boolean {
  const file = autostartFile();
  if (file === undefined || !existsSync(file)) return false;

  try {
    if (process.platform === 'darwin') {
      execFileSync('launchctl', ['bootout', launchdTarget()], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      stopSupervisor();
    } else {
      execFileSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'ignore' });
    }
  } catch {
    /* gia' fermo */
  }
  rmSync(file, { force: true });
  if (process.platform === 'linux') {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  }
  return true;
}

/** Riavvia il servizio, ad esempio dopo un aggiornamento del pacchetto. */
export function restartAutostart(): void {
  if (!isAutostartInstalled()) throw new Error('avvio automatico non installato');
  if (process.platform === 'darwin') {
    execFileSync('launchctl', ['kickstart', '-k', launchdTarget()], { stdio: 'pipe' });
  } else if (process.platform === 'win32') {
    stopSupervisor();
    launchSupervisor(cliEntry());
  } else {
    execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'pipe' });
  }
}

function installLaunchd(file: string, entry: string): AutostartResult {
  const log = join(configDir(), 'proxy.log');
  const env = environmentOverrides();
  const envBlock =
    Object.keys(env).length === 0
      ? ''
      : `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env)
          .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
          .join('\n')}\n  </dict>\n`;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(entry)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${envBlock}  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`;
  writeFileSync(file, plist);

  const domain = `gui/${process.getuid?.() ?? ''}`;
  // Un servizio gia' caricato fa fallire `bootstrap`: si scarica prima, e se
  // non c'era l'errore non interessa.
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    /* non era caricato */
  }
  // `bootout` e' asincrono: finche' launchd non ha finito, `bootstrap` fallisce con EIO (5).
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'pipe' });
      break;
    } catch (error) {
      if (attempt >= 10) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }

  return { file, removeHint: `launchctl bootout ${domain}/${LABEL} && rm ${file}` };
}

function installSystemd(file: string, entry: string): AutostartResult {
  const env = environmentOverrides();
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join('\n');

  const unit = `[Unit]
Description=Proxy locale di misurazione del consumo Copilot
After=network-online.target

[Service]
ExecStart=${process.execPath} ${entry} start
Restart=always
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
  writeFileSync(file, unit);

  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  execFileSync('systemctl', ['--user', 'enable', '--now', UNIT], { stdio: 'pipe' });

  return { file, removeHint: `systemctl --user disable --now ${UNIT} && rm ${file}` };
}

/**
 * Script per la cartella Esecuzione automatica di Windows.
 *
 * Non serve essere amministratori, a differenza di un'attivita' pianificata
 * all'accesso. In un `.cmd` il `%` va raddoppiato, altrimenti cmd lo espande
 * come variabile.
 */
export function startupScript(execPath: string, entry: string, env: Record<string, string>): string {
  const escape = (value: string): string => value.replace(/%/g, '%%');
  const lines = [
    '@echo off',
    // Percorsi con caratteri accentati: il file e' UTF-8, la console no.
    'chcp 65001 >nul',
    ...Object.entries(env).map(([key, value]) => `set "${key}=${escape(value)}"`),
    `"${escape(execPath)}" "${escape(entry)}" supervise`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function installStartup(file: string, entry: string): AutostartResult {
  writeFileSync(file, startupScript(process.execPath, entry, environmentOverrides()));
  // Come `bootstrap` e `enable --now`: il proxy parte subito, non al prossimo accesso.
  stopSupervisor();
  launchSupervisor(entry);
  return { file, removeHint: 'copilot-proxy uninstall' };
}

function supervisorPidFile(): string {
  return join(configDir(), 'supervisor.pid');
}

/** Avvia il supervisore staccato da qualunque console, senza finestre. */
function launchSupervisor(entry: string): void {
  mkdirSync(configDir(), { recursive: true });
  const log = openSync(join(configDir(), 'proxy.log'), 'a');
  spawn(process.execPath, [entry, 'supervise'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, [SUPERVISED_VAR]: '1' },
  }).unref();
}

/**
 * Ferma il supervisore e, con lui, il proxy. Un pid riciclato puo' appartenere
 * a un altro programma: si termina solo se e' ancora un processo Node.
 */
function stopSupervisor(): void {
  let pid: number;
  try {
    pid = Number(readFileSync(supervisorPidFile(), 'utf-8').trim());
  } catch {
    return;
  }
  rmSync(supervisorPidFile(), { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8' });
    if (!row.toLowerCase().includes(`"${basename(process.execPath).toLowerCase()}"`)) return;
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* gia' terminato */
  }
}

/**
 * Tiene in vita il proxy su Windows, dove non c'e' un gestore di servizi
 * utente come launchd o systemd.
 *
 * Lanciato dalla cartella Esecuzione automatica si rilancia staccato, cosi' la
 * finestra di cmd si chiude subito; da li' riavvia il proxy ogni volta che
 * termina. Su Windows l'arresto e' sempre forzato: si perdono al massimo gli
 * eventi non ancora scritti nello spool, come a ogni spegnimento.
 */
export function runSupervisor(): void {
  const entry = cliEntry();
  if (process.env[SUPERVISED_VAR] !== '1') {
    launchSupervisor(entry);
    return;
  }

  writeFileSync(supervisorPidFile(), String(process.pid));
  const launch = (): void => {
    const child = spawn(process.execPath, [entry, 'start'], { windowsHide: true, stdio: 'inherit' });
    let restarting = false;
    const again = (): void => {
      if (restarting) return;
      restarting = true;
      setTimeout(launch, RESTART_DELAY_MS);
    };
    child.on('exit', again);
    child.on('error', again);
  };
  launch();
}
