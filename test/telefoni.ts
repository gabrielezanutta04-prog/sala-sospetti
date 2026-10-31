// Prova dei telefoni, `npm run test:telefoni`: tre Chrome veri in emulazione mobile con il touch e dodici bot WebSocket.
// Si gioca una partita intera sul sito compilato, contro un wrangler dev avviato qui, e si guarda ciò che vede chi gioca:
// stesso HTML per civile e assassino, pressione lunga con tocchi veri, nessuno sbordo a nessuna misura, console pulita.
//
// Usa solo le porte 8788 e 3100 e .wrangler/prova: le istanze dell'utente sulla 3000 e sulla 8787 non vengono toccate,
// e si fermano solo i processi avviati da questo file, per PID. Gli screenshot finiscono in test/risultati/.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import type { Browser, CDPSession, Page } from 'playwright-core'
import { encode } from 'uqr'
import { LONG_PRESS_MS, TASKS_DEFAULT, generaCodice } from '../gioco/regole.ts'

const PORTA_SERVER = 8788
const PORTA_SITO = 3100
const HTTP = `http://127.0.0.1:${PORTA_SERVER}`
const WS_BOT = `ws://127.0.0.1:${PORTA_SERVER}`
const WS_SITO = `ws://localhost:${PORTA_SERVER}`
const SITO = `http://localhost:${PORTA_SITO}`
const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..')
const RISULTATI = join(RADICE, 'test', 'risultati')
const WRANGLER = join(RADICE, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const NEXT = join(RADICE, 'node_modules', 'next', 'dist', 'bin', 'next')

const MISURE: [number, number][] = [
  [320, 568],
  [360, 640],
  [400, 800], // la prova a 400 px richiesta da CLAUDE.md
  [640, 360],
  [768, 1024],
  [1280, 800],
]
const TELEFONO = { width: 400, height: 800 }
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'
const PRESSA_MS = LONG_PRESS_MS + 200
const PING_MS = 10 * 1000
const OFFLINE_ATTESA_MS = 50 * 1000 // 30 s di soglia più il giro delle presenze da 10 s

// Nomi scomodi di proposito: i 16 caratteri più larghi, spazi, emoji.
const NOMI_TELEFONI = ['Massimiliano Ros', 'Anna', 'Dario']
const NOMI_BOT = ['Marta', 'Ugo', 'Beppe', 'Pina', 'Sandro', 'Giulia', 'Carlo', 'WWWWWWWWWWWWWWWW', 'Tommaso', 'Elena 😀', 'Rita', 'Maria Antonietta']

// Le viste arrivano da un server che qui è sotto esame: il test le legge senza fidarsi dei tipi.
type V = Record<string, any>
type Ruolo = string | null

const dorme = (ms: number) => new Promise(ok => setTimeout(ok, Math.max(0, ms)))

async function attendi(cond: () => boolean | Promise<boolean>, perche: string, ms = 5000) {
  const limite = Date.now() + ms
  while (!(await cond())) {
    assert.ok(Date.now() < limite, `tempo scaduto: ${perche}`)
    await dorme(25)
  }
}

// ---- Il registro dei difetti: un difetto non ferma la partita, così una corsa sola li mostra tutti ----
const difetti: string[] = []
const conti = { confronti: 0, misure: 0, foto: 0 }

function segnala(testo: string) {
  difetti.push(testo)
  console.log(`  DIFETTO ${testo}`)
}

const passo = (testo: string) => console.log(`- ${testo}`)

// ---- Sito compilato, su un piccolo server statico ----
function compilaSito() {
  const build = spawnSync(process.execPath, [NEXT, 'build'], {
    cwd: RADICE,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PAGES_BASE_PATH: '', NEXT_TELEMETRY_DISABLED: '1' },
  })
  assert.equal(build.status, 0, `next build non riuscito:\n${build.stdout}\n${build.stderr}`)
}

