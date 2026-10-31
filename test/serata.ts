// Livello L1: serate intere sulle regole, senza rete, con orologio virtuale e seme fisso.
//   node test/serata.ts                          scenari, 100 serate, tabella di bilanciamento
//   node test/serata.ts --seme 1042              rifà una sola serata
//   node test/serata.ts --partita 15,2,24,701234 rifà una sola partita (giocatori,assassini,task,seme)
//   node test/serata.ts --rapido                 solo scenari e 10 serate, senza bilanciamento
//   node test/serata.ts --solo-tabella           solo il bilanciamento
//   node test/serata.ts --sensibilita            aggiunge il bilanciamento con ipotesi diverse
//   node test/serata.ts --task 32,48 --giocatori 12,13   cambia la griglia del bilanciamento

import { applica, codiceValido, entra, MAX_GIOCATORI, NOME_MAX, nuovaStanza, PROBABILITA_MISSIONE, prossimaScadenza, scadi, segnale, SEGNO_MISSIONE, TASKS, vista } from '../gioco/regole.ts'
import type { Azione, Fase, Giocatore, Rifiuto, Schermata, Stato, Vista, VistaEsito, VistaFine, VistaPartita, VistaRiunione, VistaRuolo, VistaSala, Voto } from '../gioco/regole.ts'
import { generatore, giro, IPOTESI, nuovaMemoria, nuovoMondo, passo, PERSONALITA, senzaManie } from './agenti.ts'
import type { Agente, Ipotesi, Mondo, Piano, Telefono, Tratti } from './agenti.ts'

const MIN = 60_000

// Tempi riscritti a mano: se una costante di regole.ts cambia, il test deve accorgersene.
const ATTESO = { task: 120_000, uccidi: 300_000, emergency: 600_000, esito: 8_000, fine: 10_000, offline: 30_000, assente: 45_000 }
const PRESENZE_MS = 10_000 // giro delle presenze del server
const LIMITE: Record<Fase, number> = { sala: 30 * MIN, partita: 240 * MIN, riunione: 10 * MIN, esito: ATTESO.esito, fine: ATTESO.fine }
const PREFISSO_TOKEN = 'tok-segreto-'

function errore(codice: string, testo: string): never {
  throw new Error(`${codice}: ${testo}`)
}

function vero(condizione: unknown, testo: string) {
  if (!condizione) throw new Error(testo)
}

// ---- C4, l'arbitro: niente da regole.ts, solo i fatti osservati ----
function arbitroEliminato(schede: (number | 'salta')[]): number | null {
  const conta = new Map<number | 'salta', number>()
  for (const x of schede) conta.set(x, (conta.get(x) ?? 0) + 1)
  const massimo = Math.max(0, ...conta.values())
  const primi = [...conta].filter(([, n]) => n === massimo).map(([x]) => x)
  return primi.length === 1 && primi[0] !== 'salta' ? (primi[0] as number) : null
}

function arbitroVincitore(vivi: number[], assassini: Set<number>): 'civili' | 'assassini' | null {
  const a = vivi.filter(id => assassini.has(id)).length
  const c = vivi.length - a
  return a === 0 ? 'civili' : a >= c ? 'assassini' : null
}

// Il registro dell'arbitro: si aggiorna solo con le azioni accettate e i tempi attesi.
type Arbitro = {
  inizio: number
  assassini: Set<number>
  vivi: Set<number>
  schede: Map<number, Voto>
  spunte: number
  traguardo: number
  taskPronta: Map<number, number>
  uccidiPronto: Map<number, number>
  emergencyPronta: number
}

// Chi esce o muore perde il voto e fa perdere quelli che aveva ricevuto.
function fuoriDaiVoti(arb: Arbitro, id: number) {
  arb.vivi.delete(id)
  arb.schede.delete(id)
  for (const [chi, voto] of arb.schede) if (voto === id) arb.schede.delete(chi)
}

// ---- Il banco: finto server con orologio virtuale ----
type TelefonoFinto = Telefono & {
  token: string
  id: number | null
  connesso: boolean
  ricevuta: Vista | null
  ultimoTesto: string
  barra: number
  motivo: Rifiuto | null
}

const CONTA_VUOTA = {
  partite: 0,
  riunioni: 0,
  chiusurePerAssenti: 0,
  tolti: 0,
  usciteInRiunione: 0,
  usciteConVoti: 0,
  mortiInVoto: 0,
  rivoti: 0,
  passaggiHost: 0,
  hostUsciti: 0,
  ripresePosto: 0,
  azioniFalse: 0,
  parita: 0,
  saltaInTesta: 0,
  eliminazioni: 0,
  civiliEliminati: 0,
  vinteBarra: 0,
  vinteScoperti: 0,
  vinteMaggioranza: 0,
}
type Conta = typeof CONTA_VUOTA

type Banco = {
  s: Stato
  ora: number
  presenzeIl: number
  telefoni: TelefonoFinto[]
  agenti: Agente[]
  mondo: Mondo
  arb: Arbitro | null
  fase: Fase
  faseDa: number
  host: number | null
  iscritti: Set<number>
  segnali: Map<number, number>
  tokenDati: number
  conta: Conta
  durata: number // dell'ultima partita finita
  leggero: boolean // bilanciamento: niente messaggi, i telefoni leggono la vista quando serve. Lo stato resta sorvegliato
}

function nuovoBanco(seme: number, ipotesi: Ipotesi = IPOTESI, leggero = false): Banco {
  const s = nuovaStanza('ABCDE', seme)
  const mondo = nuovoMondo(seme ^ 0x51ed, ipotesi)
  return {
    s,
    ora: 0,
    presenzeIl: PRESENZE_MS,
    telefoni: [],
    agenti: mondo.agenti,
    mondo,
    arb: null,
    fase: s.fase,
    faseDa: 0,
    host: null,
    iscritti: new Set(),
    segnali: new Map(),
    tokenDati: 0,
    conta: { ...CONTA_VUOTA },
    durata: 0,
    leggero,
  }
}

function nuovoTelefono(b: Banco, token?: string): TelefonoFinto {
  const t: TelefonoFinto = {
    token: token ?? PREFISSO_TOKEN + ++b.tokenDati,
    id: null,
    connesso: false,
    ricevuta: null,
    ultimoTesto: '',
    barra: 0,
    motivo: null,
    adesso: () => b.ora,
    vista: () => (b.leggero && t.connesso && t.id !== null ? vista(b.s, t.id, b.ora) : t.ricevuta),
    rifiuto: () => t.motivo,
    collega(nome) {
      t.ricevuta = null
      t.ultimoTesto = ''
      t.motivo = null
      t.barra = 0
      const nuovoPosto = !b.telefoni.includes(t)
      const presenti = b.s.giocatori.length
      const esito = entra(b.s, t.token, nome, b.ora)
      if (!esito.ok) {
        t.motivo = esito.motivo
        t.connesso = false
        return
      }
      if (nuovoPosto && t.id === null && b.s.giocatori.length === presenti && !token) b.conta.ripresePosto++
      // Un secondo socket dello stesso giocatore chiude il precedente.
      for (const altro of b.telefoni) {
        if (altro === t || altro.id !== esito.id) continue
        altro.connesso = false
        altro.id = null
      }
      t.id = esito.id
      t.connesso = true
      if (nuovoPosto) b.telefoni.push(t)
      b.iscritti.add(esito.id)
      b.segnali.set(esito.id, b.ora)
      sorveglia(b)
      trasmetti(b)
    },
    scollega() {
      t.connesso = false
    },
    invia(azione, falsa) {
      manda(b, t, azione, falsa)
    },
  }
  return t
}

// Un'azione arriva al server. Rifiutata non deve lasciare tracce, falsa deve essere rifiutata.
function manda(b: Banco, t: TelefonoFinto, azione: unknown, falsa = false): boolean {
  if (!t.connesso || t.id === null) return false
  const prima = b.leggero ? '' : JSON.stringify(b.s)
  const ok = applica(b.s, t.id, azione as Azione, b.ora)
  if (!ok && !b.leggero && JSON.stringify(b.s) !== prima) errore('S9', `azione rifiutata con effetti: ${JSON.stringify(azione)}`)
  if (falsa) {
    b.conta.azioniFalse++
    if (ok) errore('S9', `azione falsa accettata: ${JSON.stringify(azione)?.slice(0, 80)}`)
  }
  if (!ok) return false
  b.segnali.set(t.id, b.ora)
  azioneAccettata(b, t.id, azione as Azione)
  sorveglia(b)
  trasmetti(b)
  return true
}

// C5 e il registro dell'arbitro: ogni azione accettata passa di qui.
function azioneAccettata(b: Banco, id: number, az: Azione) {
  const a = b.arb
  switch (az.a) {
    case 'spunta':
      if (!a) errore('C3', 'spunta senza partita')
      if (b.ora < (a.taskPronta.get(id) ?? 0)) errore('C5', `spunta in anticipo di ${id}`)
      if (!b.s.giocatori.find(g => g.id === id)?.vivo) errore('C5', `spunta da chi è fuori: ${id}`)
      a.taskPronta.set(id, b.ora + ATTESO.task)
      a.spunte++
      vero(b.s.giocatori.some(g => g.id === id && g.task !== g.taskFatta), 'C5: nuova task uguale alla precedente')
      break
    case 'uccidi':
      if (!a) errore('C5', 'Uccidi senza partita')
      if (!a.assassini.has(id)) errore('C5', `Uccidi accettato da un civile: ${id}`)
      if (b.ora < (a.uccidiPronto.get(id) ?? Infinity)) errore('C5', `Uccidi in anticipo di ${id}`)
      a.uccidiPronto.set(id, b.ora + ATTESO.uccidi)
      break
    case 'emergency':
      if (!a) errore('C5', 'Emergency senza partita')
      if (b.ora < a.emergencyPronta) errore('C5', 'Emergency in anticipo')
      a.emergencyPronta = b.ora + ATTESO.emergency
      break
    case 'vota':
      if (!a) errore('C4', 'voto senza partita')
      if (a.schede.has(id)) errore('C4', `secondo voto di ${id}`)
      a.schede.set(id, az.x)
      break
    case 'sonoMorto':
      if (!a) errore('C4', 'Sono morto senza partita')
      if (b.fase === 'riunione') b.conta.mortiInVoto++
      contaRivoti(b, a, id)
      fuoriDaiVoti(a, id)
      break
    case 'esci':
      togliDallaLista(b, id)
      break
    case 'togli':
      if (b.ora - (b.segnali.get(az.x) ?? 0) < ATTESO.offline) errore('C8', `Togli su un giocatore online: ${az.x}`)
      b.conta.tolti++
      togliDallaLista(b, az.x)
      break
  }
}

function contaRivoti(b: Banco, a: Arbitro, id: number) {
  for (const voto of a.schede.values()) if (voto === id) b.conta.rivoti++
}

function togliDallaLista(b: Banco, id: number) {
  b.iscritti.delete(id)
  if (b.host === id) b.conta.hostUsciti++
  const a = b.arb
  if (!a) return
  if (b.fase === 'riunione') {
    b.conta.usciteInRiunione++
    if ([...a.schede.values()].includes(id)) b.conta.usciteConVoti++
  }
  contaRivoti(b, a, id)
  fuoriDaiVoti(a, id)
}

// Il server trasmette a ogni telefono la sua vista, solo se è cambiata.
function trasmetti(b: Banco) {
  if (b.leggero) return
  const viste: Vista[] = []
  for (const t of b.telefoni) {
    if (!t.connesso || t.id === null) continue
    const v = vista(b.s, t.id, b.ora)
    viste.push(v)
    const testo = JSON.stringify({ ...v, ora: 0 })
    if (testo === t.ultimoTesto) continue
    t.ultimoTesto = testo
    t.ricevuta = v
    controllaSegreti(b, t, v, testo)
    controllaBarra(b, t, v)
  }
  controllaStessaVista(viste)
}

