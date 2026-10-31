import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Variabile con cui il runtime agentico di Copilot (Copilot CLI e le sessioni
 * "Copilot CLI" / Copilot SDK dentro VS Code) sceglie l'endpoint. Quel runtime
 * e' un processo a se': ignora `github.copilot.advanced.debug.overrideCapiUrl`
 * e, senza questa variabile, parla direttamente con GitHub saltando il proxy.
 * Lo eredita dall'ambiente dell'editor, quindi va impostata a livello di
 * sessione utente, non solo nella shell.
 */
export const API_URL_VAR = 'COPILOT_API_URL';

const LABEL = 'com.vidiemme.copilot-proxy.env';

export function proxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function launchAgentFile(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function environmentDFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), '.config'), 'environment.d', 'copilot-proxy.conf');
}

function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

export interface RuntimeRoutingResult {
  /** Dove e' stata resa persistente la variabile. */
  persistedIn: string;
  removeHint: string;
}

/**
 * Indirizza il runtime agentico al proxy per tutte le applicazioni avviate da
 * qui in avanti, e anche dopo un riavvio della macchina.
 */
export function installRuntimeRouting(port: number): RuntimeRoutingResult {
  const url = proxyUrl(port);

  if (process.platform === 'darwin') {
    // `launchctl setenv` vale fino al logout: un LaunchAgent lo ripete a ogni accesso.
    const file = launchAgentFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>${API_URL_VAR}</string>
    <string>${escapeXml(url)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`,
    );
    execFileSync('launchctl', ['setenv', API_URL_VAR, url], { stdio: 'pipe' });
    return {
      persistedIn: file,
      removeHint: `launchctl unsetenv ${API_URL_VAR} && rm ${file}`,
    };
  }

  if (process.platform === 'linux') {
    const file = environmentDFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${API_URL_VAR}=${url}\n`);
    try {
      execFileSync('systemctl', ['--user', 'set-environment', `${API_URL_VAR}=${url}`], { stdio: 'ignore' });
    } catch {
      /* senza systemd vale dal prossimo accesso */
    }
    return { persistedIn: file, removeHint: `rm ${file}` };
  }

  if (process.platform === 'win32') {
    execFileSync('setx', [API_URL_VAR, url], { stdio: 'pipe' });
    return {
      persistedIn: 'variabili d\'ambiente utente',
      removeHint: `reg delete HKCU\\Environment /v ${API_URL_VAR} /f`,
    };
  }

  throw new Error(`piattaforma ${process.platform} non gestita`);
}

/** Rimuove l'instradamento; `false` se non era attivo. */
export function uninstallRuntimeRouting(): boolean {
  if (process.platform === 'darwin') {
    const file = launchAgentFile();
    const present = existsSync(file);
    rmSync(file, { force: true });
    try {
      execFileSync('launchctl', ['unsetenv', API_URL_VAR], { stdio: 'ignore' });
    } catch {
      /* gia' assente */
    }
    return present;
  }

  if (process.platform === 'linux') {
    const file = environmentDFile();
    const present = existsSync(file);
    rmSync(file, { force: true });
    try {
      execFileSync('systemctl', ['--user', 'unset-environment', API_URL_VAR], { stdio: 'ignore' });
    } catch {
      /* senza systemd */
    }
    return present;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', API_URL_VAR, '/f'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Valore che riceveranno le applicazioni avviate d'ora in poi; `undefined` se
 * non impostato. La shell corrente non fa testo: puo' essere stata aperta prima.
 */
export function readRuntimeRouting(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const value = execFileSync('launchctl', ['getenv', API_URL_VAR], { encoding: 'utf-8' }).trim();
      return value || undefined;
    }
    if (process.platform === 'linux') {
      const match = new RegExp(`^${API_URL_VAR}=(.*)$`, 'm').exec(readFileSync(environmentDFile(), 'utf-8'));
      return match?.[1]?.trim() || undefined;
    }
    if (process.platform === 'win32') {
      const output = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', API_URL_VAR], {
        encoding: 'utf-8',
      });
      return /REG_\w+\s+(\S+)/.exec(output)?.[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface RuntimeProcess {
  pid: number;
  /** Valore di `COPILOT_API_URL` con cui il processo e' partito, se presente. */
  apiUrl: string | undefined;
}

/** Runtime agentico dentro l'editor (`copilot-runtime`) o binario nativo di Copilot CLI. */
export function isRuntimeCommand(command: string): boolean {
  return /(^|\/)copilot-runtime(\s|$)/.test(command) || /\/@github\/copilot-[a-z0-9-]+\/copilot(\.exe)?(\s|$)/.test(command);
}

/** Estrae `COPILOT_API_URL` dall'output di `ps eww`, dove l'ambiente segue gli argomenti. */
export function apiUrlFromPsLine(line: string): string | undefined {
  return new RegExp(`(?:^|\\s)${API_URL_VAR}=(\\S+)`).exec(line)?.[1];
}

/**
 * Processi del runtime agentico gia' in esecuzione, con l'URL che hanno
 * ereditato. L'ambiente si legge solo all'avvio: un processo partito prima del
 * setup resta fuori dal proxy finche' non si riavvia l'editor.
 * `undefined` dove non si sa leggere l'ambiente degli altri processi.
 */
export function runningRuntimes(): RuntimeProcess[] | undefined {
  try {
    if (process.platform === 'darwin') {
      const list = execFileSync('ps', ['-x', '-o', 'pid=,command='], { encoding: 'utf-8' });
      const result: RuntimeProcess[] = [];
      for (const row of list.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(row);
        if (!match || !isRuntimeCommand(match[2]!)) continue;
        const pid = Number(match[1]);
        let line = '';
        try {
          line = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
        } catch {
          continue; // terminato nel frattempo
        }
        result.push({ pid, apiUrl: apiUrlFromPsLine(line) });
      }
      return result;
    }

    if (process.platform === 'linux') {
      const result: RuntimeProcess[] = [];
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const command = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0').join(' ');
          if (!isRuntimeCommand(command)) continue;
          const env = readFileSync(`/proc/${entry}/environ`, 'utf-8').split('\0');
          const value = env.find((item) => item.startsWith(`${API_URL_VAR}=`));
          result.push({ pid: Number(entry), apiUrl: value?.slice(API_URL_VAR.length + 1) });
        } catch {
          /* processo di un altro utente o gia' terminato */
        }
      }
      return result;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
