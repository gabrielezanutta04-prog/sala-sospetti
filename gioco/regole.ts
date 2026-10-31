// Regole di Sala Sospetti: unica fonte di regole, tempi e testi delle task.
// Funzioni pure e sincrone, senza rete né React: l'ora arriva sempre da fuori, la casualità dal seme nello stato.
// Lo stato è JSON puro. Ogni funzione lo modifica sul posto; il server lo salva dopo ogni cambiamento.

// ---- Testi delle task: si cambiano qui, servono almeno 2 testi diversi ----
export const TASKS = [
  "Vai in cucina e bevi un bicchiere d'acqua",
  'Tocca tutte le maniglie delle porte del piano',
  'Fai 10 squat davanti a un altro giocatore',
  "Conta ad alta voce fino a 20 in un'altra stanza",
  'Spegni e riaccendi una luce tre volte',
  'Fai il giro completo del tavolo',
  "Chiedi l'ora a un altro giocatore",
  'Scrivi il tuo nome su un foglio e lascialo sul tavolo',
  "Riempi un bicchiere e portalo in un'altra stanza",
  'Trova un oggetto rosso e mostralo a qualcuno',
  'Trova un oggetto blu e appoggialo sul tavolo',
  'Trova qualcosa di verde e toccalo tre volte',
  'Trova tre oggetti rotondi e indicali a qualcuno',
  'Trova una penna e appoggiala sul tavolo',
  'Trova un libro e leggi ad alta voce la prima frase',
  'Apri e richiudi il frigorifero',
  "Apri e richiudi un cassetto in un'altra stanza",
  'Lavati le mani in bagno',
  'Entra in bagno, conta fino a 10 ed esci',
  'Sposta una sedia di un passo e rimettila al suo posto',
  "Siediti su tre sedie diverse, una dopo l'altra",
  "Conta le sedie della casa e di' il numero a un altro giocatore",
  'Conta i quadri o le foto appesi in una stanza',
  'Guarda fuori da una finestra per dieci secondi',
  'Fai cinque flessioni con le mani al muro',
  "Cammina all'indietro per dieci passi",
  'Stai in equilibrio su un piede per 15 secondi',
  'Piega un tovagliolo o un foglio e lascialo sul tavolo',
  "Porta un cuscino in un'altra stanza e poi riportalo indietro",
  'Stringi la mano a due giocatori',
  'Fai un complimento a un altro giocatore',
  'Chiedi a un altro giocatore il suo colore preferito',
  "Batti le mani dieci volte in un'altra stanza",
  'Canticchia una canzone per dieci secondi',
  'Disegna una casa su un foglio e lasciala sul tavolo',
  'Cammina lungo tutte le pareti di una stanza',
  "Tocca la porta d'ingresso e torna indietro",
  'Attraversa tutte le stanze del piano senza fermarti',
]

// ---- Tempi modificabili ----
export const COOLDOWN = 10 * 60 * 1000 // Emergency: 10 min dall'ultima riunione d'emergenza, di chiunque
export const TASK_MS = 2 * 60 * 1000 // attesa dopo una spunta
export const KILL_CD = 5 * 60 * 1000 // Uccidi: attesa a inizio partita, dopo ogni uso e dopo ogni riunione
export const RESULT_MS = 8000 // esito della votazione a schermo
export const END_MS = 10000 // scritta di vittoria a schermo
export const OFFLINE_MS = 30 * 1000 // senza segnale da tanto si è offline. Non viene mai scalato
export const ASSENTE_VOTO_MS = 45 * 1000 // senza segnale da tanto si vale come Salta. Non viene mai scalato
export const LONG_PRESS_MS = 650 // pressione lunga sulla barra in alto
export const LONG_PRESS_PX = 12 // movimento che annulla la pressione lunga

// ---- Altre costanti ----
export const MIN_PLAYERS = 3
export const MAX_GIOCATORI = 20
export const TASKS_DEFAULT = 32
export const TASKS_MIN = 1 // nessun tetto massimo: l'host sceglie liberamente
export const ASSASSINI_SCEGLIBILI = 2 // il selettore in sala offre 1 o 2
export const NOME_MAX = 16
export const ALFABETO_CODICE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const LUNGHEZZA_CODICE = 5