// ---- C1: nessun segreto in nessun messaggio ----
const COMUNI = ['schermata', 'ora', 'f', 'codice', 'barra', 'traguardo', 'presenti', 'io']
const CONVOCATA = ['tipo', 'daId', 'daNome']
const CAMPI: Record<Schermata, string[]> = {
  sala: [...COMUNI, 'giocatori', 'numeroTask', 'numeroAssassini', 'maxAssassini', 'traguardoPrevisto', 'minGiocatori'],
  ruolo: [...COMUNI, 'ruolo', 'assassini', 'complici', 'riunioneAperta'],
  partita: [...COMUNI, 'task', 'taskFatta', 'taskDa', 'emergencyDa', 'emergencyDaId', 'emergencyDaNome'],
  riunione: [...COMUNI, ...CONVOCATA, 'giocatori', 'fuori', 'votati', 'totale', 'mioVoto', 'rivota'],
  esito: [...COMUNI, ...CONVOCATA, 'scadenza', 'votanti', 'fuori', 'eliminatoId', 'eliminatoNome', 'eliminatoRuolo', 'parita', 'salti', 'vincitore'],
  fine: [...COMUNI, 'scadenza', 'vincitore', 'motivo', 'giocatori'],
}
const VOLTO = ['id', 'nome', 'iniziale', 'colore', 'lettera']
const RIGHE: Partial<Record<Schermata, string[]>> = {
  sala: [...VOLTO, 'host', 'offline'],
  riunione: [...VOLTO, 'host', 'offline', 'haVotato'],
  fine: [...VOLTO, 'ruolo', 'vivo'],
}
const CAMPI_IO = [...VOLTO, 'host', 'vivo', 'causa']

function soloCampi(oggetto: object, permessi: string[], dove: string) {
  for (const k of Object.keys(oggetto)) if (!permessi.includes(k)) errore('C1', `campo non previsto «${k}» in ${dove}`)
}

function controllaSegreti(b: Banco, t: TelefonoFinto, v: Vista, testo: string) {
  const dove = `vista ${v.schermata} di ${t.id}`
  if (testo.includes(PREFISSO_TOKEN)) errore('C1', `token in ${dove}`)

  const { uccidiDa, ...resto } = v as VistaPartita
  soloCampi(resto, CAMPI[v.schermata], dove)
  for (const k of CAMPI[v.schermata]) if (!(k in v)) errore('C2', `manca «${k}» in ${dove}`)
  soloCampi(v.io, CAMPI_IO, dove)

  const elenco = (v as VistaSala).giocatori as object[] | undefined
  if (elenco) for (const riga of elenco) soloCampi(riga, RIGHE[v.schermata] as string[], dove)

  const a = b.arb
  const g = b.s.giocatori.find(x => x.id === t.id)
  const assassino = !!g && g.ruolo === 'assassino'

  if (v.schermata === 'sala' || v.schermata === 'partita' || v.schermata === 'riunione') {
    if (testo.includes('"assassino"') || testo.includes('"civile"')) errore('C1', `ruolo in ${dove}`)
  }
  if (v.schermata === 'partita') {
    const mostra = !!g && g.vivo && assassino
    if ((uccidiDa !== undefined) !== mostra) errore('C1', `uccidiDa fuori posto in ${dove}`)
    if (mostra && a && uccidiDa !== a.uccidiPronto.get(g.id)) errore('C5', `uccidiDa diverso dal registro in ${dove}`)
  }
  if (v.schermata === 'ruolo') {
    if (!g || v.ruolo !== g.ruolo) errore('C1', `ruolo altrui in ${dove}`)
    if (!assassino && v.complici.length) errore('C1', `complici a un civile in ${dove}`)
  }
  if (v.schermata === 'riunione' && g && a && v.mioVoto !== (a.schede.get(g.id) ?? null)) errore('C1', `mioVoto sbagliato in ${dove}`)
  if (v.schermata === 'esito') {
    for (const riga of v.votanti) soloCampi(riga, [...VOLTO, 'voti'], dove)
    const atteso = v.eliminatoId === null ? null : a?.assassini.has(v.eliminatoId) ? 'assassino' : 'civile'
    if (v.eliminatoRuolo !== atteso) errore('C1', `ruolo dell'eliminato sbagliato in ${dove}`)
  }
  if (v.schermata === 'fine') {
    for (const riga of v.giocatori) if ((riga.ruolo === 'assassino') !== !!a?.assassini.has(riga.id)) errore('C4', `ruolo finale sbagliato in ${dove}`)
  }
}

// ---- C2: tolti i campi privati dichiarati, tutti ricevono la stessa cosa ----
const PRIVATI = ['ora', 'io', 'task', 'taskFatta', 'taskDa', 'uccidiDa', 'mioVoto', 'rivota']

function parteComune(v: Vista): string {
  const copia: Record<string, unknown> = { ...v }
  for (const k of PRIVATI) delete copia[k]
  return JSON.stringify(copia)
}

function controllaStessaVista(viste: Vista[]) {
  const prima = new Map<Schermata, string>()
  for (const v of viste) {
    if (v.schermata === 'ruolo') continue
    const comune = parteComune(v)
    const nota = prima.get(v.schermata)
    if (nota === undefined) prima.set(v.schermata, comune)
    else if (nota !== comune) errore('C2', `viste diverse in ${v.schermata}`)
  }
}

// ---- C3: la barra ----
function controllaBarra(b: Banco, t: TelefonoFinto, v: Vista) {
  if (v.schermata === 'sala') {
    if (v.barra !== 0 || v.traguardo !== 0) errore('C9', 'barra o traguardo non azzerati in sala')
    t.barra = 0
    return
  }
  const a = b.arb
  if (!a) errore('C3', `vista ${v.schermata} senza partita`)
  if (v.traguardo !== a.traguardo) errore('C3', `traguardo ${v.traguardo}, atteso ${a.traguardo}`)
  if (v.barra > v.traguardo) errore('C3', `barra ${v.barra} oltre il traguardo ${v.traguardo}`)
  if (v.barra < t.barra) errore('C3', `barra in calo: da ${t.barra} a ${v.barra}`)
  t.barra = v.barra
}

// ---- Sorveglianza dello stato dopo ogni cambiamento ----
function sorveglia(b: Banco) {
  const { s } = b

  // C8: la lista perde qualcuno solo con Esci o Togli, registrati in azioneAccettata.
  if (s.giocatori.length !== b.iscritti.size || s.giocatori.some(g => !b.iscritti.has(g.id))) errore('C8', 'lista giocatori diversa da quella attesa')
  if (s.hostId !== null && !b.iscritti.has(s.hostId)) errore('C8', 'host non presente nella stanza')
  if (s.hostId !== b.host) {
    if (b.host !== null && b.iscritti.has(b.host)) {
      b.conta.passaggiHost++
      if (b.ora - (b.segnali.get(s.hostId as number) ?? 0) >= ATTESO.offline) errore('C8', `host passato a un giocatore offline: ${s.hostId}`)
    }
    b.host = s.hostId
  }

  if (s.fase !== b.fase) {
    cambiaFase(b, b.fase, s.fase)
    b.fase = s.fase
    b.faseDa = b.ora
  }

  const a = b.arb
  if (!a) return
  if (s.traguardo !== a.traguardo) errore('C3', `traguardo cambiato: ${s.traguardo}, atteso ${a.traguardo}`)
  if (s.barra !== a.spunte) errore('C3', `barra ${s.barra} con ${a.spunte} spunte`)
  const vivi = s.giocatori.filter(g => g.vivo)
  if (vivi.length !== a.vivi.size || vivi.some(g => !a.vivi.has(g.id))) errore('C4', 'vivi diversi dal registro')
  if (s.emergencyDa !== a.emergencyPronta) errore('C5', `Emergency pronta a ${s.emergencyDa}, attesa ${a.emergencyPronta}`)
  for (const g of s.giocatori) {
    if (g.visto !== b.segnali.get(g.id)) errore('C8', `ultimo segnale di ${g.id} a ${g.visto}, atteso ${b.segnali.get(g.id)}`)
    if (g.taskDa !== (a.taskPronta.get(g.id) ?? 0)) errore('C5', `task di ${g.id} pronta a ${g.taskDa}, attesa ${a.taskPronta.get(g.id)}`)
    if (a.assassini.has(g.id) && g.uccidiDa !== a.uccidiPronto.get(g.id)) errore('C5', `Uccidi di ${g.id} pronto a ${g.uccidiDa}, atteso ${a.uccidiPronto.get(g.id)}`)
  }
  if (s.fase === 'partita') {
    const vincitore = arbitroVincitore([...a.vivi], a.assassini)
    if (vincitore) errore('C4', `la partita doveva finire: vincono ${vincitore}`)
  }
}

function cambiaFase(b: Banco, da: Fase, a: Fase) {
  const { s, ora } = b

  if (da === 'sala') {
    if (a !== 'partita') errore('C4', `dalla sala si è passati a ${a}`)
    b.arb = nuovoArbitro(b)
    b.conta.partite++
    return
  }

  const arb = b.arb
  if (!arb) errore('C4', 'partita senza registro')

  if (da === 'riunione') {
    if (a !== 'esito') errore('C4', `una riunione è finita in ${a}`)
    chiusuraRiunione(b, arb)
  }
  if (da === 'esito' && ora - b.faseDa !== ATTESO.esito) errore('C5', `esito durato ${ora - b.faseDa} ms`)
  if (a === 'riunione') {
    b.conta.riunioni++
    arb.schede.clear()
  }
  if (da === 'esito' && a === 'partita') {
    const vincitore = arbitroVincitore([...arb.vivi], arb.assassini)
    if (vincitore) errore('C4', `dopo l'esito doveva vincere: ${vincitore}`)
    for (const id of arb.assassini) arb.uccidiPronto.set(id, ora + ATTESO.uccidi)
  }
  if (a === 'fine') arrivoAllaFine(b, arb)
  if (da === 'fine') ritornoInSala(b)
}

function nuovoArbitro(b: Banco): Arbitro {
  const { s, ora } = b
  const assassini = new Set(s.giocatori.filter(g => g.ruolo === 'assassino').map(g => g.id))
  const n = s.giocatori.length
  if (assassini.size < 1 || assassini.size > Math.max(1, Math.floor((n - 1) / 2))) errore('C4', `${assassini.size} assassini con ${n} giocatori`)
  if (s.giocatori.some(g => g.ruolo === null)) errore('C4', 'giocatore senza ruolo allo Start')
  if (s.assassiniPartita !== assassini.size) errore('C4', `${s.assassiniPartita} assassini dichiarati, ${assassini.size} con il ruolo`)
  const uccidiPronto = new Map([...assassini].map(id => [id, ora + ATTESO.uccidi]))
  return {
    inizio: ora,
    assassini,
    vivi: new Set(s.giocatori.map(g => g.id)),
    schede: new Map(),
    spunte: 0,
    traguardo: Math.ceil(((n - assassini.size) * s.numeroTask) / 2),
    taskPronta: new Map(),
    uccidiPronto,
    emergencyPronta: 0,
  }
}

function chiusuraRiunione(b: Banco, arb: Arbitro) {
  const { s, ora } = b
  const r = s.riunione
  if (!r?.esito) errore('C4', 'riunione chiusa senza esito')

  // Decisione approvata: si chiude da sola solo se chi manca è muto da 45 s, e chi manca vale Salta.
  const vivi = [...arb.vivi]
  const mancanti = vivi.filter(id => !arb.schede.has(id))
  for (const id of mancanti) {
    const silenzio = ora - (b.segnali.get(id) ?? 0)
    if (silenzio < ATTESO.assente) errore('C6', `voto chiuso con ${id} muto da soli ${silenzio} ms`)
  }
  if (mancanti.length) b.conta.chiusurePerAssenti++

  const schede = vivi.map(id => arb.schede.get(id) ?? 'salta')
  const eliminato = arbitroEliminato(schede)
  if (r.esito.eliminatoId !== eliminato) errore('C4', `eliminato ${r.esito.eliminatoId}, per l'arbitro ${eliminato}`)
  const salti = schede.filter(x => x === 'salta').length
  if (r.esito.salti !== salti) errore('C4', `salti ${r.esito.salti}, per l'arbitro ${salti}`)
  for (const riga of r.votanti) {
    const voti = schede.filter(x => x === riga.id).length
    if (riga.voti !== voti) errore('C4', `${riga.nome} ha ${riga.voti} voti, per l'arbitro ${voti}`)
  }
  if (r.votanti.length !== vivi.length) errore('C4', 'votanti diversi dai vivi')
  const morti = s.giocatori.filter(g => !arb.vivi.has(g.id)).map(g => g.nome)
  if (r.fuori.join() !== morti.join()) errore('C4', `fuori: ${r.fuori}, per l'arbitro: ${morti}`)
  if (s.scadenza !== ora + ATTESO.esito) errore('C5', `esito con scadenza ${s.scadenza}, attesa ${ora + ATTESO.esito}`)

  if (eliminato !== null) {
    arb.vivi.delete(eliminato)
    b.conta.eliminazioni++
    if (!arb.assassini.has(eliminato)) b.conta.civiliEliminati++
  } else if (r.esito.parita) {
    b.conta.parita++
  } else {
    b.conta.saltaInTesta++
  }
}