const TIPI: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function serviSito(): Promise<Server> {
  const cartella = join(RADICE, 'out')
  const sito = createServer((richiesta, risposta) => {
    const percorso = decodeURIComponent(new URL(richiesta.url ?? '/', SITO).pathname)
    const file = join(cartella, percorso.endsWith('/') ? `${percorso}index.html` : percorso)
    if (!file.startsWith(cartella) || !existsSync(file) || !statSync(file).isFile()) {
      risposta.writeHead(404).end()
      return
    }
    risposta.writeHead(200, { 'Content-Type': TIPI[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(risposta)
  })
  return new Promise((ok, ko) => {
    sito.once('error', ko)
    sito.listen(PORTA_SITO, 'localhost', () => ok(sito))
  })
}

// ---- Il server di prova ----
let server: ChildProcess | null = null
let registro = ''

async function risponde(): Promise<boolean> {
  try {
    return (await fetch(HTTP, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

function fermaServer() {
  const pid = server?.pid
  server = null
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else process.kill(-pid, 'SIGKILL')
}

process.on('exit', fermaServer)

async function avviaServer() {
  assert.ok(!(await risponde()), `la porta ${PORTA_SERVER} è già occupata`)
  const argomenti = ['dev', '--port', String(PORTA_SERVER), '--ip', '127.0.0.1', '--persist-to', '.wrangler/prova', '--var', 'SCALA_TEMPI:30', '--show-interactive-dev-session=false']

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
      await attendi(pronto, 'wrangler dev non risponde', 30 * 1000)
      return
    } catch (errore) {
      fermaServer()
      if (tentativo === 3) throw errore
    }
  }
}

// ---- I bot: un socket, l'ultima vista, nient'altro. Fanno solo quello che dice il copione ----
class Bot {
  nome: string
  token: string = crypto.randomUUID()
  ws: WebSocket | null = null
  v: V | null = null
  ruolo: Ruolo = null
  private battito: ReturnType<typeof setInterval> | undefined

  constructor(nome: string) {
    this.nome = nome
  }

  get vivo(): boolean {
    return this.v?.io.vivo ?? false
  }

  apri(codice: string): Promise<void> {
    const query = new URLSearchParams({ token: this.token, nome: this.nome })
    const ws = new WebSocket(`${WS_BOT}/stanza/${codice}?${query}`)
    this.ws = ws
    // Un socket che non ha mai trasmesso nulla riceve la chiusura del server con 10 s di ritardo: il bot si presenta subito.
    ws.onopen = () => this.segnala()
    this.battito = setInterval(() => this.segnala(), PING_MS)
    return new Promise((ok, ko) => {
      const limite = setTimeout(() => ko(new Error(`${this.nome}: nessuna risposta dalla stanza ${codice}`)), 10 * 1000)
      ws.onmessage = e => {
        clearTimeout(limite)
        if (e.data !== 'pong') this.ricevi(String(e.data))
        ok()
      }
    })
  }

  private ricevi(testo: string) {
    const { v, errore } = JSON.parse(testo)
    assert.ok(!errore, `${this.nome} rifiutato: ${errore}`)
    if (v.schermata === 'ruolo') this.ruolo = v.ruolo
    this.v = v
  }

  private segnala() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping')
  }

  invia(a: string, x?: unknown) {
    this.ws?.send(JSON.stringify({ a, x, f: this.v?.f }))
  }

  // Batteria finita: nessun altro segnale e nessuna chiusura.
  spegni() {
    clearInterval(this.battito)
  }

  chiudi() {
    this.spegni()
    this.ws?.close()
  }

  attendi(cond: (v: V) => boolean, perche: string, ms = 5000) {
    return attendi(() => this.v !== null && cond(this.v), `${this.nome} aspettava ${perche}, ultima vista ${this.v?.schermata}`, ms)
  }

  attendiSchermata(schermata: string) {
    return this.attendi(v => v.schermata === schermata, schermata)
  }
}

// ---- Funzioni eseguite dentro il browser ----

// Prima del sito. La rete resta quella vera di Chrome; in più il test può fermare un telefono su una schermata, perché con
// la scala 30 esito e fine durano 0,3 s, può togliergli la rete e può fargli perdere i comandi lasciando passare i ping.
// Le viste trattenute arrivano tutte, in ordine, a riprendi.
function spia() {
  const w = window as any
  const Vero = w.WebSocket
  const coda: [EventTarget, string][] = []
  let fermo = false

  w.__ferma = []
  w.__riprendi = () => {
    fermo = false
    while (!fermo && coda.length) {
      const [ws, data] = coda.shift() as [EventTarget, string]
      ws.dispatchEvent(new MessageEvent('message', { data }))
    }
  }

  w.WebSocket = class extends Vero {
    constructor(...dati: unknown[]) {
      if (w.__giu) throw new Error('senza rete')
      super(...dati)
      w.__socket = this
      this.addEventListener('message', (e: MessageEvent) => {
        if (e.data === 'pong') return
        if (fermo) {
          e.stopImmediatePropagation()
          coda.push([this as unknown as EventTarget, e.data])
          return
        }
        const schermata = JSON.parse(e.data).v?.schermata
        if (w.__ferma.includes(schermata)) {
          fermo = true
          w.__ferma = w.__ferma.filter((x: string) => x !== schermata)
        }
      })
    }

    send(dato: string) {
      if (!w.__perdi || dato === 'ping') super.send(dato)
    }
  }
}

// HTML di #schermo con gli elementi privati svuotati: è ciò che deve restare uguale tra civile e assassino.
function htmlPubblico(togli: string | null): string {
  const copia = document.getElementById('schermo')?.cloneNode(true) as HTMLElement
  for (const el of copia.querySelectorAll('[data-privato]')) el.innerHTML = ''
  if (togli) for (const el of copia.querySelectorAll(togli)) el.remove()
  return copia.outerHTML
}

function htmlGrezzo(): string {
  return document.getElementById('schermo')?.outerHTML ?? ''
}

function osserva() {
  const w = window as any
  w.__mutazioni = 0
  w.__osservatore?.disconnect()
  w.__osservatore = new MutationObserver(lista => (w.__mutazioni += lista.length))
  w.__osservatore.observe(document.getElementById('schermo'), { subtree: true, childList: true, attributes: true, characterData: true })
}

// Le animazioni d'entrata restano registrate anche finite: contano solo quelle ancora in corso.
function animazioniInCorso(): number {
  return document.getAnimations().filter(a => a.playState === 'running').length
}

// Le animazioni d'entrata ingrandiscono i riquadri: si misura a schermo fermo.
function assestato(): Promise<unknown> {
  const finite = document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
  return Promise.allSettled(finite.map(a => a.finished))
}

// Tutto ciò che sporge di lato, sia che faccia scorrere la pagina sia che venga tagliato da un overflow nascosto.
function sporgenze(): string[] {
  const larghezza = window.innerWidth
  const problemi: string[] = []
  const nome = (el: Element) => `${el.localName}${el.getAttribute('class') ? `.${el.getAttribute('class')?.split(' ').join('.')}` : ''}`

  for (const el of [document.documentElement, document.body]) {
    if (el.scrollWidth > larghezza) problemi.push(`${nome(el)} scrollWidth ${el.scrollWidth}`)
  }
  for (const el of document.querySelectorAll('#schermo, .corpo, .piede, .barra-alta, .barra-verde, .griglia, .velo, .dialogo, .fascicolo, .scheda, .invito, .impostazioni, .task, .uccidi')) {
    if (el.scrollWidth > el.clientWidth) problemi.push(`${nome(el)} scrollWidth ${el.scrollWidth} oltre ${el.clientWidth}`)
  }
  for (const el of document.querySelectorAll('#schermo *, .avvisi *')) {
    if (el.closest('svg') && el.localName !== 'svg') continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.left < -0.5 || r.right > larghezza + 0.5)) problemi.push(`${nome(el)} sporge: da ${Math.round(r.left)} a ${Math.round(r.right)}`)
  }
  for (const el of document.querySelectorAll('.tasto')) {
    if (el.scrollWidth > el.clientWidth) problemi.push(`testo tagliato sul tasto «${el.textContent}»`)
  }
  // I tasti del gioco: quelli piccoli a due passi sono la causa dei tocchi sbagliati.
  for (const el of document.querySelectorAll('.tasto, .regole summary')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.width < 43.5 || r.height < 43.5)) problemi.push(`tasto piccolo «${el.textContent}»: ${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  for (const el of document.querySelectorAll('.cella .tasto')) {
    const cella = el.closest('.cella')?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (cella && (r.top < cella.top || r.bottom > cella.bottom)) problemi.push(`il tasto «${el.textContent}» esce dalla sua cella`)
  }
  return problemi
}

// Ciò che corrisponde al selettore e non si può toccare senza scorrere: fuori schermo o coperto da altro.
function nonAVista(selettore: string): string[] {
  const nascosti: string[] = []
  for (const el of document.querySelectorAll(selettore)) {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const sopra = document.elementFromPoint(x, y)
    const dentro = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth
    if (!dentro || !sopra || !(el === sopra || el.contains(sopra))) nascosti.push(`${el.textContent} (${Math.round(r.top)}-${Math.round(r.bottom)})`)
  }
  return nascosti
}

function altezzaCorpo(): number {
  return document.querySelector('.corpo')?.clientHeight ?? 0
}

// ---- Un telefono vero ----
class Telefono {
  nome: string
  etichetta: string
  pagina!: Page
  cdp!: CDPSession
  ruolo: Ruolo = null
  vivo = true
  errori: string[] = []
  avvisi = new Set<string>()

  constructor(nome: string, etichetta: string) {
    this.nome = nome
    this.etichetta = etichetta
  }

  async accendi(browser: Browser, tema: 'dark' | 'light') {
    const contesto = await browser.newContext({
      viewport: TELEFONO,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: 'it-IT',
      colorScheme: tema,
      userAgent: MOBILE_UA,
    })
    await contesto.addInitScript(spia)
    this.pagina = await contesto.newPage()
    this.cdp = await contesto.newCDPSession(this.pagina)
    this.pagina.on('pageerror', e => this.errori.push(String(e)))
    this.pagina.on('console', m => {
      if (m.type() === 'error') this.errori.push(m.text())
      if (m.type() === 'warning') this.avvisi.add(m.text())
    })
  }

  aspetta(schermata: string, ms = 10 * 1000) {
    return this.pagina.locator(`#schermo[data-schermata="${schermata}"]`).waitFor({ timeout: ms })
  }

  tocca(nome: string) {
    return this.pagina.getByRole('button', { name: nome, exact: true }).tap()
  }

  async ricarica(schermata: string) {
    await this.pagina.reload({ waitUntil: 'load' })
    await this.aspetta(schermata)
  }

  scrivi(testo: string) {
    return this.pagina.getByPlaceholder('Come ti chiamano gli altri?').fill(testo)
  }

  async leggiRuolo() {
    const classe = await this.pagina.locator('.fascicolo').getAttribute('class')
    this.ruolo = classe?.includes('assassino') ? 'assassino' : 'civile'
    this.vivo = true
  }

  // Tocco vero via CDP sul codice stanza, il punto della barra che premerebbe chiunque.
  async premi(ms: number) {
    const area = await this.pagina.locator('.ba-stanza').boundingBox()
    assert.ok(area, 'barra in alto non trovata')
    const punto = { x: area.x + area.width / 2, y: area.y + area.height / 2 }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [punto] })
    await dorme(ms)
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  riquadri() {
    return this.pagina.locator('.uccidi').count()
  }

  async attendiRiquadri(quanti: number, quando: string) {
    try {
      await attendi(async () => (await this.riquadri()) === quanti, 'riquadro', 1500)
    } catch {
      segnala(`${quando}: ${this.nome} ha ${await this.riquadri()} riquadri Uccidi invece di ${quanti}`)
    }
  }

  ferma(schermate: string[]) {
    return this.pagina.evaluate(s => ((window as any).__ferma = s), schermate)
  }

  riprendi() {
    return this.pagina.evaluate(() => (window as any).__riprendi())
  }

  // I comandi che partono finché dura perdi non arrivano al server. I ping sì: il socket sembra sano.
  perdi(si: boolean) {
    return this.pagina.evaluate(valore => ((window as any).__perdi = valore), si)
  }

  // Una schermata ferma a tutte le misure: niente sbordi, tasti del piede raggiungibili, una foto per misura.
  async giro(nome: string) {
    await this.pagina.locator('.avviso').waitFor({ state: 'detached' }) // un avviso coprirebbe i tasti solo per 2 s
    for (const [width, height] of MISURE) {
      const dove = `${nome}, ${this.etichetta}, ${width}x${height}`
      await this.pagina.setViewportSize({ width, height })
      await this.pagina.evaluate(assestato)
      for (const problema of await this.pagina.evaluate(sporgenze)) segnala(`${dove}: ${problema}`)
      await this.pagina.screenshot({ path: join(RISULTATI, `${nome}-${this.etichetta}-${width}x${height}.png`), animations: 'disabled' })
      const dialogo = await this.pagina.locator('.velo').count()
      // Sugli schermi bassi Ho capito sta in fondo al testo: non deve essere a vista, ma ci si deve arrivare scorrendo.
      const ruolo = nome.startsWith('ruolo') && !dialogo
      if (ruolo) await this.pagina.evaluate(() => document.querySelector('.piede .tasto')?.scrollIntoView({ block: 'center' }))
      const coperti = await this.pagina.evaluate(nonAVista, dialogo ? '.velo .tasto' : '.piede .tasto')
      if (coperti.length) segnala(`${dove}: tasti non a vista: ${coperti.join(', ')}`)
      if (ruolo) await this.pagina.evaluate(() => document.getElementById('schermo')?.scrollTo(0, 0))
      const corpo = await this.pagina.evaluate(altezzaCorpo)
      if (corpo > 0 && corpo < 80) segnala(`${dove}: contenuto schiacciato a ${corpo} px`)
      conti.misure++
      conti.foto++
    }
    await this.pagina.setViewportSize(TELEFONO)
  }
}

