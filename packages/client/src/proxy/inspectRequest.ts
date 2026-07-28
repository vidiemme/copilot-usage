interface RequestFacts {
  model?: string;
  sessionId?: string;
  stream: boolean;
  /** Corpo eventualmente riscritto per abilitare la contabilizzazione. */
  body: Buffer;
}

const SESSION_PATTERN = /session_([0-9a-f-]{8,})/i;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Ispeziona il corpo della richiesta per ricavare modello e sessione, e
 * garantisce che l'upstream restituisca i contatori di usage.
 *
 * Per gli endpoint in stile OpenAI l'usage in streaming e' opzionale e va
 * richiesto esplicitamente con `stream_options.include_usage`; senza di esso
 * la risposta non conterrebbe alcun contatore. Gli endpoint Anthropic lo
 * includono sempre e il corpo resta invariato.
 */
export function inspectRequest(path: string, body: Buffer): RequestFacts {
  if (body.length === 0) return { stream: false, body };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return { stream: false, body };
  }

  const root = asObject(parsed);
  if (!root) return { stream: false, body };

  const model = typeof root.model === 'string' ? root.model : undefined;
  const stream = root.stream === true;

  let sessionId: string | undefined;
  const metadata = asObject(root.metadata);
  if (typeof metadata?.user_id === 'string') {
    sessionId = SESSION_PATTERN.exec(metadata.user_id)?.[1];
  }

  const isOpenAiStyle = path.includes('/chat/completions') || path.includes('/responses');
  if (stream && isOpenAiStyle && root.stream_options === undefined) {
    root.stream_options = { include_usage: true };
    return { model, sessionId, stream, body: Buffer.from(JSON.stringify(root), 'utf-8') };
  }

  return { model, sessionId, stream, body };
}
