# copilot-usage

Proxy di misurazione del consumo di token GitHub Copilot, con attribuzione **per progetto**
oltre che per persona.

Il problema che risolve: le statistiche native di Copilot sono verticali per utente, quindi
non dicono quanto costa un cliente o una commessa quando piu' developer lavorano su piu'
progetti. Un client locale si mette in mezzo al traffico, legge i contatori di token che il
modello restituisce e li manda a un servizio centrale, che li converte in costo con il listino
GitHub e li scrive su Postgres.

Questo repository contiene la **meta' pubblica**: il proxy che gira sulla postazione del
developer e il contratto che parla con il servizio di raccolta. Il servizio di raccolta sta in
un repository separato e privato, perche' custodisce listino, schema del database e dati di
costo aziendali.

| Client | Attribuzione |
| --- | --- |
| Claude Code, Codex e altri CLI agentici | **per progetto** e per developer |
| Copilot Chat in VS Code / Visual Studio | **per progetto** e per developer, dedotto dai path |

## Le due parti

```
                  macchina del developer          cloud
                 ┌────────────────────────┐     ┌──────────────────┐
VS Code / CLI ──►│ client (proxy)         │────►│ server           │
                 │  misura, non prezza    │ API │  prezza, salva   │
                 └───────────┬────────────┘     └────────┬─────────┘
                             │                           │
                             ▼                           ▼
                  api.githubcopilot.com            Postgres
```

| | `@vidiemme/copilot-proxy` | `@vidiemme/copilot-usage-collector` |
| --- | --- | --- |
| Dove sta | **questo repository**, pubblico su npm | repository separato, privato |
| Dove gira | postazione del developer | cloud, sempre disponibile |
| Cosa fa | proxy trasparente, estrae i contatori, riconosce il progetto | applica il listino, deduplica, persiste, espone il reporting |
| Cosa gli serve | `COLLECTOR_URL` e `COLLECTOR_TOKEN` | accesso al database |
| Cosa **non** ha | credenziali del database, listino prezzi | token Copilot, prompt, path locali |

Il taglio non e' arbitrario. Il listino sta sul server perche' aggiornarlo non deve richiedere
di ridistribuire n postazioni, e perche' un client vecchio o manomesso non deve poter
dichiarare quanto ha speso: manda solo contatori grezzi. Il database sta dietro il server
perche' le sue credenziali non devono finire su n macchine. Il traffico Copilot **non** passa
dal cloud: il client parla direttamente con `api.githubcopilot.com`, e al collector arrivano
solo eventi di consumo.

E' anche il motivo per cui i due repository sono separati: qui non c'e' niente da tenere
riservato, e un pacchetto che i developer installano con `npx` e' piu' credibile se il codice
si puo' leggere. Il contratto sul filo (`@vidiemme/copilot-usage-contract`) e' pubblico per la
stessa ragione: e' l'interfaccia, non il contenuto.

Il client non dipende mai dalla raggiungibilita' del server: se il collector e' giu' o la rete
manca, le richieste Copilot continuano a passare e gli eventi restano su un file di spool,
rispediti al primo tentativo utile. La chiave `request_id` rende i rinvii innocui.

> **Modello di fiducia.** Il token di ingest e' un segreto condiviso a livello di
> organizzazione: chiunque lo possieda puo' dichiarare qualsiasi `developer_id` e
> `project_id`. E' contabilita' analitica interna, **non** un confine di sicurezza. Se serve
> attribuzione non ripudiabile occorrono credenziali per postazione e un'identita' verificata
> lato server: qui non c'e'.

## Come funziona la misura

Il client e' un passthrough trasparente: inoltra la richiesta cosi' com'e' e duplica il flusso
di risposta verso un parser di usage. Non tocca il contenuto della conversazione e **non
persiste mai prompt o completion**, solo contatori.

Riconosce entrambi i dialetti senza configurazione:

| Formato | Dove sta l'usage |
| --- | --- |
| Anthropic Messages | `message_start` (input, cache read, cache write) + `message_delta` (output) |
| OpenAI / Copilot chat completions | chunk finale con `usage`, richiede `stream_options.include_usage` |

Per il secondo caso il client **inietta automaticamente** `stream_options: { include_usage: true }`
nelle richieste in streaming: senza quel flag l'upstream non restituirebbe alcun contatore.

## Avvio

Serve Node >= 22.9.

### 1. Il servizio di raccolta

Va avviato per primo, dal suo repository: e' lui a distribuire il `COLLECTOR_URL` e il token di
ingest che serviranno a tutte le postazioni. Un solo token per tutta l'organizzazione.

In Vidiemme e' gia' attivo su **`https://copilot-collector.swarm.vidiemme.it`**: l'endpoint di
ingest da usare nel setup e' `https://copilot-collector.swarm.vidiemme.it/v1/usage`, il token
va chiesto a chi lo amministra.

### 2. Il client, su ogni postazione

Il client e' pubblicato su npm: sulle postazioni non serve clonare questo repository, ne'
creare file di configurazione a mano. Endpoint di raccolta, salt degli pseudonimi e cartelle
di lavoro sono default committati nel pacchetto ([`src/defaults.ts`](packages/client/src/defaults.ts)):
l'unica cosa da procurarsi e' il token di ingest.

```bash
# una volta sola, e poi basta: il token viene chiesto in modo nascosto
npx @vidiemme/copilot-proxy@latest setup --vscode --autostart

# per un rollout non interattivo (MDM, script)
COLLECTOR_TOKEN=<token> npx @vidiemme/copilot-proxy@latest setup --vscode --autostart

# quando qualcosa non torna
npx @vidiemme/copilot-proxy@latest doctor
```

Aggiornare l'endpoint di raccolta o il salt non richiede quindi di ripassare da n postazioni:
si pubblica una versione nuova del pacchetto. Chi ha bisogno di scostarsi dai default ha
comunque `--collector-url`, `--salt` e `--workspace-roots`.

Con `--vscode` e `--autostart` il rollout per il team e' una sola riga da
incollare: la prima scrive le impostazioni utente di VS Code, la seconda registra
il proxy fra i servizi dell'utente. Nessuno deve piu' lanciare `start` a mano ne'
toccare `settings.json`.

L'avvio automatico usa `launchd` su macOS (`~/Library/LaunchAgents`) e un unit
utente `systemd` su Linux (`~/.config/systemd/user`); su Windows il comando
stampa cosa mettere in Esecuzione automatica. Il servizio riparte da solo se il
proxy muore, e il comando stampa la riga per disattivarlo.

Una sola avvertenza: se hai installato via `npx`, il servizio punta dentro la
cache di npx, che `npm cache clean` puo' svuotare. Per un avvio automatico che
non si rompe mai, `npm i -g @vidiemme/copilot-proxy` e poi il setup con
`--autostart`. Il comando lo segnala da solo.

`setup` scrive `~/.config/copilot-proxy/config.json` con permessi `0600`
(`%APPDATA%\copilot-proxy` su Windows; `COPILOT_PROXY_HOME` sposta la cartella).
Il file contiene **solo cio' che si discosta dai default**: di norma il token e
nient'altro. Le sue chiavi sono le stesse delle variabili d'ambiente elencate
piu' sotto.

I valori si sovrappongono in quest'ordine: **opzioni della riga di comando >
variabili d'ambiente > file di configurazione > default**. Sotto `npx` non viene
letto nessun `.env` dalla working directory: sarebbe una cartella qualsiasi, e
raccogliere da li' un file altrui e' un rischio inutile.

