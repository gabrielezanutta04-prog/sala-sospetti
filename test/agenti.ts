// Gli agenti dei test: 15 personalità, un solo cervello, il mondo fisico.
// Il cervello vede solo la vista del proprio telefono e ciò che il mondo gli dice a voce.
// Da regole.ts arrivano solo tipi: nessuna regola è raggiungibile da qui.

import type { Rifiuto, Ruolo, Vista, VistaPartita, VistaRiunione, VistaRuolo, VistaSala, Voto } from '../gioco/regole.ts'

const S = 1000
const MIN = 60 * S

// ---- Il telefono astratto ----
// L'unica strada verso il server. In serata.ts è finto con orologio virtuale, il livello rete lo farà con un WebSocket.
export type Telefono = {
  adesso(): number // ora del server secondo il telefono
  vista(): Vista | null // ultima vista ricevuta, null se non si ha un posto
  rifiuto(): Rifiuto | null // motivo dell'ultimo ingresso rifiutato
  collega(nome: string): void // apre il socket col token di questo telefono
  scollega(): void // schermo bloccato, rete persa, pagina chiusa: il token resta
  invia(azione: unknown, falsa?: boolean): void // falsa: l'agente sa che il server deve rifiutarla
}

// ---- Le personalità ----
export type Tratti = {
  nome: string
  reazione: number // ms: ogni quanto guarda il telefono o si accorge di qualcosa
  durataTask: number // ms per fare una task dal vero
  morto: [number, number] // ms da quando scopre di essere stato colpito a quando preme Sono morto
  leggeRuolo: number // ms sulla Rivelazione
  attesaUccidi: number // ms per trovare qualcuno da solo, da quando Uccidi è pronto
  spuntaDaAssassino: number // probabilità che un assassino prema davvero Fatto per coprirsi
  prudenza: number // probabilità di saltare il voto se c'è solo una voce, senza prove
  fiducia: number // probabilità di credere a una testimonianza
  loquacita: number // probabilità di accusare qualcuno senza prove
  // Manie: bastano questi campi a rendere diverso il comportamento dello stesso cervello
  ultimaAVotare?: boolean
  soloProve?: boolean
  cambiaScelta?: number
  bloccaOgni?: number
  bloccaPer?: [number, number]
  reportAllaVoce?: boolean
  emergencySubito?: boolean
  reportInTasca?: boolean
  piantagrane?: boolean
  ritardataria?: boolean
  ricarica?: boolean
  batteria?: boolean
  falsario?: boolean
  fuggitiva?: boolean
  nomi?: string[]
  cambiaReteOgni?: number
  dueSchede?: boolean
}

// Valori medi per chi non ha una caratteristica sua: sono stime, non misure.
const NORMALE = {
  reazione: 8 * S,
  durataTask: 45 * S,
  morto: [5 * S, 20 * S] as [number, number],
  leggeRuolo: 12 * S,
  attesaUccidi: 45 * S,
  spuntaDaAssassino: 0.5,
  prudenza: 0.6,
  fiducia: 0.85,
  loquacita: 0.05,
}

export const PERSONALITA: Tratti[] = [
  { ...NORMALE, nome: 'Marta', reazione: 3 * S, durataTask: 30 * S, morto: [2 * S, 5 * S] },
  { ...NORMALE, nome: 'Ugo', attesaUccidi: 0, spuntaDaAssassino: 0 },
  { ...NORMALE, nome: 'Beppe', reazione: 40 * S, bloccaOgni: 6 * MIN, bloccaPer: [1 * MIN, 3 * MIN] },
  { ...NORMALE, nome: 'Pina', reazione: 25 * S, leggeRuolo: 90 * S, ultimaAVotare: true },
  { ...NORMALE, nome: 'Sandro', reportAllaVoce: true, emergencySubito: true, reportInTasca: true },
  { ...NORMALE, nome: 'Giulia', soloProve: true, prudenza: 1 },
  { ...NORMALE, nome: 'Carlo', piantagrane: true },
  { ...NORMALE, nome: 'Lara', ritardataria: true, ricarica: true },
  { ...NORMALE, nome: 'Tommaso', batteria: true },
  { ...NORMALE, nome: 'Elena', prudenza: 0.8, cambiaScelta: 3, ultimaAVotare: true },
  { ...NORMALE, nome: 'Max', falsario: true },
  { ...NORMALE, nome: 'Rita', fuggitiva: true },
  { ...NORMALE, nome: 'Piero', morto: [60 * S, 90 * S] },
  { ...NORMALE, nome: 'Anna', nomi: ['marta ', 'Anna 🌸'] },
  { ...NORMALE, nome: 'Dario', cambiaReteOgni: 5 * MIN, dueSchede: true },
]

