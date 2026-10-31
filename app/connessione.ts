// Tutto ciò che il telefono fa fuori dallo schermo: socket col server, token, memoria locale,
// orologio del server, schermo acceso e segnale di riunione. Le regole stanno solo sul server.
import { useCallback, useEffect, useRef, useState } from 'react'
import { generaCodice } from '../gioco/regole.ts'
import type { Azione, Rifiuto, Vista } from '../gioco/regole.ts'

const SERVER_PUBBLICO = 'wss://sala-sospetti.zanna.workers.dev'

const PING_MS = 10_000
const ATTESA_APERTURA_MS = 8000 // senza una vista entro questo tempo il socket non è buono
const ATTESA_PONG_MS = 5000 // alcuni socket restano aperti dopo il sonno del telefono: solo il pong lo smentisce
const ATTESA_RITORNO_MS = 2500 // al ritorno sulla pagina si vuole sapere subito se il socket è vivo
const RIPROVA_MIN_MS = 1000
const RIPROVA_MAX_MS = 5000
const USCITA_MAX_MS = 5000 // Esci aspetta la chiusura del server: oltre questo tempo non è arrivato
const TENTATIVI_CODICE = 8
const CHIUSO_SOSTITUITO = 4000 // il server chiude così il socket sostituito da uno più recente
const CHIUSO_USCITO = 4001 // Togli o stanza cancellata: il posto non esiste più
const RIPRESA_MS = 2000 // dopo una sostituzione si riprova una volta: può essere un socket di questa scheda aperto in ritardo
const FINESTRA_SOSTITUITO_MS = 30_000 // due sostituzioni entro questo tempo sono un'altra scheda vera
const SALTO_OROLOGIO_MS = 5000 // un campione più basso di così non è un ritardo: l'orologio del telefono è saltato avanti

const CHIAVE_TOKEN = 'sala-sospetti:token'
const CHIAVE_NOME = 'sala-sospetti:nome'
const CHIAVE_STANZA = 'sala-sospetti:stanza'

export type Ingresso = { codice: string; nome: string; crea: boolean; rientro?: boolean } // rientro: nessuno ha scritto un codice
export type Errore = Rifiuto | 'stanza-inesistente' | 'codice-occupato' | 'codice-non-valido' | 'tolto'
export type Fine = Errore | 'uscito' | 'uscito-altrove' // il posto non c'è più: Esci confermato dal server, Esci da un'altra scheda, oppure uno degli errori
export type StatoRete = 'ok' | 'persa' | 'altrove'

// Le azioni partono senza contatore di fase: lo aggiunge chi conosce la vista corrente.
type SenzaF<T> = T extends unknown ? Omit<T, 'f'> : never
export type Comando = SenzaF<Azione>

// ---- Memoria locale: può mancare o rifiutarsi, e il gioco deve funzionare lo stesso ----
function leggi(chiave: string): string | null {
  try {
    return localStorage.getItem(chiave)
  } catch {
    return null
  }
}

function scrivi(chiave: string, valore: string | null) {
  try {
    if (valore === null) localStorage.removeItem(chiave)
    else localStorage.setItem(chiave, valore)
  } catch {}
}

let tokenInMemoria = ''

function tokenDispositivo(): string {
  tokenInMemoria ||= leggi(CHIAVE_TOKEN) ?? ''
  if (!tokenInMemoria) {
    const byte = crypto.getRandomValues(new Uint8Array(16))
    tokenInMemoria = Array.from(byte, b => b.toString(16).padStart(2, '0')).join('')
    scrivi(CHIAVE_TOKEN, tokenInMemoria)
  }
  return tokenInMemoria
}

export const nomeSalvato = () => leggi(CHIAVE_NOME) ?? ''
export const salvaNome = (nome: string) => scrivi(CHIAVE_NOME, nome)
export const stanzaSalvata = () => leggi(CHIAVE_STANZA)
export const dimenticaStanza = () => scrivi(CHIAVE_STANZA, null)
export const nuovoCodice = () => generaCodice(Math.random)

