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
persona e' uno pseudonimo, cioe' un hash con salt non invertibile.

## Uso

```bash
# una volta sola, e poi basta
npx @vidiemme/copilot-proxy@latest setup \
  --collector-url https://raccolta.interno/v1/usage \
  --salt <salt aziendale> \
  --workspace-roots ~/Work \
  --vscode \
  --autostart

# se qualcosa non torna
npx @vidiemme/copilot-proxy@latest doctor
```

`--vscode` scrive le impostazioni utente di VS Code, `--autostart` registra il
proxy fra i servizi dell'utente: parte subito e a ogni accesso, senza che nessuno
debba ricordarsi di lanciarlo. Con entrambe, dopo questo comando non c'e' piu'
nulla da fare. Il comando stampa come disattivarlo.

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

Node.js >= 22.9 e un servizio di raccolta gia' attivo, da cui prendere
`--collector-url` e il token di ingest. Chiedili a chi lo amministra: sono gli
stessi per tutta l'organizzazione.
