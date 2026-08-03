import { homedir } from 'node:os';

/**
 * Valori aziendali committati nel pacchetto.
 *
 * Il proxy viene installato con `npx` da chi non conosce — ne' deve conoscere —
 * l'infrastruttura di raccolta: se questi valori fossero da passare a mano, ogni
 * postazione sarebbe un'occasione per sbagliarli. Stanno qui, non in un `.env`,
 * perche' un file di ambiente sulla macchina del developer e' esattamente cio'
 * che si vuole evitare. Restano sovrascrivibili da opzione o variabile
 * d'ambiente per lo sviluppo del proxy stesso.
 */

/** Endpoint di ingest del servizio di raccolta. */
export const DEFAULT_COLLECTOR_URL = 'https://copilot-collector.swarm.vidiemme.it/v1/usage';

/**
 * Salt degli pseudonimi developer.
 *
 * Deve essere identico su tutte le postazioni: e' cio' che rende la stessa
 * persona confrontabile fra macchine e nel tempo. Cambiarlo spezza la
 * continuita' dello storico, perche' da quel momento la stessa persona compare
 * con un id diverso.
 *
 * Sta nel sorgente e non fra i segreti: non protegge un accesso, rende solo non
 * banale risalire dall'id alla credenziale da cui e' derivato. Chi ha il
 * database conosce comunque le persone che ci lavorano.
 */
export const DEFAULT_DEVELOPER_ID_SALT =
  '44e342883d198dd2744dd9b485dce715f871e7c2c41dc8aa9ecb64b02b20a015';

/**
 * Cartelle sotto cui cercare i repository.
 *
 * La home e' il default che funziona ovunque senza chiedere nulla: delimita i
 * path che il proxy puo' risolvere, e nessuno tiene i propri repository fuori
 * dalla propria home. Chi vuole restringere il campo passa `--workspace-roots`.
 */
export const defaultWorkspaceRoots = (): string => homedir();
