import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const OVERRIDE_KEY = 'github.copilot.advanced.debug.overrideCapiUrl';
const AUTH_TYPE_KEY = 'github.copilot.advanced.debug.overrideAuthType';

export interface Editor {
  name: string;
  settingsFile: string;
}

/**
 * Editor derivati da VS Code: stessa estensione Copilot, stesse impostazioni,
 * cambia solo la cartella dei dati utente. JetBrains, Eclipse, Xcode e Visual
 * Studio usano il Copilot Language Server, che non ha un URL di override.
 */
const VSCODE_FAMILY: [name: string, folder: string][] = [
  ['VS Code', 'Code'],
  ['VS Code Insiders', 'Code - Insiders'],
  ['VSCodium', 'VSCodium'],
  ['Cursor', 'Cursor'],
  ['Windsurf', 'Windsurf'],
  ['Antigravity', 'Antigravity'],
];

function userDataRoot(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

export function knownEditors(): Editor[] {
  const root = userDataRoot();
  return VSCODE_FAMILY.map(([name, folder]) => ({
    name,
    settingsFile: join(root, folder, 'User', 'settings.json'),
  }));
}

/** Editor usati almeno una volta su questa macchina: hanno gia' la cartella dei dati utente. */
export function installedEditors(): Editor[] {
  return knownEditors().filter((editor) => existsSync(dirname(dirname(editor.settingsFile))));
}

export function editorSnippet(port: number): Record<string, string> {
  return { [OVERRIDE_KEY]: `http://127.0.0.1:${port}`, [AUTH_TYPE_KEY]: 'token' };
}

export type ApplyResult =
  | { status: 'updated'; backup: string | undefined }
  | { status: 'unparsable' };

export function applyEditorSettings(editor: Editor, port: number): ApplyResult {
  const file = editor.settingsFile;
  let current: Record<string, unknown> = {};
  let backup: string | undefined;

  try {
    const raw = readFileSync(file, 'utf-8');
    // `settings.json` ammette commenti e virgole finali: riscriverlo li distruggerebbe.
    current = raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unparsable' };
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...current, ...editorSnippet(port) }, null, 2)}\n`);
  return { status: 'updated', backup };
}

/** Valore di override letto dal file, senza `JSON.parse`: il file puo' contenere commenti. */
export function readOverride(editor: Editor): string | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(editor.settingsFile, 'utf-8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`"${OVERRIDE_KEY.replace(/\./g, '\\.')}"\\s*:\\s*"([^"]*)"`).exec(raw);
  return match ? (match[1] ?? '') : null;
}

export function pointsToProxy(value: string, port: number): boolean {
  return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(value);
}
