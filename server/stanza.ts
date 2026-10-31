// Server di Sala Sospetti: un Worker che smista e un Durable Object per stanza.
// Le regole stanno tutte in gioco/regole.ts: qui ci sono solo socket, salvataggi e sveglie.
//
// Dal telefono: una Azione in JSON, oppure `ping`, a cui risponde `pong` il runtime senza svegliare l'oggetto.
// Dal server: {"v": Vista} a ogni cambiamento, oppure {"errore": motivo} seguito dalla chiusura.
import { DurableObject } from 'cloudflare:workers'
import { applica, codiceValido, entra, nuovaStanza, prossimaScadenza, scadi, segnale, vista } from '../gioco/regole.ts'
import type { Azione, Stato } from '../gioco/regole.ts'

// Codici di chiusura: il telefono non deve riconnettersi da solo dopo nessuno di questi.
const SOSTITUITO = 4000 // lo stesso giocatore ha aperto un altro socket
const USCITO = 4001 // Esci, Togli o stanza cancellata
const RIFIUTATO = 4002 // ingresso rifiutato, il motivo è nel messaggio {errore}
// Fuori da quella regola: chi manda più messaggi di quanti ne possa mandare un dito viene staccato, e un telefono vero si ricollega.
const TROPPI_MESSAGGI = 1008

const GIRO_MS = 10 * 1000 // giro delle presenze
const SILENZIO_MS = 6 * 60 * 60 * 1000 // senza segnali da tanto, la stanza viene cancellata
const MESSAGGIO_MAX = 1024
const MESSAGGI_AL_SECONDO = 20 // per socket. I ping non contano: risponde il runtime e l'oggetto non li vede
const TENTATIVI_MAX = 600 // tentativi di aprire un socket verso una stanza, per IP e per finestra
const FINESTRA_TENTATIVI_MS = 60 * 1000
const CHIAVE = 'stanza'
const VERSIONE = 3 // si legge da fuori: dice se l'ultimo deploy è arrivato

// GIRO_MS e TENTATIVI_MAX servono solo a test/rete.ts: con il giro da 10 s l'oggetto non resta mai fermo abbastanza da ibernarsi.
type Env = { STANZA: DurableObjectNamespace<Stanza>; SCALA_TEMPI?: string; GIRO_MS?: string; TENTATIVI_MAX?: string }

// Allegato del socket: sopravvive all'ibernazione. Tiene un'impronta perché una vista intera può superare i 2 KB ammessi.
// Con secondo e messaggi conta il ritmo del socket senza scrivere nello storage.
type Posto = { id: number; firma: number | null; secondo: number; messaggi: number }

// vivo: ultima ora in cui l'oggetto faceva i giri. Null se non deve farne: stanza in sala, senza socket.
type Salvataggio = { s: Stato; vivo: number | null }