Il token di raccolta non ha un'opzione dedicata di proposito: gli argomenti dei
processi sono visibili con `ps` agli altri utenti della macchina, e finirebbero
nella cronologia della shell. Il comando lo chiede in modo nascosto, oppure lo
legge da `COLLECTOR_TOKEN` (utile per un rollout via MDM).

`--vscode` scrive le due impostazioni utente di VS Code, dopo aver salvato un
`.bak`. Se `settings.json` contiene commenti — legittimo, e' JSONC — il comando
non lo tocca e stampa lo snippet da incollare a mano.

`doctor` verifica configurazione, cartelle di lavoro, raggiungibilita' e validita'
del token verso il servizio di raccolta, impostazione di VS Code, eventi rimasti
nello spool e proxy in ascolto. Esce con codice diverso da zero se qualcosa non va.

Due vincoli che il client verifica all'avvio, e per cui si rifiuta di partire:

- il salt degli pseudonimi deve essere **identico su tutte le macchine**: e' cio' che rende lo
  pseudonimo della stessa persona confrontabile fra postazioni. Non viene generato a caso dal
  `setup` proprio per questo — e' una costante del pacchetto. Cambiarlo spezza la continuita'
  dello storico: da quel momento la stessa persona compare con un id nuovo.
- `COLLECTOR_URL` in `http://` e' ammesso solo verso localhost: altrove il token di ingest
  viaggerebbe in chiaro.

#### Sviluppo del client da questo repository

```bash
npm install
cp packages/client/.env.example packages/client/.env
npm run dev
```

Il `.env` serve **solo** allo sviluppo del proxy, per puntarlo a un collector locale: le
postazioni non ne hanno uno. In sviluppo viene caricato da `node --env-file-if-exists`, non da
codice, cosi' il percorso `npx` e quello locale restano distinti.

Verifica che tutto risponda prima di configurare gli editor:

```bash
curl -s localhost:8787/_health     # client
npm run smoke                      # proxy reale contro un upstream finto
npm run verify-detection           # rilevamento del progetto, con un collector finto
npm run verify-e2e                 # client -> collector -> Postgres (collector gia' avviato)
```

`npm run smoke` e `npm run verify-detection` non richiedono ne' Postgres ne' collector: sono
le verifiche eseguibili su qualsiasi postazione. `verify-e2e` invece attraversa tutto lo stack
e richiede il servizio di raccolta in esecuzione.

`UPSTREAM_BASE_URL` puo' puntare direttamente a `https://api.githubcopilot.com` oppure a un
traduttore Anthropic↔Copilot che gia' usi (es. `copilot-api` su `http://127.0.0.1:4141`).
Il client funziona in entrambi i casi.

### 3. Pubblicare una nuova versione del client

Da CI, spingendo un tag:

```bash
npm version 0.2.0 -w @vidiemme/copilot-proxy   # e il contratto, se e' cambiato
git tag v0.2.0 && git push --tags
```

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) esegue typecheck,
test e build, verifica che il tag corrisponda alle versioni dichiarate, poi pubblica.

L'autenticazione usa **trusted publishing**: GitHub Actions si autentica su npm via
OIDC, con credenziali usa e getta. Non c'e' nessun token npm da mettere nei secret
ne' da ruotare. Va configurato una volta su npmjs.com, nelle impostazioni di
**entrambi** i pacchetti, indicando organizzazione, repository e `publish.yml` come
workflow autorizzato. Il campo `repository` in `package.json` deve combaciare
esattamente con il repository GitHub, altrimenti la pubblicazione viene rifiutata.

**La prima pubblicazione va fatta a mano.** Il trusted publisher si configura dalle
impostazioni di un pacchetto, e finche' il pacchetto non esiste sul registry quelle
impostazioni non ci sono. Quindi: `npm run release` da locale una volta, poi si
configura il trusted publishing su npmjs.com, e da li' in avanti rilascia la CI.

