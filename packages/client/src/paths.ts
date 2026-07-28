import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cartella dove il client tiene configurazione e stato.
 *
 * Sotto `npx` la working directory e' quella da cui il developer ha lanciato il
 * comando, cioe' un posto qualsiasi: file di configurazione e spool devono
 * stare in una posizione stabile, non relativa alla cwd.
 */
export function configDir(): string {
  const override = process.env.COPILOT_PROXY_HOME?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) return join(appData, 'copilot-proxy');
  }

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), '.config'), 'copilot-proxy');
}

export function configFile(): string {
  return join(configDir(), 'config.json');
}

export function defaultSpoolPath(): string {
  return join(configDir(), 'spool.jsonl');
}

/** Percorso del `settings.json` utente di VS Code, per la piattaforma corrente. */
export function vscodeSettingsFile(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  return join(homedir(), '.config', 'Code', 'User', 'settings.json');
}