// ---- Indirizzi ----
function indirizzoServer(): string {
  const scelto = new URLSearchParams(window.location.search).get('server')
  if (scelto) return scelto
  if (window.location.protocol === 'http:') return `ws://${window.location.hostname}:8787`
  return SERVER_PUBBLICO
}

// Link da dare agli altri: ?server si conserva, così una prova su un altro server resta su quel server.
export function linkStanza(codice: string): string {
  const url = new URL(window.location.href)
  const server = url.searchParams.get('server')
  url.search = ''
  url.hash = ''
  url.searchParams.set('stanza', codice)
  if (server) url.searchParams.set('server', server)
  return url.toString()
}

export function aggiornaIndirizzo(codice: string | null) {
  const url = new URL(window.location.href)
  if (codice) url.searchParams.set('stanza', codice)
  else url.searchParams.delete('stanza')
  window.history.replaceState(window.history.state, '', url)
}

// ---- Connessione alla stanza ----
export function useStanza(ingresso: Ingresso | null, alRifiuto: (motivo: Fine) => void, alMancataUscita: () => void) {
  const [vista, setVista] = useState<Vista | null>(null)
  const [rete, setRete] = useState<StatoRete>('persa')
  const [uscendo, setUscendo] = useState(false)
  const socket = useRef<WebSocket | null>(null)
  const scarto = useRef(0)
  const riprovaOra = useRef<() => void>(() => {})
  const esciOra = useRef<() => void>(() => {})
  const rifiuto = useRef(alRifiuto)
  const mancata = useRef(alMancataUscita)

  useEffect(() => {
    rifiuto.current = alRifiuto
    mancata.current = alMancataUscita
  })

  useEffect(() => {
    if (!ingresso) return

    const server = indirizzoServer()
    const token = tokenDispositivo()
    let { codice, crea } = ingresso
    let finito = false
    let ws: WebSocket | null = null
    let tentativi = 0
    let codiciProvati = 0
    let aperto = false // il socket corrente ha già portato una vista
    let scartoSocket = -Infinity
    let faseNota: number | null = null // contatore di fase dell'ultima vista
    let esciChiesto = false
    let ceduto = false // il posto è passato a un altro socket e non è ancora tornato qui
    let ultimoSostituito = -Infinity
    let memoriaBuona = false // la stanza si è scritta davvero: senza memoria stanzaSalvata() non dice nulla
    let tempoRiprova: ReturnType<typeof setTimeout> | undefined
    let tempoRisposta: ReturnType<typeof setTimeout> | undefined
    let tempoUscita: ReturnType<typeof setTimeout> | undefined

    // Stacca il socket corrente senza che i suoi eventi tornino qui: ce n'è sempre uno solo.
    function stacca() {
      annullaAttesa()
      if (!ws) return
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
      ws = null
      socket.current = null
    }

    function annullaAttesa() {
      clearTimeout(tempoRisposta)
      tempoRisposta = undefined
    }

    // Una scadenza già in corso non si allunga: un socket muto non deve guadagnare tempo a ogni ping.
    function aspettaRisposta(ms: number) {
      tempoRisposta ??= setTimeout(cade, ms)
    }

    function cade() {
      stacca()
      setRete('persa')
      const attesa = Math.min(RIPROVA_MAX_MS, RIPROVA_MIN_MS * 2 ** tentativi++)
      // Lo scarto evita che 15 telefoni tornino tutti nello stesso istante dopo un riavvio del server.
      clearTimeout(tempoRiprova)
      tempoRiprova = setTimeout(apri, attesa * (0.75 + Math.random() / 2))
    }

    function apri() {
      clearTimeout(tempoRiprova)
      stacca()
      if (finito) return
      const query = new URLSearchParams({ token, nome: ingresso!.nome })
      if (crea) query.set('crea', '1')
      try {
        ws = new WebSocket(`${server}/stanza/${codice}?${query}`)
      } catch {
        return cade()
      }
      socket.current = ws
      aperto = false
      scartoSocket = -Infinity
      aspettaRisposta(ATTESA_APERTURA_MS)
      ws.onmessage = evento => ricevi(evento.data)
      ws.onclose = evento => {
        if (evento.code === CHIUSO_USCITO && esciChiesto) return smetti('uscito')
        if (evento.code === CHIUSO_USCITO) return smetti(evento.reason === 'stanza-cancellata' ? 'stanza-inesistente' : 'tolto')
        if (evento.code !== CHIUSO_SOSTITUITO) return cade()
        sostituito()
      }
    }

    // Il posto è passato a un altro socket, che può essere di un'altra scheda o di questa, aperto in ritardo da una ricarica.
    // Si riprova una volta sola: due schede vere rimbalzano una volta e l'ultima aperta resta, senza rimbalzare all'infinito.
    // Una scheda nascosta non riprova: la riapre visibilitychange.
    function sostituito() {
      stacca()
      clearTimeout(tempoRiprova)
      ceduto = true
      const ora = Date.now()
      if (ora - ultimoSostituito < FINESTRA_SOSTITUITO_MS || document.visibilityState === 'hidden') {
        setRete('altrove')
        return
      }
      ultimoSostituito = ora
      setRete('persa')
      tempoRiprova = setTimeout(riprendi, RIPRESA_MS)
    }

    // Se dalla memoria la stanza è sparita, da un'altra scheda si è usciti: riprendere il posto rimetterebbe dentro il giocatore.
    function riprendi() {
      if (memoriaBuona && stanzaSalvata() !== codice) smetti('uscito-altrove')
      else apri()
    }

    function ricevi(dato: unknown) {
      if (typeof dato !== 'string') return
      // Solo il pong dimostra che il filo porta anche i messaggi del telefono: una vista in arrivo non lo dice.
      if (dato === 'pong') {
        if (aperto) annullaAttesa()
        return
      }
      let messaggio: { v?: Vista; errore?: Errore }
      try {
        messaggio = JSON.parse(dato)
      } catch {
        return
      }

      if (messaggio.errore === 'codice-occupato' && crea && ++codiciProvati < TENTATIVI_CODICE) {
        codice = nuovoCodice()
        return apri()
      }
      if (messaggio.errore) return smetti(messaggio.errore)

      const v = messaggio.v
      if (!v) return
      if (!aperto) {
        aperto = true
        annullaAttesa()
      }
      // Una vista rimasta in coda arriva in ritardo: per ogni socket vale il campione con il ritardo minore.
      const campione = v.ora - Date.now()
      scartoSocket = campione < scartoSocket - SALTO_OROLOGIO_MS ? campione : Math.max(scartoSocket, campione)
      scarto.current = scartoSocket
      crea = false // La stanza ora esiste: una riconnessione con crea=1 verrebbe rifiutata
      tentativi = 0
      faseNota = v.f
      ceduto = false
      scrivi(CHIAVE_STANZA, v.codice)
      memoriaBuona = stanzaSalvata() === v.codice
      setVista(v)
      setRete('ok')
      mandaEsci()
    }

    // Esci con un contatore di fase vecchio viene ignorato: si rimanda a ogni vista finché il server non chiude.
    function mandaEsci() {
      if (esciChiesto && faseNota !== null && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: 'esci', f: faseNota }))
    }

    function chiediUscita() {
      esciChiesto = true
      setUscendo(true)
      mandaEsci()
      clearTimeout(tempoUscita)
      tempoUscita = setTimeout(() => {
        esciChiesto = false
        setUscendo(false)
        mancata.current()
      }, USCITA_MAX_MS)
    }

    function smetti(motivo: Fine) {
      finito = true
      clearTimeout(tempoRiprova)
      clearTimeout(tempoUscita)
      stacca()
      rifiuto.current(motivo)
    }

    // Ritorno sulla pagina o sulla rete: si verifica subito invece di aspettare il prossimo ping.
    function controlla() {
      if (finito || document.visibilityState === 'hidden') return
      tentativi = 0
      clearTimeout(tempoRiprova)
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send('ping')
        annullaAttesa()
        aspettaRisposta(ATTESA_RITORNO_MS)
      } else if (ws?.readyState !== WebSocket.CONNECTING) {
        if (!ceduto) return apri()
        ultimoSostituito = -Infinity // qui si è tornati di proposito: la prossima sostituzione riparte da capo
        riprendi()
      }
    }

    // Una pagina nella cache del browser non deve tenere un socket aperto: pageshow lo riapre.
    function allaChiusura() {
      clearTimeout(tempoRiprova)
      stacca()
      setRete('persa')
    }

    const ping = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return
      ws.send('ping')
      aspettaRisposta(ATTESA_PONG_MS)
    }, PING_MS)

    riprovaOra.current = controlla
    esciOra.current = chiediUscita
    document.addEventListener('visibilitychange', controlla)
    window.addEventListener('pageshow', controlla)
    window.addEventListener('online', controlla)
    window.addEventListener('pagehide', allaChiusura)
    apri()

    return () => {
      finito = true
      clearInterval(ping)
      clearTimeout(tempoRiprova)
      clearTimeout(tempoUscita)
      stacca()
      riprovaOra.current = () => {}
      esciOra.current = () => {}
      document.removeEventListener('visibilitychange', controlla)
      window.removeEventListener('pageshow', controlla)
      window.removeEventListener('online', controlla)
      window.removeEventListener('pagehide', allaChiusura)
      setVista(null)
      setRete('persa')
      setUscendo(false)
    }
  }, [ingresso])

  const invia = useCallback((azione: Azione) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(azione))
  }, [])

  const adesso = useCallback(() => Date.now() + scarto.current, [])
  const riprova = useCallback(() => riprovaOra.current(), [])
  const esci = useCallback(() => esciOra.current(), [])

  return { vista, rete, uscendo, invia, adesso, riprova, esci }
}