Il contratto viene pubblicato per primo, perche' il client ne importa a runtime la
dimensione massima del batch e la somma dei token di input; se la sua versione e'
gia' sul registry il passo viene saltato, cosi' un rilascio del solo client non
fallisce. Entrambi i pacchetti hanno `publishConfig.access: public`, altrimenti npm
tratterebbe uno scope come privato.

In locale, se serve pubblicare a mano:

```bash
npm run release      # typecheck, test, poi pubblica contratto e proxy
```

## Attribuzione al progetto

Il conteggio dei token e' la parte facile; capire **a quale progetto** imputarlo e' il vero
problema, perche' nessun client manda la working directory. Il proxy risolve il progetto con
questa precedenza:

> I due client hanno sistemi di configurazione separati e che non si conoscono:
> `.claude/settings.json` e' letto **solo** da Claude Code (il CLI, e l'estensione VS Code che
> lancia quello stesso CLI), mentre l'estensione GitHub Copilot legge solo le impostazioni di
> VS Code. Non esiste un file che li configuri entrambi: da qui il design a piu' livelli.

### 1. Rilevamento automatico dai path (default, zero configurazione per repo)

Le richieste di chat e agent mode trasportano il contesto di lavoro: file aperti, riferimenti
espliciti, risultati degli strumenti dell'agente. Tutti nominano **file reali sul disco**. Il
proxy risale da quei path fino al marker di progetto piu' vicino (`.git`) e ne usa il nome.

```bash
WORKSPACE_ROOTS=/Users/nome.cognome/Work
PROJECT_MARKERS=.git,.hg,.svn
```

`WORKSPACE_ROOTS` delimita cosa e' lecito risolvere: un path fuori da quelle cartelle viene
ignorato. Un repository nuovo funziona subito, senza toccare nulla. Quando una richiesta cita
piu' progetti vince il piu' menzionato, cosi' un riferimento isolato a un altro repo non
dirotta l'attribuzione.

L'identita' del progetto **non** e' il nome della cartella — quello lo sceglie chi clona ed e'
diverso da macchina a macchina — ma il percorso sul server Git, letto dal remote `origin`:

| Remote | `project_id` | `repo_owner` | `repo_name` |
| --- | --- | --- | --- |
| `git@gitlab.com:acme/web/portal.git` | `acme/web/portal` | `acme` | `portal` |
| `https://github.com/acme/legacy-crm.git` | `acme/legacy-crm` | `acme` | `legacy-crm` |

I gruppi parent vengono conservati nella tabella `projects` (`repo_groups`), cosi' le
aggregazioni per cliente, business unit o area restano possibili anche a posteriori, senza
riclassificare a mano. Senza remote si ripiega sul nome della cartella: quei progetti si
riconoscono perche' hanno `remote_url IS NULL`.

Le richieste che non nominano alcun file (generazione del titolo, domande secche) ereditano il
progetto dell'ultima richiesta della **stessa sessione** — la finestra dell'editor, distinta
tramite l'header di sessione. Due progetti aperti in parallelo restano quindi separati.
L'ereditarieta' scade dopo `PROJECT_STICKY_TTL_MS` (30 minuti).

Cosa finisce a database: **solo l'identita' del repository**. Il corpo della richiesta viene
letto in memoria e scartato.

### 2. Prefisso di path — CLI agentici

Base URL dedicata per repo, committata nel repo stesso. Ha la precedenza sul rilevamento
automatico.

`.claude/settings.json` del progetto:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787/p/acme-portal"
  }
}
```

I prefissi `/u/<developer>` e `/p/<progetto>` sono entrambi opzionali e accettati in qualsiasi
ordine: `/u/g.carassale/p/acme-portal/v1/messages`.

### 3. Header di progetto

Se preferisci una base URL unica:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Project-Id: acme-portal"
  }
}
```

### 4. Credenziali proxy — client che supportano un forward proxy

Lo **username** delle credenziali proxy viene usato come id progetto:

```
http://acme-portal:token@127.0.0.1:8787
```