const telefoni = NOMI_TELEFONI.map((nome, i) => new Telefono(nome, ['host', 'ospite', 'ospite2'][i]))
const bot = NOMI_BOT.map(nome => new Bot(nome))
const chiusi: Telefono[] = [] // telefoni di una scena sola: restano solo per il controllo degli errori in console

// ---- Controlli ----
function differenza(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  const da = Math.max(0, i - 100)
  return `\n    ${a.slice(da, i + 140)}\n    ${b.slice(da, i + 140)}`
}

// Le viste arrivano a pochi millisecondi di distanza: si ritenta per un attimo prima di parlare di differenza.
async function stessoHtml(a: Telefono, b: Telefono, quando: string, senzaInA: string | null = null) {
  const limite = Date.now() + 2500
  for (;;) {
    const [x, y] = await Promise.all([a.pagina.evaluate(htmlPubblico, senzaInA), b.pagina.evaluate(htmlPubblico, null)])
    if (x === y) {
      conti.confronti++
      return
    }
    if (Date.now() > limite) {
      segnala(`${quando}: HTML diverso tra ${a.etichetta} e ${b.etichetta}:${differenza(x, y)}`)
      return
    }
    await dorme(100)
  }
}

// Ogni assassino vivo contro ogni civile vivo: chi è morto ha la scritta Morto, ed è giusto così.
// Solo chi ha aperto Uccidi col gesto può passare conRiquadro, e il riquadro è l'unica cosa che si lascia fuori.
async function confrontaRuoli(quando: string, conRiquadro: Telefono | null = null) {
  for (const a of telefoni.filter(t => t.ruolo === 'assassino' && t.vivo)) {
    for (const c of telefoni.filter(t => t.ruolo === 'civile' && t.vivo)) await stessoHtml(a, c, quando, a === conRiquadro ? '.uccidi' : null)
  }
}

// In sala non esistono ruoli: si confrontano i due telefoni che non sono host.
const confrontaOspiti = (quando: string) => stessoHtml(telefoni[1], telefoni[2], quando)

async function schermata(nome: string, chi: Telefono[]) {
  await confrontaRuoli(nome)
  await Promise.all(chi.map(t => t.giro(nome)))
}

// Il QR è il modo principale di entrare: deve portare proprio al link della stanza.
function percorsoQr(testo: string): string {
  const { data } = encode(testo, { ecc: 'M', border: 0 })
  let d = ''
  data.forEach((riga, y) =>
    riga.forEach((pieno, x) => {
      if (pieno) d += `M${x} ${y}h1v1h-1z`
    }),
  )
  return d
}