// Per il bilanciamento: restano tempi e abitudini, spariscono le prove di forza che non fanno parte di una partita normale.
export function senzaManie(t: Tratti): Tratti {
  const { piantagrane, ritardataria, ricarica, batteria, falsario, fuggitiva, nomi, dueSchede, ...resto } = t
  return resto
}

// ---- La memoria ----
export type Persona = { id: number; nome: string }
export type Piano = { giocatori: number; numeroTask: number; assassini: number }
export type Voce = { contro: number; prova: boolean }

// Ricordi di una sola partita: spariscono al ritorno in sala.
type Ricordi = {
  iniziata: boolean
  salaDa: number | null
  ruolo: Ruolo | null
  complici: string[]
  ruoloDa: number | null
  ruoloLetto: boolean
  colpitoIl: number | null
  premoMortoIl: number
  hoVisto: number | null // l'assassino visto colpire
  cadavere: boolean
  voce: boolean
  prove: number[] // accusati da una testimonianza
  accuse: Record<number, number>
  tascaIl: number | null
  fineTaskIl: number | null
  fintaFino: number
  uccidoIl: number | null
  riquadro: boolean // stato del client: non viene mai dal server
  riunioneF: number
  riunioneDa: number
  parlato: boolean
  dubbi: number
  ricaricatoRuolo: boolean
  ricaricatoVotoF: number
  fuggita: boolean
  dueSchede: boolean
}

function nuoviRicordi(): Ricordi {
  return {
    iniziata: false,
    salaDa: null,
    ruolo: null,
    complici: [],
    ruoloDa: null,
    ruoloLetto: false,
    colpitoIl: null,
    premoMortoIl: 0,
    hoVisto: null,
    cadavere: false,
    voce: false,
    prove: [],
    accuse: {},
    tascaIl: null,
    fineTaskIl: null,
    fintaFino: 0,
    uccidoIl: null,
    riquadro: false,
    riunioneF: 0,
    riunioneDa: 0,
    parlato: false,
    dubbi: 0,
    ricaricatoRuolo: false,
    ricaricatoVotoF: 0,
    fuggita: false,
    dueSchede: false,
  }
}

export type Memoria = {
  caso: () => number
  adesso: number
  id: number | null
  nome: string // nome con cui provare a entrare
  tentativo: number // posizione in tratti.nomi
  rifiuto: Rifiuto | null
  fuori: boolean // ha premuto Esci
  vivo: boolean // secondo l'ultima vista
  piano: Piano | null // deciso a voce prima di ogni partita
  intorno: Persona[] // chi è in piedi nella stanza: si vede a occhio
  rientroIl: number | null // telefono bloccato o spento fino a
  prestito: boolean // al rientro serve un telefono prestato
  bloccoIl: number | null
  reteIl: number | null
  scarico: boolean // la batteria è già finita stasera
  r: Ricordi
}

export function nuovaMemoria(seme: number, t: Tratti): Memoria {
  return {
    caso: generatore(seme),
    adesso: 0,
    id: null,
    nome: t.nomi?.[0] ?? t.nome,
    tentativo: 0,
    rifiuto: null,
    fuori: false,
    vivo: true,
    piano: null,
    intorno: [],
    rientroIl: null,
    prestito: false,
    bloccoIl: null,
    reteIl: null,
    scarico: false,
    r: nuoviRicordi(),
  }
}