function arrivoAllaFine(b: Banco, arb: Arbitro) {
  const { s, ora } = b
  if (s.motivo === 'barra') {
    if (arb.spunte !== arb.traguardo || s.vincitore !== 'civili') errore('C4', `barra piena con ${arb.spunte} spunte su ${arb.traguardo}`)
    b.conta.vinteBarra++
  } else {
    const vincitore = arbitroVincitore([...arb.vivi], arb.assassini)
    if (vincitore === null || vincitore !== s.vincitore) errore('C4', `ha vinto ${s.vincitore}, per l'arbitro ${vincitore}`)
    if (s.motivo !== (vincitore === 'civili' ? 'assassini' : 'maggioranza')) errore('C4', `motivo ${s.motivo} con vincitore ${vincitore}`)
    if (vincitore === 'civili') b.conta.vinteScoperti++
    else b.conta.vinteMaggioranza++
  }
  if (s.scadenza !== ora + ATTESO.fine) errore('C5', `fine con scadenza ${s.scadenza}, attesa ${ora + ATTESO.fine}`)
  b.durata = ora - arb.inizio
}

// C9: tutto azzerato, chi è connesso è ancora qui.
function ritornoInSala(b: Banco) {
  const { s, ora } = b
  if (ora - b.faseDa !== ATTESO.fine) errore('C5', `fine durata ${ora - b.faseDa} ms`)
  if (s.barra !== 0 || s.traguardo !== 0 || s.assassiniPartita !== 0 || s.riunione || s.scadenza !== null || s.vincitore || s.motivo) errore('C9', 'stanza non azzerata')
  for (const g of s.giocatori) {
    if (g.ruolo !== null || !g.vivo || g.causa !== null || g.ruoloVisto || g.task !== null || g.taskFatta !== null || g.uccidiDa !== null) {
      errore('C9', `giocatore non azzerato: ${g.nome}`)
    }
  }
  for (const t of b.telefoni) {
    if (t.connesso && t.id !== null && b.iscritti.has(t.id) && !s.giocatori.some(g => g.id === t.id)) errore('C9', `giocatore connesso sparito: ${t.id}`)
  }
  b.arb = null
}

// ---- C6: nessun blocco ----
function controllaTempi(b: Banco) {
  if (b.ora - b.faseDa > LIMITE[b.fase]) errore('C6', `fase ${b.fase} ferma da ${Math.round((b.ora - b.faseDa) / 1000)} s`)
  const a = b.arb
  if (b.s.fase !== 'riunione' || !a) return
  const mancanti = [...a.vivi].filter(id => !a.schede.has(id))
  if (mancanti.every(id => b.ora - (b.segnali.get(id) ?? 0) >= ATTESO.assente)) errore('C6', 'riunione ancora aperta con soli assenti')
}

// ---- L'orologio virtuale ----
// Come il server vero: scadi all'allarme di prossimaScadenza e nel giro delle presenze, mai altrove.
function avanza(b: Banco, fino: number, ferma: () => boolean = () => false) {
  while (!ferma()) {
    const scadenza = prossimaScadenza(b.s)
    let t = Math.min(fino, b.presenzeIl)
    if (scadenza !== null && scadenza > b.ora) t = Math.min(t, scadenza)
    for (const ag of b.agenti) t = Math.min(t, ag.sveglia)
    b.ora = Math.max(b.ora, t)
    if (!Number.isInteger(b.ora)) errore('C5', `orologio non intero: ${b.ora}`)

    let controlla = scadenza !== null && scadenza <= b.ora
    if (b.ora >= b.presenzeIl) {
      b.presenzeIl += PRESENZE_MS
      controlla = true
      for (const tel of b.telefoni) {
        if (!tel.connesso || tel.id === null) continue
        segnale(b.s, tel.id, b.ora)
        b.segnali.set(tel.id, b.ora)
      }
    }
    if (controlla) {
      const cambiato = scadi(b.s, b.ora)
      if (cambiato) sorveglia(b)
      // In partita la presenza non è nella vista: senza cambiamenti non c'è nulla da spedire.
      if (cambiato || b.s.fase === 'sala' || b.s.fase === 'riunione') trasmetti(b)
    }

    giro(b.mondo, b.ora)
    for (const ag of b.agenti) if (ag.sveglia <= b.ora) passo(ag, b.mondo)
    controllaTempi(b)
    if (b.ora >= fino) break
  }
}

function aggiungiAgente(b: Banco, tratti: Tratti, sveglia: number, seme: number) {
  const telefono = nuovoTelefono(b)
  const ag: Agente = {
    tratti,
    memoria: nuovaMemoria(seme, tratti),
    telefono,
    sveglia: Math.round(sveglia),
    altroTelefono: stessoToken => nuovoTelefono(b, stessoToken ? (ag.telefono as TelefonoFinto).token : undefined),
  }
  b.agenti.push(ag)
}

// Il piano si decide a voce: lo sentono tutti, lo applica chi è host in quel momento.
function annuncia(b: Banco, piano: Piano) {
  for (const ag of b.agenti) ag.memoria.piano = piano
}

// ---- S1: una serata intera ----
const PARTITE_SERATA: { numeroTask: number; assassini: number }[] = [
  { numeroTask: 12, assassini: 1 },
  { numeroTask: 16, assassini: 1 },
  { numeroTask: 8, assassini: 1 },
  { numeroTask: 24, assassini: 2 },
  { numeroTask: 16, assassini: 2 },
  { numeroTask: 13, assassini: 2 }, // dispari, con 13 civili: l'arrotondamento per eccesso si vede solo così
]

function giocaSerata(seme: number): Banco {
  const caso = generatore(seme)
  const b = nuovoBanco(seme)
  // Di solito crea la stanza Marta. Una sera su quattro Rita, che scappa da host, e una Beppe, che blocca il telefono da host.
  const primo = ['Rita', 'Beppe', 'Marta', 'Marta'][seme % 4]
  PERSONALITA.forEach((t, i) => {
    const ritardo = t.nome === primo ? 0 : t.ritardataria ? 60_000 + caso() * 30_000 : 5_000 + caso() * 35_000
    aggiungiAgente(b, t, ritardo, Math.imul(seme, 31) + i)
  })
  for (const p of PARTITE_SERATA) {
    annuncia(b, { giocatori: PERSONALITA.length, ...p })
    avanza(b, Infinity, () => b.s.fase !== 'sala')
    avanza(b, Infinity, () => b.s.fase === 'sala')
  }
  vero(b.conta.partite === PARTITE_SERATA.length, `partite giocate: ${b.conta.partite}`)
  return b
}

// ---- Una sola partita, per il bilanciamento ----
type Impostazione = { giocatori: number; assassini: number; numeroTask: number }
type Variante = { ipotesi?: Ipotesi; tratti?: (t: Tratti) => Tratti }

function giocaPartita(c: Impostazione, seme: number, variante: Variante = {}): Banco {
  const caso = generatore(seme ^ 0x2f6e)
  const b = nuovoBanco(seme, variante.ipotesi ?? NORMALE, true)
  const mazzo = [...PERSONALITA]
  for (let i = mazzo.length - 1; i > 0; i--) {
    const j = Math.floor(caso() * (i + 1))
    ;[mazzo[i], mazzo[j]] = [mazzo[j], mazzo[i]]
  }
  mazzo.slice(0, c.giocatori).forEach((t, i) => {
    const tratti = senzaManie(t)
    aggiungiAgente(b, variante.tratti ? variante.tratti(tratti) : tratti, i * 1000, Math.imul(seme, 37) + i)
  })
  annuncia(b, c)
  avanza(b, Infinity, () => b.s.fase === 'fine')
  return b
}

// ---- Aiuti per gli scenari scritti a mano ----
type Mossa = { a: Azione['a']; x?: unknown }

const premi = (b: Banco, t: TelefonoFinto, mossa: Mossa) => manda(b, t, { ...mossa, f: b.s.f })
const nega = (b: Banco, t: TelefonoFinto, mossa: Mossa) => manda(b, t, { ...mossa, f: b.s.f }, true)
const aspetta = (b: Banco, ms: number) => avanza(b, b.ora + ms)

function devePremere(b: Banco, t: TelefonoFinto, mossa: Mossa) {
  vero(premi(b, t, mossa), `azione rifiutata: ${JSON.stringify(mossa)}`)
}

const vedi = (b: Banco, t: TelefonoFinto) => vista(b.s, t.id as number, b.ora)
const inRiunione = (b: Banco, t: TelefonoFinto) => vedi(b, t) as VistaRiunione
const inEsito = (b: Banco, t: TelefonoFinto) => vedi(b, t) as VistaEsito
const inPartita = (b: Banco, t: TelefonoFinto) => vedi(b, t) as VistaPartita
const inSala = (b: Banco, t: TelefonoFinto) => vedi(b, t) as VistaSala
const giocatore = (b: Banco, t: TelefonoFinto) => b.s.giocatori.find(g => g.id === t.id) as Giocatore
const coloreDi = (b: Banco, t: TelefonoFinto) => vedi(b, t).io.colore

function iscrivi(b: Banco, quanti: number): TelefonoFinto[] {
  return PERSONALITA.slice(0, quanti).map(p => {
    const t = nuovoTelefono(b)
    t.collega(p.nome)
    vero(t.id !== null, `${p.nome} non è entrato`)
    return t
  })
}

function parti(b: Banco, tel: TelefonoFinto[], scelta: { task?: number; assassini?: number } = {}) {
  const host = tel.find(t => t.id === b.s.hostId) as TelefonoFinto
  if (scelta.task) devePremere(b, host, { a: 'impostaTask', x: scelta.task })
  if (scelta.assassini) devePremere(b, host, { a: 'impostaAssassini', x: scelta.assassini })
  devePremere(b, host, { a: 'start' })
  for (const t of tel) devePremere(b, t, { a: 'ruoloVisto' })
  return {
    ass: tel.filter(t => giocatore(b, t).ruolo === 'assassino'),
    civ: tel.filter(t => giocatore(b, t).ruolo === 'civile'),
  }
}

// Ultimo segnale di un telefono: da qui si contano 30 e 45 s.
const silenzioDa = (b: Banco, t: TelefonoFinto) => b.segnali.get(t.id as number) as number