const indirizzo = (query: string) => `${SITO}/?${query}`

// ---- Il copione ----
async function ingressi() {
  const [host, ospite, terzo] = telefoni

  passo('Home ed errori')
  await host.pagina.goto(indirizzo(`server=${WS_SITO}`), { waitUntil: 'load' })
  await host.pagina.locator('#schermo[data-schermata="home"]').waitFor()
  await host.giro('home')
  for (const [width, height] of MISURE.slice(0, 2)) {
    await host.pagina.setViewportSize({ width, height })
    const nascosti = await host.pagina.evaluate(nonAVista, '.input.codice, .riga .tasto')
    if (nascosti.length) segnala(`Home a ${width}x${height}: per entrare con il codice bisogna scorrere: ${nascosti.join(', ')}`)
  }
  await host.pagina.setViewportSize(TELEFONO)
  await host.tocca('Crea stanza')
  await host.pagina.locator('.errore').waitFor()
  await host.giro('home-errore')

  passo('Invio dopo il nome porta al codice e non crea nessuna stanza')
  await host.scrivi(host.nome)
  await host.pagina.getByPlaceholder('Come ti chiamano gli altri?').press('Enter')
  await dorme(300)
  if (!(await host.pagina.locator('#schermo[data-schermata="home"]').count())) segnala('Invio dopo il nome ha lasciato la Home')
  if (!(await host.pagina.getByLabel('Codice stanza').evaluate(el => el === document.activeElement))) segnala('Invio dopo il nome non porta al codice')
  await host.pagina.getByLabel('Codice stanza').fill('7A6VO')
  await host.tocca('Entra')
  const lettere = await host.pagina.locator('.errore').innerText()
  if (!lettere.includes('non è valido')) segnala(`codice con lettere vietate: messaggio «${lettere}»`)
  await host.pagina.getByLabel('Codice stanza').fill('')

  passo('Stanza creata, ingressi dal link')
  await host.tocca('Crea stanza')
  await host.aspetta('sala')
  const codice = (await host.pagina.locator('.ba-codice').innerText()).trim()
  await host.pagina.locator('.qr path').waitFor({ state: 'attached' })
  await host.giro('sala-solo')

  const link = indirizzo(`stanza=${codice}&server=${encodeURIComponent(WS_SITO)}`)
  if ((await host.pagina.locator('.qr path').getAttribute('d')) !== percorsoQr(link)) segnala('il QR non porta al link della stanza')

  await ospite.pagina.goto(link, { waitUntil: 'load' })
  await ospite.pagina.locator('#schermo[data-schermata="home"]').waitFor()
  await ospite.giro('home-invito')
  await ospite.scrivi(ospite.nome)
  await ospite.tocca('Entra')
  await ospite.aspetta('sala')

  // Il nome già preso torna alla Home con il motivo e il codice ancora scritto.
  await terzo.pagina.goto(link, { waitUntil: 'load' })
  await terzo.scrivi(ospite.nome)
  await terzo.tocca('Entra')
  await terzo.pagina.locator('.errore').waitFor()
  const rifiuto = await terzo.pagina.locator('.errore').innerText()
  if (!rifiuto.includes('già usato')) segnala(`nome doppio: messaggio «${rifiuto}»`)
  await terzo.scrivi(terzo.nome)
  await terzo.tocca('Entra')
  await terzo.aspetta('sala')

  passo('Dodici bot in sala')
  for (const b of bot) await b.apri(codice)
  await Promise.all(bot.map(b => b.attendi(v => v.presenti === 15, 'tutti in sala')))

  passo('Impostazioni dal telefono dell’host')
  await host.pagina.locator('.selettore').getByRole('button', { name: '2', exact: true }).tap()
  await bot[0].attendi(v => v.numeroAssassini === 2, 'due assassini')
  await host.pagina.getByRole('button', { name: 'Aumenta' }).tap()
  await bot[0].attendi(v => v.numeroTask === TASKS_DEFAULT + 1, 'numero task +1')
  await host.pagina.getByRole('button', { name: 'Diminuisci' }).tap()
  await bot[0].attendi(v => v.numeroTask === TASKS_DEFAULT, 'numero task -1')

  await host.pagina.getByRole('button', { name: 'Copia' }).tap()
  await host.pagina.locator('.avviso').waitFor()

  await confrontaOspiti('sala')
  await Promise.all([host.giro('sala'), ospite.giro('sala')])

  // Chi aspetta deve vedere subito chi c'è, anche in 15 su un telefono piccolo.
  await ospite.pagina.setViewportSize({ width: 360, height: 640 })
  const primo = await ospite.pagina.locator('.griglia .cella').first().boundingBox()
  if (!primo || primo.y > 200) segnala(`sala dell'ospite: il primo giocatore è a y=${primo?.y}`)
  await ospite.pagina.setViewportSize(TELEFONO)

  passo('Regole dalla barra in alto, in sala')
  await ospite.tocca('Regole')
  await ospite.giro('regole-sala')
  await ospite.tocca('Chiudi')
}

// Start chiede conferma: un tocco anticipato lascerebbe fuori chi sta ancora inquadrando il QR, e la partita non si annulla.
async function avvia() {
  const [host] = telefoni
  await host.tocca('Start')
  await host.tocca('Si parte')
}

// I ruoli escono a caso: si rigioca finché almeno un assassino è su un telefono vero. Una mano senza non costa nulla:
// i due assassini sono bot, premono Sono morto e la partita finisce da sola.
async function distribuisci() {
  const [host] = telefoni

  await host.tocca('Start')
  await host.pagina.locator('.dialogo').waitFor()
  await host.giro('dialogo-start')
  await host.tocca('Aspetta')
  await host.pagina.locator('.dialogo').waitFor({ state: 'detached' })
  if (bot[0].v?.schermata !== 'sala') segnala('Start è partito senza conferma')

  for (let mano = 1; mano <= 60; mano++) {
    await avvia()
    await Promise.all([...telefoni.map(t => t.aspetta('ruolo')), ...bot.map(b => b.attendiSchermata('ruolo'))])
    for (const t of telefoni) await t.leggiRuolo()
    if (telefoni.some(t => t.ruolo === 'assassino')) {
      console.log(`  ruoli buoni alla mano ${mano}: ${telefoni.map(t => t.ruolo).join(', ')}`)
      return
    }
    for (const b of bot.filter(x => x.ruolo === 'assassino')) {
      b.invia('ruoloVisto')
      await b.attendiSchermata('partita')
      b.invia('sonoMorto')
    }
    await Promise.all([...telefoni.map(t => t.aspetta('sala')), ...bot.map(b => b.attendiSchermata('sala'))])
  }
  assert.fail('nessun assassino sui telefoni dopo 60 mani')
}