// ---- Schermo acceso: errori silenziosi, nessuna differenza tra giocatori ----
export function useSchermoAcceso(attivo: boolean) {
  useEffect(() => {
    if (!attivo || !('wakeLock' in navigator)) return
    let blocco: WakeLockSentinel | null = null
    let inCorso = false
    let finito = false

    async function chiedi() {
      if (blocco || inCorso || finito || document.visibilityState !== 'visible') return
      inCorso = true
      try {
        const preso = await navigator.wakeLock.request('screen')
        if (finito) {
          void preso.release()
        } else {
          blocco = preso
          preso.addEventListener('release', () => {
            blocco = null
          })
        }
      } catch {}
      inCorso = false
    }

    void chiedi()
    document.addEventListener('visibilitychange', chiedi)
    window.addEventListener('pointerdown', chiedi) // Se la richiesta è fallita, si ritenta al tocco successivo
    return () => {
      finito = true
      document.removeEventListener('visibilitychange', chiedi)
      window.removeEventListener('pointerdown', chiedi)
      void blocco?.release()
    }
  }, [attivo])
}

// ---- Segnale di riunione: uguale per tutti ----
let audio: AudioContext | null = null

// I browser sbloccano l'audio solo dentro un tocco: si chiama a ogni tocco, non costa nulla.
export function sbloccaAudio() {
  try {
    audio ??= new AudioContext()
    if (audio.state !== 'running') void audio.resume()
  } catch {}
}

export function segnaleRiunione() {
  navigator.vibrate?.([120, 60, 120])
  if (audio?.state !== 'running') return
  const inizio = audio.currentTime
  ;[660, 880].forEach((frequenza, i) => {
    const tono = audio!.createOscillator()
    const volume = audio!.createGain()
    const parte = inizio + i * 0.16
    tono.type = 'triangle'
    tono.frequency.value = frequenza
    volume.gain.setValueAtTime(0.0001, parte)
    volume.gain.exponentialRampToValueAtTime(0.2, parte + 0.02)
    volume.gain.exponentialRampToValueAtTime(0.0001, parte + 0.15)
    tono.connect(volume).connect(audio!.destination)
    tono.start(parte)
    tono.stop(parte + 0.16)
  })
}