// ---- Gli scenari ----
function s2() {
  // In riunione: dopo 30 s l'host vede Togli, conferma, la riunione si chiude.
  let b = nuovoBanco(2001)
  let tel = iscrivi(b, 6)
  parti(b, tel)
  const [marta, , , , , tommaso] = tel
  devePremere(b, marta, { a: 'emergency' })
  for (const t of tel.slice(0, 5)) devePremere(b, t, { a: 'vota', x: 'salta' })
  tommaso.scollega()
  const zero = silenzioDa(b, tommaso)

  avanza(b, zero + ATTESO.offline - 1)
  const riga = () => inRiunione(b, marta).giocatori.find(g => g.id === tommaso.id)
  vero(riga()?.offline === false, 'offline prima dei 30 s')
  vero(nega(b, marta, { a: 'togli', x: tommaso.id }) === false, 'Togli prima dei 30 s')

  avanza(b, zero + ATTESO.offline)
  vero(riga()?.offline === true, 'non offline dopo 30 s')
  vero(!nega(b, tel[1], { a: 'togli', x: tommaso.id }), 'Togli da chi non è host')
  devePremere(b, marta, { a: 'togli', x: tommaso.id })
  vero(b.s.fase === 'esito', 'dopo Togli la riunione doveva chiudersi')
  vero(!b.s.giocatori.some(g => g.id === tommaso.id), 'Tommaso è ancora in lista')

  // In partita Togli non esiste: solo in sala e in riunione.
  const p = nuovoBanco(2003)
  const sei = iscrivi(p, 6)
  parti(p, sei)
  sei[5].scollega()
  aspetta(p, ATTESO.offline + PRESENZE_MS)
  vero(!nega(p, sei[0], { a: 'togli', x: sei[5].id }), 'Togli in partita')

  // In sala, prima dello Start: chi è sparito non riceve un ruolo.
  b = nuovoBanco(2002)
  tel = iscrivi(b, 4)
  const zaino = tel[3]
  zaino.scollega()
  const inizio = silenzioDa(b, zaino)
  avanza(b, inizio + ATTESO.offline - 1)
  vero(nega(b, tel[0], { a: 'togli', x: zaino.id }) === false, 'Togli in sala prima dei 30 s')
  avanza(b, inizio + ATTESO.offline)
  vero(inSala(b, tel[0]).giocatori.find(g => g.id === zaino.id)?.offline === true, 'in sala non risulta offline')
  devePremere(b, tel[0], { a: 'togli', x: zaino.id })
  parti(b, tel.slice(0, 3))
  vero(b.s.giocatori.length === 3, 'ruolo dato a chi era sparito')
}

function s3() {
  const b = nuovoBanco(3001)
  const tel = iscrivi(b, 4)
  const [marta, ugo, beppe] = tel

  marta.scollega()
  ugo.scollega()
  aspetta(b, ATTESO.offline)
  vero(b.s.hostId === beppe.id, 'il ruolo deve passare al primo connesso, saltando chi è offline')
  vero(inSala(b, beppe).io.host, 'il nuovo host non si vede tale')

  marta.collega('Marta')
  aspetta(b, ATTESO.offline + PRESENZE_MS)
  vero(b.s.hostId === beppe.id, 'il vecchio host si è ripreso il ruolo')
  vero(nega(b, marta, { a: 'start' }) === false, 'Start dal vecchio host')
  ugo.collega('Ugo')
  parti(b, tel)
  vero(b.s.fase === 'partita', 'Start impossibile col nuovo host')

  // Anche a partita in corso.
  beppe.scollega()
  aspetta(b, ATTESO.offline + PRESENZE_MS)
  vero(b.s.hostId !== beppe.id, 'host offline durante la partita')
}

function s4() {
  const b = nuovoBanco(4001)
  const tel = iscrivi(b, 5)
  const { ass, civ } = parti(b, tel)
  const [rita, a, c, d, e] = [civ[0], civ[1], civ[2], civ[3], ass[0]]
  const nomeRita = giocatore(b, rita).nome
  const colori = [a, c, d, e].map(t => coloreDi(b, t))
  devePremere(b, rita, { a: 'emergency' })
  for (const t of [a, c, d]) devePremere(b, t, { a: 'vota', x: rita.id })
  devePremere(b, rita, { a: 'vota', x: a.id })
  vero(inRiunione(b, a).votati === 4, 'voti prima dell\'uscita')

  devePremere(b, rita, { a: 'esci' })
  vero(b.s.fase === 'riunione', 'la riunione si è chiusa prima del tempo')
  for (const t of [a, c, d]) {
    const v = inRiunione(b, t)
    vero(v.rivota && v.mioVoto === null, 'chi aveva votato Rita deve rivotare')
  }
  // Sparisce solo il voto di Rita: chi deve rivotare resta contato, altrimenti tutti vedrebbero chi aveva votato lei.
  vero(inRiunione(b, a).votati === 3 && inRiunione(b, a).totale === 4, 'il voto di Rita doveva sparire, gli annullati restare contati')
  vero(inRiunione(b, e).giocatori.every(g => g.haVotato === (g.id !== e.id)), 'chi deve rivotare si distingue dagli altri')
  vero(inRiunione(b, a).daNome === nomeRita, 'Convocata da: il nome di chi è uscito va tenuto')
  vero([a, c, d, e].every((t, i) => coloreDi(b, t) === colori[i]), 'il colore è cambiato quando qualcuno è uscito')

  devePremere(b, e, { a: 'vota', x: 'salta' })
  vero(tel.length - 1 === b.s.giocatori.length, 'Rita è ancora in lista')
  devePremere(b, a, { a: 'vota', x: 'salta' })
  vero(!inRiunione(b, a).rivota, 'chi ha rivotato non deve rivotare ancora')
  devePremere(b, c, { a: 'vota', x: 'salta' })
  vero(b.s.fase === 'riunione', 'chiusa con un voto mancante')
  devePremere(b, d, { a: 'vota', x: 'salta' })
  vero(b.s.fase === 'esito' && inEsito(b, a).salti === 4, 'conteggio dopo l\'uscita')

  // Se esce l'host il ruolo passa al successivo, non al primo della lista.
  const r = nuovoBanco(4002)
  const altri = iscrivi(r, 4)
  altri[0].scollega()
  altri[1].scollega()
  aspetta(r, ATTESO.offline)
  vero(r.s.hostId === altri[2].id, 'host atteso prima dell\'uscita')
  altri[0].collega('Marta')
  altri[1].collega('Ugo')
  devePremere(r, altri[2], { a: 'esci' })
  vero(r.s.hostId === altri[3].id, 'host non passato al successivo')
}

function s5() {
  const b = nuovoBanco(5001)
  const tel = iscrivi(b, 4)
  const { ass, civ } = parti(b, tel)
  const [assassino, c1, c2, piero] = [ass[0], civ[0], civ[1], civ[2]]
  devePremere(b, c2, { a: 'sonoMorto' })
  vero(b.s.fase === 'partita', 'con 1 assassino e 2 civili si continua')

  devePremere(b, c1, { a: 'report' })
  devePremere(b, c1, { a: 'vota', x: piero.id })
  devePremere(b, assassino, { a: 'vota', x: piero.id })
  devePremere(b, piero, { a: 'sonoMorto' })

  vero(b.s.fase === 'riunione', 'la vittoria deve aspettare la fine della riunione')
  const v = inRiunione(b, c1)
  vero(v.totale === 2 && v.votati === 2, 'conteggi dopo Sono morto')
  vero(v.rivota && v.fuori.includes(giocatore(b, piero).nome), 'Piero tra i morti e voti da rifare')
  vero(giocatore(b, piero).causa === 'trovato', 'causa di Piero: in riunione il morto è già noto a tutti')

  devePremere(b, c1, { a: 'vota', x: assassino.id })
  devePremere(b, assassino, { a: 'vota', x: c1.id })
  vero(b.s.fase === 'esito' && inEsito(b, c1).vincitore === 'assassini', 'esito con vittoria annunciata')
  aspetta(b, ATTESO.esito)
  vero(b.s.fase === 'fine' && b.s.motivo === 'maggioranza', 'vittoria a fine riunione')
}

function s6() {
  const b = nuovoBanco(6001)
  const tel = iscrivi(b, 4)
  const host = tel.find(t => t.id === b.s.hostId) as TelefonoFinto
  const lara = tel[3]
  const ricarica = () => {
    lara.scollega()
    lara.collega('Lara')
  }
  devePremere(b, host, { a: 'start' })

  // Su Rivelazione: il ruolo resta lo stesso e riappare.
  const ruolo = (vedi(b, lara) as VistaRuolo).ruolo
  ricarica()
  vero(lara.vista()?.schermata === 'ruolo' && (lara.vista() as VistaRuolo).ruolo === ruolo, 'ricarica su Rivelazione')
  devePremere(b, lara, { a: 'ruoloVisto' })
  ricarica()
  vero(lara.vista()?.schermata === 'partita', 'ruolo rimostrato dopo Ho capito')

  // Il riquadro Uccidi non esiste nella vista: dopo una ricarica non può tornare da solo.
  vero(!JSON.stringify(lara.vista()).toLowerCase().includes('riquadro'), 'stato del riquadro nella vista')

  // Task in attesa: nessuna spunta extra.
  devePremere(b, lara, { a: 'spunta' })
  const { taskDa } = inPartita(b, lara)
  const barra = b.s.barra
  ricarica()
  vero((lara.vista() as VistaPartita).taskDa === taskDa, 'il timer della task è ripartito')
  vero(nega(b, lara, { a: 'spunta' }) === false && b.s.barra === barra, 'spunta extra dopo una ricarica')

  // Riunione aperta mentre qualcuno legge il ruolo: resta su Rivelazione, la riunione lo aspetta.
  for (const t of tel.filter(x => x !== lara && !giocatore(b, x).ruoloVisto).slice(0, 1)) {
    devePremere(b, lara, { a: 'report' })
    vero(vedi(b, t).schermata === 'ruolo', 'riunione davanti alla Rivelazione')
    vero(nega(b, t, { a: 'vota', x: 'salta' }) === false, 'voto da Rivelazione')
    devePremere(b, t, { a: 'ruoloVisto' })
    vero(vedi(b, t).schermata === 'riunione', 'dopo Ho capito si entra in riunione')
  }

  // Durante il voto: il voto resta e non se ne dà un secondo.
  devePremere(b, lara, { a: 'vota', x: 'salta' })
  ricarica()
  vero((lara.vista() as VistaRiunione).mioVoto === 'salta', 'voto perso con la ricarica')
  vero(nega(b, lara, { a: 'vota', x: 'salta' }) === false, 'secondo voto dopo una ricarica')
}

function s7() {
  // 15 Emergency insieme.
  let b = nuovoBanco(7001)
  let tel = iscrivi(b, 15)
  parti(b, tel)
  let f = b.s.f
  const accettate = tel.filter(t => manda(b, t, { a: 'emergency', f }))
  vero(accettate.length === 1 && b.s.fase === 'riunione' && b.s.f === f + 1, `${accettate.length} Emergency accettate`)
  vero(b.s.emergencyDa === b.ora + ATTESO.emergency, 'Emergency consumata male')

  // Report ed Emergency insieme, nei due ordini. Emergency si consuma solo se apre davvero.
  b = nuovoBanco(7002)
  tel = iscrivi(b, 5)
  parti(b, tel)
  f = b.s.f
  vero(manda(b, tel[0], { a: 'report', f }) && !manda(b, tel[1], { a: 'emergency', f }), 'Report poi Emergency')
  vero(b.s.emergencyDa === 0, 'Emergency consumata senza aprire la riunione')
  b = nuovoBanco(7003)
  tel = iscrivi(b, 5)
  parti(b, tel)
  f = b.s.f
  vero(manda(b, tel[0], { a: 'emergency', f }) && !manda(b, tel[1], { a: 'report', f }), 'Emergency poi Report')
  vero(b.conta.riunioni === 1, 'più di una riunione')

  // Ultimo voto e uscita insieme, nei due ordini.
  for (const uscitaPrima of [false, true]) {
    b = nuovoBanco(7004 + Number(uscitaPrima))
    tel = iscrivi(b, 6)
    const { ass, civ } = parti(b, tel)
    const [chiude, esce, ...resto] = [civ[0], civ[1], civ[2], civ[3], civ[4], ass[0]]
    devePremere(b, chiude, { a: 'emergency' })
    devePremere(b, esce, { a: 'vota', x: chiude.id })
    for (const t of resto) devePremere(b, t, { a: 'vota', x: 'salta' })
    f = b.s.f
    const azioni: [TelefonoFinto, unknown][] = [
      [chiude, { a: 'vota', x: 'salta', f }],
      [esce, { a: 'esci', f }],
    ]
    if (uscitaPrima) azioni.reverse()
    const [prima, dopo] = azioni.map(([t, az]) => manda(b, t, az))
    vero(prima, 'la prima azione deve valere')
    vero(b.s.fase === 'esito' && b.conta.riunioni === 1, 'una sola riunione, chiusa una volta')
    vero(dopo === uscitaPrima, uscitaPrima ? "dopo l'uscita il voto è ancora valido" : 'uscita col f vecchio accettata')
  }

  // Sono morto e Report insieme, nei due ordini.
  b = nuovoBanco(7006)
  tel = iscrivi(b, 6)
  let { civ } = parti(b, tel)
  f = b.s.f
  vero(manda(b, civ[0], { a: 'sonoMorto', f }) && manda(b, civ[1], { a: 'report', f: b.s.f }), 'Sono morto poi Report')
  vero(b.conta.riunioni === 1 && inRiunione(b, civ[1]).totale === 5, 'il morto è uscito dal voto')

  b = nuovoBanco(7007)
  tel = iscrivi(b, 6)
  civ = parti(b, tel).civ
  f = b.s.f
  vero(manda(b, civ[1], { a: 'report', f }) && !manda(b, civ[0], { a: 'sonoMorto', f }), 'Report poi Sono morto col f vecchio')
  devePremere(b, civ[0], { a: 'sonoMorto' })
  vero(b.conta.riunioni === 1 && inRiunione(b, civ[1]).totale === 5, 'Sono morto ripetuto in riunione')
}