async function vaiInPartita() {
  for (const b of bot) if (b.v) b.invia('ruoloVisto')
  await Promise.all(telefoni.map(t => t.tocca('Ho capito')))
  await Promise.all([...telefoni.map(t => t.aspetta('partita')), ...bot.map(b => b.attendiSchermata('partita'))])
}

const vivi = (tipo: string) => bot.filter(b => b.ruolo === tipo && b.vivo)

function idDi(nome: string): number {
  const riga = bot.find(b => b.v?.schermata === 'riunione')?.v?.giocatori.find((g: V) => g.nome === nome)
  assert.ok(riga, `${nome} non è tra i vivi`)
  return riga.id
}

async function tuttiInRiunione(tipo: string) {
  await Promise.all([...telefoni.map(t => t.aspetta('riunione')), ...bot.map(b => b.attendi(v => v.schermata === 'riunione' && v.tipo === tipo, 'riunione'))])
}

// I bot votano il bersaglio, chi è il bersaglio salta: arrivano per ultimi, così la scena è ferma quando l'esito parte.
function botVotano(bersaglio: string | null) {
  const id = bersaglio === null ? null : idDi(bersaglio)
  for (const b of bot) {
    if (b.vivo && b.ws?.readyState === WebSocket.OPEN) b.invia('vota', id === null || b.nome === bersaglio ? 'salta' : id)
  }
}

// Il primo tocco sceglie e basta, sia un nome sia Salta: solo Conferma rende definitivo il voto.
async function telefonoVota(t: Telefono, nome: string | null) {
  if (nome === null) await t.tocca('Salta il voto')
  else await t.pagina.getByRole('button', { name: `Scegli ${nome}`, exact: true }).tap()
  const scelta = await t.pagina.locator('.scelta').innerText()
  if (!scelta.includes(nome ?? 'salta il voto')) segnala(`voto: dopo il primo tocco si legge «${scelta}»`)
  await t.tocca('Conferma')
}

const fermaTutti = (schermate: string[]) => Promise.all(telefoni.map(t => t.ferma(schermate)))
const riprendiTutti = () => Promise.all(telefoni.map(t => t.riprendi()))

async function pressioneLunga(A: Telefono, C: Telefono) {
  passo('Pressione lunga con tocco vero')
  await confrontaRuoli('partita')

  // Il civile: stesso gesto, nessun effetto. Né un carattere di HTML né una mutazione né un'animazione.
  await C.pagina.evaluate(assestato)
  const prima = await C.pagina.evaluate(htmlGrezzo)
  await C.pagina.evaluate(osserva)
  await C.premi(PRESSA_MS)
  await dorme(100)
  const dopo = await C.pagina.evaluate(htmlGrezzo)
  if (dopo !== prima) segnala(`pressione lunga: l'HTML del civile è cambiato:${differenza(prima, dopo)}`)
  const mutazioni = await C.pagina.evaluate(() => (window as any).__mutazioni)
  if (mutazioni) segnala(`pressione lunga: ${mutazioni} mutazioni sul civile`)
  if (await C.pagina.evaluate(animazioniInCorso)) segnala('pressione lunga: animazioni sul civile')
  if (await C.riquadri()) segnala('pressione lunga: il civile vede il riquadro')

  // L'assassino: un tocco breve non fa nulla, quello lungo apre, un altro lungo richiude.
  await A.premi(LONG_PRESS_MS / 2)
  await dorme(LONG_PRESS_MS)
  await A.attendiRiquadri(0, 'tocco breve')
  await A.premi(PRESSA_MS)
  await A.attendiRiquadri(1, 'pressione lunga')
  await A.premi(PRESSA_MS)
  await A.attendiRiquadri(0, 'seconda pressione lunga')
  await A.premi(PRESSA_MS)
  await A.attendiRiquadri(1, 'terza pressione lunga')

  // Riquadro a parte, l'assassino resta identico al civile.
  await confrontaRuoli('riquadro aperto', A)
  await A.giro('partita-uccidi')

  // La task deve restare raggiungibile: chi è accanto alla vittima deve poter fingere di farla.
  await A.pagina.setViewportSize({ width: 320, height: 568 })
  const fatto = await A.pagina.evaluate(nonAVista, '.spunta')
  if (fatto.length) segnala(`riquadro aperto a 320x568: Fatto non a vista: ${fatto.join(', ')}`)
  await A.pagina.setViewportSize(TELEFONO)

  passo('Il riquadro sparisce dopo una ricarica')
  await A.ricarica('partita')
  await A.attendiRiquadri(0, 'dopo la ricarica')
  await A.premi(PRESSA_MS)
  await A.attendiRiquadri(1, 'pressione lunga dopo la ricarica')
}

async function primaRiunione(A: Telefono, C: Telefono, T: Telefono) {
  passo('Task spuntate dai telefoni')
  await C.tocca('Segna la task come fatta')
  await C.pagina.locator('.spunta.fatta').waitFor()
  await A.tocca('Segna la task come fatta')
  await A.pagina.locator('.spunta.fatta').waitFor()
  await Promise.all(telefoni.map(t => t.pagina.getByText('2 / 78').waitFor()))
  await confrontaRuoli('task in attesa', A)
  await C.giro('partita-attesa')
  await C.pagina.getByRole('button', { name: 'Segna la task come fatta' }).waitFor({ timeout: 8000 })
  await confrontaRuoli('nuova task', A)

  passo('Report da un bot: il riquadro sparisce')
  const relatore = bot[0]
  relatore.invia('report')
  await tuttiInRiunione('report')
  await A.attendiRiquadri(0, 'in riunione')
  await schermata('riunione', [A, C])

  passo('15 giocatori a 360x640: Salta e Conferma a vista')
  for (const [width, height] of MISURE) {
    await C.pagina.setViewportSize({ width, height })
    const nascosti = await C.pagina.evaluate(nonAVista, '.conferma .tasto')
    if (nascosti.length) segnala(`riunione a ${width}x${height}: non a vista ${nascosti.join(', ')}`)
  }
  await C.pagina.setViewportSize({ width: 360, height: 640 })
  const lungo = 'WWWWWWWWWWWWWWWW'
  await C.pagina.getByRole('button', { name: `Scegli ${lungo}`, exact: true }).tap()
  const nascosti = await C.pagina.evaluate(nonAVista, '.conferma .tasto')
  if (nascosti.length) segnala(`riunione a 360x640 con una scelta: non a vista ${nascosti.join(', ')}`)
  await C.giro('riunione-scelta')

  passo('Ricarica durante il voto')
  await C.ricarica('riunione')
  await confrontaRuoli('riunione dopo la ricarica')
  const conta = C.pagina.locator('.conto .mono')
  await telefonoVota(A, relatore.nome)
  await A.pagina.getByText('Hai votato Marta').waitFor()
  await A.ricarica('riunione')
  await A.pagina.getByText('Hai votato Marta').waitFor()
  if ((await A.pagina.locator('.copri').count()) > 0) segnala('dopo la ricarica chi ha votato può scegliere di nuovo')
  await attendi(async () => (await conta.innerText()).startsWith('1 /'), 'un voto solo dopo la ricarica')
  await telefonoVota(C, 'Ugo')
  await telefonoVota(T, null)
  await confrontaRuoli('riunione dopo i voti')
  await A.giro('riunione-votato')

  passo('Esito: civile eliminato')
  await fermaTutti(['esito'])
  botVotano('Ugo')
  await Promise.all(telefoni.map(t => t.aspetta('esito')))
  await schermata('esito', [A, C])
  await riprendiTutti()
  await Promise.all(telefoni.map(t => t.aspetta('partita')))
  await A.attendiRiquadri(0, 'di nuovo in partita')
  await confrontaRuoli('ritorno in partita')
  await bot[0].attendiSchermata('partita')
}