Utile per client configurabili per progetto (script, CI, tool custom). **Non** funziona per
Copilot Chat in VS Code: vedi la sezione dedicata piu' sotto.

### 5. Fallback

Tutto il resto finisce in `unassigned`. La colonna `project_source` di `usage_events` dice da
dove e' arrivata l'attribuzione — `workspace`, `session`, `path`, `header`, `proxy-auth`,
`token`, `fallback` — e serve a misurare la copertura reale:

```bash
curl "localhost:8080/_usage/summary?groupBy=source"
```

L'id developer viene ricavato, in ordine, da `X-Developer-Id`, dalla mappa
`ATTRIBUTION_TOKENS`, oppure da un **hash salato del token upstream** — pseudonimo stabile
che non conserva credenziali.

## Copilot Chat in VS Code

**Una sola impostazione, identica su tutte le macchine, messa una volta.** Il progetto non sta
nell'URL: lo deduce il proxy. Non servono profili, ne' configurazione per repository.

Impostazioni utente (`Preferences: Open User Settings (JSON)`), distribuibili via MDM o
Settings Sync:

```json
{
  "github.copilot.advanced.debug.overrideCapiUrl": "http://127.0.0.1:8787",
  "github.copilot.advanced.debug.overrideAuthType": "token"
}
```

`overrideCapiUrl` e' l'endpoint di chat e agent mode, cioe' l'unico traffico fatturato in AI
credits. `overrideAuthType: "token"` non e' un segreto ma una modalita': serve perche' con un
URL di override l'estensione userebbe HMAC, che l'upstream reale rifiuterebbe.

Perche' proprio queste due chiavi, e perche' nelle impostazioni **utente**:

| Impostazione | Scope | Conseguenza |
| --- | --- | --- |
| `http.proxy` | `APPLICATION` / `MACHINE` | non committabile in `.vscode/settings.json` |
| `github.copilot.advanced.debug.overrideCapiUrl` | `userScopeOnly` | idem |

Non esiste un modo per far passare il traffico di Copilot Chat dal proxy senza una di queste,
o in alternativa senza un forward proxy con intercettazione TLS. Ma poiche' il valore e'
costante per tutti, il costo di configurazione e' una riga sola, una volta sola.

Da **non** impostare: `overrideProxyUrl` punta all'endpoint delle code completions, che non
consumano AI credits — dirottarlo aggiunge rischio senza dare dati.

> Sono impostazioni di **debug, non documentate e non supportate**: possono cambiare o sparire
> tra una release e l'altra dell'estensione. Verifica dopo ogni aggiornamento che il traffico
> arrivi ancora al proxy, e tieni pronto il rollback (rimuovere le due chiavi).

Perche' il progetto venga riconosciuto serve che il client giri **sulla stessa macchina** del
developer (i path sono locali) e che `WORKSPACE_ROOTS` copra le cartelle di lavoro. E' la
ragione per cui il proxy e' locale e solo la raccolta e' centralizzata: un proxy condiviso
vedrebbe path che non puo' risolvere, e resterebbe solo l'attribuzione esplicita per prefisso
di path o header.

### TLS

Sull'URL `http://127.0.0.1:8787` il token Copilot non lascia la macchina, quindi non serve
TLS fra editor e client. Serve invece **fra client e collector**: li' passa il token di ingest.
Usa `https://` in `COLLECTOR_URL` — il client si rifiuta di partire se punta in chiaro a un
host che non sia localhost.

Se invece esponi il client oltre localhost (postazione condivisa, macchina di sviluppo remota),
allora il token Copilot attraversa la rete e TLS torna obbligatorio:

```bash
TLS_KEY_PATH=/etc/copilot-proxy/key.pem
TLS_CERT_PATH=/etc/copilot-proxy/cert.pem
```

