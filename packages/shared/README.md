# @vidiemme/copilot-usage-contract

[![npm](https://img.shields.io/npm/v/@vidiemme/copilot-usage-contract)](https://www.npmjs.com/package/@vidiemme/copilot-usage-contract)

Contratto fra il client di misurazione ([`@vidiemme/copilot-proxy`](https://www.npmjs.com/package/@vidiemme/copilot-proxy))
e il servizio di raccolta che conserva i consumi di token di GitHub Copilot.

Il client misura e attribuisce; il server prezza e conserva. Il confine e' volutamente povero:
passano solo contatori e identificatori, mai prompt, completion o credenziali. Il costo **non**
fa parte del payload, perche' il listino sta sul server: un client vecchio non deve poter
scrivere prezzi sbagliati, ne' un client manomesso poter dichiarare quanto ha speso.

Questo README e' la **specifica del protocollo**: e' il riferimento per chi implementa un
collector compatibile o un client alternativo. Il pacchetto contiene i tipi e la validazione
che entrambi i lati usano.

## Indice

- [Installazione](#installazione)
- [Il protocollo](#il-protocollo)
- [L'evento](#levento)
- [Risposte](#risposte)
- [Le scelte che contano](#le-scelte-che-contano)
- [Cosa esporta il pacchetto](#cosa-esporta-il-pacchetto)
- [Versionamento e compatibilita'](#versionamento-e-compatibilita)

## Installazione

```bash
npm i @vidiemme/copilot-usage-contract
```

Richiede Node >= 22.9. Il pacchetto e' solo ESM e non ha dipendenze.

## Il protocollo

Un solo endpoint, chiamato dal client in batch:

```
POST /v1/usage
Authorization: Bearer <token di ingest>
Content-Type: application/json
User-Agent: @vidiemme/copilot-proxy/<versione>
X-Developer-Name: Mario%20Rossi
X-Developer-Email: mario.rossi%40example.com

{ "events": [ <evento>, ... ] }
```

| Header | Obbligatorio | Significato |
| --- | --- | --- |
| `Authorization` | si' | `Bearer` con un token di ingest condiviso nell'organizzazione. Non e' il token Copilot. |
| `Content-Type` | si' | `application/json`. |
| `User-Agent` | no | `@vidiemme/copilot-proxy/<versione>`: il collector ne ricava la versione del client. |
| `X-Developer-Name` | no | Nome confermato dal developer al setup, percent-encoded. Vale per tutti gli eventi del batch. |
| `X-Developer-Email` | no | Email associata, percent-encoded. Considerata solo insieme al nome. |

Nome ed email viaggiano negli header, non nell'evento, perche' descrivono la postazione e non
la singola richiesta. Un client avviato con `--anonymous` non li manda.

Il corpo contiene da **1 a 500** eventi (`MAX_EVENTS_PER_BATCH`). Il client di riferimento
manda batch da 100.

## L'evento

```json
{
  "requestId": "chatcmpl-9f2c...",
  "occurredAt": "2026-10-31T09:12:44.120Z",
  "developerId": "794d98febee52e98",
  "developerSource": "pseudonym",
  "projectId": "acme/web/portal",
  "projectSource": "workspace",
  "repository": {
    "projectId": "acme/web/portal",
    "host": "gitlab.com",
    "groups": ["acme", "web"],
    "name": "portal",
    "remoteUrl": "git@gitlab.com:acme/web/portal.git"
  },
  "clientName": "GitHubCopilotChat/0.72.0",
  "sessionId": "c1a5...",
  "endpoint": "/chat/completions",
  "model": "gpt-5.4",
  "usage": {
    "inputTokens": 1830,
    "cachedInputTokens": 12400,
    "cacheWriteTokens": 0,
    "outputTokens": 412
  },
  "streamed": true,
  "durationMs": 4210
}
```

`parseUsageEvent` applica queste regole. Un campo obbligatorio mancante, o un contatore non
valido, rende l'evento inutilizzabile; un campo descrittivo troppo lungo viene troncato.

| Campo | Tipo | Obbligatorio | Regola |
| --- | --- | --- | --- |
| `requestId` | string | si' | Chiave di deduplica. Troncato a 200 caratteri. |
| `occurredAt` | string | si' | Data interpretabile, normalizzata in ISO 8601 UTC. |
| `developerId` | string | si' | Troncato a 200. |
| `developerSource` | string | si' | Troncato a 40. Vedi le [sorgenti](#sorgenti-dellattribuzione). |
| `projectId` | string | si' | Troncato a 200. |
| `projectSource` | string | si' | Troncato a 40. |
| `repository` | oggetto o `null` | no | Identita' del repository rilevato; vedi sotto. |
| `clientName` | string o `null` | no | User-agent del client a monte. Troncato a 200. |
| `sessionId` | string o `null` | no | Finestra o conversazione. Troncato a 200. |
| `endpoint` | string | si' | Path dell'API chiamata, senza prefissi di attribuzione. Troncato a 500. |
| `model` | string o `null` | no | Modello dichiarato dalla risposta, o dalla richiesta. Troncato a 200. |
| `usage` | oggetto | si' | Quattro contatori; vedi sotto. |
| `streamed` | boolean | no | `true` solo se esplicitamente `true`. |
| `durationMs` | number o `null` | no | Arrotondato per difetto, mai negativo. |

`repository`, se presente:

| Campo | Regola |
| --- | --- |
| `projectId` | Obbligatorio. Percorso sul server Git, per esempio `acme/web/portal`. |
| `host` | Host del remote, o `null`. |
| `groups` | Gruppi parent in ordine, dal piu' esterno. Al massimo 20. |
| `name` | Obbligatorio. Nome del repository. |
| `remoteUrl` | URL del remote, o `null` se l'identita' e' stata dedotta dal nome della cartella. |

`usage`: quattro interi da 0 a 1.000.000.000, tutti obbligatori. Un valore negativo, non
numerico o oltre il miliardo rende l'evento invalido: e' certamente un errore, non un consumo.

| Contatore | Contiene |
| --- | --- |
| `inputTokens` | Token in ingresso **esclusi** quelli serviti o scritti in cache. |
| `cachedInputTokens` | Token letti dalla cache. |
| `cacheWriteTokens` | Token scritti in cache, dove il provider li fattura. |
| `outputTokens` | Token generati. |

### Sorgenti dell'attribuzione

Il contratto accetta qualsiasi stringa, cosi' un client nuovo puo' introdurre una sorgente
senza rompere il server. Il client di riferimento produce questi valori:

| `projectSource` | Significato |
| --- | --- |
| `path` | Prefisso `/p/<progetto>` nella base URL. |
| `header` | Header `X-Project-Id` (nome configurabile). |
| `proxy-auth` | Username di `Proxy-Authorization`. |
| `token` | Mappa statica `ATTRIBUTION_TOKENS`. |
| `workspace` | Rilevato dai path locali citati nella richiesta. |
| `session` | Ereditato dall'ultima richiesta della stessa sessione. |
| `fallback` | Nessun segnale: progetto `unassigned`. |

| `developerSource` | Significato |
| --- | --- |
| `path` | Prefisso `/u/<developer>`. |
| `header` | Header `X-Developer-Id`. |
| `token` | Mappa statica `ATTRIBUTION_TOKENS`. |
| `pseudonym` | Hash con salt del campo stabile del token Copilot. |
| `fallback` | Nessun segnale: developer `unknown`. |

## Risposte

| Stato | Corpo | Quando | Il client di riferimento |
| --- | --- | --- | --- |
| `202` | `{ "accepted": n }` | Tutti gli eventi validi sono stati scritti. | Considera consegnato il batch. |
| `202` | `{ "accepted": n, "rejected": [{ "index", "requestId", "error" }] }` | Alcuni eventi erano malformati; gli altri sono stati scritti. | Scarta i rifiutati e li segnala nei log. |
| `400` | `{ "error": "payload_non_valido", ... }` | Batch vuoto, oltre 500 eventi, o nessun evento valido. | Scarta il batch: ritentare non cambierebbe nulla. |
| `401` | `{ "error": "non_autorizzato" }` | Token mancante o non valido. | Tiene gli eventi nello spool: un token ruotato si sistema sulla postazione. |
| `503` | `{ "error": "storage_non_disponibile" }` | Il database non ha accettato la scrittura. | Tiene gli eventi nello spool e ritenta. |

Il client di riferimento ritenta anche su errori di rete, timeout, `403`, `408`, `429` e
qualsiasi `5xx`. Un collector compatibile deve quindi rispondere `202` **solo dopo** aver
reso persistenti gli eventi: un `202` seguito da una perdita non e' recuperabile.

## Le scelte che contano

`requestId` e' la chiave di deduplica: il client puo' rinviare un batch senza timore di
raddoppiare i consumi, il che rende sicuro lo spool su disco quando il collector e'
irraggiungibile. Un collector compatibile deve ignorare un `requestId` gia' visto.

I contatori di `TokenCounters` **non si sovrappongono**: `inputTokens` esclude i token serviti
dalla cache, che stanno in `cachedInputTokens` e `cacheWriteTokens`. Ognuno ha la sua tariffa,
quindi sommarli sarebbe un doppio conteggio; per il totale in ingresso c'e' `totalInputTokens`.
Nel formato OpenAI `prompt_tokens` include gia' la cache: e' il client a sottrarla.

`repository.groups` conserva i gruppi parent in ordine: e' la base per aggregare per cliente,
business unit o area anche a posteriori, senza riclassificare a mano.

La validazione e' **asimmetrica** di proposito: tronca i campi descrittivi invece di rifiutarli,
cosi' un client con uno user-agent anomalo non fa perdere la misura, e rifiuta solo cio' che
renderebbe il record insensato o inutile come chiave. Valida un evento alla volta, cosi' un
evento malformato non costa gli altri del batch.

Il confine di validazione e' il server, non il client: il client misura e consegna, il server
decide cosa e' accettabile.

## Cosa esporta il pacchetto

| Export | Tipo | Uso |
| --- | --- | --- |
| `UsageEventPayload`, `TokenCounters`, `RepositoryIdentity`, `IngestBody` | tipi | Forma dell'evento e del corpo. |
| `parseUsageEvent(input)` | funzione | Normalizza un evento; lancia `InvalidEventError` se e' inutilizzabile. |
| `parseIngestBody(input)` | funzione | Valida l'intero corpo; lancia al primo evento invalido. |
| `InvalidEventError` | classe | Errore di validazione, con il motivo nel messaggio. |
| `MAX_EVENTS_PER_BATCH` | costante | `500`: guida per il client, tetto per il server. |
| `totalInputTokens(usage)` | funzione | Somma dei tre contatori di input. |

Per accettare un batch parziale, come fa il collector di riferimento, si valida evento per
evento con `parseUsageEvent` e si raccolgono i rifiutati:

```ts
import { InvalidEventError, MAX_EVENTS_PER_BATCH, parseUsageEvent } from '@vidiemme/copilot-usage-contract';

const raw = body?.events;
if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS_PER_BATCH) {
  return reply.code(400).send({ error: 'payload_non_valido' });
}

const accepted = [];
const rejected = [];
raw.forEach((item, index) => {
  try {
    accepted.push(parseUsageEvent(item));
  } catch (error) {
    if (!(error instanceof InvalidEventError)) throw error;
    rejected.push({ index, requestId: item?.requestId ?? null, error: error.message });
  }
});
```

`parseIngestBody` resta utile dove un batch e' tutto valido o tutto da rifiutare.

## Versionamento e compatibilita'

Il contratto ha un ciclo di versioni suo, indipendente dal client: si incrementa solo quando
cambia. Viene pubblicato prima del client, che a runtime ne importa `MAX_EVENTS_PER_BATCH` e
`totalInputTokens`.

I proxy installati sulle postazioni si aggiornano quando vogliono, quindi ogni modifica deve
restare retrocompatibile con loro:

- **sicuro**: aggiungere campi opzionali, perche' la validazione ignora quello che non conosce;
- **sicuro**: aggiungere nuovi valori di `projectSource` o `developerSource`;
- **breaking**: rimuovere o rinominare un campo, renderne obbligatorio uno opzionale,
  restringere un limite. Richiede di aggiornare prima il collector e poi tutti i client.

Documentazione del sistema: <https://github.com/vidiemme/copilot-usage>.
