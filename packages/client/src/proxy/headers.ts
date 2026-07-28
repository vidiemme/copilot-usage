/** Header hop-by-hop: non vanno mai propagati oltre il proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Header interni al proxy, non devono raggiungere l'upstream. */
const INTERNAL_HEADERS = new Set(['x-project-id', 'x-developer-id']);

export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  options: { projectHeader: string; overrideAuthToken?: string | undefined; upstreamHost: string },
): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || INTERNAL_HEADERS.has(key)) continue;
    if (key === options.projectHeader) continue;
    if (key === 'host' || key === 'content-length') continue;
    if (value === undefined) continue;

    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }

  headers.set('host', options.upstreamHost);

  // Il corpo deve arrivare in chiaro: undici non decomprime automaticamente e
  // uno stream SSE compresso sarebbe illeggibile sia per il parser di usage sia
  // per il client, a cui inoltriamo i byte cosi' come li riceviamo.
  headers.set('accept-encoding', 'identity');

  if (options.overrideAuthToken) {
    headers.set('authorization', `Bearer ${options.overrideAuthToken}`);
  }

  return headers;
}

export function buildDownstreamHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    // La lunghezza viene ricalcolata da Node: il corpo passa in streaming.
    if (key === 'content-length' || key === 'content-encoding') return;
    out[name] = value;
  });
  return out;
}
