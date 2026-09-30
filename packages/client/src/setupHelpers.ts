import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

export interface DeveloperIdentity {
  name?: string;
  email?: string;
}

function gitConfig(key: string): string | undefined {
  try {
    const value = execFileSync('git', ['config', '--global', key], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Nome ed email con cui il developer firma i commit: il default piu' ragionevole per la dashboard. */
export function gitIdentity(): DeveloperIdentity {
  return { name: gitConfig('user.name'), email: gitConfig('user.email') };
}

export type PortStatus = 'free' | 'proxy' | 'busy';

/** Distingue una porta libera da una gia' occupata dal proxy stesso o da altro. */
export async function portStatus(port: number, host: string): Promise<PortStatus> {
  const free = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
  if (free) return 'free';

  try {
    const response = await fetch(`http://127.0.0.1:${port}/_health`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json()) as { upstream?: unknown; collector?: unknown };
    return body.upstream !== undefined && body.collector !== undefined ? 'proxy' : 'busy';
  } catch {
    return 'busy';
  }
}