function s8() {
  const b = nuovoBanco(8001)
  iscrivi(b, 1)
  nuovoTelefono(b).collega('Anna')
  const rifiuto = (nome: string, atteso: Rifiuto) => {
    const esito = entra(b.s, 'tok-altro', nome, b.ora)
    vero(!esito.ok && esito.motivo === atteso, `«${nome}» doveva dare ${atteso}`)
  }

  rifiuto('anna ', 'nome-usato')
  rifiuto('marta ', 'nome-usato')
  rifiuto('MARTA', 'nome-usato')
  rifiuto('  Marta  ', 'nome-usato')
  rifiuto('Ｍａｒｔａ', 'nome-usato') // caratteri a larghezza piena: stessa forma normalizzata
  rifiuto('', 'nome-vuoto')
  rifiuto('   ', 'nome-vuoto')

  // Nomi che non si vedono: per Unicode non sono spazi, ma a schermo resterebbe un giocatore senza nome.
  for (const vuoto of ['⠀⠀', 'ㅤ', 'ᅟᅠﾠ', '​‍', '️', '‮', '\u{E0041}', 'ㅤ ⠀\n​']) rifiuto(vuoto, 'nome-vuoto')
  rifiuto('​​Anna', 'nome-usato')
  rifiuto('An⠀naㅤ', 'nome-usato')
  rifiuto('Annа', 'nome-usato') // a cirillica
  rifiuto('Mаrtа', 'nome-usato')
  rifiuto('МАRTА', 'nome-usato') // M e A maiuscole cirilliche

  const mostrato = (nome: string) => {
    const t = nuovoTelefono(b)
    t.collega(nome)
    return vedi(b, t).io
  }
  vero(mostrato('‮gnip').nome === 'gnip', 'caratteri di direzione nel nome mostrato')
  const conZero = mostrato('​x')
  vero(conZero.nome === 'x' && conZero.iniziale === 'X', 'iniziale invisibile')
  const riempito = mostrato('ㅤ⠀y‍z​')
  vero(riempito.nome === 'yz' && riempito.iniziale === 'Y', 'riempitivi nel nome mostrato')
  // Le emoji composte restano intere: U+200D, i selettori e i tag fanno parte del disegno.
  for (const emoji of ['👩‍💻', '🧑🏻‍💻', '🏳️‍🌈', '❤️‍🔥', '🏃‍♂️', '👍🏽', '🇮🇹', '🏴󠁧󠁢󠁥󠁮󠁧󠁿']) {
    const io = mostrato(emoji)
    vero(io.nome === emoji, `emoji ${emoji} alterata: ${JSON.stringify(io.nome)}`)
  }

  const volpe = nuovoTelefono(b)
  volpe.collega('🦊 Volpe')
  vero(vedi(b, volpe).io.iniziale === '🦊', 'iniziale spezzata su un\'emoji')
  const lungo = nuovoTelefono(b)
  lungo.collega('Massimiliano De Rossi')
  vero(Array.from(vedi(b, lungo).io.nome).length <= NOME_MAX, 'nome oltre il massimo')

  vero(!codiceValido('ABCD'), 'codice di 4 caratteri accettato')
  vero(!codiceValido('ABCDEF'), 'codice di 6 caratteri accettato')
  vero(!codiceValido('ABCDI') && !codiceValido('ABCDO') && !codiceValido('ABCD0') && !codiceValido('ABCD1'), 'codice con simboli esclusi')
  vero(!codiceValido('abcde'), 'codice minuscolo accettato')
  vero(codiceValido('ABCDE') && codiceValido('HJK23'), 'codice valido rifiutato')

  // Stanza piena.
  const piena = nuovoBanco(8002)
  iscrivi(piena, 15)
  for (let i = 15; i < MAX_GIOCATORI; i++) nuovoTelefono(piena).collega(`Ospite ${i}`)
  vero(piena.s.giocatori.length === MAX_GIOCATORI, 'massimo giocatori')
  const ultimo = entra(piena.s, 'tok-altro', 'Ventunesimo', piena.ora)
  vero(!ultimo.ok && ultimo.motivo === 'stanza-piena', 'stanza piena non rifiutata')

  // Partita iniziata: entra solo chi ha un posto.
  const p = nuovoBanco(8003)
  const tel = iscrivi(p, 4)
  parti(p, tel)
  const fuori = entra(p.s, 'tok-altro', 'Nuovo', p.ora)
  vero(!fuori.ok && fuori.motivo === 'partita-in-corso', 'ingresso a partita iniziata')

  // Ripresa del posto: rifiutata se online, accettata dopo 30 s, e il vecchio token non vale più.
  const pina = tel[3]
  const ruolo = giocatore(p, pina).ruolo
  const prestato = nuovoTelefono(p)
  prestato.collega('Pina')
  vero(prestato.rifiuto() === 'nome-usato' && prestato.vista() === null, 'posto online rubato')
  pina.scollega()
  const muta = silenzioDa(p, pina)
  avanza(p, muta + ATTESO.offline - 1)
  prestato.collega('pina')
  vero(prestato.rifiuto() === 'nome-usato', 'posto ripreso prima dei 30 s')
  avanza(p, muta + ATTESO.offline)
  prestato.collega('Pina')
  vero(prestato.vista()?.io.nome === 'Pina', 'posto offline non ripreso')
  vero(giocatore(p, prestato).ruolo === ruolo, 'ruolo cambiato con la ripresa')
  vero(p.s.giocatori.length === 4, 'la ripresa ha creato un posto nuovo')
  vero(!entra(p.s, pina.token, 'Altro nome', p.ora).ok, 'il vecchio token vale ancora')
}

function s9() {
  const b = nuovoBanco(9001)
  const due = iscrivi(b, 2)
  vero(nega(b, due[0], { a: 'start' }) === false, 'Start con 2 giocatori')

  const altri = PERSONALITA.slice(2, 6).map(p => {
    const t = nuovoTelefono(b)
    t.collega(p.nome)
    return t
  })
  const tel = [...due, ...altri]
  const f = b.s.f
  const host = due[0]
  const max = due[1]

  vero(!nega(b, max, { a: 'start' }), 'Start senza essere host')
  vero(!nega(b, max, { a: 'impostaTask', x: 99 }), 'numero task senza essere host')
  vero(!nega(b, max, { a: 'impostaAssassini', x: 2 }), 'assassini senza essere host')
  for (const x of [0, -3, 1.5, NaN, Infinity, '12', null]) vero(!nega(b, host, { a: 'impostaTask', x }), `numero task non valido: ${x}`)
  for (const x of [0, 3, '2', null]) vero(!nega(b, host, { a: 'impostaAssassini', x }), `assassini non validi: ${x}`)
  vero(!nega(b, max, { a: 'togli', x: host.id }), 'Togli senza essere host')
  vero(!nega(b, host, { a: 'togli', x: max.id }), 'Togli su un giocatore online')
  vero(!nega(b, host, { a: 'togli', x: host.id }), 'Togli su se stesso')
  vero(f === b.s.f, 'f cambiato')

  const { ass, civ } = parti(b, tel)
  const [truffatore, altro, terzo] = civ

  // Messaggi senza senso: il filtro su JSON e 1 KB sta nel server, qui si prova che le regole reggono comunque.
  for (const junk of [null, undefined, 'testo non JSON', 12, [], {}, { a: 'boh', f: b.s.f }, { f: b.s.f }, { a: 'vota', x: 'x'.repeat(2048), f: b.s.f }]) {
    vero(!manda(b, truffatore, junk, true), 'messaggio assurdo accettato')
  }

  vero(!nega(b, truffatore, { a: 'uccidi' }), 'Uccidi da civile')
  vero(!nega(b, ass[0], { a: 'uccidi' }), 'Uccidi prima dei 5 minuti')
  devePremere(b, truffatore, { a: 'spunta' })
  vero(!nega(b, truffatore, { a: 'spunta' }), 'spunta in anticipo')
  aspetta(b, ATTESO.task - 1)
  vero(!nega(b, truffatore, { a: 'spunta' }), 'spunta 1 ms prima della scadenza')
  aspetta(b, 1)
  devePremere(b, truffatore, { a: 'spunta' })
  vero(!manda(b, truffatore, { a: 'report', f: b.s.f - 1 }, true), 'f vecchio accettato')
  vero(!manda(b, truffatore, { a: 'report', f: String(b.s.f) }, true), 'f come testo accettato')

  devePremere(b, altro, { a: 'report' })
  vero(!nega(b, truffatore, { a: 'vota', x: 'x'.repeat(2048) }), 'voto da 2 KB')
  vero(!nega(b, truffatore, { a: 'vota', x: truffatore.id }), 'voto su se stesso')
  vero(!nega(b, truffatore, { a: 'vota', x: 99999 }), 'voto su uno sconosciuto')
  vero(!nega(b, truffatore, { a: 'vota', x: { toString: () => 'salta' } }), 'voto con un oggetto')
  devePremere(b, terzo, { a: 'sonoMorto' })
  vero(!nega(b, truffatore, { a: 'vota', x: terzo.id }), 'voto su un morto')
  vero(!nega(b, terzo, { a: 'vota', x: 'salta' }), 'voto da morto')
  devePremere(b, truffatore, { a: 'vota', x: 'salta' })
  vero(!nega(b, truffatore, { a: 'vota', x: altro.id }), 'secondo voto')
  vero(!nega(b, ass[0], { a: 'spunta' }), 'spunta in riunione con la task pronta')

  // Emergency: 10 minuti per tutti dall'ultima pressione. Il Report non ha attese.
  const e = nuovoBanco(9003)
  const stanza = iscrivi(e, 6)
  parti(e, stanza)
  devePremere(e, stanza[0], { a: 'emergency' })
  const pronta = e.ora + ATTESO.emergency
  for (const t of stanza) devePremere(e, t, { a: 'vota', x: 'salta' })
  aspetta(e, ATTESO.esito)
  vero(!nega(e, stanza[1], { a: 'emergency' }), 'Emergency in attesa, premuta da un altro')
  devePremere(e, stanza[1], { a: 'report' })
  for (const t of stanza) devePremere(e, t, { a: 'vota', x: 'salta' })
  aspetta(e, ATTESO.esito)
  avanza(e, pronta - 1)
  vero(!nega(e, stanza[2], { a: 'emergency' }), 'Emergency 1 ms prima della scadenza')
  avanza(e, pronta)
  devePremere(e, stanza[2], { a: 'emergency' })

  // Da morti resta solo Esci.
  const c = nuovoBanco(9002)
  const tavolo = iscrivi(c, 6)
  const ruoli = parti(c, tavolo, { task: 40, assassini: 2 })
  aspetta(c, ATTESO.uccidi)
  devePremere(c, ruoli.ass[0], { a: 'sonoMorto' })
  devePremere(c, ruoli.civ[0], { a: 'sonoMorto' })
  vero(!nega(c, ruoli.ass[0], { a: 'uccidi' }), 'Uccidi da morto')
  vero(!nega(c, ruoli.civ[0], { a: 'report' }), 'Report da morto')
  vero(!nega(c, ruoli.civ[0], { a: 'emergency' }), 'Emergency da morto')
  vero(!nega(c, ruoli.civ[0], { a: 'sonoMorto' }), 'Sono morto due volte')
  vero(!nega(c, ruoli.civ[0], { a: 'spunta' }), 'Fatto da morto')
  devePremere(c, ruoli.civ[0], { a: 'esci' })
}

