import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parseTree, type FormattingOptions, type ParseError } from 'jsonc-parser';

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

/** Rientro gia' usato nel file, cosi' le righe aggiunte non stonano (VS Code scrive con i tab). */
function formattingOf(text: string): FormattingOptions {
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent?.length ?? 2, eol };
}

export function applyEditorSettings(editor: Editor, port: number): ApplyResult {
  const file = editor.settingsFile;
  let text = '';
  let backup: string | undefined;

  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unparsable' };
  }

  // `settings.json` ammette commenti e virgole finali: si modificano solo le
  // due chiavi, lasciando intatto il resto del file.
  if (text.trim().length === 0) text = '{}\n';
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || root?.type !== 'object') return { status: 'unparsable' };

  if (existsSync(file)) {
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }

  const formattingOptions = formattingOf(text);
  for (const [key, value] of Object.entries(editorSnippet(port))) {
    text = applyEdits(text, modify(text, [key], value, { formattingOptions }));
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  return { status: 'updated', backup };
}

const OVERRIDE_PATTERN = OVERRIDE_KEY.replace(/\./g, '\\.');

function readSettings(editor: Editor): string | undefined {
  try {
    return readFileSync(editor.settingsFile, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Valore di override letto dal file, senza `JSON.parse`: il file puo' contenere
 * commenti. Una riga commentata non conta: per l'editor l'override non c'e'.
 */
export function readOverride(editor: Editor): string | null | undefined {
  const raw = readSettings(editor);
  if (raw === undefined) return undefined;
  const match = new RegExp(`^[ \\t{,]*"${OVERRIDE_PATTERN}"\\s*:\\s*"([^"]*)"`, 'm').exec(raw);
  return match ? (match[1] ?? '') : null;
}

/** L'override c'e' ma e' disattivato con `//`: tipico quando si esclude il proxy "per un attimo". */
export function isOverrideCommented(editor: Editor): boolean {
  const raw = readSettings(editor);
  return raw !== undefined && new RegExp(`^\\s*//.*"${OVERRIDE_PATTERN}"`, 'm').test(raw);
}

export function pointsToProxy(value: string, port: number): boolean {
  return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(value);
}