// Impronta FNV-1a a 32 bit.
function impronta(testo: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < testo.length; i++) h = Math.imul(h ^ testo.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function leggi(messaggio: string | ArrayBuffer): Azione | null {
  if (typeof messaggio !== 'string' || messaggio.length > MESSAGGIO_MAX) return null
  try {
    return JSON.parse(messaggio)
  } catch {
    return null
  }
}

// Il browser non legge gli errori HTTP di un WebSocket: il rifiuto viaggia in un messaggio, poi il socket si chiude.
function rifiuta(motivo: string): Response {
  const { 0: telefono, 1: server } = new WebSocketPair()
  server.accept()
  server.send(JSON.stringify({ errore: motivo }))
  server.close(RIFIUTATO, motivo)
  return new Response(null, { status: 101, webSocket: telefono })
}

function chiudi(ws: WebSocket, codice: number, motivo: string) {
  try {
    ws.close(codice, motivo)
  } catch {
    // già chiuso: non c'è altro da fare
  }
}

// Conta un messaggio nell'allegato del socket e dice se il secondo in corso ha superato il limite.
function troppiMessaggi(ws: WebSocket, posto: Posto, ora: number): boolean {
  const secondo = Math.floor(ora / 1000)
  const messaggi = posto.secondo === secondo ? posto.messaggi + 1 : 1
  ws.serializeAttachment({ ...posto, secondo, messaggi } satisfies Posto)
  return messaggi > MESSAGGI_AL_SECONDO
}

// Tetto per IP sui tentativi, prima di svegliare l'oggetto. È largo perché i telefoni di una festa escono tutti dallo stesso IP:
// dopo un calo di rete 20 telefoni che riprovano per un minuto, con l'attesa di connessione.ts, fanno meno di 400 tentativi.
// Chi lo supera riceve un 429, non un rifiuto: il telefono lo vive come un socket caduto e riprova da solo.
// Il conteggio sta nella memoria del Worker: ogni copia conta per sé e un riavvio lo azzera. È un freno, non una barriera.
const tentativi = new Map<string, number>()
let inizioFinestra = 0

function troppiTentativi(ip: string, ora: number, massimo: number): boolean {
  if (ora - inizioFinestra >= FINESTRA_TENTATIVI_MS) {
    tentativi.clear()
    inizioFinestra = ora
  }
  const fatti = (tentativi.get(ip) ?? 0) + 1
  tentativi.set(ip, fatti)
  return fatti > massimo
}

export class Stanza extends DurableObject<Env> {
  private giro: number

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.giro = Number(env.GIRO_MS) || GIRO_MS
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    // Una riga a ogni avvio: in `wrangler tail` e nei test mostra quando l'oggetto si è risvegliato.
    console.log(`stanza avviata: ${ctx.storage.kv.get<Salvataggio>(CHIAVE)?.s.codice ?? 'nuova'}`)
  }

  // Ogni evento parte da qui. Nulla resta in memoria tra un evento e l'altro: ibernarsi non può perdere niente.
  // scaduto: il tempo trascorso ha già cambiato lo stato, che va salvato anche se l'evento in sé non cambia nulla.
  private carica(ora: number): { s: Stato; scaduto: boolean } | undefined {
    const salvato = this.ctx.storage.kv.get<Salvataggio>(CHIAVE)
    if (!salvato) return undefined
    const { s, vivo } = salvato

    // Dopo un riavvio non ci sono socket né timestamp: il tempo a server fermo non conta come assenza dei telefoni.
    // Saltare un giro intero vuol dire che l'oggetto non c'era.
    if (vivo !== null && ora - vivo >= 2 * this.giro) {
      for (const g of s.giocatori) segnale(s, g.id, Math.min(ora, g.visto + ora - vivo))
    }
    for (const ws of this.ctx.getWebSockets()) {
      const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      if (pong) segnale(s, (ws.deserializeAttachment() as Posto).id, pong.getTime())
    }

    return { s, scaduto: scadi(s, ora) }
  }

  // Ogni evento che cambia qualcosa finisce qui: salva, avvisa i telefoni, arma la sveglia. Una stanza vuota o muta da 6 ore sparisce.
  private async concludi(s: Stato, ora: number) {
    const ultimoSegnale = Math.max(0, ...s.giocatori.map(g => g.visto))
    if (ora - ultimoSegnale >= SILENZIO_MS) {
      for (const ws of this.ctx.getWebSockets()) chiudi(ws, USCITO, 'stanza-cancellata')
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    const conGiri = this.ctx.getWebSockets().length > 0 || s.fase !== 'sala'
    this.ctx.storage.kv.put<Salvataggio>(CHIAVE, { s, vivo: conGiri ? ora : null })
    this.trasmetti(s, ora)

    const sveglie = [ultimoSegnale + SILENZIO_MS]
    const scadenza = prossimaScadenza(s)
    if (scadenza !== null) sveglie.push(scadenza)
    if (conGiri) sveglie.push(ora + this.giro)
    await this.ctx.storage.setAlarm(Math.min(...sveglie))
  }

  // Manda a ogni telefono la sua vista solo se è cambiata. Il campo ora cambia sempre, quindi resta fuori dal confronto.
  private trasmetti(s: Stato, ora: number) {
    for (const ws of this.ctx.getWebSockets()) {
      const posto = ws.deserializeAttachment() as Posto
      if (!s.giocatori.some(g => g.id === posto.id)) {
        chiudi(ws, USCITO, 'uscito')
        continue
      }
      const v = vista(s, posto.id, ora)
      const { ora: _, ...senzaOra } = v
      const firma = impronta(JSON.stringify(senzaOra))
      if (firma === posto.firma) continue
      try {
        ws.send(JSON.stringify({ v }))
        ws.serializeAttachment({ ...posto, firma } satisfies Posto)
      } catch {
        // socket in chiusura: un telefono perso non deve fermare gli altri
      }
    }
  }

  async fetch(req: Request) {
    const url = new URL(req.url)
    const token = url.searchParams.get('token') ?? ''
    const nome = url.searchParams.get('nome') ?? ''
    const crea = url.searchParams.get('crea') === '1'

    const ora = Date.now()
    let s = this.carica(ora)?.s
    // Chi ha già un posto e ripete crea=1 sta solo rientrando nella propria stanza.
    if (s && crea && !(token && s.giocatori.some(g => g.token === token))) return rifiuta('codice-occupato')
    if (!s && !crea) return rifiuta('stanza-inesistente')

    if (!s) {
      const codice = url.pathname.split('/')[2]
      const seme = crypto.getRandomValues(new Uint32Array(1))[0]
      s = nuovaStanza(codice, seme, Number(this.env.SCALA_TEMPI) || 1)
    }
    // Una stanza nuova viene salvata solo in fondo: se l'ingresso è rifiutato non resta nulla.
    const ingresso = entra(s, token, nome, ora)
    if (!ingresso.ok) return rifiuta(ingresso.motivo)

    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Posto).id === ingresso.id) chiudi(ws, SOSTITUITO, 'sostituito')
    }

    const { 0: telefono, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ id: ingresso.id, firma: null, secondo: 0, messaggi: 0 } satisfies Posto)
    await this.concludi(s, ora)
    return new Response(null, { status: 101, webSocket: telefono })
  }

  async webSocketMessage(ws: WebSocket, messaggio: string | ArrayBuffer) {
    try {
      if (ws.readyState !== WebSocket.OPEN) return // messaggi rimasti in coda dopo la chiusura
      const ora = Date.now()
      const posto = ws.deserializeAttachment() as Posto
      if (troppiMessaggi(ws, posto, ora)) return chiudi(ws, TROPPI_MESSAGGI, 'troppi-messaggi')
      const caricata = this.carica(ora)
      if (!caricata) return
      const { s, scaduto } = caricata
      segnale(s, posto.id, ora)
      const azione = leggi(messaggio)
      const mossa = azione ? applica(s, posto.id, azione, ora) : false
      // Un messaggio che non cambia nulla non scrive nello storage, così non può consumarne la quota.
      // Le presenze non si perdono: il visto si riprende dai pong a ogni carica e il giro delle presenze salva comunque.
      if (scaduto || mossa) await this.concludi(s, ora)
    } catch (errore) {
      // Si scarta il messaggio e l'oggetto resta in piedi: il prossimo evento riparte dall'ultimo stato salvato.
      console.error('messaggio scartato', errore)
    }
  }

  // Un giro subito, finché il suo ultimo pong è ancora leggibile. Poi va risposto, o il telefono resta in attesa per decine
  // di secondi. Sempre 1000: chi chiude senza codice arriva qui con 1005, che non si può rimandare indietro.
  async webSocketClose(ws: WebSocket) {
    await this.alarm()
    chiudi(ws, 1000, 'chiuso')
  }

  async alarm() {
    const ora = Date.now()
    const caricata = this.carica(ora)
    if (caricata) await this.concludi(caricata.s, ora)
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const trovato = new URL(req.url).pathname.match(/^\/stanza\/([^/]*)$/)
    if (!trovato || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(`Sala Sospetti: server attivo, versione ${VERSIONE}`)
    if (!codiceValido(trovato[1])) return rifiuta('codice-non-valido')
    const ip = req.headers.get('CF-Connecting-IP') ?? ''
    if (troppiTentativi(ip, Date.now(), Number(env.TENTATIVI_MAX) || TENTATIVI_MAX)) return new Response('Troppi tentativi', { status: 429 })
    return env.STANZA.get(env.STANZA.idFromName(trovato[1]), { locationHint: 'weur' }).fetch(req)
  },
}