function s10() {
  const quattro = nuovoBanco(10001)
  const q = iscrivi(quattro, 4)
  vero(!nega(quattro, q[0], { a: 'impostaAssassini', x: 2 }), '2 assassini a 4 giocatori')
  vero(inSala(quattro, q[0]).maxAssassini === 1, 'selettore a 4 giocatori')

  const cinque = nuovoBanco(10002)
  const c = iscrivi(cinque, 5)
  devePremere(cinque, c[0], { a: 'impostaAssassini', x: 2 })
  vero(inSala(cinque, c[0]).numeroAssassini === 2 && inSala(cinque, c[0]).maxAssassini === 2, 'selettore a 5 giocatori')
  devePremere(cinque, c[4], { a: 'esci' })
  vero(inSala(cinque, c[0]).numeroAssassini === 1, 'con 4 giocatori ne resta 1')

  // La scelta dell'host resta salvata anche se si gioca con meno giocatori: al ritorno in sala torna valida.
  const scelta = nuovoBanco(10004)
  const sc = iscrivi(scelta, 5)
  const quattroRimasti = sc.slice(0, 4)
  devePremere(scelta, sc[0], { a: 'impostaAssassini', x: 2 })
  devePremere(scelta, sc[4], { a: 'esci' })
  devePremere(scelta, sc[0], { a: 'impostaTask', x: 1 })
  devePremere(scelta, sc[0], { a: 'start' })
  vero(quattroRimasti.every(t => (vedi(scelta, t) as VistaRuolo).assassini === 1), 'Rivelazione a 4 giocatori: 1 assassino')
  vero(scelta.s.traguardo === 2, `traguardo ${scelta.s.traguardo}: 3 civili per 1 task fanno 2`)
  for (const t of quattroRimasti) devePremere(scelta, t, { a: 'ruoloVisto' })
  for (const t of quattroRimasti.slice(0, 2)) devePremere(scelta, t, { a: 'spunta' })
  aspetta(scelta, ATTESO.fine)
  vero(scelta.s.fase === 'sala', 'si doveva tornare in sala')
  vero(inSala(scelta, sc[0]).numeroAssassini === 1, 'al ritorno, con 4 giocatori, il selettore resta a 1')
  sc[4].collega('Quinto')
  vero(inSala(scelta, sc[0]).numeroAssassini === 2, 'dopo una partita a 4 la scelta di 2 assassini si è persa')

  // Su Rivelazione si legge il numero della partita: se scendesse quando un assassino esce, lo si scoprirebbe.
  const riv = nuovoBanco(10005)
  const sette = iscrivi(riv, 7)
  devePremere(riv, sette[0], { a: 'impostaAssassini', x: 2 })
  devePremere(riv, sette[0], { a: 'start' })
  const inFuga = sette.find(t => giocatore(riv, t).ruolo === 'assassino') as TelefonoFinto
  const fermo = sette.find(t => giocatore(riv, t).ruolo === 'civile') as TelefonoFinto
  devePremere(riv, inFuga, { a: 'esci' })
  vero((vedi(riv, fermo) as VistaRuolo).assassini === 2, "il numero su Rivelazione è sceso con l'uscita di un assassino")

  const b = nuovoBanco(10003)
  const tel = iscrivi(b, 7)
  const { ass, civ } = parti(b, tel, { assassini: 2 })
  const [a1, a2] = ass
  vero(ass.length === 2, 'assassini in partita')
  const inizio = b.ora
  vero(inPartita(b, a1).uccidiDa === inizio + ATTESO.uccidi, 'timer iniziale')
  vero(inPartita(b, civ[0]).uccidiDa === undefined, 'timer Uccidi a un civile')

  aspetta(b, ATTESO.uccidi - 1)
  vero(!nega(b, a1, { a: 'uccidi' }), 'Uccidi 1 ms prima della scadenza')
  aspetta(b, 1)
  const prima = tel.map(t => t.ultimoTesto)
  devePremere(b, a1, { a: 'uccidi' })
  vero(tel.every((t, i) => t === a1 || t.ultimoTesto === prima[i]), 'Uccidi ha spedito qualcosa agli altri telefoni')
  vero(inPartita(b, a1).uccidiDa === b.ora + ATTESO.uccidi, 'il timer del primo riparte')
  vero(inPartita(b, a2).uccidiDa === inizio + ATTESO.uccidi, 'il timer del secondo non deve cambiare')
  vero(!nega(b, a1, { a: 'uccidi' }), 'Uccidi due volte')
  devePremere(b, a2, { a: 'uccidi' })

  aspetta(b, 60_000)
  devePremere(b, civ[0], { a: 'report' })
  for (const t of tel) devePremere(b, t, { a: 'vota', x: 'salta' })
  aspetta(b, ATTESO.esito)
  vero(b.s.fase === 'partita', 'si torna in partita')
  for (const t of ass) vero(inPartita(b, t).uccidiDa === b.ora + ATTESO.uccidi, 'timer azzerati a fine riunione')
}

function s11() {
  const conFase = (b: Banco, fase: Fase, testo: string) => vero(b.s.fase === fase, `${testo}: fase ${b.s.fase}`)

  // La scala divide le durate di gioco, le soglie di presenza non si toccano.
  const veloce = nuovaStanza('ABCDE', 1, 30)
  vero(veloce.durate.esito === 267 && veloce.durate.task === 4000 && veloce.durate.uccidi === 10000, 'scala delle durate')

  // Traguardo arrotondato per eccesso: 3 civili per 3 task fanno 4,5.
  const dispari = nuovoBanco(11000)
  parti(dispari, iscrivi(dispari, 4), { task: 3 })
  vero(dispari.s.traguardo === 5, `traguardo ${dispari.s.traguardo}, atteso 5`)

  // L'anteprima in sala non scende sotto 1, come nel prototipo: con l'host da solo i civili sono 0.
  const solo = nuovoBanco(11008)
  const [unico] = iscrivi(solo, 1)
  vero(inSala(solo, unico).traguardoPrevisto === 1, `anteprima con un giocatore: ${inSala(solo, unico).traguardoPrevisto}`)

  // Barra piena: 2 civili, 1 task, traguardo 1.
  let b = nuovoBanco(11001)
  let tel = iscrivi(b, 3)
  let { ass, civ } = parti(b, tel, { task: 1 })
  vero(b.s.traguardo === 1, 'traguardo minimo')
  devePremere(b, ass[0], { a: 'spunta' })
  conFase(b, 'fine', 'barra piena, anche con la spunta di un assassino')
  vero(b.s.vincitore === 'civili' && b.s.motivo === 'barra', 'motivo barra')
  vero(b.s.barra === b.s.traguardo, 'barra al traguardo')
  aspetta(b, ATTESO.fine - 1)
  conFase(b, 'fine', 'fine prima dei 10 s')
  aspetta(b, 1)
  conFase(b, 'sala', 'ritorno in sala dopo 10 s')

  // Ultimo assassino eliminato.
  b = nuovoBanco(11002)
  tel = iscrivi(b, 5)
  ;({ ass, civ } = parti(b, tel))
  devePremere(b, civ[0], { a: 'report' })
  for (const t of civ) devePremere(b, t, { a: 'vota', x: ass[0].id })
  devePremere(b, ass[0], { a: 'vota', x: civ[0].id })
  conFase(b, 'esito', 'voto chiuso')
  vero(inEsito(b, civ[0]).eliminatoRuolo === 'assassino' && inEsito(b, civ[0]).vincitore === 'civili', 'esito ultimo assassino')
  aspetta(b, ATTESO.esito - 1)
  conFase(b, 'esito', 'esito prima degli 8 s')
  aspetta(b, 1)
  conFase(b, 'fine', 'fine dopo 8 s')
  vero(b.s.vincitore === 'civili' && b.s.motivo === 'assassini', 'motivo assassini')

  // Parità dopo Sono morto, in partita: si finisce subito.
  b = nuovoBanco(11003)
  tel = iscrivi(b, 5)
  ;({ ass, civ } = parti(b, tel))
  devePremere(b, civ[0], { a: 'sonoMorto' })
  devePremere(b, civ[1], { a: 'sonoMorto' })
  conFase(b, 'partita', 'con 2 civili si continua')
  devePremere(b, civ[2], { a: 'sonoMorto' })
  conFase(b, 'fine', 'parità dopo Sono morto')
  vero(b.s.vincitore === 'assassini' && b.s.motivo === 'maggioranza', 'motivo maggioranza')

  // Vittoria per uscita: esce l'assassino, oppure esce un civile e si arriva alla parità.
  b = nuovoBanco(11004)
  tel = iscrivi(b, 5)
  ;({ ass, civ } = parti(b, tel))
  devePremere(b, ass[0], { a: 'esci' })
  vero(b.s.vincitore === 'civili' && b.s.motivo === 'assassini', 'esce l\'unico assassino')
  b = nuovoBanco(11005)
  tel = iscrivi(b, 3)
  ;({ ass, civ } = parti(b, tel))
  devePremere(b, civ[0], { a: 'esci' })
  vero(b.s.vincitore === 'assassini', 'uscita fino alla parità')

  // Salta in testa: nessuno eliminato.
  b = nuovoBanco(11006)
  tel = iscrivi(b, 7)
  ;({ ass, civ } = parti(b, tel))
  devePremere(b, civ[0], { a: 'emergency' })
  devePremere(b, tel[0], { a: 'vota', x: tel[1].id })
  devePremere(b, tel[1], { a: 'vota', x: tel[0].id })
  devePremere(b, tel[2], { a: 'vota', x: tel[0].id })
  devePremere(b, tel[3], { a: 'vota', x: tel[1].id })
  devePremere(b, tel[4], { a: 'vota', x: 'salta' })
  devePremere(b, tel[5], { a: 'vota', x: 'salta' })
  devePremere(b, tel[6], { a: 'vota', x: 'salta' })
  vero(inEsito(b, tel[0]).eliminatoId === null && inEsito(b, tel[0]).salti === 3, 'Salta in testa con 3 voti')
  vero(!inEsito(b, tel[0]).parita, 'Salta in testa non è parità')

  // Parità di voti: nessuno eliminato.
  b = nuovoBanco(11007)
  tel = iscrivi(b, 6)
  ;({ civ } = parti(b, tel))
  devePremere(b, civ[0], { a: 'report' })
  devePremere(b, tel[0], { a: 'vota', x: tel[1].id })
  devePremere(b, tel[1], { a: 'vota', x: tel[0].id })
  devePremere(b, tel[2], { a: 'vota', x: tel[0].id })
  devePremere(b, tel[3], { a: 'vota', x: tel[1].id })
  devePremere(b, tel[4], { a: 'vota', x: 'salta' })
  devePremere(b, tel[5], { a: 'vota', x: 'salta' })
  vero(inEsito(b, tel[0]).parita && inEsito(b, tel[0]).eliminatoId === null, 'parità di voti')
}