// Colori degli avatar con contrasto verificato: assegnati all'ingresso, mai legati al ruolo.
export const COLORI = [
  ...['#1f5aad', '#b62052', '#aa4f0e', '#14713b', '#7d34b2', '#746b06', '#0d6e77', '#bf2222'].map(sfondo => ({ sfondo, lettera: '#ffffff' })),
  ...['#8bb9f9', '#f994b6', '#fba856', '#5fdd94', '#d3a1f7', '#f4e434', '#49d2df', '#f99494'].map(sfondo => ({ sfondo, lettera: '#0b1430' })),
]

export const TESTI_RIFIUTO: Record<Rifiuto, string> = {
  'nome-vuoto': 'Scrivi prima il tuo nome',
  'nome-usato': 'Questo nome è già usato in questa stanza',
  'partita-in-corso': "La partita è già iniziata: si entra solo dalla sala d'attesa",
  'stanza-piena': `La stanza è piena: massimo ${MAX_GIOCATORI} giocatori`,
}

// ---- Tipi dello stato ----
export type Fase = 'sala' | 'partita' | 'riunione' | 'esito' | 'fine'
export type Schermata = 'sala' | 'ruolo' | 'partita' | 'riunione' | 'esito' | 'fine'
export type Ruolo = 'civile' | 'assassino'
export type Causa = 'morto' | 'eliminato'
export type Vincitore = 'civili' | 'assassini'
export type Motivo = 'barra' | 'assassini' | 'maggioranza'
export type TipoRiunione = 'report' | 'emergency'
export type Voto = number | 'salta'
export type Rifiuto = 'nome-vuoto' | 'nome-usato' | 'partita-in-corso' | 'stanza-piena'

export type Giocatore = {
  id: number
  token: string
  nome: string
  colore: number // indice in COLORI
  ruolo: Ruolo | null
  vivo: boolean
  causa: Causa | null
  ruoloVisto: boolean
  task: string | null // prossima task da fare: dopo una spunta è già pescata
  taskFatta: string | null // task spuntata, a schermo finché non arriva taskDa
  taskDa: number // da quando si può spuntare
  uccidiDa: number | null // da quando questo assassino può usare Uccidi
  visto: number // ultimo segnale ricevuto
}

export type Votante = { id: number; nome: string; colore: number; voti: number }

export type Esito = {
  eliminatoId: number | null
  eliminatoNome: string | null
  eliminatoRuolo: Ruolo | null
  parita: boolean
  salti: number
}

export type Riunione = {
  tipo: TipoRiunione
  daId: number
  daNome: string // congelato: chi convoca può uscire
  voti: Record<string, Voto>
  rivotare: number[] // chi ha perso il voto e deve darne un altro
  votanti: Votante[] // congelati alla chiusura
  fuori: string[] // nomi dei morti, congelati alla chiusura
  esito: Esito | null
}

export type Stato = {
  codice: string
  fase: Fase
  f: number // contatore di fase: scarta le azioni rimaste indietro
  hostId: number | null
  numeroTask: number
  numeroAssassini: number // scelta dell'host: resta salvata di partita in partita
  assassiniPartita: number // assassini distribuiti allo Start, 0 finché non c'è una partita
  giocatori: Giocatore[] // in ordine di ingresso
  barra: number
  traguardo: number // 0 finché non c'è una partita
  emergencyDa: number // da quando si può premere Emergency
  emergencyDaId: number | null
  emergencyDaNome: string | null
  riunione: Riunione | null
  scadenza: number | null // fine di esito e fine partita
  mazzo: number[] // indici di TASKS ancora da pescare
  vincitore: Vincitore | null
  motivo: Motivo | null
  durate: { emergency: number; task: number; uccidi: number; esito: number; fine: number }
  seme: number
  prossimoId: number
}

// ---- Azioni dei telefoni: arrivano da fuori, quindi vanno sempre controllate ----
export type Azione = { f: number } & (
  | { a: 'impostaTask'; x: number }
  | { a: 'impostaAssassini'; x: number }
  | { a: 'start' }
  | { a: 'ruoloVisto' }
  | { a: 'report' }
  | { a: 'emergency' }
  | { a: 'spunta' }
  | { a: 'uccidi' }
  | { a: 'sonoMorto' }
  | { a: 'vota'; x: Voto }
  | { a: 'togli'; x: number }
  | { a: 'esci' }
)

