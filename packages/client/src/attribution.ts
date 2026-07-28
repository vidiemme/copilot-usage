import { pseudonymize, stableIdentity, type ClientConfig } from './config.js';

export type AttributionSource =
  | 'path'
  | 'header'
  | 'proxy-auth'
  | 'token'
  | 'workspace'
  | 'session'
  | 'pseudonym'
  | 'fallback';

export interface Attribution {
  projectId: string;
  developerId: string;
  /** Da dove e' stato ricavato il progetto: utile per misurare la copertura. */
  projectSource: AttributionSource;
  /** Da dove arriva il developer: `pseudonym` = hash del token, non un nome reale. */
  developerSource: AttributionSource;
  clientName: string | null;
}

export interface AttributionInput {
  /** Path della richiesta, comprensivo degli eventuali prefissi `/u/` e `/p/`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface AttributionResult extends Attribution {
  /** Path ripulito dai prefissi di attribuzione, da inoltrare upstream. */
  upstreamPath: string;
}

/**
 * Prefissi di attribuzione: `/u/<developer>` e `/p/<progetto>`, in qualsiasi
 * ordine e opzionali. Il lookahead impone che segua altro path, cosi' una
 * richiesta a `/p/acme` senza endpoint non viene interpretata come prefisso.
 */
const ATTRIBUTION_SEGMENT = /^\/(u|p)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\/)/;

function headerValue(
  headers: AttributionInput['headers'],
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function decodeBasic(value: string | undefined): { user: string; pass: string } | undefined {
  if (!value) return undefined;
  const match = /^basic\s+(.+)$/i.exec(value.trim());
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf-8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return { user: decoded.slice(0, separator), pass: decoded.slice(separator + 1) };
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1]!.trim() : value.trim();
}

/** Riduce un valore arbitrario a un identificatore stabile e sicuro da indicizzare. */
export function sanitizeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

const sanitize = sanitizeIdentifier;

/**
 * Determina progetto e developer di una richiesta.
 *
 * L'ordine di precedenza riflette quanto e' esplicito il segnale:
 *  1. prefissi di path `/u/<developer>/p/<progetto>` — base URL dedicata
 *  2. header `X-Project-Id` / `X-Developer-Id`
 *  3. username delle credenziali proxy — client con forward proxy configurabile
 *  4. mappa token statica
 *  5. per il developer, hash salato del token upstream (pseudonimo stabile);
 *     per il progetto, `unassigned`
 */
export function resolveAttribution(input: AttributionInput, config: ClientConfig): AttributionResult {
  const headers = input.headers;

  let projectId: string | undefined;
  let projectSource: AttributionSource = 'fallback';
  let developerId: string | undefined;
  let developerSource: AttributionSource = 'fallback';
  let upstreamPath = input.path;

  for (;;) {
    const match = ATTRIBUTION_SEGMENT.exec(upstreamPath);
    if (!match) break;
    upstreamPath = upstreamPath.slice(match[0].length);

    const value = sanitize(match[2]);
    if (!value) continue;

    if (match[1] === 'p') {
      projectId ??= value;
      projectSource = 'path';
    } else {
      developerId ??= value;
      developerSource = 'path';
    }
  }

  if (!projectId) {
    projectId = sanitize(headerValue(headers, config.projectHeader));
    if (projectId) projectSource = 'header';
  }

  if (!developerId) {
    developerId = sanitize(headerValue(headers, 'x-developer-id'));
    if (developerId) developerSource = 'header';
  }

  const proxyAuth = decodeBasic(headerValue(headers, 'proxy-authorization'));
  if (!projectId && proxyAuth) {
    projectId = sanitize(proxyAuth.user);
    if (projectId) projectSource = 'proxy-auth';
  }

  const upstreamToken = bearerToken(headerValue(headers, 'authorization'));
  const mapping =
    (upstreamToken ? config.attributionTokens[upstreamToken] : undefined) ??
    (proxyAuth ? config.attributionTokens[proxyAuth.pass] : undefined);

  if (!projectId && mapping?.projectId) {
    projectId = sanitize(mapping.projectId);
    if (projectId) projectSource = 'token';
  }

  if (!developerId && mapping?.developerId) {
    developerId = sanitize(mapping.developerId);
    if (developerId) developerSource = 'token';
  }

  if (!developerId && upstreamToken) {
    developerId = pseudonymize(stableIdentity(upstreamToken), config.developerIdSalt);
    developerSource = 'pseudonym';
  }

  const userAgent = headerValue(headers, 'user-agent');

  return {
    projectId: projectId ?? config.unassignedProject,
    projectSource,
    developerId: developerId ?? 'unknown',
    developerSource,
    clientName: userAgent ? userAgent.slice(0, 200) : null,
    upstreamPath,
  };
}