function s14() {
  // Nessun intervento dell'host: gli assenti chiudono il voto da soli, e valgono Salta.
  let b = nuovoBanco(14001)
  let tel = iscrivi(b, 5)
  let { ass, civ } = parti(b, tel)
  const [a, c1, c2, assente] = [ass[0], civ[0], civ[1], civ[2]]
  const bersaglio = civ[3]
  devePremere(b, c1, { a: 'report' })
  assente.scollega()
  const zero = silenzioDa(b, assente)
  devePremere(b, a, { a: 'vota', x: bersaglio.id })
  devePremere(b, c1, { a: 'vota', x: bersaglio.id })
  devePremere(b, c2, { a: 'vota', x: 'salta' })
  devePremere(b, bersaglio, { a: 'vota', x: a.id })

  // Passare il limite offline non basta: solo a 45 s si chiude.
  avanza(b, zero + ATTESO.assente - 1)
  vero(b.s.fase === 'riunione', 'voto chiuso prima dei 45 s')
  avanza(b, zero + ATTESO.assente)
  vero(b.s.fase === 'esito', 'voto non chiuso a 45 s senza interventi')
  const v = inEsito(b, c1)
  // 2 voti su uno, 1 sull'altro e 2 Salta: senza l'assente il bersaglio sarebbe stato eliminato.
  vero(v.salti === 2 && v.parita && v.eliminatoId === null, 'l\'assente deve valere Salta')
  vero(giocatore(b, assente).vivo, 'l\'assente non si tocca: resta vivo')

  // Con l'assente già muto da 45 s, l'ultimo voto chiude subito.
  b = nuovoBanco(14002)
  tel = iscrivi(b, 5)
  ;({ ass, civ } = parti(b, tel))
  civ[0].scollega()
  aspetta(b, ATTESO.assente + PRESENZE_MS)
  devePremere(b, civ[1], { a: 'report' })
  for (const t of [ass[0], civ[1], civ[2]]) devePremere(b, t, { a: 'vota', x: 'salta' })
  vero(b.s.fase === 'riunione', 'manca ancora un voto')
  devePremere(b, civ[3], { a: 'vota', x: 'salta' })
  vero(b.s.fase === 'esito', 'ultimo voto con assente già muto')

  // Due assenti: serve che lo siano entrambi. Chi torna in tempo blocca la chiusura, senza alcun timer per lui.
  b = nuovoBanco(14003)
  tel = iscrivi(b, 6)
  ;({ ass, civ } = parti(b, tel))
  const [torna, resta] = [civ[0], civ[1]]
  devePremere(b, civ[2], { a: 'report' })
  torna.scollega()
  resta.scollega()
  const inizio = silenzioDa(b, torna)
  for (const t of [ass[0], civ[2], civ[3], civ[4]]) devePremere(b, t, { a: 'vota', x: 'salta' })
  avanza(b, inizio + ATTESO.assente - 5_000)
  torna.collega('qualsiasi')
  avanza(b, inizio + 5 * MIN)
  vero(b.s.fase === 'riunione', 'chi è connesso non ha timer di voto')
  devePremere(b, torna, { a: 'vota', x: 'salta' })
  vero(b.s.fase === 'esito', 'chiusura dopo il voto di chi è tornato')
  vero(giocatore(b, resta).vivo && b.s.giocatori.length === 6, 'offline non è uscita')

  // Vale anche per chi ha perso il voto: se chi deve rivotare è assente, si chiude senza di lui.
  b = nuovoBanco(14004)
  tel = iscrivi(b, 6)
  ;({ ass, civ } = parti(b, tel))
  devePremere(b, civ[2], { a: 'report' })
  devePremere(b, civ[0], { a: 'vota', x: civ[1].id })
  civ[0].scollega()
  const muto = silenzioDa(b, civ[0])
  for (const t of [ass[0], civ[2], civ[3], civ[4]]) devePremere(b, t, { a: 'vota', x: 'salta' })
  devePremere(b, civ[1], { a: 'sonoMorto' })
  vero(b.s.fase === 'riunione', 'il voto annullato va ancora dato')
  avanza(b, muto + ATTESO.assente - 1)
  vero(b.s.fase === 'riunione', 'chiuso prima dei 45 s')
  avanza(b, muto + ATTESO.assente)
  vero(b.s.fase === 'esito' && inEsito(b, ass[0]).salti === 5, 'chi deve rivotare e manca vale Salta')
}

// Due stanze uguali tranne il bersaglio di un voto: dopo l'annullamento chi guarda non deve capire in quale si trova.
function votiAnnullati() {
  const dopo = (uscita: 'sonoMorto' | 'esci' | 'togli', votaChiEsce: boolean) => {
    const b = nuovoBanco(15001)
    const tel = iscrivi(b, 6)
    parti(b, tel)
    const [host, votante, altro, terzo, , chiEsce] = tel
    devePremere(b, host, { a: 'report' })
    devePremere(b, votante, { a: 'vota', x: (votaChiEsce ? chiEsce : altro).id })
    if (uscita === 'togli') {
      chiEsce.scollega()
      aspetta(b, ATTESO.offline + PRESENZE_MS)
      devePremere(b, host, { a: 'togli', x: chiEsce.id })
    } else {
      devePremere(b, chiEsce, { a: uscita })
    }
    vero(b.s.fase === 'riunione', `${uscita}: la riunione doveva restare aperta`)
    vero(inRiunione(b, votante).rivota === votaChiEsce, `${uscita}: rivota solo chi aveva votato chi è uscito`)
    return parteComune(vedi(b, terzo))
  }
  for (const uscita of ['sonoMorto', 'esci', 'togli'] as const) {
    vero(dopo(uscita, true) === dopo(uscita, false), `${uscita}: un voto annullato si riconosce dagli altri telefoni`)
  }
}

function riproducibile() {
  const impronta = (b: Banco) => JSON.stringify([b.s, b.ora, b.conta, b.mondo.conta])
  vero(impronta(giocaSerata(4242)) === impronta(giocaSerata(4242)), 'lo stesso seme ha dato due serate diverse')
  vero(impronta(giocaSerata(4242)) !== impronta(giocaSerata(4243)), 'semi diversi hanno dato la stessa serata')
}

function coperturaTask() {
  vero(new Set(TASKS).size === TASKS.length && TASKS.length >= 30, 'servono almeno 30 testi diversi')

  // Molti giri di mazzo: dopo ogni spunta il testo deve cambiare.
  // $& è un nome valido e nelle sostituzioni di testo ha un significato speciale.
  const s = nuovaStanza('ABCDE', 77)
  const giocatori = ['Aldo', 'Bice', 'Ciro', '$&Dora'].map(n => entra(s, n, n, 0)).map(e => (e as { id: number }).id)
  applica(s, giocatori[0], { a: 'impostaTask', x: 1_000_000, f: s.f }, 0)
  applica(s, giocatori[0], { a: 'start', f: s.f }, 0)
  for (const id of giocatori) applica(s, id, { a: 'ruoloVisto', f: s.f }, 0)
  let ora = 0
  let missioni = 0
  let suVittima = 0
  let vittima: (typeof s.giocatori)[number] | undefined
  const giri = (quanti: number) => {
    for (let turno = 0; turno < quanti; turno++) {
      ora += ATTESO.task
      for (const g of s.giocatori) segnale(s, g.id, ora)
      for (const g of s.giocatori.filter(x => x.vivo)) {
        vero(applica(s, g.id, { a: 'spunta', f: s.f }, ora), 'spunta rifiutata')
        vero(g.task !== g.taskFatta, `task ripetuta al turno ${turno}`)
        vero(!g.task?.includes('{'), `segnaposto rimasto: ${g.task}`)
        if (!g.task?.startsWith(SEGNO_MISSIONE)) continue
        missioni++
        const nominati = s.giocatori.filter(a => g.task?.includes(a.nome))
        vero(nominati.length === 1 && nominati[0].id !== g.id && nominati[0].id === g.missioneSu, `missione segreta sul nome sbagliato: ${g.task}`)
        if (nominati[0].id === vittima?.id) suVittima++
      }
    }
  }

  giri(3000)
  const frequenza = missioni / (3000 * giocatori.length)
  vero(Math.abs(frequenza - PROBABILITA_MISSIONE) < 0.015, `missioni segrete con frequenza ${frequenza}`)

  vittima = s.giocatori.find(g => g.ruolo === 'civile')
  vero(applica(s, vittima?.id ?? -1, { a: 'sonoMorto', f: s.f }, ora), 'Sono morto rifiutato')
  giri(1000)
  vero(suVittima > 0, 'chi ha premuto Sono morto non viene più nominato: lo rivelerebbe')

  // Dopo una riunione il morto è noto a tutti: non si siede più e non viene più nominato.
  const vivo = s.giocatori.find(g => g.vivo)
  vero(applica(s, vivo?.id ?? -1, { a: 'report', f: s.f }, ora), 'Report rifiutato')
  vero(vittima?.causa === 'trovato', 'la riunione non ha reso noto il morto')
  vero(vista(s, vittima?.id ?? -1, ora).io.causa === 'trovato', 'il telefono del morto non lo sa')
}

// Sei giocatori e spunte a giro finché uno non ha una missione in attesa.
function conMissione(seme: number) {
  const s = nuovaStanza('ABCDE', seme)
  const ids = ['Aldo', 'Bice', 'Ciro', 'Dora', 'Elio', 'Fede'].map(n => (entra(s, n, n, 0) as { id: number }).id)
  applica(s, ids[0], { a: 'impostaTask', x: 1_000_000, f: s.f }, 0)
  applica(s, ids[0], { a: 'start', f: s.f }, 0)
  for (const id of ids) applica(s, id, { a: 'ruoloVisto', f: s.f }, 0)
  for (let ora = ATTESO.task; ; ora += ATTESO.task) {
    for (const id of ids) segnale(s, id, ora)
    for (const id of ids) applica(s, id, { a: 'spunta', f: s.f }, ora)
    const chi = s.giocatori.find(g => g.missioneSu !== null)
    if (chi) return { s, ora, chi, nominato: chi.missioneSu as number }
  }
}

function missioniInAttesa() {
  for (let seme = 1; seme <= 40; seme++) {
    const annullata = (chi: { task: string | null; missioneSu: number | null }, come: string) => {
      vero(!chi.task?.startsWith(SEGNO_MISSIONE) && chi.missioneSu === null, `seme ${seme}: missione rimasta dopo ${come}: ${chi.task}`)
    }

    const esce = conMissione(seme)
    vero(applica(esce.s, esce.nominato, { a: 'esci', f: esce.s.f }, esce.ora), 'Esci rifiutato')
    annullata(esce.chi, 'l’uscita del nominato')

    const morto = conMissione(seme)
    const testo = morto.chi.task
    vero(applica(morto.s, morto.nominato, { a: 'sonoMorto', f: morto.s.f }, morto.ora), 'Sono morto rifiutato')
    vero(morto.chi.task === testo, `seme ${seme}: la missione è cambiata col Sono morto del nominato, che così si scopre`)

    const voto = conMissione(seme)
    vero(applica(voto.s, voto.chi.id, { a: 'report', f: voto.s.f }, voto.ora), 'Report rifiutato')
    for (const g of [...voto.s.giocatori]) {
      const x = g.id === voto.nominato ? 'salta' : voto.nominato
      vero(applica(voto.s, g.id, { a: 'vota', x, f: voto.s.f }, voto.ora), 'voto rifiutato')
    }
    vero(voto.s.fase === 'esito', `seme ${seme}: votazione non chiusa`)
    annullata(voto.chi, 'l’eliminazione del nominato')
  }
}

const SCENARI: [string, () => void][] = [
  ['S1  stesso seme, stessa serata', riproducibile],
  ['S1b missioni in attesa', missioniInAttesa],
  ['S2  telefono scarico: Togli, in riunione e in sala', s2],
  ['S3  host bloccato', s3],
  ['S4  uscita con voti ricevuti', s4],
  ['S5  vittima tardiva', s5],
  ['S6  ricariche', s6],
  ['S7  corse', s7],
  ['S8  ingressi', s8],
  ['S9  imbrogli', s9],
  ['S10 due assassini', s10],
  ['S11 tutti i finali', s11],
  ['S14 voto chiuso dagli assenti, senza host', s14],
  ['    voti annullati senza indizi per gli altri', votiAnnullati],
  ['    testi delle task', coperturaTask],
]

// ---- Il bilanciamento ----
type Griglia = { task: number[]; tavoli: [number, number][] }
const GRIGLIA: Griglia = {
  task: [8, 12, 16, 24, 32],
  tavoli: [
    [10, 1],
    [10, 2],
    [15, 1],
    [15, 2],
  ],
}
const PARTITE_PER_CELLA = 200
const SEME_BILANCIAMENTO = 700_000

// Una partita normale: niente voci false, che esistono solo per mettere sotto stress le serate di collaudo.
const NORMALE: Ipotesi = { ...IPOTESI, allarmeMs: Infinity }
const SENZA_ANSIOSO = (t: Tratti): Tratti => ({ ...t, emergencySubito: false, reportAllaVoce: false, reportInTasca: false })

type Riga = Impostazione & {
  partite: number
  durata: number
  civili: number
  assassiniVinti: number
  barra: number
  scoperti: number
  riunioni: number
  uccisioni: number
  sbagli: number // civili eliminati per errore, a partita
}