export type Ingresso = { ok: true; id: number } | { ok: false; motivo: Rifiuto }

// ---- Vista: ciò che un telefono riceve, solo ciò che quel giocatore può sapere ----
export type Volto = { id: number; nome: string; iniziale: string; colore: string; lettera: string }
export type RigaSala = Volto & { host: boolean; offline: boolean }
export type RigaRiunione = RigaSala & { haVotato: boolean }
export type RigaEsito = Volto & { voti: number }
export type RigaFine = Volto & { ruolo: Ruolo; vivo: boolean }

type Comune = {
  ora: number // ora del server: tutte le scadenze sono timestamp assoluti da confrontare con questa
  f: number
  codice: string
  barra: number
  traguardo: number
  presenti: number
  io: Volto & { host: boolean; vivo: boolean; causa: Causa | null }
}

export type VistaSala = Comune & {
  schermata: 'sala'
  giocatori: RigaSala[]
  numeroTask: number
  numeroAssassini: number
  maxAssassini: number
  traguardoPrevisto: number
  minGiocatori: number
}

export type VistaRuolo = Comune & {
  schermata: 'ruolo'
  ruolo: Ruolo
  assassini: number
  complici: string[]
  riunioneAperta: boolean // chi legge il ruolo tiene ferma la riunione: deve saperlo anche dopo una ricarica
}

export type VistaPartita = Comune & {
  schermata: 'partita'
  task: string | null
  taskFatta: string | null
  taskDa: number // prima di taskDa si mostra taskFatta col timer, da taskDa in poi task
  emergencyDa: number
  emergencyDaId: number | null
  emergencyDaNome: string | null
  uccidiDa?: number // solo per un assassino vivo
}

export type VistaRiunione = Comune & {
  schermata: 'riunione'
  tipo: TipoRiunione
  daId: number
  daNome: string
  giocatori: RigaRiunione[] // solo i vivi
  fuori: string[]
  votati: number
  totale: number
  mioVoto: Voto | null // il proprio voto: quelli altrui non escono mai dal server
  rivota: boolean // il voto dato è stato annullato
}

export type VistaEsito = Comune & {
  schermata: 'esito'
  scadenza: number
  tipo: TipoRiunione
  daId: number
  daNome: string
  votanti: RigaEsito[]
  fuori: string[]
  eliminatoId: number | null
  eliminatoNome: string | null
  eliminatoRuolo: Ruolo | null
  parita: boolean
  salti: number
  vincitore: Vincitore | null // non nullo se allo scadere la partita finisce
}

export type VistaFine = Comune & {
  schermata: 'fine'
  scadenza: number
  vincitore: Vincitore
  motivo: Motivo
  giocatori: RigaFine[]
}

export type Vista = VistaSala | VistaRuolo | VistaPartita | VistaRiunione | VistaEsito | VistaFine

// ---- Aiuti ----
const trova = (s: Stato, id: number | null) => s.giocatori.find(g => g.id === id)
const online = (g: Giocatore, ora: number) => ora - g.visto < OFFLINE_MS
const contaAssassini = (giocatori: Giocatore[]) => giocatori.filter(g => g.ruolo === 'assassino').length
const calcolaTraguardo = (civili: number, numeroTask: number) => Math.max(1, Math.ceil((civili * numeroTask) / 2))

