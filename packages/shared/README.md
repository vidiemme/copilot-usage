# @vidiemme/copilot-usage-contract

Contratto fra il client di misurazione ([`@vidiemme/copilot-proxy`](https://www.npmjs.com/package/@vidiemme/copilot-proxy))
e il servizio di raccolta che conserva i consumi di token di GitHub Copilot.

Il client misura e attribuisce; il server prezza e conserva. Il confine e' volutamente povero:
passano solo contatori e identificatori, mai prompt, completion o credenziali. Il costo **non**
fa parte del payload, perche' il listino sta sul server: un client vecchio non deve poter
scrivere prezzi sbagliati, ne' un client manomesso poter dichiarare quanto ha speso.

## Installazione

```bash
npm i @vidiemme/copilot-usage-contract
```

Richiede Node >= 22.9. Il pacchetto e' solo ESM.

## Cosa esporta

**Tipi** — `UsageEventPayload`, `TokenCounters`, `RepositoryIdentity`, `IngestBody`.

**Validazione** — `parseUsageEvent(input)` e `parseIngestBody(input)` normalizzano quello che
arriva dalla rete, lanciando `InvalidEventError` quando il dato e' inutilizzabile. Sono
volutamente asimmetrici: **troncano** i campi descrittivi (nome del client, modello, endpoint)
invece di rifiutare, cosi' un client con uno user-agent anomalo non fa perdere la misura, e
**rifiutano** solo cio' che renderebbe il record insensato o inutile come chiave.

**Costanti e utilita'** — `MAX_EVENTS_PER_BATCH` (500), che vale sia da guida per il client sia
da tetto per il server, e `totalInputTokens(usage)`.

```ts
import { parseIngestBody, InvalidEventError } from '@vidiemme/copilot-usage-contract';

try {
  const { events } = parseIngestBody(await request.json());
  await store(events);
} catch (error) {
  if (error instanceof InvalidEventError) return reply.code(400).send({ error: error.message });
  throw error;
}
```

## Le scelte che contano

`requestId` e' la chiave di deduplica: il client puo' rinviare un batch senza timore di
raddoppiare i consumi, il che rende sicuro lo spool su disco quando il collector e'
irraggiungibile.

I contatori di `TokenCounters` **non si sovrappongono**: `inputTokens` esclude i token serviti
dalla cache, che stanno in `cachedInputTokens` e `cacheWriteTokens`. Ognuno ha la sua tariffa,
quindi sommarli sarebbe un doppio conteggio — per il totale in ingresso c'e' `totalInputTokens`.

`repository.groups` conserva i gruppi parent in ordine: e' la base per aggregare per cliente,
business unit o area anche a posteriori. Quando l'identita' e' stata dedotta dal nome della
cartella invece che dal remote, `remoteUrl` e' `null`.

## Versionamento

Il contratto e' pubblicato prima del client, che a runtime ne importa `MAX_EVENTS_PER_BATCH` e
`totalInputTokens`. Un cambiamento che rimuove o rinomina un campo e' breaking per entrambi i
lati: aggiungere campi opzionali e' invece sicuro, perche' la validazione ignora quello che non
conosce.

Documentazione completa: <https://github.com/vidiemme/copilot-usage>.