function cella(c: Impostazione, variante: Variante, partite: number, errori: string[]): Riga {
  const riga: Riga = { ...c, partite: 0, durata: 0, civili: 0, assassiniVinti: 0, barra: 0, scoperti: 0, riunioni: 0, uccisioni: 0, sbagli: 0 }
  const base = SEME_BILANCIAMENTO + c.giocatori * 10_000 + c.assassini * 1_000 + c.numeroTask * 10
  for (let i = 0; i < partite; i++) {
    const seme = base * 7 + i
    try {
      const b = giocaPartita(c, seme, variante)
      riga.partite++
      riga.durata += b.durata
      riga.civili += b.s.vincitore === 'civili' ? 1 : 0
      riga.assassiniVinti += b.s.vincitore === 'assassini' ? 1 : 0
      riga.barra += b.s.motivo === 'barra' ? 1 : 0
      riga.scoperti += b.s.motivo === 'assassini' ? 1 : 0
      riga.riunioni += b.conta.riunioni
      riga.uccisioni += b.mondo.conta.uccisioni
      riga.sbagli += b.conta.civiliEliminati
    } catch (e) {
      errori.push(`partita ${c.giocatori},${c.assassini},${c.numeroTask},${seme}: ${(e as Error).message}\n  per ricrearlo: node test/serata.ts --partita ${c.giocatori},${c.assassini},${c.numeroTask},${seme}`)
    }
  }
  return riga
}

function bilancia(g: Griglia, variante: Variante, partite: number, errori: string[]): Riga[] {
  const righe: Riga[] = []
  for (const [giocatori, assassini] of g.tavoli) {
    for (const numeroTask of g.task) righe.push(cella({ giocatori, assassini, numeroTask }, variante, partite, errori))
  }
  return righe
}

const percento = (n: number, su: number) => (su ? `${Math.round((n / su) * 100)}%` : '-')
const decimale = (n: number) => n.toFixed(1)

function tabella(righe: Riga[]): string {
  const titoli = ['Giocatori', 'Assassini', 'Task', 'Durata', 'Vince civili', 'Vince assassini', 'di cui barra', 'di cui scoperti', 'Riunioni', 'Uccisioni', 'Innocenti eliminati']
  const corpo = righe.map(r => [
    String(r.giocatori),
    String(r.assassini),
    String(r.numeroTask),
    `${decimale(r.durata / r.partite / MIN)} min`,
    percento(r.civili, r.partite),
    percento(r.assassiniVinti, r.partite),
    percento(r.barra, r.partite),
    percento(r.scoperti, r.partite),
    decimale(r.riunioni / r.partite),
    decimale(r.uccisioni / r.partite),
    decimale(r.sbagli / r.partite),
  ])
  const larghezze = titoli.map((t, i) => Math.max(t.length, ...corpo.map(c => c[i].length)))
  const scrivi = (celle: string[]) => celle.map((c, i) => c.padStart(larghezze[i])).join('  ')
  return [scrivi(titoli), ...corpo.map(scrivi)].join('\n')
}

// Per ogni tavolo il numero task più vicino al 50%, e se rientra nella fascia combattuta.
function lettura(g: Griglia, righe: Riga[]): string {
  return g.tavoli.map(([giocatori, assassini]) => {
    const tavolo = righe.filter(r => r.giocatori === giocatori && r.assassini === assassini && r.partite)
    if (!tavolo.length) return `${giocatori} giocatori, ${assassini} assassini: nessun dato`
    const distanza = (r: Riga) => Math.abs(r.assassiniVinti / r.partite - 0.5)
    const migliore = tavolo.reduce((a, r) => (distanza(r) < distanza(a) ? r : a))
    const pct = (migliore.assassiniVinti / migliore.partite) * 100
    const giudizio = pct >= 35 && pct <= 65 ? 'combattuta' : 'sbilanciata'
    return `${giocatori} giocatori, ${assassini} assassini: ${migliore.numeroTask} task, assassini ${Math.round(pct)}%, ${decimale(migliore.durata / migliore.partite / MIN)} min, ${giudizio}`
  }).join('\n')
}

// Tutte senza l'Ansioso, così si legge l'effetto della sola ipotesi cambiata rispetto alla seconda tabella.
const conTratti = (f: (t: Tratti) => Tratti): Variante => ({ tratti: t => f(SENZA_ANSIOSO(t)) })
const VARIANTI: [string, Variante][] = [
  ['task lente (90 s)', conTratti(t => ({ ...t, durataTask: 90_000 }))],
  ['task rapide (20 s)', conTratti(t => ({ ...t, durataTask: 20_000 }))],
  ['cadaveri trovati in media in 1 min', { ...conTratti(t => t), ipotesi: { ...NORMALE, cadavereMs: 1 * MIN } }],
  ['cadaveri trovati in media in 5 min', { ...conTratti(t => t), ipotesi: { ...NORMALE, cadavereMs: 5 * MIN } }],
  ['voto facile (prudenza 0,3)', conTratti(t => ({ ...t, prudenza: t.soloProve ? 1 : 0.3 }))],
  ['assassini che non spuntano mai', conTratti(t => ({ ...t, spuntaDaAssassino: 0 }))],
  ['testimone solo nel 10% delle uccisioni', { ...conTratti(t => t), ipotesi: { ...NORMALE, pTestimone: 0.1 } }],
  ['testimonianze credute una volta su due', conTratti(t => ({ ...t, fiducia: 0.5 }))],
  ["con l'Ansioso e voci false ogni 8 min", { ipotesi: IPOTESI }],
]

// ---- Avvio ----
function sommaConte(totale: Conta, conta: Conta) {
  for (const k of Object.keys(totale) as (keyof Conta)[]) totale[k] += conta[k]
}

function eseguiScenari(errori: string[]) {
  console.log('Scenari (con i controlli C1-C6, C8 e C9 attivi a ogni messaggio)')
  for (const [nome, prova] of SCENARI) {
    try {
      prova()
      console.log(`  ok      ${nome}`)
    } catch (e) {
      console.log(`  ERRORE  ${nome}: ${(e as Error).message}`)
      errori.push(`scenario ${nome}: ${(e as Error).stack}`)
    }
  }
}

function eseguiSerate(quante: number, errori: string[]) {
  const totale = { ...CONTA_VUOTA }
  const mondo = { uccisioni: 0, testimoni: 0, cadaveri: 0, allarmi: 0, ricariche: 0, secondeSchede: 0 }
  let virtuale = 0
  const inizio = performance.now()
  for (let seme = 1000; seme < 1000 + quante; seme++) {
    try {
      const b = giocaSerata(seme)
      sommaConte(totale, b.conta)
      for (const k of Object.keys(mondo) as (keyof typeof mondo)[]) mondo[k] += b.mondo.conta[k]
      virtuale += b.ora
    } catch (e) {
      errori.push(`serata seme ${seme}: ${(e as Error).message}\n  per ricrearlo: node test/serata.ts --seme ${seme}`)
    }
  }
  const secondi = ((performance.now() - inizio) / 1000).toFixed(1)
  console.log(`\nSerate: ${quante} con semi fissi da 1000 a ${999 + quante}, ${totale.partite} partite finite, ${Math.round(virtuale / 3_600_000)} ore virtuali in ${secondi} s`)
  console.log('Cose successe davvero nelle serate:')
  const voci: [string, number][] = [
    ['riunioni', totale.riunioni],
    ['uccisioni fisiche', mondo.uccisioni],
    ['con testimone', mondo.testimoni],
    ['cadaveri trovati', mondo.cadaveri],
    ['voci senza fondamento', mondo.allarmi],
    ['voti chiusi per assenti', totale.chiusurePerAssenti],
    ['Togli dell\'host', totale.tolti],
    ['uscite in riunione', totale.usciteInRiunione],
    ['  di cui con voti ricevuti', totale.usciteConVoti],
    ['Sono morto durante il voto', totale.mortiInVoto],
    ['voti annullati da rifare', totale.rivoti],
    ['passaggi di host per assenza', totale.passaggiHost],
    ['host usciti', totale.hostUsciti],
    ['posti ripresi senza token', totale.ripresePosto],
    ['ricariche di pagina', mondo.ricariche],
    ['seconde schede', mondo.secondeSchede],
    ['azioni false respinte', totale.azioniFalse],
    ['pareggi', totale.parita],
    ['Salta in testa', totale.saltaInTesta],
    ['eliminazioni', totale.eliminazioni],
    ['  di cui innocenti', totale.civiliEliminati],
    ['vittorie con barra piena', totale.vinteBarra],
    ['vittorie assassini scoperti', totale.vinteScoperti],
    ['vittorie assassini in parità', totale.vinteMaggioranza],
  ]
  for (const [nome, n] of voci) console.log(`  ${nome.padEnd(30)} ${n}`)
}

function main() {
  const argomenti = process.argv.slice(2)
  const errori: string[] = []
  const pos = (nome: string) => argomenti.indexOf(nome)
  const lista = (nome: string, altrimenti: number[]) => (pos(nome) >= 0 ? argomenti[pos(nome) + 1].split(',').map(Number) : altrimenti)

  if (pos('--seme') >= 0) {
    const seme = Number(argomenti[pos('--seme') + 1])
    try {
      const b = giocaSerata(seme)
      console.log(`Serata ${seme} finita senza errori: ${b.conta.partite} partite, ${b.conta.riunioni} riunioni.`)
    } catch (e) {
      console.log(`ERRORE serata seme ${seme}: ${(e as Error).message}`)
      process.exitCode = 1
    }
    return
  }

  if (pos('--partita') >= 0) {
    const [giocatori, assassini, numeroTask, seme] = argomenti[pos('--partita') + 1].split(',').map(Number)
    try {
      const b = giocaPartita({ giocatori, assassini, numeroTask }, seme)
      console.log(`Partita finita senza errori: vincono i ${b.s.vincitore} (${b.s.motivo}) in ${decimale(b.durata / MIN)} min.`)
    } catch (e) {
      console.log(`ERRORE partita seme ${seme}: ${(e as Error).message}`)
      process.exitCode = 1
    }
    return
  }

  console.log('Sala Sospetti, livello L1: regole, orologio virtuale, nessuna rete\n')
  const inizio = performance.now()
  if (pos('--solo-tabella') < 0) {
    eseguiScenari(errori)
    eseguiSerate(pos('--rapido') >= 0 ? 10 : 100, errori)
  }

  const griglia: Griglia = {
    task: lista('--task', GRIGLIA.task),
    tavoli: pos('--giocatori') >= 0 ? lista('--giocatori', []).flatMap(g => [[g, 1], [g, 2]] as [number, number][]) : GRIGLIA.tavoli,
  }

  if (pos('--rapido') < 0) {
    const tutti = bilancia(griglia, {}, PARTITE_PER_CELLA, errori)
    console.log(`\nBilanciamento: ${PARTITE_PER_CELLA} partite per riga, durata dallo Start alla fine, margine sulle percentuali circa ±7 punti`)
    console.log("Tutte le personalità, compreso l'Ansioso (Emergency appena possibile, Report alla prima voce, uno in tasca):")
    console.log(tabella(tutti))
    console.log('\nNumero task più vicino a una partita combattuta (assassini tra 35% e 65%):')
    console.log(lettura(griglia, tutti))

    const calmi = bilancia(griglia, { tratti: SENZA_ANSIOSO }, PARTITE_PER_CELLA, errori)
    console.log("\nStesse partite senza l'Ansioso (riunioni solo per un cadavere o un testimone):")
    console.log(tabella(calmi))
    console.log('\nNumero task più vicino a una partita combattuta (assassini tra 35% e 65%):')
    console.log(lettura(griglia, calmi))
  }

  if (pos('--sensibilita') >= 0) {
    for (const [nome, variante] of VARIANTI) {
      const altre = bilancia(griglia, variante, PARTITE_PER_CELLA, errori)
      console.log(`\nSensibilità, ${nome}:`)
      console.log(tabella(altre))
    }
  }

  console.log(`\nTempo totale ${((performance.now() - inizio) / 1000).toFixed(1)} s`)
  if (errori.length) {
    console.log(`\n${errori.length} ERRORI:`)
    for (const e of errori.slice(0, 30)) console.log(e)
    if (errori.length > 30) console.log(`...e altri ${errori.length - 30}`)
    process.exitCode = 1
  } else {
    console.log('\nZero errori.')
  }
}

main()
