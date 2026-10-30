# @vidiemme/copilot-proxy

Proxy locale che misura il consumo di token di GitHub Copilot e lo attribuisce
al progetto su cui si sta lavorando.

Le statistiche native di Copilot sono per persona. Questo strumento risponde a
un'altra domanda: **quanto e' costato il progetto X**, sommando il lavoro di
tutte le persone che ci hanno messo mano.

## Come funziona

VS Code parla con il proxy invece che direttamente con Copilot. Il proxy inoltra
la richiesta cosi' com'e', legge dalla risposta i contatori di token e li manda
a un servizio di raccolta aziendale, che applica il listino e li salva.

Il progetto viene riconosciuto dal repository git su cui si sta lavorando: nessun
profilo da cambiare quando si passa da un progetto all'altro.

Non vengono mai salvati prompt ne' risposte: solo contatori. L'identita' della
persona e' uno pseudonimo, cioe' un hash con salt non invertibile; il setup
propone di affiancargli il nome di `git config`, per riconoscersi nella dashboard
(`--anonymous` per non farlo).

## Uso

```bash
# una volta sola, e poi basta
npx @vidiemme/copilot-proxy@latest setup --vscode --autostart

# se qualcosa non torna
npx @vidiemme/copilot-proxy@latest doctor

# versione, eventi misurati e consegnati, spool in attesa
npx @vidiemme/copilot-proxy@latest status
```

Con l'avvio automatico, dopo un aggiornamento (`npm i -g @vidiemme/copilot-proxy@latest`)
serve `copilot-proxy restart`; per toglierlo, `copilot-proxy uninstall`.

Non c'e' nulla da configurare a mano: endpoint di raccolta, salt e cartelle dove
cercare i progetti sono gia' nel pacchetto. L'unica cosa da procurarsi e' il
token di raccolta, che il comando chiede in modo nascosto.

`--vscode` scrive le impostazioni utente di VS Code e dei derivati installati
(Insiders, VSCodium, Cursor, Windsurf, Antigravity), `--autostart` registra il
proxy fra i servizi dell'utente: parte subito e a ogni accesso, senza che nessuno
debba ricordarsi di lanciarlo. Con entrambe, dopo questo comando non c'e' piu'
nulla da fare. Il comando stampa come disattivarlo.

Il setup chiede la porta locale (default 8787) e controlla che sia libera. Per
cambiarla dopo: `setup --force --port 9000 --vscode --autostart`, senza
reinserire il token.

JetBrains, Eclipse, Xcode e Visual Studio non si possono indirizzare al proxy:
il loro consumo non viene misurato.

Senza `--autostart` il proxy si avvia a mano:

```bash
npx @vidiemme/copilot-proxy@latest start
```

Il token di raccolta non si passa come opzione: finirebbe nella cronologia della
shell e nella lista dei processi. Lo chiede il comando in modo nascosto, oppure
si mette nella variabile `COLLECTOR_TOKEN`.

La configurazione finisce in `~/.config/copilot-proxy/config.json` con permessi
`0600`.

## Requisiti

Node.js >= 22.19 (richiesto da Undici 8) e il token di ingest del servizio di raccolta: chiedilo a chi lo
amministra, e' lo stesso per tutta l'organizzazione.