async function secondaRiunione(A: Telefono, C: Telefono, T: Telefono) {
  passo('Uccidi dal telefono dell’assassino: niente scritte finché il server non conferma')
  await A.premi(PRESSA_MS)
  await A.attendiRiquadri(1, 'nuova pressione lunga')
  const uccidi = A.pagina.getByRole('button', { name: 'Uccidi', exact: true })
  await A.perdi(true)
  await uccidi.tap({ timeout: 15 * 1000 })
  await A.pagina.locator('.uccidi-perso').waitFor({ timeout: 6000 })
  await A.perdi(false)
  await uccidi.tap()
  await A.pagina.getByText(/^pronto tra/).waitFor()
  if (await A.pagina.locator('.uccidi-perso').count()) segnala('Uccidi arrivato, ma la scritta di comando perso è rimasta')
  await A.giro('partita-uccisione')

  passo('Sono morto dal terzo telefono: l’avviso aspetta la conferma del server')
  await T.perdi(true)
  await T.tocca('Sono morto')
  await T.tocca('Sì, sono morto')
  await T.pagina.getByText('Non è arrivato al server').waitFor({ timeout: 6000 })
  if (await T.pagina.locator('.tag.morto').count()) segnala('Sono morto perso, ma il telefono si crede morto')
  await T.perdi(false)
  await T.tocca('Sono morto')
  await T.pagina.locator('.dialogo').waitFor()
  await T.giro('dialogo-morto')
  await T.tocca('Sì, sono morto')
  await T.pagina.locator('.tag.morto').waitFor()
  await T.pagina.getByText('Sei fuori dalle votazioni per il resto della partita').waitFor()
  T.vivo = false
  await T.giro('partita-morto')

  passo('Emergency dal telefono del civile')
  await C.pagina.getByRole('button', { name: 'Emergency meeting' }).tap()
  await tuttiInRiunione('emergency')
  await A.attendiRiquadri(0, 'in riunione d’emergenza')
  await schermata('riunione-emergency', [C])
  await T.giro('riunione-morto')

  passo('Tutti saltano il voto')
  await fermaTutti(['esito'])
  await Promise.all([A, C].map(t => telefonoVota(t, null)))
  botVotano(null)
  await Promise.all(telefoni.map(t => t.aspetta('esito')))
  await schermata('esito-nessuno', [C])
  await riprendiTutti()
  await Promise.all(telefoni.map(t => t.aspetta('partita')))
  await A.attendiRiquadri(0, 'dopo la riunione d’emergenza') // qui era aperto: la ricarica della prima riunione non conta
  await confrontaRuoli('dopo l’emergency')
  await C.giro('partita-cooldown')
}

// Gli assassini vincono con un voto, così a fine partita civile e assassino sono entrambi vivi e si possono confrontare.
async function finale(A: Telefono, C: Telefono) {
  passo('Finale: vincono gli assassini')
  await bot[0].attendiSchermata('partita')
  const assassini = telefoni.filter(t => t.ruolo === 'assassino' && t.vivo).length + vivi('assassino').length
  const civili = vivi('civile')
  for (const b of civili.slice(assassini)) b.invia('sonoMorto')
  await attendi(() => vivi('civile').length === assassini, 'civili ridotti')

  const bersaglio = civili[0].nome
  await C.tocca('Report')
  await tuttiInRiunione('report')
  await fermaTutti(['esito', 'fine'])
  await Promise.all([A, C].map(t => telefonoVota(t, bersaglio)))
  botVotano(bersaglio)
  await Promise.all(telefoni.map(t => t.aspetta('esito')))
  await schermata('esito-vittoria', [A, C])
  await riprendiTutti()
  await Promise.all(telefoni.map(t => t.aspetta('fine')))
  await schermata('fine-assassini', [A, C])
  await riprendiTutti()
  await Promise.all([...telefoni.map(t => t.aspetta('sala')), ...bot.map(b => b.attendiSchermata('sala'))])
  await confrontaOspiti('sala dopo la partita')
}

// Seconda partita, più breve: l'ultimo assassino esce col voto. Serve per Togli in riunione e per la vittoria dei civili.
async function rivincita() {
  passo('Seconda partita: vincono i civili, Togli in riunione')
  const [host] = telefoni
  await avvia()
  await Promise.all([...telefoni.map(t => t.aspetta('ruolo')), ...bot.map(b => b.attendiSchermata('ruolo'))])
  for (const t of telefoni) await t.leggiRuolo()
  await vaiInPartita()

  const assassiniTel = telefoni.filter(t => t.ruolo === 'assassino')
  const assassiniBot = bot.filter(b => b.ruolo === 'assassino')
  const [primo, ultimo] = [...assassiniBot, ...assassiniTel]
  if (primo instanceof Bot) primo.invia('sonoMorto')
  else {
    await primo.tocca('Sono morto')
    await primo.tocca('Sì, sono morto')
    primo.vivo = false
  }

  const [relatore, muto] = bot.filter(b => b.ruolo === 'civile')
  relatore.invia('report')
  await tuttiInRiunione('report')

  muto.spegni()
  const togli = host.pagina.getByRole('button', { name: 'Togli', exact: true })
  await togli.waitFor({ timeout: OFFLINE_ATTESA_MS })
  await confrontaRuoli('riunione con un telefono spento')
  await host.giro('riunione-togli')
  await togli.tap()
  await host.pagina.locator('.dialogo').waitFor()
  await host.giro('dialogo-togli')
  await host.pagina.locator('.dialogo').getByRole('button', { name: 'Togli' }).tap()
  await bot[0].attendi(v => v.presenti === 14, 'Togli in riunione')
  muto.ws = null

  // Sono morto si può premere anche durante il voto: chi lo preme esce dal conteggio.
  const tardivo = telefoni.find(t => t.ruolo === 'civile') as Telefono
  await tardivo.pagina.locator('.testa-riunione').getByRole('button', { name: 'Sono morto' }).tap()
  await tardivo.tocca('Sì, sono morto')
  await tardivo.pagina.locator('.tag.morto').waitFor()
  tardivo.vivo = false
  await bot[0].attendi(v => v.totale === 12, 'Sono morto durante il voto')

  await fermaTutti(['esito', 'fine'])
  await Promise.all(telefoni.filter(t => t.vivo).map(t => telefonoVota(t, null)))
  botVotano(ultimo.nome)
  await Promise.all(telefoni.map(t => t.aspetta('esito')))
  await telefoni[0].giro('esito-ultimo')
  await riprendiTutti()
  await Promise.all(telefoni.map(t => t.aspetta('fine')))
  await telefoni[0].giro('fine-civili')
  await riprendiTutti()
  await Promise.all(telefoni.map(t => t.aspetta('sala')))
  await confrontaOspiti('sala dopo la rivincita')
}

