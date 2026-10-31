// Prova di rete, `npm run test:rete`: WebSocket veri contro un wrangler dev avviato qui, pilotati da piccoli bot.
// Le soglie di presenza non vengono scalate, quindi dura qualche minuto. Usa solo la porta 8788 e .wrangler/prova:
// l'istanza dell'utente sulla 8787 non viene toccata, e si fermano solo i processi avviati da questo file, per PID.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSENTE_VOTO_MS, MAX_GIOCATORI, OFFLINE_MS, RESULT_MS, generaCodice } from '../gioco/regole.ts'

const PORTA = 8788
const HTTP = `http://127.0.0.1:${PORTA}`
const WS = `ws://127.0.0.1:${PORTA}`
const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(RADICE, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const PING_MS = 10 * 1000
const CONVERGENZA_MS = 1000 // C7
const MARGINE_MS = 3000 // ritardo ammesso sulle soglie reali
const GIRO_MASSIMO_MS = 10 * 1000 // il server si accorge di un'assenza al giro successivo
const NOMI = ['Marta', 'Ugo', 'Beppe', 'Pina', 'Sandro', 'Giulia', 'Carlo', 'Lara', 'Tommaso', 'Elena', 'Max', 'Rita', 'Piero', 'Anna', 'Dario']

// Le viste arrivano da un server che qui è sotto esame: il test le legge senza fidarsi dei tipi.
type V = Record<string, any>

const dorme = (ms: number) => new Promise(ok => setTimeout(ok, Math.max(0, ms)))

// ---- Il server di prova ----
let server: ChildProcess | null = null
let registro = '' // tutto ciò che wrangler ha stampato, riavvii compresi

async function risponde(): Promise<boolean> {
  try {
    return (await fetch(HTTP, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

async function attendiCondizione(cond: () => boolean | Promise<boolean>, perche: string, ms: number) {
  const limite = Date.now() + ms
  while (!(await cond())) {
    assert.ok(Date.now() < limite, `tempo scaduto: ${perche}`)
    await dorme(100)
  }
}

async function avviaServer(variabili: string[]) {
  assert.ok(!(await risponde()), `la porta ${PORTA} è già occupata`)
  const argomenti = ['dev', '--port', String(PORTA), '--ip', '127.0.0.1', '--persist-to', '.wrangler/prova', '--show-interactive-dev-session=false']
  for (const v of variabili) argomenti.push('--var', v)

  // wrangler sceglie da solo le sue porte interne: se un altro avvio sulla macchina gliele porta via, si riprova.
  for (let tentativo = 1; ; tentativo++) {
    const inizio = registro.length
    const processo = spawn(process.execPath, [WRANGLER, ...argomenti], {
      cwd: RADICE,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    })
    server = processo
    processo.stdout.on('data', d => (registro += d))
    processo.stderr.on('data', d => (registro += d))
    try {
      const pronto = async () => {
        assert.equal(processo.exitCode, null, 'wrangler si è fermato')
        assert.ok(!registro.includes('Address already in use', inizio), 'porta interna di wrangler occupata')
        return risponde()
      }
      await attendiCondizione(pronto, 'wrangler dev non risponde', 30 * 1000)
      return
    } catch (errore) {
      uccidiServer()
      if (tentativo === 3) throw errore
    }
  }
}

// Uccisione vera, senza chiusura ordinata: solo il processo avviato qui e i suoi figli.
function uccidiServer() {
  const pid = server?.pid
  server = null
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else process.kill(-pid, 'SIGKILL')
}

async function fermaServer() {
  uccidiServer()
  await attendiCondizione(async () => !(await risponde()), 'la porta non si è liberata', 15 * 1000)
}

process.on('exit', uccidiServer)

// Il costruttore stampa una riga a ogni avvio di una stanza già salvata: è così che si vede il risveglio dell'oggetto.
const avviiDi = (codice: string) => registro.split(`stanza avviata: ${codice}`).length - 1

// ---- C7: ogni stato pubblico raggiunge tutti i telefoni connessi entro 1 s dal primo arrivo ----
class Convergenza {
  telefoni: Set<Telefono>
  arrivi = new Map<string, { primo: number; ultimo: number; chi: Set<Telefono>; attesi: number }>()

  constructor(telefoni: Telefono[]) {
    this.telefoni = new Set(telefoni)
    for (const t of telefoni) t.c7 = this
  }

  togli(t: Telefono) {
    this.telefoni.delete(t)
    t.c7 = null
  }

  aggiungi(t: Telefono) {
    this.telefoni.add(t)
    t.c7 = this
  }

  annota(t: Telefono, v: V) {
    const chiave = `${v.f}/${v.barra}/${v.presenti}`
    const ora = performance.now()
    const arrivo = this.arrivi.get(chiave) ?? { primo: ora, ultimo: ora, chi: new Set<Telefono>(), attesi: this.telefoni.size }
    this.arrivi.set(chiave, arrivo)
    if (arrivo.chi.has(t)) return // una vista privata successiva con lo stesso stato pubblico non conta
    arrivo.ultimo = ora
    arrivo.chi.add(t)
  }

  verifica(): string {
    let massimo = 0
    for (const [chiave, a] of this.arrivi) {
      assert.ok(a.chi.size >= a.attesi, `C7: stato ${chiave} arrivato a ${a.chi.size} telefoni su ${a.attesi}`)
      massimo = Math.max(massimo, a.ultimo - a.primo)
    }
    assert.ok(massimo <= CONVERGENZA_MS, `C7: scarto di ${Math.round(massimo)} ms`)
    return `C7 ${this.arrivi.size} stati, scarto massimo ${Math.round(massimo)} ms`
  }
}

// ---- Il telefono: un socket e ciò che ha ricevuto ----
const tokenVisti = new Set<string>()
const violazioni: string[] = []

function controllaSegreti(t: Telefono, testo: string, v: V) {
  const segnala = (cosa: string) => violazioni.push(`${t.nome}, ${v.schermata}: ${cosa}`)
  for (const token of tokenVisti) if (testo.includes(token)) segnala('token nella vista')
  if (['sala', 'partita', 'riunione'].includes(v.schermata) && /[rR]uolo"/.test(testo)) segnala('ruolo nella vista')
  if (v.schermata === 'partita' && 'uccidiDa' in v && t.ruolo !== 'assassino') segnala('timer Uccidi a un civile')
  if (v.schermata === 'riunione' && testo.includes('"voti"')) segnala('voti nella vista')
}

class Telefono {
  nome: string
  token: string = crypto.randomUUID()
  ws: WebSocket | null = null
  storia: V[] = []
  cursore = 0 // viste già consumate da attendi: così non si perde una fase breve
  errore: string | null = null
  chiusura: number | null = null
  ruolo: string | null = null
  pong = 0
  ultimoSegnale = 0
  c7: Convergenza | null = null
  private battito: ReturnType<typeof setInterval> | undefined
  private attese = new Set<() => void>()

  constructor(nome: string) {
    this.nome = nome
    tokenVisti.add(this.token)
  }

  get v(): V {
    return this.storia[this.storia.length - 1]
  }

  private sveglia() {
    for (const prova of [...this.attese]) prova()
  }

  // Si risolve al primo messaggio del server, vista o rifiuto.
  apri(codice: string, { crea = false, nome = this.nome } = {}): Promise<void> {
    this.errore = null
    this.chiusura = null
    const query = new URLSearchParams({ token: this.token, nome })
    if (crea) query.set('crea', '1')
    const ws = new WebSocket(`${WS}/stanza/${codice}?${query}`)
    this.ws = ws
    this.ultimoSegnale = Date.now()
    clearInterval(this.battito)
    this.battito = setInterval(() => this.segnala(), PING_MS)

    // Un socket che non ha mai trasmesso nulla riceve la chiusura del server con 10 s di ritardo: il telefono si presenta subito.
    ws.onopen = () => this.segnala()

    return new Promise((ok, ko) => {
      const limite = setTimeout(() => ko(new Error(`${this.nome}: nessuna risposta aprendo ${codice}`)), 10 * 1000)
      ws.onmessage = e => {
        clearTimeout(limite)
        if (this.ws === ws) this.ricevi(String(e.data))
        ok()
      }
      ws.onclose = e => {
        clearTimeout(limite)
        ok()
        if (this.ws !== ws) return
        this.chiusura = e.code
        this.sveglia()
      }
    })
  }

  private ricevi(testo: string) {
    if (testo === 'pong') {
      this.pong++
      return
    }
    const messaggio = JSON.parse(testo)
    if (messaggio.errore) {
      this.errore = messaggio.errore
    } else {
      const v: V = messaggio.v
      if (v.schermata === 'ruolo') this.ruolo = v.ruolo
      controllaSegreti(this, testo, v)
      this.storia.push(v)
      this.c7?.annota(this, v)
    }
    this.sveglia()
  }

  aperto(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  segnala() {
    if (!this.aperto()) return
    this.ws?.send('ping')
    this.ultimoSegnale = Date.now()
  }

  invia(a: string, x?: unknown) {
    this.ws?.send(JSON.stringify({ a, x, f: this.v.f }))
    this.ultimoSegnale = Date.now()
  }

  // Batteria finita: nessun altro segnale e nessuna chiusura, il server non viene avvisato.
  spegni() {
    clearInterval(this.battito)
  }

  async chiudi() {
    this.spegni()
    this.ws?.close()
    await this.attendiChiusura()
  }

  // La prossima vista non ancora consumata che soddisfa cond. Vale anche l'ultima consumata, se lo stato è rimasto quello.
  attendi(cond: (v: V) => boolean, perche: string, ms = 5000): Promise<V> {
    return new Promise((ok, ko) => {
      const limite = setTimeout(() => {
        this.attese.delete(prova)
        const u = this.v
        ko(new Error(`${this.nome} aspettava ${perche}: ultima vista ${u?.schermata} f${u?.f}, errore ${this.errore}, chiusura ${this.chiusura}`))
      }, ms)
      const prova = () => {
        for (let i = Math.max(0, this.cursore - 1); i < this.storia.length; i++) {
          if (!cond(this.storia[i])) continue
          this.cursore = i + 1
          clearTimeout(limite)
          this.attese.delete(prova)
          ok(this.storia[i])
          return
        }
      }
      this.attese.add(prova)
      prova()
    })
  }

  attendiChiusura(ms = 5000): Promise<number> {
    return new Promise((ok, ko) => {
      const limite = setTimeout(() => {
        this.attese.delete(prova)
        ko(new Error(`${this.nome}: il socket non si è chiuso`))
      }, ms)
      const prova = () => {
        if (this.chiusura === null) return
        clearTimeout(limite)
        this.attese.delete(prova)
        ok(this.chiusura)
      }
      this.attese.add(prova)
      prova()
    })
  }
}

// ---- Mosse comuni dei bot ----
const id = (t: Telefono): number => t.v.io.id
const aspettaTutti = (telefoni: Telefono[], cond: (v: V) => boolean, perche: string, ms?: number) =>
  Promise.all(telefoni.map(t => t.attendi(cond, perche, ms)))
const esito = (v: V) => v.schermata === 'esito'
const inPartita = (v: V) => v.schermata === 'partita'

async function nuovaStanza(quanti: number) {
  const codice = generaCodice(Math.random)
  const telefoni = Array.from({ length: quanti }, (_, i) => new Telefono(NOMI[i] ?? `Ospite ${i}`))
  await telefoni[0].apri(codice, { crea: true })
  assert.equal(telefoni[0].errore, null, 'creazione della stanza')
  for (const t of telefoni.slice(1)) await t.apri(codice)
  await aspettaTutti(telefoni, v => v.presenti === quanti, 'tutti in sala')
  return { codice, telefoni }
}

async function iniziaPartita(telefoni: Telefono[], numeroTask: number, assassini: number) {
  const host = telefoni.find(t => t.v.io.host) as Telefono
  if (host.v.numeroTask !== numeroTask) {
    host.invia('impostaTask', numeroTask)
    await aspettaTutti(telefoni, v => v.numeroTask === numeroTask, 'numero task')
  }
  if (host.v.numeroAssassini !== assassini) {
    host.invia('impostaAssassini', assassini)
    await aspettaTutti(telefoni, v => v.numeroAssassini === assassini, 'numero assassini')
  }
  host.invia('start')
  await aspettaTutti(telefoni, v => v.schermata === 'ruolo', 'rivelazione')
  const cattivi = telefoni.filter(t => t.ruolo === 'assassino')
  const buoni = telefoni.filter(t => t.ruolo === 'civile')
  assert.equal(cattivi.length, assassini, 'numero di assassini')
  for (const t of telefoni) t.invia('ruoloVisto')
  await aspettaTutti(telefoni, inPartita, 'partita')
  const traguardo = Math.ceil((buoni.length * numeroTask) / 2)
  for (const t of telefoni) assert.equal(t.v.traguardo, traguardo, 'traguardo')
  return { cattivi, buoni }
}

async function convoca(chi: Telefono, tipo: 'report' | 'emergency', telefoni: Telefono[]) {
  chi.invia(tipo)
  await aspettaTutti(telefoni, v => v.schermata === 'riunione' && v.tipo === tipo, 'riunione')
}

// C9: dopo la scritta finale tutti in sala, ruoli svelati e poi azzerati, barra a zero.
async function attendiFine(telefoni: Telefono[], vincitore: string, motivo: string) {
  const viste = await aspettaTutti(telefoni, v => v.schermata === 'fine', 'fine partita')
  for (const v of viste) {
    assert.equal(v.vincitore, vincitore, 'vincitore')
    assert.equal(v.motivo, motivo, 'motivo')
    for (const t of telefoni) assert.equal(v.giocatori.find((g: V) => g.id === id(t))?.ruolo, t.ruolo, `ruolo svelato di ${t.nome}`)
  }
  const sale = await aspettaTutti(telefoni, v => v.schermata === 'sala', 'ritorno in sala')
  for (const v of sale) {
    assert.equal(v.barra, 0, 'barra azzerata')
    assert.equal(v.traguardo, 0, 'traguardo azzerato')
    assert.equal(v.presenti, telefoni.length, 'nessuno perso')
  }
  for (const t of telefoni) t.ruolo = null
  return viste[0]
}

// Tutti premono Esci: l'ultimo cancella la stanza. Un'uscita può chiudere la partita e cambiare f, quindi si ripete
// con la vista aggiornata finché ogni socket non è chiuso.
async function congeda(telefoni: Telefono[]) {
  await attendiCondizione(
    async () => {
      for (const t of telefoni) if (t.aperto()) t.invia('esci')
      await dorme(100)
      return telefoni.every(t => !t.aperto())
    },
    'qualcuno non riesce a uscire',
    5000,
  )
  for (const t of telefoni) t.spegni()
}

// ---- Scene ----
// Sei partite nella stessa stanza, una per ogni finale, con 15 telefoni che restano connessi.
async function serata(): Promise<string> {
  const { codice, telefoni } = await nuovaStanza(15)
  const c7 = new Convergenza(telefoni)

  // 1. Barra piena: valgono le spunte di tutti.
  let { cattivi, buoni } = await iniziaPartita(telefoni, 1, 1)
  for (const t of telefoni.slice(0, 7)) t.invia('spunta')
  const fine = await attendiFine(telefoni, 'civili', 'barra')
  assert.equal(fine.barra, 7, 'barra al traguardo')
  assert.equal(fine.scadenza - fine.ora, 333, 'SCALA_TEMPI:30 sulla scritta finale')

  // 2. L'unico assassino eliminato al voto.
  ;({ cattivi, buoni } = await iniziaPartita(telefoni, 4, 1))
  const colpevole = cattivi[0]
  await convoca(buoni[0], 'report', telefoni)
  for (const t of buoni) t.invia('vota', id(colpevole))
  colpevole.invia('vota', 'salta')
  const [fuori] = await aspettaTutti(telefoni, esito, 'esito')
  assert.equal(fuori.eliminatoId, id(colpevole), 'eliminato')
  assert.equal(fuori.eliminatoRuolo, 'assassino', 'ruolo svelato')
  assert.equal(fuori.vincitore, 'civili', 'vincitore annunciato')
  assert.equal(fuori.scadenza - fuori.ora, 267, "SCALA_TEMPI:30 sull'esito")
  await attendiFine(telefoni, 'civili', 'assassini')

  // 3. Due assassini con timer personali, poi maggioranza. Uccidi non produce messaggi per gli altri.
  ;({ cattivi, buoni } = await iniziaPartita(telefoni, 12, 2))
  const [primo, secondo] = cattivi
  const pronto: number = primo.v.uccidiDa
  assert.ok(pronto > Date.now(), 'Uccidi in attesa a inizio partita')
  assert.equal(buoni[0].v.uccidiDa, undefined, 'nessun timer per un civile')
  primo.invia('uccidi')
  buoni[0].invia('uccidi')
  await dorme(200)
  assert.equal(primo.v.uccidiDa, pronto, 'Uccidi prima del tempo')
  await dorme(pronto + 50 - Date.now())
  const visteAltrui = buoni[1].storia.length
  primo.invia('uccidi')
  await primo.attendi(v => v.uccidiDa > pronto, 'nuovo timer Uccidi')
  await dorme(100)
  assert.equal(secondo.v.uccidiDa, pronto, 'timer personale')
  assert.equal(buoni[1].storia.length, visteAltrui, 'Uccidi visibile agli altri')
  for (const t of buoni.slice(0, 11)) t.invia('sonoMorto')
  await attendiFine(telefoni, 'assassini', 'maggioranza')

  // 4. Parità, Salta in testa, Emergency in attesa, poi via gli assassini uno alla volta.
  ;({ cattivi, buoni } = await iniziaPartita(telefoni, 12, 2))
  const [x, y, ...resto] = telefoni
  const uccidiPrima: number = cattivi[0].v.uccidiDa
  await convoca(buoni[0], 'emergency', telefoni)
  x.invia('vota', id(y))
  y.invia('vota', id(x))
  for (const t of resto.slice(0, 6)) t.invia('vota', id(x))
  for (const t of resto.slice(6, 12)) t.invia('vota', id(y))
  resto[12].invia('vota', 'salta')
  const [pari] = await aspettaTutti(telefoni, esito, 'esito pari')
  assert.deepEqual([pari.parita, pari.eliminatoId, pari.salti], [true, null, 1], 'parità')
  assert.equal(pari.votanti.reduce((somma: number, g: V) => somma + g.voti, 0), 14, 'conteggio dei voti')
  await aspettaTutti(telefoni, inPartita, 'ritorno in partita')
  assert.ok(cattivi[0].v.uccidiDa > uccidiPrima, 'Uccidi riparte dopo la riunione')
  const f: number = buoni[1].v.f
  buoni[1].invia('emergency')
  await dorme(200)
  assert.equal(buoni[1].v.f, f, 'Emergency durante la sua attesa')

  await convoca(buoni[1], 'report', telefoni)
  for (const t of telefoni) t.invia('vota', 'salta')
  const [salto] = await aspettaTutti(telefoni, esito, 'esito con Salta')
  assert.deepEqual([salto.parita, salto.eliminatoId, salto.salti], [false, null, 15], 'Salta in testa')
  await aspettaTutti(telefoni, inPartita, 'ritorno in partita')

  for (const [i, c] of cattivi.entries()) {
    const vivi = telefoni.filter(t => t.v.io.vivo)
    await convoca(buoni[0], 'report', telefoni)
    for (const t of vivi) t.invia('vota', t === c ? 'salta' : id(c))
    const [via] = await aspettaTutti(telefoni, esito, 'esito')
    assert.equal(via.eliminatoRuolo, 'assassino', 'assassino eliminato')
    assert.equal(via.vincitore, i === 0 ? null : 'civili', 'vincitore a fine riunione')
    if (i === 0) await aspettaTutti(telefoni, inPartita, 'ritorno in partita')
  }
  await attendiFine(telefoni, 'civili', 'assassini')

  // 5. Uscite: chi riceve voti esce e si rivota, l'host esce e il ruolo passa, l'assassino esce e la partita finisce.
  ;({ cattivi, buoni } = await iniziaPartita(telefoni, 12, 1))
  const fuggitivo = buoni.find(t => !t.v.io.host) as Telefono
  const elettori = buoni.filter(t => t !== fuggitivo).slice(0, 3)
  await convoca(elettori[0], 'report', telefoni)
  for (const t of elettori) t.invia('vota', id(fuggitivo))
  await aspettaTutti(telefoni, v => v.votati === 3, 'tre voti')
  c7.togli(fuggitivo)
  fuggitivo.invia('esci')
  assert.equal(await fuggitivo.attendiChiusura(), 4001, 'chiusura dopo Esci')
  await aspettaTutti(elettori, v => v.rivota === true && v.mioVoto === null && v.votati === 3, 'voto da rifare')
  const rimasti = telefoni.filter(t => t !== fuggitivo)
  for (const t of rimasti) t.invia('vota', 'salta')
  await aspettaTutti(rimasti, esito, 'esito')
  await aspettaTutti(rimasti, inPartita, 'ritorno in partita')

  const usciti = [fuggitivo]
  const assassino = cattivi[0]
  const host = rimasti.find(t => t.v.io.host) as Telefono
  if (host !== assassino) {
    const erede = rimasti[(rimasti.indexOf(host) + 1) % rimasti.length]
    c7.togli(host)
    host.invia('esci')
    await host.attendiChiusura()
    await erede.attendi(v => v.io.host, 'nuovo host dopo Esci')
    usciti.push(host)
  }
  usciti.push(assassino)
  c7.togli(assassino)
  assassino.invia('esci')
  await assassino.attendiChiusura()
  await attendiFine(telefoni.filter(t => !usciti.includes(t)), 'civili', 'assassini')

  // 6. Chi è uscito rientra in sala. Sono morto durante il voto, poi barra piena.
  for (const t of usciti) {
    c7.aggiungi(t)
    await t.apri(codice)
    assert.equal(t.errore, null, 'rientro in sala')
  }
  await aspettaTutti(telefoni, v => v.presenti === 15, 'di nuovo in quindici')
  ;({ cattivi, buoni } = await iniziaPartita(telefoni, 2, 2))
  const tardivo = buoni[0]
  const contro = buoni.slice(1, 5)
  await convoca(contro[0], 'report', telefoni)
  tardivo.invia('vota', 'salta')
  for (const t of contro) t.invia('vota', id(tardivo))
  await aspettaTutti(telefoni, v => v.votati === 5, 'cinque voti')
  tardivo.invia('sonoMorto')
  const annullati = await aspettaTutti(contro, v => v.rivota === true && v.votati === 4, 'voti annullati')
  for (const v of annullati) {
    assert.equal(v.totale, 14, 'votanti dopo Sono morto')
    assert.deepEqual(v.fuori, [tardivo.nome], 'lista dei morti')
  }
  const vivi = telefoni.filter(t => t !== tardivo)
  for (const t of vivi) t.invia('vota', 'salta')
  await aspettaTutti(telefoni, esito, 'esito')
  await aspettaTutti(telefoni, inPartita, 'ritorno in partita')
  for (const t of vivi.slice(0, 13)) t.invia('spunta')
  await attendiFine(telefoni, 'civili', 'barra')

  const riassunto = c7.verifica()
  await congeda(telefoni)

  // L'ultimo che esce cancella la stanza.
  const dopo = new Telefono('Dopo')
  await dopo.apri(codice)
  assert.equal(dopo.errore, 'stanza-inesistente', 'stanza cancellata con l’ultimo Esci')
  return `6 partite, ${riassunto}`
}

// Due telefoni muoiono in riunione, uno senza chiudere il socket: il voto si chiude da solo a 45 s, senza Togli.
async function telefonoScarico(): Promise<string> {
  const { telefoni } = await nuovaStanza(6)
  const { buoni } = await iniziaPartita(telefoni, 4, 1)
  const [muto, chiuso] = buoni
  const altri = telefoni.filter(t => t !== muto && t !== chiuso)
  await convoca(altri[0], 'report', telefoni)

  muto.segnala()
  chiuso.segnala()
  const spento = Date.now()
  muto.spegni()
  await chiuso.chiudi()
  for (const t of altri) t.invia('vota', 'salta')
  await aspettaTutti(altri, v => v.votati === 4 && v.totale === 6, 'quattro voti su sei')

  await dorme(ASSENTE_VOTO_MS - 2000)
  assert.equal(altri[0].v.schermata, 'riunione', 'il voto non si chiude prima del tempo')
  const [e] = await aspettaTutti(altri, esito, 'chiusura per assenza', 2000 + MARGINE_MS)
  const trascorso = Date.now() - spento
  assert.ok(trascorso >= ASSENTE_VOTO_MS - 300, `chiuso dopo soli ${trascorso} ms`)
  assert.equal(e.salti, 6, 'gli assenti valgono come Salta')
  await aspettaTutti(altri, inPartita, 'ritorno in partita')
  assert.equal(altri[0].v.presenti, 6, 'offline non è uscita')

  await chiuso.apri(telefoni[0].v.codice)
  await congeda(telefoni)
  return `chiuso dopo ${(trascorso / 1000).toFixed(1)} s`
}

// L'host sparisce: il ruolo passa al successivo connesso e al ritorno non torna.
async function hostOffline(): Promise<string> {
  const { codice, telefoni } = await nuovaStanza(4)
  const [host, erede] = telefoni
  host.segnala()
  const spento = Date.now()
  host.spegni()

  const v = await erede.attendi(v => v.io.host, 'passaggio host', OFFLINE_MS + GIRO_MASSIMO_MS + MARGINE_MS)
  const trascorso = Date.now() - spento
  assert.ok(trascorso >= OFFLINE_MS - 300, `passato dopo soli ${trascorso} ms`)
  const riga = v.giocatori.find((g: V) => g.id === id(host))
  assert.deepEqual([riga.host, riga.offline], [false, true], 'riga del vecchio host')

  await host.apri(codice)
  assert.equal(host.v.io.host, false, 'il vecchio host non torna tale')
  await erede.attendi(v => !v.giocatori?.find((g: V) => g.id === id(host))?.offline, 'di nuovo online', 2000)
  erede.invia('start')
  await aspettaTutti(telefoni, v => v.schermata === 'ruolo', 'partita avviata dal nuovo host')
  for (const t of telefoni) t.invia('ruoloVisto')
  await aspettaTutti(telefoni, inPartita, 'partita')
  await congeda(telefoni)
  return `passato dopo ${(trascorso / 1000).toFixed(1)} s`
}

// Togli rifiutato su chi è online, accettato su chi è offline, in sala e in riunione.
async function togli(): Promise<void> {
  const attendiOffline = (host: Telefono, bersaglio: Telefono) =>
    host.attendi(v => v.giocatori?.find((g: V) => g.id === id(bersaglio))?.offline, 'riga offline', OFFLINE_MS + GIRO_MASSIMO_MS + MARGINE_MS)

  const sala = await nuovaStanza(4)
  const [hostSala, bersaglioSala] = sala.telefoni
  hostSala.invia('togli', id(bersaglioSala))
  await dorme(300)
  assert.equal(hostSala.v.presenti, 4, 'Togli su chi è online')
  bersaglioSala.segnala()
  bersaglioSala.spegni()

  const riunione = await nuovaStanza(4)
  const { buoni } = await iniziaPartita(riunione.telefoni, 4, 1)
  const hostRiunione = riunione.telefoni[0]
  const bersaglio = buoni.find(t => t !== hostRiunione) as Telefono
  const altri = riunione.telefoni.filter(t => t !== bersaglio)
  await convoca(hostRiunione, 'report', riunione.telefoni)
  bersaglio.segnala()
  bersaglio.spegni()
  for (const t of altri) t.invia('vota', 'salta')

  await Promise.all([attendiOffline(hostSala, bersaglioSala), attendiOffline(hostRiunione, bersaglio)])
  hostSala.invia('togli', id(bersaglioSala))
  assert.equal(await bersaglioSala.attendiChiusura(), 4001, 'chiusura dopo Togli')
  await aspettaTutti(sala.telefoni.filter(t => t !== bersaglioSala), v => v.presenti === 3, 'tolto dalla sala')

  hostRiunione.invia('togli', id(bersaglio))
  assert.equal(await bersaglio.attendiChiusura(), 4001, 'chiusura dopo Togli')
  const [e] = await aspettaTutti(altri, esito, 'la riunione si chiude con Togli')
  assert.equal(e.salti, 3, 'voti rimasti')
  assert.equal(e.presenti, 3, 'tolto dalla riunione')
  await aspettaTutti(altri, inPartita, 'ritorno in partita')

  await congeda(sala.telefoni.filter(t => t !== bersaglioSala))
  await congeda(altri)
}

// Rientro col token su Rivelazione, in partita e durante il voto. Rientro con il nome solo dopo 30 s senza segnale.
async function rientri(): Promise<string> {
  const { codice, telefoni } = await nuovaStanza(5)
  const [host, a, b] = telefoni
  host.invia('start')
  await aspettaTutti(telefoni, v => v.schermata === 'ruolo', 'rivelazione')

  const ruolo = a.ruolo
  await a.chiudi()
  await a.apri(codice)
  assert.deepEqual([a.v.schermata, a.v.ruolo], ['ruolo', ruolo], 'il ruolo non letto si rivede')

  for (const t of telefoni) t.invia('ruoloVisto')
  await aspettaTutti(telefoni, inPartita, 'partita')
  await a.chiudi()
  await a.apri(codice)
  assert.equal(a.v.schermata, 'partita', 'il ruolo letto non riappare')

  await convoca(host, 'report', telefoni)
  a.invia('vota', 'salta')
  await aspettaTutti(telefoni, v => v.votati === 1, 'un voto')
  const visteDiB = b.storia.length
  await a.chiudi()
  await a.apri(codice)
  assert.deepEqual([a.v.schermata, a.v.mioVoto, a.v.votati], ['riunione', 'salta', 1], 'voto intatto dopo il rientro')
  await dorme(200)
  assert.equal(b.storia.length, visteDiB, 'un rientro rapido non cambia nulla per gli altri')

  // Stesso nome da un telefono prestato, con un altro token.
  b.segnala()
  const spento = Date.now()
  const idB = id(b)
  await b.chiudi()
  const prestato = new Telefono(b.nome)
  await prestato.apri(codice)
  assert.equal(prestato.errore, 'nome-usato', 'nome rifiutato con il posto ancora online')
  assert.equal(await prestato.attendiChiusura(), 4002, 'chiusura dopo il rifiuto')

  await dorme(spento + OFFLINE_MS - 2000 - Date.now())
  await prestato.apri(codice)
  assert.equal(prestato.errore, 'nome-usato', 'nome rifiutato prima dei 30 s')
  await prestato.attendiChiusura()

  await dorme(spento + OFFLINE_MS + 200 - Date.now())
  await prestato.apri(codice)
  const ripreso = Date.now() - spento
  assert.equal(prestato.errore, null, 'posto ripreso dopo 30 s')
  assert.equal(prestato.v.io.id, idB, 'stesso posto')
  assert.equal(prestato.v.schermata, 'riunione', 'stessa fase')

  await b.apri(codice)
  assert.equal(b.errore, 'nome-usato', 'il vecchio token non vale più')
  await b.attendiChiusura()

  await congeda(telefoni.filter(t => t !== b).concat(prestato))
  return `posto ripreso dopo ${(ripreso / 1000).toFixed(1)} s`
}

// Un secondo socket dello stesso giocatore chiude il primo, senza disturbare gli altri.
async function doppioSocket(): Promise<void> {
  const { telefoni } = await nuovaStanza(3)
  const [a, b, c] = telefoni
  const visteDiB = b.storia.length
  const seconda = new Telefono(a.nome)
  seconda.token = a.token
  await seconda.apri(a.v.codice)
  assert.equal(seconda.v.io.id, id(a), 'stesso posto')
  assert.equal(seconda.v.presenti, 3, 'nessun giocatore in più')
  assert.equal(await a.attendiChiusura(), 4000, 'il primo socket si chiude')
  await dorme(300)
  assert.equal(b.storia.length, visteDiB, 'nessuna vista inutile agli altri')
  seconda.invia('impostaTask', 7)
  await aspettaTutti([b, c], v => v.numeroTask === 7, 'il secondo socket comanda')
  await congeda([seconda, b, c])
}

// Nulla di ciò che arriva da fuori può far cadere l'oggetto o cambiare lo stato.
async function malformati(): Promise<string> {
  const { codice, telefoni } = await nuovaStanza(3)
  await iniziaPartita(telefoni, 4, 1)
  const [a, b, c] = telefoni
  const ws = a.ws as WebSocket
  const avvii = avviiDi(codice)
  const f: number = a.v.f
  const imbottita = (lunghezza: number, fase = f) => {
    const base = JSON.stringify({ a: 'spunta', f: fase, z: '' })
    return JSON.stringify({ a: 'spunta', f: fase, z: 'x'.repeat(lunghezza - base.length) })
  }
  const spazzatura = [
    'non è json', '{', '', ' ', 'null', 'true', '42', '"testo"', '[]', '[1,2,3]', '{}', '{"a":"vota"}',
    `{"a":"spunta","f":"${f}"}`, `{"a":"spunta","f":${f - 1}}`, `{"a":"spunta","f":null}`, `{"a":"boh","f":${f}}`,
    `{"a":{"b":1},"f":${f}}`, `{"a":["spunta"],"f":${f}}`, `{"a":"constructor","f":${f}}`, `{"a":"__proto__","f":${f}}`,
    `{"__proto__":{"a":"spunta","f":${f}}}`, `{"a":"start","f":${f}}`, `{"a":"impostaTask","x":1e309,"f":${f}}`,
    '['.repeat(1000), '{"a":'.repeat(200), imbottita(1025), imbottita(2048), imbottita(512 * 1024),
  ]
  // Uno ogni 60 ms: qui si provano i contenuti, il limite di ritmo ha la sua prova.
  for (const m of [...spazzatura, new Uint8Array([0, 255, 1, 2]), new Uint8Array(4096)]) {
    ws.send(m)
    await dorme(60)
  }
  await dorme(500)
  assert.equal(a.v.barra, 0, 'nessuna spunta passata tra gli scarti')
  assert.ok(a.aperto(), 'socket ancora aperto')

  // In riunione: voti falsificati.
  await convoca(b, 'report', telefoni)
  const fr: number = a.v.f
  const voti = [id(a), 9999, -1, 1.5, '1', null, true, [id(b)], { id: id(b) }, '__proto__', 'constructor', 'salta2']
  for (const x of voti) {
    ws.send(JSON.stringify({ a: 'vota', x, f: fr }))
    await dorme(60)
  }
  await dorme(300)
  assert.equal(a.v.votati, 0, 'voti falsificati')
  a.invia('togli', id(b))
  c.invia('togli', id(b))
  await dorme(200)
  assert.equal(a.v.presenti, 3, 'Togli falsificato')
  for (const t of telefoni) t.invia('vota', 'salta')
  await aspettaTutti(telefoni, esito, 'esito')
  await aspettaTutti(telefoni, inPartita, 'ritorno in partita')

  // Il limite è esattamente 1 KB, e dopo tutto questo l'oggetto gioca ancora.
  a.ws?.send(imbottita(1024, a.v.f))
  await aspettaTutti(telefoni, v => v.barra === 1, 'spunta da 1024 byte')
  assert.equal(avviiDi(codice), avvii, "l'oggetto non è mai ripartito")
  assert.ok(telefoni.every(t => t.aperto()), 'tutti i socket ancora aperti')
  await congeda(telefoni)
  return `${spazzatura.length + 2 + voti.length} messaggi scartati`
}

// Chi inonda viene staccato con un codice da cui il telefono si riprende: gli altri non se ne accorgono e il posto resta suo.
async function inondazione(): Promise<string> {
  const { codice, telefoni } = await nuovaStanza(3)
  const [a, b, c] = telefoni
  const posto = id(a)
  const avvii = avviiDi(codice)
  const quanti = 200
  for (let i = 0; i < quanti; i++) a.ws?.send(i % 2 ? 'x' : JSON.stringify({ f: -1, a: 'start' }))
  assert.equal(await a.attendiChiusura(), 1008, 'chiusura per troppi messaggi')
  assert.ok(b.aperto() && c.aperto(), 'gli altri restano collegati')

  await a.apri(codice)
  assert.equal(a.errore, null, 'il telefono rientra')
  assert.equal(id(a), posto, 'stesso posto')

  // I comandi di un dito veloce, 15 al secondo, non fanno scattare il limite.
  for (let x = 2; x < 32; x++) {
    a.invia('impostaTask', x)
    await dorme(66)
  }
  await aspettaTutti(telefoni, v => v.numeroTask === 31, 'comandi rapidi tutti applicati')
  assert.ok(a.aperto(), 'il dito veloce resta collegato')
  assert.equal(avviiDi(codice), avvii, "l'oggetto non è mai ripartito")
  await congeda(telefoni)
  return `${quanti} messaggi di fila, poi 30 comandi a 15 al secondo`
}

// I telefoni di una festa escono dallo stesso IP: un calo di rete li riporta tutti insieme, e il tetto non deve toccarli.
async function ritornoInsieme(): Promise<string> {
  const { codice, telefoni } = await nuovaStanza(15)
  const ids = telefoni.map(id)
  const giri = 4
  for (let giro = 0; giro < giri; giro++) {
    await Promise.all(telefoni.map(t => t.chiudi()))
    await Promise.all(telefoni.map(t => t.apri(codice)))
    for (const [i, t] of telefoni.entries()) {
      assert.equal(t.errore, null, `${t.nome} rientra al giro ${giro}`)
      assert.ok(t.aperto(), `${t.nome} collegato al giro ${giro}`)
      assert.equal(t.v.io.id, ids[i], `${t.nome} riprende il suo posto`)
    }
  }
  await congeda(telefoni)
  return `${giri} giri da 15 rientri simultanei, tutti riusciti`
}

// Oltre il tetto il tentativo si ferma nel Worker con un 429, che per il telefono è un socket caduto: riprova da solo.
async function tettoTentativi(massimo: number): Promise<string> {
  const quanti = massimo + 10
  let arrivati = 0
  let fermati = 0
  for (let i = 0; i < quanti; i++) {
    const t = new Telefono('Scansione')
    await t.apri(generaCodice(Math.random))
    t.spegni()
    if (t.errore === 'stanza-inesistente') arrivati++
    else if (t.errore === null) fermati++
  }
  assert.equal(arrivati, massimo, 'tentativi arrivati alla stanza')
  assert.equal(fermati, quanti - massimo, 'tentativi fermati prima della stanza')
  assert.ok(!registro.includes('Uncaught'), 'nessun errore dal 429')
  return `${arrivati} arrivati, ${fermati} fermati`
}

// Ogni rifiuto arriva come messaggio su un socket accettato, poi il socket si chiude.
async function rifiuti(): Promise<void> {
  const prova = async (codice: string, atteso: string, opzioni: { crea?: boolean; nome?: string } = {}, token?: string) => {
    const t = new Telefono(opzioni.nome ?? 'Bot')
    if (token) t.token = token
    await t.apri(codice, opzioni)
    assert.equal(t.errore, atteso, `${codice}: ${atteso}`)
    assert.equal(await t.attendiChiusura(), 4002, `${atteso}: chiusura`)
    t.spegni()
  }

  for (const codice of ['ABCD', 'ABCDEF', 'ABCDI', 'ABCD0', 'ABCDO', 'abcde', 'ABC%20D', '']) await prova(codice, 'codice-non-valido', { crea: true })

  const libero = generaCodice(Math.random)
  await prova(libero, 'stanza-inesistente')
  await prova(libero, 'nome-vuoto', { crea: true, nome: '   ' })
  await prova(libero, 'stanza-inesistente') // la stanza rifiutata non è rimasta salvata

  const { codice, telefoni } = await nuovaStanza(3)
  await prova(codice, 'codice-occupato', { crea: true })
  await prova(codice, 'nome-vuoto', { nome: '' })
  await prova(codice, 'nome-usato', { nome: ' mArTa ' })

  // Chi crea e ripete crea=1 perché il primo tentativo è caduto rientra nella propria stanza.
  const [creatore] = telefoni
  await creatore.apri(codice, { crea: true })
  assert.equal(creatore.errore, null, 'crea=1 ripetuto da chi è già dentro')
  assert.equal(creatore.v.io.host, true, 'resta host')

  await iniziaPartita(telefoni, 4, 1)
  await prova(codice, 'partita-in-corso', { nome: 'Ritardataria' })
  await congeda(telefoni)

  const piena = await nuovaStanza(MAX_GIOCATORI)
  await prova(piena.codice, 'stanza-piena', { nome: 'Ventunesimo' })
  await congeda(piena.telefoni)

  for (const percorso of ['/', '/stanza/ABCDE', '/altro']) {
    const risposta = await fetch(HTTP + percorso)
    assert.equal(risposta.status, 200, `salute su ${percorso}`)
    assert.match(await risposta.text(), /server attivo/, `salute su ${percorso}`)
  }
}

// ---- Scene con il processo ucciso, in sequenza perché fermano tutte le stanze ----
type Tavolo = { codice: string; telefoni: Telefono[] }

async function s12(): Promise<Tavolo> {
  const { codice, telefoni } = await nuovaStanza(15)
  const { buoni } = await iniziaPartita(telefoni, 12, 2)
  const bersaglio = telefoni[14]
  const votanti = telefoni.slice(0, 9)
  await convoca(buoni[0], 'report', telefoni)
  for (const t of votanti) t.invia('vota', id(bersaglio))
  await aspettaTutti(telefoni, v => v.votati === 9, 'nove voti')

  const ids = telefoni.map(id)
  const f: number = telefoni[0].v.f
  const avvii = avviiDi(codice)
  await fermaServer()

  // Fermo oltre la soglia del voto: al riavvio tutti risultano muti da più di 45 s, e il voto non deve chiudersi per questo.
  await dorme(ASSENTE_VOTO_MS + 5000)
  await avviaServer(['GIRO_MS:15000'])
  await attendiCondizione(() => avviiDi(codice) > avvii, "l'allarme non ha risvegliato la stanza", 20 * 1000)
  await dorme(500)

  await Promise.all(telefoni.map(t => t.apri(codice)))
  for (const [i, t] of telefoni.entries()) {
    assert.equal(t.errore, null, `${t.nome} rientra`)
    assert.equal(t.v.io.id, ids[i], `${t.nome} riprende il suo posto`)
    assert.deepEqual([t.v.schermata, t.v.f, t.v.votati, t.v.totale], ['riunione', f, 9, 15], `riunione intatta per ${t.nome}`)
    assert.equal(t.v.mioVoto, i < 9 ? id(bersaglio) : null, `voto di ${t.nome}`)
  }

  const c7 = new Convergenza(telefoni)
  for (const t of telefoni.slice(9)) t.invia('vota', 'salta')
  const [e] = await aspettaTutti(telefoni, esito, 'esito dopo il riavvio')
  assert.equal(e.eliminatoId, id(bersaglio), 'eliminato con i voti di prima del riavvio')
  assert.equal(e.eliminatoRuolo, bersaglio.ruolo, 'ruolo intatto')
  assert.equal(e.salti, 6, 'Salta')
  assert.equal(e.votanti.find((g: V) => g.id === id(bersaglio)).voti, 9, 'voti ricevuti')
  await aspettaTutti(telefoni, inPartita, 'ritorno in partita')
  c7.verifica()
  for (const t of telefoni) t.c7 = null
  return { codice, telefoni }
}

// Sessanta secondi di silenzio con il giro allungato, così l'oggetto si iberna davvero tra un giro e l'altro.
async function s13({ codice, telefoni }: Tavolo): Promise<string> {
  const vivi = telefoni.filter(t => t.v.io.vivo)
  const muto = vivi.find(t => !t.v.io.host) as Telefono // se tacesse l'host, il suo passaggio cambierebbe due viste
  const parlanti = vivi.filter(t => t !== muto)
  muto.segnala()
  await dorme(100)
  muto.spegni()

  const viste = telefoni.map(t => t.storia.length)
  const pong = parlanti[0].pong
  const avvii = avviiDi(codice)
  await dorme(60 * 1000)

  assert.deepEqual(telefoni.map(t => t.storia.length), viste, 'viste trasmesse senza cambiamenti')
  assert.ok(parlanti[0].pong - pong >= 5, `solo ${parlanti[0].pong - pong} pong nel silenzio`)
  const risvegli = avviiDi(codice) - avvii
  assert.ok(risvegli >= 2, `l'oggetto non si è ibernato: ${risvegli} risvegli`)

  const c7 = new Convergenza(telefoni)
  const barra: number = telefoni[0].v.barra
  parlanti[0].invia('spunta')
  await aspettaTutti(telefoni, v => v.barra === barra + 1, 'spunta dopo il silenzio', CONVERGENZA_MS)

  await convoca(parlanti[0], 'report', telefoni)
  const offline = parlanti[0].v.giocatori.filter((g: V) => g.offline).map((g: V) => g.nome)
  assert.deepEqual(offline, [muto.nome], 'presenze lette dopo il silenzio')
  for (const t of parlanti) t.invia('vota', 'salta')
  const [e] = await aspettaTutti(telefoni, esito, 'esito dopo il silenzio')
  assert.equal(e.salti, vivi.length, 'chi è muto da oltre 45 s vale come Salta')
  await aspettaTutti(telefoni, inPartita, 'ritorno in partita')
  c7.verifica()

  // La scritta finale svela i ruoli di tutti: devono essere quelli assegnati prima del riavvio.
  for (const t of parlanti) if (t.ruolo === 'civile') t.invia('sonoMorto')
  await attendiFine(telefoni, 'assassini', 'maggioranza')
  await congeda(telefoni)
  return `${risvegli} risvegli in 60 s, ${parlanti[0].pong - pong} pong, nessuna vista inutile`
}

// La fine dell'esito cade mentre il server è fermo: deve scattare al riavvio, prima che rientri qualcuno.
async function scadenzaPassata(): Promise<void> {
  const { codice, telefoni } = await nuovaStanza(3)
  await iniziaPartita(telefoni, 4, 1)
  await convoca(telefoni[0], 'report', telefoni)
  for (const t of telefoni) t.invia('vota', 'salta')
  const [e] = await aspettaTutti(telefoni, esito, 'esito')
  assert.equal(e.scadenza - e.ora, RESULT_MS, 'senza SCALA_TEMPI i tempi sono reali')

  const avvii = avviiDi(codice)
  await fermaServer()
  await dorme(e.scadenza + 500 - Date.now())
  await avviaServer([])
  await attendiCondizione(() => avviiDi(codice) > avvii, "l'allarme scaduto non è scattato", 20 * 1000)
  await dorme(300)

  await Promise.all(telefoni.map(t => t.apri(codice)))
  for (const t of telefoni) assert.deepEqual([t.v.schermata, t.v.f], ['partita', e.f + 1], `${t.nome} dopo la scadenza`)
  await congeda(telefoni)
}

// ---- Esecuzione ----
const esiti: { nome: string; ok: boolean; secondi: number; nota: string }[] = []

async function prova<T>(nome: string, corpo: () => Promise<T>): Promise<T | null> {
  const inizio = Date.now()
  const annota = (ok: boolean, nota: string) => {
    esiti.push({ nome, ok, secondi: Math.round((Date.now() - inizio) / 1000), nota })
    console.log(`${ok ? 'ok     ' : 'FALLITA'} ${nome}${nota ? `: ${nota}` : ''}`)
  }
  try {
    const risultato = await corpo()
    annota(true, typeof risultato === 'string' ? risultato : '')
    return risultato
  } catch (e) {
    annota(false, e instanceof Error ? e.message : String(e))
    return null
  }
}

// Un bot bloccato non deve lasciare il test appeso per sempre.
const limite = setTimeout(() => {
  console.error('Tempo massimo superato')
  process.exit(1)
}, 10 * 60 * 1000)
limite.unref()

console.log(`Avvio di wrangler dev sulla porta ${PORTA}...`)
await avviaServer(['SCALA_TEMPI:30']).catch(errore => {
  console.error(registro.slice(-2000))
  throw errore
})

await Promise.all([
  prova('Serata completa con 15 telefoni e C7', serata),
  prova('Telefono scarico: il voto si chiude da solo', telefonoScarico),
  prova('Host offline: il ruolo passa e non torna', hostOffline),
  prova('Togli in sala e in riunione', togli),
  prova('Rientro con token e con nome', rientri),
  prova('Doppio socket', doppioSocket),
  prova('Messaggi malformati', malformati),
  prova('Inondazione: staccato solo chi inonda', inondazione),
  prova('15 telefoni che tornano insieme', ritornoInsieme),
  prova('Rifiuti e salute', rifiuti),
])

const tavolo = await prova('S12 processo ucciso in riunione: 15 rientri, voti intatti', s12)
if (tavolo) await prova('S13 oggetto ibernato: 60 s di silenzio senza perdite', () => s13(tavolo))
if (!server) await avviaServer([])
await prova('S12 scadenza passata a server fermo', scadenzaPassata)

// In coda e con un server a parte: tutte le prove escono dallo stesso IP, e un tetto basso le fermerebbe.
await prova('Tetto ai tentativi per IP', async () => {
  await fermaServer()
  await avviaServer(['TENTATIVI_MAX:25'])
  return tettoTentativi(25)
})

await prova('C1 nessun segreto nelle viste', async () => assert.deepEqual(violazioni.slice(0, 5), []))
await prova('Nessun errore nel registro di wrangler', async () => {
  const errori = registro.split('\n').filter(riga => /Uncaught|messaggio scartato|\[ERROR\]|internal error/i.test(riga))
  assert.deepEqual(errori.slice(0, 5), [])
})

await fermaServer()

const fallite = esiti.filter(e => !e.ok)
console.log(`\n${esiti.length - fallite.length} prove riuscite su ${esiti.length}`)
for (const e of esiti) console.log(`${e.ok ? 'ok' : 'NO'}  ${String(e.secondi).padStart(3)} s  ${e.nome}`)
if (fallite.length) console.log(`\nUltime righe di wrangler:\n${registro.split('\n').slice(-20).join('\n')}`)
process.exit(fallite.length ? 1 : 0)
