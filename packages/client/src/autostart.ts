import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './paths.js';

const LABEL = 'com.vidiemme.copilot-proxy';
const UNIT = 'copilot-proxy.service';

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
  return undefined;
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
    throw new Error(
      `Avvio automatico non gestito su ${process.platform}. Su Windows aggiungi a mano un collegamento a "${process.execPath} ${cliEntry()} start" nella cartella Esecuzione automatica.`,
    );
  }

  const entry = cliEntry();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });

  const result: AutostartResult =
    process.platform === 'darwin' ? installLaunchd(file, entry) : installSystemd(file, entry);

  // La cache di npx non e' una posizione stabile: `npm cache clean` la svuota e
  // il servizio resterebbe a puntare nel vuoto.
  const warnings: string[] = [];
  if (entry.includes('/_npx/')) {
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