// Terza partita, brevissima: chi sta ancora leggendo il ruolo tiene ferma la riunione, e deve saperlo.
async function riunioneSulRuolo() {
  passo('Riunione aperta mentre i telefoni leggono il ruolo')
  const attivi = bot.filter(b => b.ws)
  await avvia()
  await Promise.all([...telefoni.map(t => t.aspetta('ruolo')), ...attivi.map(b => b.attendiSchermata('ruolo'))])
  for (const t of telefoni) await t.leggiRuolo()
  for (const b of attivi) b.invia('ruoloVisto')
  await Promise.all(attivi.map(b => b.attendiSchermata('partita')))
  const relatore = attivi.find(b => b.ruolo === 'civile') as Bot
  relatore.invia('report')
  await Promise.all(attivi.map(b => b.attendiSchermata('riunione')))

  await Promise.all(telefoni.map(t => t.pagina.getByText('Hanno aperto una riunione').waitFor()))
  await Promise.all(telefoni.map(t => t.giro('ruolo-riunione')))
  await Promise.all(telefoni.map(t => t.tocca('Ho capito')))
  await Promise.all(telefoni.map(t => t.aspetta('riunione')))

  // Gli assassini escono durante il voto, poi saltano tutti: vincono i civili e si torna in sala.
  for (const b of attivi.filter(x => x.ruolo === 'assassino')) b.invia('sonoMorto')
  for (const t of telefoni.filter(x => x.ruolo === 'assassino')) {
    await t.pagina.locator('.testa-riunione').getByRole('button', { name: 'Sono morto' }).tap()
    await t.tocca('Sì, sono morto')
    await t.pagina.locator('.tag.morto').waitFor()
  }
  await Promise.all(telefoni.filter(t => t.ruolo === 'civile').map(t => telefonoVota(t, null)))
  await attendi(() => attivi.every(b => !b.vivo || b.v?.schermata === 'riunione'), 'riunione ferma')
  botVotano(null)
  await Promise.all(telefoni.map(t => t.aspetta('sala')))
}

async function connessionePersa() {
  passo('Connessione persa: banner uguale per tutti e tasti spenti')
  const t = telefoni[1]
  await t.pagina.evaluate(() => {
    const w = window as any
    w.__giu = true
    w.__socket.close()
  })
  await t.pagina.locator('.banner-rete').waitFor()
  await t.giro('sala-senza-rete')
  await t.pagina.evaluate(() => ((window as any).__giu = false))
  await t.pagina.locator('.banner-rete').waitFor({ state: 'detached', timeout: 15 * 1000 })
}

// Il link aperto in una seconda scheda prende il posto: la prima si ferma e non rimbalza, finché non la si tocca.
async function altraScheda() {
  passo('Stessa stanza in due schede')
  const t = telefoni[1]
  const seconda = await t.pagina.context().newPage()
  seconda.on('console', m => {
    if (m.type() === 'error') t.errori.push(m.text())
  })
  await seconda.goto(t.pagina.url(), { waitUntil: 'load' })
  await seconda.locator('#schermo[data-schermata="sala"]').waitFor()
  const banner = t.pagina.getByRole('button', { name: /altra scheda/ })
  await banner.waitFor()
  await t.giro('sala-altra-scheda')
  await banner.tap()
  await banner.waitFor({ state: 'detached' })
  await seconda.close()
}

async function collegamento(browser: Browser) {
  passo('Collegamento in corso')
  const t = new Telefono('Prova', 'telefono')
  await t.accendi(browser, 'dark')
  await t.pagina.addInitScript(() => {
    ;(window as any).__giu = true
    localStorage.setItem('sala-sospetti:stanza', 'ABCDE')
    localStorage.setItem('sala-sospetti:nome', 'Prova')
  })
  await t.pagina.goto(indirizzo(`server=${WS_SITO}`), { waitUntil: 'load' })
  await t.aspetta('collegamento')
  await t.giro('collegamento')
  await t.pagina.getByText('Non riesco a collegarmi').waitFor({ timeout: 20 * 1000 })
  await t.giro('collegamento-lento')
  await t.pagina.context().close()
  chiusi.push(t)
}

// Il ritardatario dal QR: un solo messaggio, che dice cosa fare, e il link resta buono per riprovare.
async function ritardatario(browser: Browser, codice: string) {
  passo('Ritardatario dal QR a partita iniziata')
  const t = new Telefono('Lina', 'ritardatario')
  await t.accendi(browser, 'dark')
  await t.pagina.goto(indirizzo(`stanza=${codice}&server=${encodeURIComponent(WS_SITO)}`), { waitUntil: 'load' })
  await t.scrivi(t.nome)
  await t.tocca('Entra')
  await t.pagina.locator('.errore').waitFor()
  const testo = await t.pagina.locator('#schermo').innerText()
  if (!testo.includes('aspetta che finisca')) segnala(`ritardatario: il messaggio non dice cosa fare: ${testo}`)
  if (testo.includes('premi Entra.')) segnala('ritardatario: riceve ancora due ordini opposti')
  if (!t.pagina.url().includes(`stanza=${codice}`)) segnala(`ritardatario: il link è andato perso: ${t.pagina.url()}`)
  await t.giro('home-ritardatario')
  await t.pagina.context().close()
  chiusi.push(t)
}

// Una stanza salvata che non esiste più riporta alla Home: chi apre il sito non ha scritto nessun codice.
async function stanzaSparita(browser: Browser) {
  passo('Rientro automatico in una stanza che non esiste più')
  const t = new Telefono('Prova', 'rientro')
  await t.accendi(browser, 'dark')
  await t.pagina.addInitScript(() => localStorage.setItem('sala-sospetti:stanza', 'ZZZZZ'))
  await t.pagina.goto(indirizzo(`server=${WS_SITO}`), { waitUntil: 'load' })
  await t.pagina.locator('#schermo[data-schermata="home"]').waitFor()
  if (await t.pagina.locator('.errore').count()) segnala('rientro automatico fallito: la Home mostra un errore')
  await t.pagina.context().close()
  chiusi.push(t)
}