e usa `https://` in `overrideCapiUrl`. Se il certificato e' firmato da una CA interna, installala
nel trust store del sistema: VS Code la usa gia' (`http.systemCertificates` e' attivo di default).
Non disabilitare `http.proxyStrictSSL`.

### Verifica del rollout

```bash
# 1. il client locale risponde e vede il collector
curl http://127.0.0.1:8787/_health

# 2. dopo qualche prompt in VS Code, il traffico deve comparire qui
curl "https://copilot-collector.swarm.vidiemme.it/_usage/summary?groupBy=developer"

# 3. nessun modello deve finire fra gli sconosciuti
curl https://copilot-collector.swarm.vidiemme.it/_usage/unknown-models
```

Se il punto 1 risponde ma il punto 2 resta vuoto, guarda il file di spool indicato da
`SPOOL_PATH`: se cresce, il client sta misurando ma non riesce a consegnare, e nei suoi log
c'e' il motivo (`collector irraggiungibile`, `collector ha rifiutato gli eventi`).

Il traffico VS Code arriva con `project_source` a `workspace` o `session` e `client_name`
valorizzato con lo user agent dell'estensione: usa quest'ultimo per distinguerlo dai CLI
agentici nelle query. Un `project_source = 'fallback'` diffuso significa che `WORKSPACE_ROOTS`
non copre le cartelle di lavoro reali.

### L'alternativa: TLS interception

L'unico modo per attribuire il traffico VS Code a un progetto sarebbe un forward proxy con
terminazione TLS su `*.githubcopilot.com` e CA aziendale sulle macchine. **Non e' implementato
qui**, e prima di percorrerlo considera che in Italia ricade nell'art. 4 dello Statuto dei
Lavoratori: va concordato con HR/legale e comunicato ai developer. Anche cosi', restando
`http.proxy` di scope applicazione, non otterresti comunque il progetto.

## Il contratto sul filo

`packages/shared` e' pubblicato come `@vidiemme/copilot-usage-contract`: e' cio' che il client
e il servizio di raccolta devono condividere, ed e' l'unica parte del sistema che li lega.

```
POST /v1/usage
Authorization: Bearer <token di ingest>
Content-Type: application/json

{ "events": [ { "requestId": "...", "occurredAt": "2026-02-01T10:00:00.000Z",
               "developerId": "...", "projectId": "...", "model": "gpt-5.4",
               "usage": { "inputTokens": 0, "cachedInputTokens": 0,
                          "cacheWriteTokens": 0, "outputTokens": 0 }, ... } ] }
```

Risponde `202 { "accepted": n }`, `400` su payload non conforme, `401` senza token valido.
Massimo 500 eventi per richiesta.

Il payload **non contiene il costo**: lo calcola il servizio di raccolta, con un listino che il
client non conosce. Non contiene nemmeno prompt, completion o path locali: solo contatori e
identificatori. Gli eventi sono deduplicati su `requestId`, quindi un rinvio dopo un errore di
rete non raddoppia la spesa.

Il confine di validazione e' il server, non il client: il client misura e consegna, il server
decide cosa e' accettabile. Ogni modifica al contratto deve restare retrocompatibile con i
proxy gia' installati sulle postazioni, che si aggiornano quando vogliono.

Il costo, il reporting (`/_usage/summary`, `/_usage/projects`, `/_usage/developers`,
`/_usage/unknown-models`), lo schema del database e la riconciliazione con la fattura GitHub
sono documentati nel repository del servizio di raccolta.

## Sviluppo

Monorepo npm con due pacchetti: `shared` (il contratto sul filo) e `client` (il proxy).

```bash
npm test                  # contratto, forwarder, parser usage, attribuzione, config
npm run smoke             # proxy reale contro un upstream finto, senza collector
npm run verify-detection  # rilevamento del progetto, con un collector finto
npm run verify-e2e        # client -> collector -> Postgres (richiede il collector avviato)
npm run typecheck
npm run build
```