// Generatore mulberry32: tutto il suo stato è il seme, quindi resta riproducibile dopo ogni salvataggio.
function casuale(s: Stato): number {
  s.seme = (s.seme + 0x6d2b79f5) | 0
  let t = Math.imul(s.seme ^ (s.seme >>> 15), 1 | s.seme)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function mescola<T>(s: Stato, lista: T[]): T[] {
  for (let i = lista.length - 1; i > 0; i--) {
    const j = Math.floor(casuale(s) * (i + 1))
    ;[lista[i], lista[j]] = [lista[j], lista[i]]
  }
  return lista
}

// Mazzo senza ripetizioni, condiviso dalla stanza: il testo è sempre diverso dal precedente del giocatore.
function pesca(s: Stato, escluso: string | null): string {
  if (s.mazzo.length < 2) {
    const resto = s.mazzo[0]
    s.mazzo.push(...mescola(s, TASKS.map((_, i) => i).filter(i => i !== resto)))
  }
  const pos = TASKS[s.mazzo[0]] === escluso ? 1 : 0
  return TASKS[s.mazzo.splice(pos, 1)[0]]
}

export const maxAssassini = (giocatori: number) => Math.max(1, Math.floor((giocatori - 1) / 2))

// La scelta dell'host resta salvata: se esce qualcuno vale il massimo consentito, se rientra torna valida.
const assassiniEffettivi = (s: Stato) => Math.min(s.numeroAssassini, maxAssassini(s.giocatori.length))

export function codiceValido(codice: string): boolean {
  return typeof codice === 'string' && codice.length === LUNGHEZZA_CODICE && Array.from(codice).every(c => ALFABETO_CODICE.includes(c))
}

// La casualità arriva da chi chiama: le regole non usano Math.random.
export function generaCodice(caso: () => number): string {
  let codice = ''
  for (let i = 0; i < LUNGHEZZA_CODICE; i++) codice += ALFABETO_CODICE[Math.floor(caso() * ALFABETO_CODICE.length)]
  return codice
}

// Caratteri che non si vedono: direzione del testo, larghezza zero e riempitivi come U+2800 e U+3164, che per Unicode non sono spazi.
// Nel nome mostrato si tolgono, ma la prima alternativa salva le emoji composte: con i toni, i selettori, i tag delle bandiere
// e U+200D seguito da un'altra emoji restano intere, e un nome di sola emoji resta valido.
const NASCOSTI_NEL_NOME = /(\p{Extended_Pictographic}(?:[\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|\u200D\p{Extended_Pictographic})*)|[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu
const NASCOSTI_NELLA_CHIAVE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu

// Lettere cirilliche che si leggono come le latine scritte nella stessa posizione: «Vеra» con la е russa è lo stesso nome di «Vera».
const SOSIA_CIRILLICI = 'авеіјкмнорсѕтух'
const SOSIA_LATINI = 'abeijkmhopcstyx'

function pulisciNome(nome: string): string {
  if (typeof nome !== 'string') return ''
  const pulito = nome
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(NASCOSTI_NEL_NOME, (_, emoji?: string) => emoji ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(pulito).slice(0, NOME_MAX).join('').trim()
}

// Forma usata solo per confrontare: «anna » e «Anna» sono lo stesso nome. Se resta vuota il nome non ha nulla di visibile.
function chiaveNome(nome: string): string {
  return nome
    .normalize('NFKC')
    .replace(NASCOSTI_NELLA_CHIAVE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/./gu, c => SOSIA_LATINI[SOSIA_CIRILLICI.indexOf(c)] ?? c)
}

const POSTO_VUOTO = { ruolo: null, vivo: true, causa: null, ruoloVisto: false, task: null, taskFatta: null, taskDa: 0, uccidiDa: null }

function nuovoGiocatore(id: number, token: string, nome: string, colore: number, ora: number): Giocatore {
  return { id, token, nome, colore, visto: ora, ...POSTO_VUOTO }
}

// Chi deve ancora leggere il ruolo resta su Rivelazione. Fine e sala valgono per tutti, così nessuno resta indietro.
function schermataDi(s: Stato, g: Giocatore): Schermata {
  if (s.fase !== 'sala' && s.fase !== 'fine' && g.ruolo && !g.ruoloVisto) return 'ruolo'
  return s.fase
}

// Giocatori in ordine di ingresso a partire da chi segue g, ricominciando dall'inizio.
function successivi(s: Stato, g: Giocatore): Giocatore[] {
  const i = s.giocatori.indexOf(g)
  return [...s.giocatori.slice(i + 1), ...s.giocatori.slice(0, i)]
}

// ---- Vittoria ----
export function computeWinner(s: Stato): Vincitore | null {
  if (!s.traguardo) return null
  const vivi = s.giocatori.filter(g => g.vivo)
  const a = contaAssassini(vivi)
  const c = vivi.length - a
  if (a === 0) return 'civili'
  if (a >= c) return 'assassini'
  return null
}

function finisci(s: Stato, vincitore: Vincitore, motivo: Motivo, ora: number) {
  s.vincitore = vincitore
  s.motivo = motivo
  s.riunione = null
  s.fase = 'fine'
  s.f++
  s.scadenza = ora + s.durate.fine
}

function controllaVittoria(s: Stato, ora: number) {
  const vincitore = computeWinner(s)
  if (vincitore) finisci(s, vincitore, vincitore === 'civili' ? 'assassini' : 'maggioranza', ora)
}

// ---- Riunione ----
function apriRiunione(s: Stato, tipo: TipoRiunione, g: Giocatore) {
  s.riunione = { tipo, daId: g.id, daNome: g.nome, voti: {}, rivotare: [], votanti: [], fuori: [], esito: null }
  s.fase = 'riunione'
  s.f++
}

const senzaVoto = (s: Stato, r: Riunione) => s.giocatori.filter(g => g.vivo && !(g.id in r.voti))

// Si chiude quando tutti i vivi hanno votato, o quando chi manca è senza segnale da ASSENTE_VOTO_MS.
function controllaChiusura(s: Stato, ora: number): boolean {
  const r = s.riunione
  if (s.fase !== 'riunione' || !r) return false
  if (!senzaVoto(s, r).every(g => ora - g.visto >= ASSENTE_VOTO_MS)) return false

  const vivi = s.giocatori.filter(g => g.vivo)
  for (const g of vivi) r.voti[g.id] ??= 'salta'

  const conteggi: Record<string, number> = {}
  for (const voto of Object.values(r.voti)) conteggi[voto] = (conteggi[voto] ?? 0) + 1
  const massimo = Math.max(0, ...Object.values(conteggi))
  const testa = Object.keys(conteggi).filter(k => conteggi[k] === massimo)
  const eliminato = testa.length === 1 && testa[0] !== 'salta' ? trova(s, Number(testa[0])) : undefined

  // Si congela tutto prima dell'eliminazione: l'eliminato resta in lista e il conteggio resta giusto.
  r.votanti = vivi.map(g => ({ id: g.id, nome: g.nome, colore: g.colore, voti: conteggi[g.id] ?? 0 }))
  r.fuori = s.giocatori.filter(g => !g.vivo).map(g => g.nome)
  r.esito = {
    eliminatoId: eliminato?.id ?? null,
    eliminatoNome: eliminato?.nome ?? null,
    eliminatoRuolo: eliminato?.ruolo ?? null,
    parita: testa.length > 1,
    salti: conteggi.salta ?? 0,
  }
  if (eliminato) {
    eliminato.vivo = false
    eliminato.causa = 'eliminato'
  }
  s.fase = 'esito'
  s.f++
  s.scadenza = ora + s.durate.esito
  return true
}

// Il voto di chi esce sparisce e i voti che ha ricevuto si annullano: chi li aveva dati può rivotare.
function togliDaiVoti(r: Riunione, id: number) {
  delete r.voti[id]
  r.rivotare = r.rivotare.filter(x => x !== id)
  for (const [chi, voto] of Object.entries(r.voti)) {
    if (voto !== id) continue
    delete r.voti[chi]
    r.rivotare.push(Number(chi))
  }
}

// Dopo una morte o un'uscita. Con una riunione aperta, esito compreso, la vittoria aspetta la fine della riunione.
function dopoPerdita(s: Stato, id: number, ora: number) {
  if (s.fase === 'riunione' && s.riunione) {
    togliDaiVoti(s.riunione, id)
    controllaChiusura(s, ora)
  } else if (s.fase === 'partita') {
    controllaVittoria(s, ora)
  }
}

// Fine dell'esito: la vittoria si decide qui, così vale anche per chi è uscito durante l'esito.
function fineEsito(s: Stato, ora: number) {
  s.riunione = null
  s.scadenza = null
  controllaVittoria(s, ora)
  if (s.fase === 'fine') return
  s.fase = 'partita'
  s.f++
  for (const g of s.giocatori) if (g.ruolo === 'assassino') g.uccidiDa = ora + s.durate.uccidi
}

// ---- Uscita, unica per Esci e Togli ----
function rimuovi(s: Stato, g: Giocatore, ora: number) {
  if (s.hostId === g.id) {
    const altri = successivi(s, g)
    s.hostId = (altri.find(x => online(x, ora)) ?? altri[0])?.id ?? null
  }
  s.giocatori = s.giocatori.filter(x => x !== g)
  dopoPerdita(s, g.id, ora)
}

// ---- Inizio e fine partita ----
function avvia(s: Stato, ora: number) {
  s.assassiniPartita = assassiniEffettivi(s)
  mescola(s, [...s.giocatori]).forEach((g, i) => {
    const assassino = i < s.assassiniPartita
    g.ruolo = assassino ? 'assassino' : 'civile'
    g.uccidiDa = assassino ? ora + s.durate.uccidi : null
    g.task = pesca(s, null)
  })
  s.traguardo = calcolaTraguardo(s.giocatori.length - s.assassiniPartita, s.numeroTask)
  s.fase = 'partita'
  s.f++
}

function tornaInSala(s: Stato) {
  for (const g of s.giocatori) Object.assign(g, POSTO_VUOTO)
  s.fase = 'sala'
  s.f++
  s.barra = 0
  s.traguardo = 0
  s.assassiniPartita = 0
  s.emergencyDa = 0
  s.emergencyDaId = null
  s.emergencyDaNome = null
  s.riunione = null
  s.scadenza = null
  s.vincitore = null
  s.motivo = null
}

// ---- Funzioni del contratto ----
export function nuovaStanza(codice: string, seme: number, scala = 1): Stato {
  const k = scala > 0 ? scala : 1
  const dura = (ms: number) => Math.round(ms / k)
  return {
    codice,
    fase: 'sala',
    f: 1,
    hostId: null,
    numeroTask: TASKS_DEFAULT,
    numeroAssassini: 1,
    assassiniPartita: 0,
    giocatori: [],
    barra: 0,
    traguardo: 0,
    emergencyDa: 0,
    emergencyDaId: null,
    emergencyDaNome: null,
    riunione: null,
    scadenza: null,
    mazzo: [],
    vincitore: null,
    motivo: null,
    durate: { emergency: dura(COOLDOWN), task: dura(TASK_MS), uccidi: dura(KILL_CD), esito: dura(RESULT_MS), fine: dura(END_MS) },
    seme: seme | 0,
    prossimoId: 1,
  }
}

export function entra(s: Stato, token: string, nome: string, ora: number): Ingresso {
  const mio = token ? s.giocatori.find(g => g.token === token) : undefined
  if (mio) {
    segnale(s, mio.id, ora)
    return { ok: true, id: mio.id }
  }

  const pulito = pulisciNome(nome)
  const chiave = chiaveNome(pulito)
  if (!chiave) return { ok: false, motivo: 'nome-vuoto' }

  const omonimo = s.giocatori.find(g => chiaveNome(g.nome) === chiave)
  if (omonimo) {
    if (online(omonimo, ora)) return { ok: false, motivo: 'nome-usato' }
    omonimo.token = token
    segnale(s, omonimo.id, ora)
    return { ok: true, id: omonimo.id }
  }

  if (s.fase !== 'sala') return { ok: false, motivo: 'partita-in-corso' }
  if (s.giocatori.length >= MAX_GIOCATORI) return { ok: false, motivo: 'stanza-piena' }

  const usati = s.giocatori.map(g => g.colore)
  const libero = COLORI.findIndex((_, i) => !usati.includes(i))
  const id = s.prossimoId++
  s.giocatori.push(nuovoGiocatore(id, token, pulito, libero >= 0 ? libero : id % COLORI.length, ora))
  s.hostId ??= id
  return { ok: true, id }
}

export function applica(s: Stato, id: number, azione: Azione, ora: number): boolean {
  const g = trova(s, id)
  if (!g || typeof azione !== 'object' || azione === null || azione.f !== s.f) return false
  const cambiato = esegui(s, g, azione, ora)
  if (cambiato) segnale(s, id, ora)
  return cambiato
}

// Ogni controllo avviene prima di ogni modifica: un'azione non valida non lascia tracce.
function esegui(s: Stato, g: Giocatore, az: Azione, ora: number): boolean {
  const qui = schermataDi(s, g)
  const host = g.id === s.hostId

  switch (az.a) {
    case 'impostaTask':
      if (qui !== 'sala' || !host || !Number.isSafeInteger(az.x) || az.x < TASKS_MIN || az.x === s.numeroTask) return false
      s.numeroTask = az.x
      return true

    case 'impostaAssassini':
      if (qui !== 'sala' || !host || az.x === s.numeroAssassini) return false
      if ((az.x !== 1 && az.x !== ASSASSINI_SCEGLIBILI) || az.x > maxAssassini(s.giocatori.length)) return false
      s.numeroAssassini = az.x
      return true

    case 'start':
      if (qui !== 'sala' || !host || s.giocatori.length < MIN_PLAYERS) return false
      avvia(s, ora)
      return true

    case 'ruoloVisto':
      if (qui !== 'ruolo') return false
      g.ruoloVisto = true
      return true

    case 'report':
      if (qui !== 'partita' || !g.vivo) return false
      apriRiunione(s, 'report', g)
      return true

    case 'emergency':
      if (qui !== 'partita' || !g.vivo || ora < s.emergencyDa) return false
      s.emergencyDa = ora + s.durate.emergency
      s.emergencyDaId = g.id
      s.emergencyDaNome = g.nome
      apriRiunione(s, 'emergency', g)
      return true

    case 'spunta':
      if (qui !== 'partita' || !g.task || ora < g.taskDa) return false
      g.taskFatta = g.task
      g.task = pesca(s, g.taskFatta)
      g.taskDa = ora + s.durate.task
      s.barra = Math.min(s.traguardo, s.barra + 1)
      if (s.barra >= s.traguardo) finisci(s, 'civili', 'barra', ora)
      return true

    case 'uccidi':
      if (qui !== 'partita' || !g.vivo || g.ruolo !== 'assassino' || g.uccidiDa === null || ora < g.uccidiDa) return false
      g.uccidiDa = ora + s.durate.uccidi
      return true

    case 'sonoMorto':
      if ((qui !== 'partita' && qui !== 'riunione') || !g.vivo) return false
      g.vivo = false
      g.causa = 'morto'
      dopoPerdita(s, g.id, ora)
      return true

    case 'vota': {
      const r = s.riunione
      if (qui !== 'riunione' || !r || !g.vivo || g.id in r.voti) return false
      if (az.x !== 'salta') {
        const bersaglio = trova(s, az.x)
        if (!bersaglio || !bersaglio.vivo || bersaglio === g) return false
      }
      r.voti[g.id] = az.x
      r.rivotare = r.rivotare.filter(x => x !== g.id)
      controllaChiusura(s, ora)
      return true
    }

    case 'togli': {
      if ((qui !== 'sala' && qui !== 'riunione') || !host) return false
      const bersaglio = trova(s, az.x)
      if (!bersaglio || bersaglio === g || online(bersaglio, ora)) return false
      rimuovi(s, bersaglio, ora)
      return true
    }

    case 'esci':
      rimuovi(s, g, ora)
      return true

    default:
      return false
  }
}

export function scadi(s: Stato, ora: number): boolean {
  let cambiato = false

  const host = trova(s, s.hostId)
  if (host && !online(host, ora)) {
    const nuovo = successivi(s, host).find(g => online(g, ora))
    if (nuovo) {
      s.hostId = nuovo.id
      cambiato = true
    }
  }

  if (s.fase === 'riunione') {
    cambiato = controllaChiusura(s, ora) || cambiato
  } else if (s.scadenza !== null && ora >= s.scadenza) {
    if (s.fase === 'fine') tornaInSala(s)
    else fineEsito(s, ora)
    cambiato = true
  }
  return cambiato
}

export function segnale(s: Stato, id: number, ora: number) {
  const g = trova(s, id)
  if (g) g.visto = Math.max(g.visto, ora)
}

// Prossimo momento in cui scadi cambierà qualcosa da solo. Il passaggio host resta fuori di proposito: senza nessuno
// connesso non può avvenire e la scadenza resterebbe nel passato. Lo fa il giro delle presenze ogni 10 s.
export function prossimaScadenza(s: Stato): number | null {
  if (s.fase === 'esito' || s.fase === 'fine') return s.scadenza
  if (s.fase === 'riunione' && s.riunione) {
    const mancanti = senzaVoto(s, s.riunione)
    if (mancanti.length) return Math.max(...mancanti.map(g => g.visto)) + ASSENTE_VOTO_MS
  }
  return null
}

export function vista(s: Stato, id: number, ora: number): Vista {
  // Un socket rimasto aperto dopo Esci o Togli riceve una vista neutra, senza segreti.
  const g = trova(s, id) ?? nuovoGiocatore(-1, '', '', 0, ora)
  const schermata = schermataDi(s, g)

  const volto = (x: { id: number; nome: string; colore: number }): Volto => ({
    id: x.id,
    nome: x.nome,
    iniziale: Array.from(x.nome)[0]?.toUpperCase() ?? '',
    colore: COLORI[x.colore].sfondo,
    lettera: COLORI[x.colore].lettera,
  })
  const riga = (x: Giocatore): RigaSala => ({ ...volto(x), host: x.id === s.hostId, offline: !online(x, ora) })

  const comune: Comune = {
    ora,
    f: s.f,
    codice: s.codice,
    barra: s.barra,
    traguardo: s.traguardo,
    presenti: s.giocatori.length,
    io: { ...volto(g), host: g.id === s.hostId, vivo: g.vivo, causa: g.causa },
  }

  if (schermata === 'sala') {
    const numeroAssassini = assassiniEffettivi(s)
    return {
      ...comune,
      schermata,
      giocatori: s.giocatori.map(riga),
      numeroTask: s.numeroTask,
      numeroAssassini,
      maxAssassini: Math.min(ASSASSINI_SCEGLIBILI, maxAssassini(s.giocatori.length)),
      traguardoPrevisto: calcolaTraguardo(s.giocatori.length - numeroAssassini, s.numeroTask),
      minGiocatori: MIN_PLAYERS,
    }
  }

  if (schermata === 'ruolo') {
    const assassino = g.ruolo === 'assassino'
    return {
      ...comune,
      schermata,
      ruolo: g.ruolo as Ruolo,
      assassini: s.assassiniPartita,
      complici: assassino ? s.giocatori.filter(x => x.ruolo === 'assassino' && x !== g).map(x => x.nome) : [],
      riunioneAperta: s.fase === 'riunione',
    }
  }

  // Nessuna lista di giocatori in partita: rivelerebbe chi ha già premuto Sono morto.
  if (schermata === 'partita') {
    const v: VistaPartita = {
      ...comune,
      schermata,
      task: g.task,
      taskFatta: g.taskFatta,
      taskDa: g.taskDa,
      emergencyDa: s.emergencyDa,
      emergencyDaId: s.emergencyDaId,
      emergencyDaNome: s.emergencyDaNome,
    }
    if (g.vivo && g.ruolo === 'assassino' && g.uccidiDa !== null) v.uccidiDa = g.uccidiDa
    return v
  }

  if (schermata === 'fine') {
    return {
      ...comune,
      schermata,
      scadenza: s.scadenza as number,
      vincitore: s.vincitore as Vincitore,
      motivo: s.motivo as Motivo,
      giocatori: s.giocatori.map(x => ({ ...volto(x), ruolo: x.ruolo as Ruolo, vivo: x.vivo })),
    }
  }

  const r = s.riunione as Riunione
  const convocata = { tipo: r.tipo, daId: r.daId, daNome: r.daNome }

  if (schermata === 'esito') {
    const e = r.esito as Esito
    return {
      ...comune,
      ...convocata,
      schermata,
      scadenza: s.scadenza as number,
      votanti: r.votanti.map(x => ({ ...volto(x), voti: x.voti })),
      fuori: r.fuori,
      eliminatoId: e.eliminatoId,
      eliminatoNome: e.eliminatoNome,
      eliminatoRuolo: e.eliminatoRuolo,
      parita: e.parita,
      salti: e.salti,
      vincitore: computeWinner(s),
    }
  }

  // Chi deve rivotare resta contato: se tornasse a zero, tutti vedrebbero chi aveva votato il giocatore uscito.
  const contato = (x: Giocatore) => x.id in r.voti || r.rivotare.includes(x.id)
  const vivi = s.giocatori.filter(x => x.vivo)
  return {
    ...comune,
    ...convocata,
    schermata,
    giocatori: vivi.map(x => ({ ...riga(x), haVotato: contato(x) })),
    fuori: s.giocatori.filter(x => !x.vivo).map(x => x.nome),
    votati: vivi.filter(contato).length,
    totale: vivi.length,
    mioVoto: r.voti[g.id] ?? null,
    rivota: r.rivotare.includes(g.id),
  }
}