async function uscite() {
  passo('Togli in sala, Esci con conferma')
  const [host, , terzo] = telefoni
  const muto = bot.filter(b => b.ws)[1]
  muto.spegni()
  const togli = host.pagina.getByRole('button', { name: 'Togli', exact: true })
  await togli.waitFor({ timeout: OFFLINE_ATTESA_MS })
  await host.giro('sala-togli')
  await togli.tap()
  await host.pagina.locator('.dialogo').getByRole('button', { name: 'Togli' }).tap()
  await bot[0].attendi(v => v.presenti === 13, 'Togli in sala')
  muto.ws = null

  // Esci che non arriva: il telefono resta nella stanza e lo dice, invece di lasciare un giocatore fantasma.
  await terzo.perdi(true)
  await terzo.pagina.getByRole('button', { name: 'Esci dalla stanza' }).tap()
  await terzo.pagina.locator('.dialogo').getByRole('button', { name: 'Esci' }).tap()
  await terzo.aspetta('uscita')
  await terzo.pagina.getByText('Non riesco a uscire').waitFor({ timeout: 7000 })
  await terzo.aspetta('sala')
  if (bot[0].v?.presenti !== 13) segnala(`Esci perso: presenti ${bot[0].v?.presenti}`)
  await terzo.perdi(false)

  await terzo.pagina.getByRole('button', { name: 'Esci dalla stanza' }).tap()
  await terzo.pagina.locator('.dialogo').waitFor()
  await terzo.giro('dialogo-esci')
  await terzo.pagina.locator('.dialogo').getByRole('button', { name: 'Esci' }).tap()
  await terzo.pagina.locator('#schermo[data-schermata="home"]').waitFor()
  await bot[0].attendi(v => v.presenti === 12, 'Esci')
  await terzo.ricarica('home')
  const nome = await terzo.pagina.getByPlaceholder('Come ti chiamano gli altri?').inputValue()
  if (nome !== terzo.nome) segnala(`dopo la ricarica la Home mostra il nome «${nome}» invece di «${terzo.nome}»`)
}

async function partita(browser: Browser) {
  await Promise.all(telefoni.map((t, i) => t.accendi(browser, i === 1 ? 'light' : 'dark')))
  await ingressi()

  passo('Start: si rigioca finché un telefono è assassino')
  await distribuisci()
  const A = telefoni.find(t => t.ruolo === 'assassino') as Telefono
  const C = telefoni.find(t => t.ruolo === 'civile') as Telefono
  const T = telefoni.find(t => t !== A && t !== C) as Telefono
  A.etichetta = 'assassino'
  C.etichetta = 'civile'
  T.etichetta = 'terzo'

  passo('Rivelazione e ricarica')
  await Promise.all([A.giro('ruolo'), C.giro('ruolo')])
  await A.ricarica('ruolo')
  await C.ricarica('ruolo')
  // Il secondo tocco di uno Start doppio cade qui: per un attimo Ho capito non deve rispondere, per nessuno.
  for (const t of [A, C]) {
    if (await t.pagina.getByRole('button', { name: 'Ho capito' }).isEnabled()) segnala(`Ho capito già attivo appena comparso, ${t.etichetta}`)
  }
  await A.leggiRuolo()
  await C.leggiRuolo()
  if (A.ruolo !== 'assassino' || C.ruolo !== 'civile') segnala('la ricarica ha cambiato il ruolo a schermo')

  const codice = (await A.pagina.locator('.ba-codice').innerText()).trim()
  await ritardatario(browser, codice)

  await vaiInPartita()
  await T.ricarica('partita') // Dopo Ho capito il ruolo non torna
  await schermata('partita', [A, C])

  passo('Regole dalla barra in alto, uguali per tutti')
  await Promise.all(telefoni.map(t => t.tocca('Regole')))
  await confrontaRuoli('regole aperte')
  await C.giro('regole-partita')
  await Promise.all(telefoni.map(t => t.tocca('Chiudi')))

  await pressioneLunga(A, C)
  await primaRiunione(A, C, T)
  await secondaRiunione(A, C, T)
  await finale(A, C)

  await rivincita()
  await riunioneSulRuolo()
  await connessionePersa()
  await altraScheda()
  await uscite()
  await collegamento(browser)
  await stanzaSparita(browser)

  passo('Si esce tutti')
  for (const b of bot) if (b.ws) b.invia('esci')
  for (const t of telefoni.slice(0, 2)) {
    await t.pagina.getByRole('button', { name: 'Esci dalla stanza' }).tap()
    await t.pagina.locator('.dialogo').getByRole('button', { name: 'Esci' }).tap()
    await t.pagina.locator('#schermo[data-schermata="home"]').waitFor()
  }
  for (const b of bot) b.chiudi()
}

// ---- Avvio ----
const limite = setTimeout(() => {
  console.error('Tempo massimo superato')
  process.exit(1)
}, 12 * 60 * 1000)
limite.unref()

const inizio = Date.now()
rmSync(RISULTATI, { recursive: true, force: true })
mkdirSync(RISULTATI, { recursive: true })

// SENZA_BUILD=1 prova il contenuto di out/ così com'è.
if (process.env.SENZA_BUILD !== '1') {
  console.log('Compilo il sito...')
  compilaSito()
}
const sito = await serviSito()
console.log(`Avvio di wrangler dev sulla porta ${PORTA_SERVER}...`)
await avviaServer()
const browser = await chromium.launch({ channel: 'chrome', headless: true })

let rotto: unknown = null
try {
  await partita(browser)
} catch (errore) {
  rotto = errore
  for (const t of telefoni) await t.pagina?.screenshot({ path: join(RISULTATI, `errore-${t.etichetta}.png`) }).catch(() => {})
}

await browser.close()
sito.close()
sito.closeAllConnections()
fermaServer()

for (const t of [...telefoni, ...chiusi]) {
  for (const errore of new Set(t.errori)) segnala(`console di ${t.etichetta}: ${errore}`)
  for (const avviso of t.avvisi) console.log(`  avviso in console di ${t.etichetta}: ${avviso}`)
}
for (const riga of registro.split('\n')) {
  if (/Uncaught|messaggio scartato|\[ERROR\]|internal error/i.test(riga)) segnala(`wrangler: ${riga}`)
}

const durata = Math.round((Date.now() - inizio) / 1000)
console.log(`\n${conti.confronti} confronti di HTML, ${conti.misure} misure, ${conti.foto} screenshot in test/risultati/, ${durata} s`)
if (rotto) console.log(`\nPARTITA INTERROTTA: ${rotto instanceof Error ? rotto.stack : rotto}\n\nUltime righe di wrangler:\n${registro.split('\n').slice(-15).join('\n')}`)
console.log(difetti.length ? `\n${difetti.length} difetti:\n${difetti.map(d => `- ${d}`).join('\n')}` : '\nNessun difetto.')
process.exit(rotto || difetti.length ? 1 : 0)
