/**
 * Parser incrementale di Server-Sent Events.
 *
 * Accetta chunk arbitrari (anche spezzati a meta' di un evento) e invoca il
 * callback una volta per ogni payload `data:` deserializzabile come JSON.
 * I payload non-JSON (es. `[DONE]`) vengono ignorati silenziosamente.
 */
export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly onPayload: (payload: unknown) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  end(): void {
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.buffer = '';
  }

  private drain(flush: boolean): void {
    // Gli eventi SSE sono separati da una riga vuota; si accettano sia \n\n
    // che \r\n\r\n.
    const normalized = this.buffer.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');
    const tail = flush ? '' : (parts.pop() ?? '');
    this.buffer = tail;

    for (const part of parts) {
      if (part.trim().length === 0) continue;
      this.emit(part);
    }

    if (flush && tail.trim().length > 0) this.emit(tail);
  }

  private emit(rawEvent: string): void {
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;

    const data = dataLines.join('\n');
    if (data === '[DONE]') return;

    try {
      this.onPayload(JSON.parse(data));
    } catch {
      // Payload non JSON: non e' un evento di usage, si ignora.
    }
  }
}