// Stesso generatore delle regole, riscritto qui: i test non devono consumare il seme della stanza.
export function generatore(seme: number): () => number {
  let x = seme | 0
  return () => {
    x = (x + 0x6d2b79f5) | 0
    let t = Math.imul(x ^ (x >>> 15), 1 | x)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const tra = (m: Memoria, da: number, a: number) => da + m.caso() * (a - da)
const scegli = <T>(m: Memoria, lista: T[]): T => lista[Math.floor(m.caso() * lista.length)]

// ---- Il cervello ----
export type Decisione = {
  attesa: number // ms alla prossima occhiata
  premi?: unknown // messaggio per il server
  falsa?: boolean // imbroglio voluto: il server deve rifiutarlo
  colpisco?: number // id della vittima, nel mondo fisico
  dico?: Voce // detto ad alta voce
  rete?: 'collega' | 'scollega' | 'riconnetti' | 'ricarica' | 'seconda-scheda' | 'telefono-prestato'
}

const DISCUSSIONE = 40 * S // chiacchiere in riunione prima di votare
const PAZIENZA_VOTO = 90 * S // quanto aspetta chi vuole votare per ultimo: in due si aspetterebbero per sempre
const PAZIENZA_SALA = 2 * MIN // quanto aspetta l'host chi manca prima di partire comunque
const GESTO = 700 // pressione lunga sulla barra in alto, con un filo di margine

export function decidi(v: Vista | null, m: Memoria, t: Tratti): Decisione {
  const occhiata = tra(m, t.reazione * 0.5, t.reazione * 1.5)

  // Telefono bloccato o spento: si aspetta, poi si riapre o se ne chiede uno in prestito.
  if (m.rientroIl !== null) {
    if (m.adesso < m.rientroIl) return { attesa: m.rientroIl - m.adesso }
    m.rientroIl = null
    const rete = m.prestito ? 'telefono-prestato' : 'collega'
    m.prestito = false
    return { rete, attesa: occhiata }
  }

  // Niente posto: si entra. Un nome già usato si cambia, gli altri rifiuti si ritentano finché la sala non riapre.
  if (m.fuori || !v || v.io.id < 0) {
    if (m.rifiuto === 'nome-usato' && t.nomi && m.tentativo + 1 < t.nomi.length) m.nome = t.nomi[++m.tentativo]
    return { rete: 'collega', attesa: 20 * S }
  }

  if (t.bloccaOgni && t.bloccaPer) {
    m.bloccoIl ??= m.adesso + tra(m, 0.5 * t.bloccaOgni, t.bloccaOgni)
    if (m.adesso >= m.bloccoIl) {
      m.bloccoIl = m.adesso + t.bloccaOgni
      m.rientroIl = m.adesso + tra(m, t.bloccaPer[0], t.bloccaPer[1])
      return { rete: 'scollega', attesa: m.rientroIl - m.adesso }
    }
  }

  if (t.cambiaReteOgni) {
    m.reteIl ??= m.adesso + t.cambiaReteOgni
    if (m.adesso >= m.reteIl) {
      m.reteIl = m.adesso + t.cambiaReteOgni
      return { rete: 'riconnetti', attesa: occhiata }
    }
  }

  if (t.falsario && m.caso() < 0.25) return { premi: falsifica(v, m), falsa: true, attesa: occhiata }

  switch (v.schermata) {
    case 'sala':
      return inSala(v, m, t, occhiata)
    case 'ruolo':
      return inRuolo(v, m, t, occhiata)
    case 'partita':
      return inPartita(v, m, t, occhiata)
    case 'riunione':
      return inRiunione(v, m, t, occhiata)
    default:
      return { attesa: occhiata }
  }
}

function falsifica(v: Vista, m: Memoria): unknown {
  const f = v.f
  const scelte: unknown[] = [
    { a: 'vota', x: m.id, f },
    { a: 'vota', x: 99999, f },
    { a: 'vota', x: 'salta', f: f - 1 },
    { a: 'start', f: f - 1 },
    { a: 'boh', f },
    { f },
    null,
    'testo non JSON',
    { a: 'vota', x: 'x'.repeat(2048), f },
  ]
  if (m.r.ruolo !== 'assassino') scelte.push({ a: 'uccidi', f })
  if (!v.io.host) scelte.push({ a: 'start', f }, { a: 'impostaTask', x: 99, f })
  if (v.schermata === 'partita' && m.adesso < v.taskDa) scelte.push({ a: 'spunta', f })
  if (v.schermata === 'partita' && m.adesso < v.emergencyDa) scelte.push({ a: 'emergency', f })
  if (v.schermata === 'riunione' && v.mioVoto !== null) scelte.push({ a: 'vota', x: 'salta', f })
  return scegli(m, scelte)
}

function inSala(v: VistaSala, m: Memoria, t: Tratti, occhiata: number): Decisione {
  if (m.r.iniziata) m.r = nuoviRicordi()
  m.r.salaDa ??= m.adesso
  const f = v.f

  if (t.piantagrane) {
    if (v.presenti < v.minGiocatori) return { premi: { a: 'start', f }, falsa: true, attesa: occhiata }
    if (!v.io.host) return { premi: { a: 'impostaTask', x: 1 + Math.floor(m.caso() * 50), f }, falsa: true, attesa: occhiata }
  }

  const p = m.piano
  if (!v.io.host || !p) return { attesa: occhiata }
  if (v.numeroTask !== p.numeroTask) return { premi: { a: 'impostaTask', x: p.numeroTask, f }, attesa: occhiata }
  if (v.numeroAssassini !== p.assassini && p.assassini <= v.maxAssassini) {
    return { premi: { a: 'impostaAssassini', x: p.assassini, f }, attesa: occhiata }
  }

  const assenti = v.giocatori.filter(g => g.offline)
  if (v.presenti >= p.giocatori && !assenti.length) return { premi: { a: 'start', f }, attesa: occhiata }
  if (m.adesso - m.r.salaDa >= PAZIENZA_SALA) {
    if (assenti.length) return { premi: { a: 'togli', x: assenti[0].id, f }, attesa: occhiata }
    if (v.presenti >= v.minGiocatori) return { premi: { a: 'start', f }, attesa: occhiata }
  }
  return { attesa: occhiata }
}

function inRuolo(v: VistaRuolo, m: Memoria, t: Tratti, occhiata: number): Decisione {
  // Con il telefono bloccato si può saltare la sala: una nuova Rivelazione vale come nuova partita.
  if (m.r.ruoloLetto) m.r = nuoviRicordi()
  const r = m.r
  r.iniziata = true
  r.ruolo = v.ruolo
  r.complici = v.complici
  r.ruoloDa ??= m.adesso

  if (t.ricarica && !r.ricaricatoRuolo) {
    r.ricaricatoRuolo = true
    return { rete: 'ricarica', attesa: 2 * S }
  }
  const resta = r.ruoloDa + t.leggeRuolo - m.adesso
  if (resta > 0) return { attesa: resta }
  r.ruoloLetto = true
  return { premi: { a: 'ruoloVisto', f: v.f }, attesa: occhiata }
}

// Se è stato colpito lo dichiara con i suoi tempi: vale in partita e in riunione, come il tasto.
function dichiaroMorte(m: Memoria, f: number, occhiata: number): Decisione {
  if (m.adesso >= m.r.premoMortoIl) return { premi: { a: 'sonoMorto', f }, attesa: occhiata }
  return { attesa: Math.min(occhiata, m.r.premoMortoIl - m.adesso) }
}

function inPartita(v: VistaPartita, m: Memoria, t: Tratti, occhiata: number): Decisione {
  const r = m.r
  const f = v.f

  if (v.io.vivo) {
    if (r.colpitoIl !== null) return dichiaroMorte(m, f, occhiata)

    if (t.dueSchede && !r.dueSchede) {
      r.dueSchede = true
      return { rete: 'seconda-scheda', attesa: occhiata }
    }

    const assassino = r.ruolo === 'assassino'
    if (!assassino && (r.hoVisto !== null || r.cadavere)) return { premi: { a: 'report', f }, attesa: occhiata }
    if (t.reportAllaVoce && r.voce) {
      r.voce = false
      return { premi: { a: 'report', f }, attesa: occhiata }
    }
    if (t.reportInTasca) {
      r.tascaIl ??= m.adesso + tra(m, 2 * MIN, 15 * MIN)
      if (m.adesso >= r.tascaIl) {
        r.tascaIl = Infinity
        return { premi: { a: 'report', f }, attesa: occhiata }
      }
    }
    if (t.emergencySubito && m.adesso >= v.emergencyDa) return { premi: { a: 'emergency', f }, attesa: occhiata }

    if (v.uccidiDa !== undefined && m.adesso >= v.uccidiDa) {
      r.uccidoIl ??= m.adesso + tra(m, 0.5 * t.attesaUccidi, 1.5 * t.attesaUccidi)
      const bersagli = m.intorno.filter(p => !r.complici.includes(p.nome))
      if (m.adesso >= r.uccidoIl && bersagli.length) {
        if (!r.riquadro) {
          r.riquadro = true
          return { attesa: GESTO }
        }
        r.uccidoIl = null
        return { premi: { a: 'uccidi', f }, colpisco: scegli(m, bersagli).id, attesa: occhiata }
      }
    }
  }

  // Le task: chi è fuori resta seduto e non ne fa più.
  if (v.io.vivo && v.task && m.adesso >= v.taskDa && m.adesso >= r.fintaFino) {
    r.fineTaskIl ??= m.adesso + tra(m, 0.7 * t.durataTask, 1.3 * t.durataTask)
    if (m.adesso < r.fineTaskIl) return { attesa: Math.min(occhiata, r.fineTaskIl - m.adesso) }
    r.fineTaskIl = null
    const finge = r.ruolo === 'assassino' && m.caso() >= t.spuntaDaAssassino
    if (!finge) return { premi: { a: 'spunta', f }, attesa: occhiata }
    r.fintaFino = m.adesso + 2 * MIN
  }
  return { attesa: occhiata }
}

function inRiunione(v: VistaRiunione, m: Memoria, t: Tratti, occhiata: number): Decisione {
  const r = m.r
  const f = v.f

  if (r.riunioneF !== f) {
    r.riunioneF = f
    r.riunioneDa = m.adesso
    r.parlato = false
    r.dubbi = 0
    r.riquadro = false
    r.fineTaskIl = null
    r.uccidoIl = null
    r.cadavere = false
    r.voce = false
  }

  if (t.batteria && !m.scarico && m.caso() < 0.3) {
    m.scarico = true
    m.prestito = true
    m.rientroIl = m.adesso + tra(m, 60 * S, 150 * S)
    return { rete: 'scollega', attesa: m.rientroIl - m.adesso }
  }

  if (!v.io.vivo) return { attesa: occhiata }
  if (r.colpitoIl !== null) return dichiaroMorte(m, f, occhiata)

  const altri = v.giocatori.filter(g => g.id !== m.id)

  if (t.piantagrane && !v.io.host) {
    const online = altri.filter(g => !g.offline)
    if (online.length && m.caso() < 0.3) return { premi: { a: 'togli', x: scegli(m, online).id, f }, falsa: true, attesa: occhiata }
  }

  if (!r.parlato) {
    r.parlato = true
    const visto = r.hoVisto
    r.hoVisto = null
    if (visto !== null && altri.some(g => g.id === visto)) return { dico: { contro: visto, prova: true }, attesa: occhiata }
    const bersagli = altri.filter(g => !r.complici.includes(g.nome))
    const loquacita = r.ruolo === 'assassino' ? t.loquacita * 3 : t.loquacita
    if (bersagli.length && m.caso() < loquacita) return { dico: { contro: scegli(m, bersagli).id, prova: false }, attesa: occhiata }
  }

  if (t.fuggitiva && !r.fuggita && v.votati * 2 >= v.totale) {
    r.fuggita = true
    if (r.accuse[v.io.id] || m.caso() < 0.2) {
      m.fuori = true
      return { premi: { a: 'esci', f }, rete: 'scollega', attesa: 20 * S }
    }
  }

  if (t.ricarica && r.ricaricatoVotoF !== f) {
    r.ricaricatoVotoF = f
    if (m.caso() < 0.5) return { rete: 'ricarica', attesa: 2 * S }
  }

  if (v.mioVoto !== null) return { attesa: occhiata }

  const inRiunioneDa = m.adesso - r.riunioneDa
  if (inRiunioneDa < DISCUSSIONE) return { attesa: Math.min(occhiata, DISCUSSIONE - inRiunioneDa) }
  if (t.ultimaAVotare && v.votati < v.totale - 1 && inRiunioneDa < PAZIENZA_VOTO) return { attesa: occhiata }
  if (t.cambiaScelta && r.dubbi < t.cambiaScelta) {
    r.dubbi++
    return { attesa: tra(m, 3 * S, 8 * S) }
  }
  return { premi: { a: 'vota', x: scegliVoto(v, m, t), f }, attesa: occhiata }
}

function piuAccusato(m: Memoria, candidati: { id: number }[]): number | null {
  const accusati = candidati.filter(g => m.r.accuse[g.id])
  if (!accusati.length) return null
  const massimo = Math.max(...accusati.map(g => m.r.accuse[g.id]))
  return scegli(m, accusati.filter(g => m.r.accuse[g.id] === massimo)).id
}

function scegliVoto(v: VistaRiunione, m: Memoria, t: Tratti): Voto {
  const r = m.r
  const altri = v.giocatori.filter(g => g.id !== m.id)

  // L'assassino segue la voce che non tocca lui né i complici, altrimenti ogni tanto ne butta una a caso.
  if (r.ruolo === 'assassino') {
    const innocenti = altri.filter(g => !r.complici.includes(g.nome))
    const voce = piuAccusato(m, innocenti.filter(g => !r.prove.includes(g.id)))
    if (voce !== null) return voce
    if (innocenti.length && m.caso() >= t.prudenza) return scegli(m, innocenti).id
    return 'salta'
  }

  const provati = altri.filter(g => r.prove.includes(g.id))
  if (provati.length) return m.caso() < t.fiducia ? scegli(m, provati).id : 'salta'
  if (t.soloProve || m.caso() < t.prudenza) return 'salta'
  return piuAccusato(m, altri) ?? 'salta'
}

// ---- L'agente: lega cervello, telefono e mondo ----
export type Agente = {
  tratti: Tratti
  memoria: Memoria
  telefono: Telefono
  altroTelefono(stessoToken: boolean): Telefono // una seconda scheda, o un telefono prestato
  sveglia: number
}

// Una decisione completa. Funziona uguale con qualsiasi Telefono.
export function passo(ag: Agente, mondo: Mondo) {
  const m = ag.memoria
  m.adesso = ag.telefono.adesso()
  m.intorno = intorno(mondo, ag)
  m.rifiuto = ag.telefono.rifiuto()

  const v = ag.telefono.vista()
  if (v && v.io.id > 0) {
    m.id = v.io.id
    m.vivo = v.io.vivo
  }
  // Quando la stanza si raduna, i cadaveri non restano da trovare.
  if (v && (v.schermata === 'riunione' || v.schermata === 'fine' || v.schermata === 'sala')) mondo.corpi = []

  const d = decidi(v, m, ag.tratti)
  if (d.premi !== undefined) ag.telefono.invia(d.premi, d.falsa)
  if (d.colpisco !== undefined) colpisci(mondo, ag, d.colpisco)
  if (d.dico) parla(mondo, d.dico)

  switch (d.rete) {
    case 'collega':
      ag.telefono.collega(m.nome)
      if (ag.telefono.vista()) m.fuori = false
      break
    case 'scollega':
      ag.telefono.scollega()
      break
    case 'riconnetti':
      ag.telefono.scollega()
      ag.telefono.collega(m.nome)
      break
    case 'ricarica':
      ag.telefono.scollega()
      ag.telefono.collega(m.nome)
      m.r.riquadro = false
      mondo.conta.ricariche++
      break
    case 'seconda-scheda':
      ag.telefono = ag.altroTelefono(true)
      ag.telefono.collega(m.nome)
      mondo.conta.secondeSchede++
      break
    case 'telefono-prestato':
      ag.telefono = ag.altroTelefono(false)
      ag.telefono.collega(m.nome)
      break
  }
  ag.sveglia = Math.round(m.adesso + Math.max(d.attesa, 100)) // millisecondi interi, come Date.now() sul server
}

// ---- Il mondo fisico: ciò che alla festa avviene a voce e con le mani ----
// Solo pTestimone viene dal piano. Le altre sono stime: il bilanciamento dipende anche da loro.
export type Ipotesi = {
  pTestimone: number // a ogni uccisione, probabilità che una persona veda
  pVoce: number // a ogni uccisione, probabilità che si senta qualcosa in giro
  cadavereMs: number // tempo medio prima che qualcuno trovi un cadavere
  allarmeMs: number // tempo medio tra due voci senza fondamento: solo per mettere sotto stress le serate di collaudo
}
export const IPOTESI: Ipotesi = { pTestimone: 0.25, pVoce: 0.5, cadavereMs: 2 * MIN, allarmeMs: 8 * MIN }

type Corpo = { trovato: boolean; trovatoIl: number }

export type Mondo = {
  agenti: Agente[]
  caso: () => number
  ipotesi: Ipotesi
  corpi: Corpo[]
  allarmeIl: number
  conta: Record<'uccisioni' | 'testimoni' | 'cadaveri' | 'allarmi' | 'ricariche' | 'secondeSchede', number>
}

export function nuovoMondo(seme: number, ipotesi = IPOTESI): Mondo {
  const caso = generatore(seme)
  return {
    agenti: [],
    caso,
    ipotesi,
    corpi: [],
    allarmeIl: esponenziale(caso, ipotesi.allarmeMs),
    conta: { uccisioni: 0, testimoni: 0, cadaveri: 0, allarmi: 0, ricariche: 0, secondeSchede: 0 },
  }
}

const esponenziale = (caso: () => number, media: number) => -Math.log(1 - caso()) * media
const scegliCon = <T>(caso: () => number, lista: T[]): T => lista[Math.floor(caso() * lista.length)]

// In piedi: ha un posto, è vivo per il telefono e nessuno l'ha ancora colpito.
function inPiedi(ag: Agente): boolean {
  const m = ag.memoria
  return m.id !== null && !m.fuori && m.vivo && m.r.colpitoIl === null
}

function intorno(mondo: Mondo, ag: Agente): Persona[] {
  return mondo.agenti.filter(a => a !== ag && inPiedi(a)).map(a => ({ id: a.memoria.id as number, nome: a.memoria.nome }))
}

function colpisci(mondo: Mondo, assassino: Agente, vittimaId: number) {
  const vittima = mondo.agenti.find(a => a.memoria.id === vittimaId)
  if (!vittima || !inPiedi(vittima)) return
  const ora = assassino.memoria.adesso
  const [da, a] = vittima.tratti.morto

  // La vittima lo scopre subito: nella realtà glielo dice l'assassino.
  vittima.memoria.r.colpitoIl = ora
  vittima.memoria.r.premoMortoIl = ora + tra(vittima.memoria, da, a)
  mondo.corpi.push({ trovato: false, trovatoIl: ora + esponenziale(mondo.caso, mondo.ipotesi.cadavereMs) })
  mondo.conta.uccisioni++

  if (mondo.caso() < mondo.ipotesi.pVoce) for (const ag of mondo.agenti) ag.memoria.r.voce = true
  if (mondo.caso() >= mondo.ipotesi.pTestimone) return
  const altri = mondo.agenti.filter(x => x !== assassino && x !== vittima && inPiedi(x))
  if (!altri.length) return
  scegliCon(mondo.caso, altri).memoria.r.hoVisto = assassino.memoria.id
  mondo.conta.testimoni++
}

function parla(mondo: Mondo, voce: Voce) {
  for (const ag of mondo.agenti) {
    const r = ag.memoria.r
    r.accuse[voce.contro] = (r.accuse[voce.contro] ?? 0) + 1
    if (voce.prova && !r.prove.includes(voce.contro)) r.prove.push(voce.contro)
  }
}

// Ciò che succede da solo mentre tutti girano per casa.
export function giro(mondo: Mondo, ora: number) {
  for (const corpo of mondo.corpi) {
    if (corpo.trovato || ora < corpo.trovatoIl) continue
    const cercatori = mondo.agenti.filter(a => inPiedi(a) && a.memoria.r.ruolo !== 'assassino')
    if (!cercatori.length) continue
    corpo.trovato = true
    scegliCon(mondo.caso, cercatori).memoria.r.cadavere = true
    mondo.conta.cadaveri++
  }
  if (ora >= mondo.allarmeIl) {
    mondo.allarmeIl = ora + esponenziale(mondo.caso, mondo.ipotesi.allarmeMs)
    mondo.conta.allarmi++
    for (const ag of mondo.agenti) ag.memoria.r.voce = true
  }
}
