// Tutte le schermate del gioco: React disegna la vista che arriva dal server e non decide nessuna regola.
//
// Vincolo: civile e assassino vedono lo stesso identico schermo finché l'assassino non apre il riquadro Uccidi.
// Quindi fuori da Ruolo nessun nodo dipende dal ruolo, e tutto ciò che cambia da un giocatore all'altro
// (nome proprio, task, timer, «Tu», tasti di voto) vive dentro un elemento con l'attributo data-privato.
import { createContext, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  ASSASSINI_SCEGLIBILI,
  COOLDOWN,
  KILL_CD,
  LONG_PRESS_MS,
  LONG_PRESS_PX,
  LUNGHEZZA_CODICE,
  MAX_GIOCATORI,
  MIN_PLAYERS,
  NOME_MAX,
  TASKS_MIN,
  codiceValido,
} from '../gioco/regole.ts'
import type {
  Ruolo as NomeRuolo,
  Vista,
  VistaEsito,
  VistaFine,
  VistaPartita,
  VistaRiunione,
  VistaRuolo,
  VistaSala,
  Volto,
  Voto,
} from '../gioco/regole.ts'
import { linkStanza, segnaleRiunione } from './connessione.ts'
import type { Comando, StatoRete } from './connessione.ts'

type Comanda = (comando: Comando) => void
type Avvisa = (testo: string) => void

// Tempi uguali per tutti, così non dicono nulla sul ruolo.
const BLOCCO_RUOLO_MS = 1500 // Ho capito: il secondo tocco di uno Start doppio non deve far sparire il ruolo
const BLOCCO_RIUNIONE_MS = 1000 // tasti del voto: un tocco pensato per la schermata di prima non deve contare
const CONFERMA_MS = 4000 // un comando che entro questo tempo non cambia la vista è andato perso
const COLLEGAMENTO_LENTO_MS = 15 * 1000

const TESTO_PERSO = 'Non è arrivato al server: riprova'
export const TESTO_CODICE_ERRATO = `Il codice non è valido: sono ${LUNGHEZZA_CODICE} caratteri, senza I, O, 0 e 1.`

const minuti = (ms: number) => ms / 60_000

// ---- Pezzi comuni ----

// Tutti i tasti del gioco passano da qui: senza vista aggiornata restano disattivati.
const Collegato = createContext(true)

function Tasto(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const collegato = useContext(Collegato)
  return <button type="button" {...props} disabled={props.disabled || !collegato} />
}

const IconaReport = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 2.5 20h19L12 3z" />
    <path d="M12 9v5" />
    <path d="M12 17.5h.01" />
  </svg>
)

const IconaCampana = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" />
    <path d="M10 21a2 2 0 0 0 4 0" />
    <path d="M12 3v2" />
  </svg>
)

const IconaSpunta = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
)

const Avatar = ({ g }: { g: Volto }) => (
  <span className="avatar" style={{ background: g.colore, color: g.lettera }} aria-hidden="true">
    {g.iniziale}
  </span>
)

type PropsCella = { g: Volto; nota?: ReactNode; classe?: string; fine?: ReactNode; children?: ReactNode }

function Cella({ g, nota, classe, fine, children }: PropsCella) {
  return (
    <li className={classe ? `cella ${classe}` : 'cella'}>
      <Avatar g={g} />
      <span className="cella-testo">
        <span className="cella-nome">{g.nome}</span>
        {nota && <span className="cella-nota">{nota}</span>}
      </span>
      {fine}
      <span data-privato className="cella-mio">
        {children}
      </span>
    </li>
  )
}

const nomeRuolo = (ruolo: NomeRuolo) => (ruolo === 'assassino' ? 'Assassino' : 'Civile')

function mmss(ms: number) {
  const secondi = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(secondi / 60)}:${String(secondi % 60).padStart(2, '0')}`
}

const secondiDa = (scadenza: number, ora: number) => Math.max(0, Math.ceil((scadenza - ora) / 1000))

// Un solo intervallo da 500 ms, acceso solo nelle schermate con un conto alla rovescia.
function useBattito(attivo: boolean) {
  const [, batti] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!attivo) return
    const intervallo = setInterval(batti, 500)
    return () => clearInterval(intervallo)
  }, [attivo])
}

// Diventa vero ms dopo la comparsa del componente.
function useDopo(ms: number) {
  const [passato, setPassato] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setPassato(true), ms)
    return () => clearTimeout(timer)
  }, [ms])
  return passato
}

// Il server non risponde ai comandi: la conferma è un valore della vista che cambia. La funzione restituita va chiamata
// quando il comando parte; se valore non cambia entro CONFERMA_MS, il comando non è arrivato.
function useConferma(valore: unknown, confermato: () => void, perso: () => void) {
  const [atteso, setAtteso] = useState<{ prima: unknown } | null>(null)
  useEffect(() => {
    if (!atteso) return
    if (valore !== atteso.prima) {
      setAtteso(null)
      confermato()
      return
    }
    const timer = setTimeout(() => {
      setAtteso(null)
      perso()
    }, CONFERMA_MS)
    return () => clearTimeout(timer)
  }, [atteso, valore])
  return () => setAtteso({ prima: valore })
}

// Le stesse regole sulla Home e nel tasto Regole della barra: uguali per tutti, quindi senza nulla che dipenda dal ruolo.
function ListaRegole() {
  return (
    <ul className="lista-regole">
      <li>Ognuno riceve in segreto un ruolo: civile o assassino.</li>
      <li>
        Tutti hanno delle task da fare davvero, in casa. Finita una, si preme <b>Fatto</b> e la barra verde cresce per tutti, anche con le
        spunte degli assassini.
      </li>
      <li>
        Gli assassini eliminano di persona, di nascosto: prima di iniziare decidete insieme come, per esempio con un tocco sulla spalla. Chi
        viene eliminato non dice chi è stato e preme <b>Sono morto</b>: non vota più, ma può continuare a fare le task.
      </li>
      <li>
        Gli assassini aprono il riquadro <b>Uccidi</b> tenendo premuta per un secondo la barra col codice stanza, non quella verde: per gli
        altri il gesto non fa nulla. Si elimina solo quando il riquadro dice «pronto», poi si preme Uccidi. L&apos;attesa è di{' '}
        {minuti(KILL_CD)} minuti all&apos;inizio, dopo ogni eliminazione e dopo ogni riunione.
      </li>
      <li>
        Hai trovato un morto? <b>Report</b>. Sospetti qualcuno? <b>Emergency</b>, una ogni {minuti(COOLDOWN)} minuti. Si vota e chi prende più
        voti è fuori. Non esce nessuno se c&apos;è parità, anche con i salti, o se i salti sono di più.
      </li>
      <li>I civili vincono con la barra piena o senza più assassini. Gli assassini vincono se pareggiano i civili.</li>
    </ul>
  )
}

// ---- Home: scorre tutta e non ha nulla di fisso in basso, così la tastiera non copre mai i campi ----

// Il confronto all'americana: cinque sagome davanti al metro, una ti sta guardando.
function Confronto() {
  const sagome = [
    { x: 66, scala: 0.98 },
    { x: 118, scala: 1.1 },
    { x: 170, scala: 0.92 },
    { x: 222, scala: 1.16, lei: true },
    { x: 274, scala: 1.02 },
  ]
  return (
    <svg className="confronto" viewBox="0 0 328 92" aria-hidden="true">
      {[180, 170, 160, 150].map((misura, i) => (
        <g key={misura}>
          <line className="tacca" x1="26" x2="328" y1={10 + i * 21} y2={10 + i * 21} />
          <text className="misura" x="0" y={13 + i * 21}>
            {misura}
          </text>
        </g>
      ))}
      {sagome.map((s, n) => (
        <g key={s.x} transform={`translate(${s.x} 92)`} className={s.lei ? 'lei' : undefined}>
          <g className="sagoma" style={{ '--n': n } as CSSProperties} transform={`scale(${s.scala})`}>
            <path d="M-25 0 C-25 -27 -15 -36 0 -36 S25 -27 25 0 Z" />
            <ellipse cy="-51" rx="13.5" ry="15" />
            {s.lei && <path className="occhi" d="M-8.5 -54 l6.5 2.6 -6 1 Z M8.5 -54 l-6.5 2.6 6 1 Z" />}
          </g>
          <rect className="targa" x="-9" y="-16" width="18" height="12" rx="2" />
          <text className="numero" y="-7">
            {n + 1}
          </text>
        </g>
      ))}
    </svg>
  )
}

// Un testo incollato può contenere più del codice: quello di Condividi e i link lo hanno in fondo.
function pulisciCodice(testo: string) {
  const parole = testo.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  const inFondo = parole.length > 1 ? parole.filter(codiceValido).at(-1) : undefined
  return inFondo ?? parole.join('').slice(0, LUNGHEZZA_CODICE)
}

type PropsHome = {
  invito: string
  codiceProvato: string
  nomeIniziale: string
  messaggio: string | null
  entra: (nome: string, codice: string | null) => void
}

export function Home({ invito, codiceProvato, nomeIniziale, messaggio, entra }: PropsHome) {
  const [nome, setNome] = useState(nomeIniziale)
  const [codice, setCodice] = useState(codiceProvato || invito)
  const [errore, setErrore] = useState<string | null>(null)
  const [erroreCodice, setErroreCodice] = useState<string | null>(null)
  const campoNome = useRef<HTMLInputElement>(null)
  const campoCodice = useRef<HTMLInputElement>(null)
  const avvisoCodice = useRef<HTMLParagraphElement>(null)

  // Con la rete lenta si scrive prima che arrivi il JavaScript: quel testo sta solo nel campo e React non lo conosce.
  // Va ripreso prima che Pagina legga l'indirizzo e la memoria, altrimenti il primo aggiornamento lo cancella.
  useLayoutEffect(() => {
    const nomeScritto = campoNome.current?.value
    const codiceScritto = campoCodice.current?.value
    if (nomeScritto) setNome(nomeScritto)
    if (codiceScritto) setCodice(pulisciCodice(codiceScritto))
  }, [])

  // Nome salvato e invito arrivano appena dopo l'aggancio: non sostituiscono ciò che la persona ha già scritto.
  useEffect(() => {
    if (nomeIniziale) setNome(attuale => attuale || nomeIniziale)
  }, [nomeIniziale])

  useEffect(() => {
    if (invito) setCodice(attuale => (codiceValido(attuale) ? attuale : invito))
  }, [invito])

  useEffect(() => {
    if (erroreCodice) avvisoCodice.current?.scrollIntoView({ block: 'nearest' })
  }, [erroreCodice])

  // Chi arriva dal QR ha già il codice: resta solo da scrivere il nome.
  useEffect(() => {
    if (invito && !nomeIniziale) campoNome.current?.focus()
  }, [invito, nomeIniziale])

  function nomeOk() {
    if (nome.trim()) return true
    setErroreCodice(null)
    setErrore('Scrivi prima il tuo nome')
    campoNome.current?.focus()
    return false
  }

  function crea() {
    if (nomeOk()) entra(nome.trim(), null)
  }

  function unisciti() {
    if (!nomeOk()) return
    if (codiceValido(codice)) return entra(nome.trim(), codice)
    setErrore(null)
    setErroreCodice(codice.length < LUNGHEZZA_CODICE ? `Inserisci il codice della stanza (${LUNGHEZZA_CODICE} caratteri)` : TESTO_CODICE_ERRATO)
    campoCodice.current?.focus()
  }

  // Invio dopo il nome non crea mai una stanza: chi non ha un codice passa al campo del codice.
  function invioSulNome() {
    if (invito || codice) unisciti()
    else campoCodice.current?.focus()
  }

  const creaStanza = (
    <section className="scheda">
      <h2>Crea una stanza</h2>
      <p>Ricevi un codice da dare agli altri. Sarai tu l&apos;host e deciderai quando iniziare.</p>
      <button type="button" className={`tasto grande${invito ? '' : ' primario'}`} onClick={crea}>
        Crea stanza
      </button>
    </section>
  )

  const entraConCodice = (
    <section className="scheda">
      <h2>{invito ? 'Ti hanno invitato' : 'Entra con un codice'}</h2>
      <p>{invito ? (messaggio ? 'Il codice è già scritto.' : 'Il codice è già scritto: premi Entra.') : 'Chiedi il codice a chi ha creato la stanza.'}</p>
      <div className="riga">
        <input
          ref={campoCodice}
          className="input codice"
          type="text"
          aria-label="Codice stanza"
          placeholder="ABCDE"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={codice}
          onChange={e => {
            setErrore(null)
            setErroreCodice(null)
            setCodice(pulisciCodice(e.target.value))
          }}
          onFocus={e => {
            const campo = e.currentTarget
            setTimeout(() => campo.scrollIntoView({ block: 'center' }), 300) // dopo l'apertura della tastiera
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') unisciti()
          }}
        />
        <button type="button" className={`tasto${invito ? ' primario' : ''}`} onClick={unisciti}>
          Entra
        </button>
      </div>
      {/* Qui e non in cima: con la tastiera aperta la cima della pagina è fuori schermo */}
      {erroreCodice && (
        <p ref={avvisoCodice} className="errore" role="alert">
          {erroreCodice}
        </p>
      )}
    </section>
  )

  return (
    <div id="schermo" className="guscio" data-schermata="home">
      <main className="corpo home entrata">
        <header className="home-titolo">
          <Confronto />
          <p className="occhiello">
            Da {MIN_PLAYERS} a {MAX_GIOCATORI} giocatori · solo pulsanti
          </p>
          <h1>
            Sala <em>Sospetti</em>
          </h1>
          <p className="lead">Un gioco di deduzione da fare nella stessa stanza, ognuno col proprio telefono.</p>
        </header>

        {(messaggio || errore) && (
          <p className="errore" role="alert">
            {errore ?? messaggio}
          </p>
        )}

        <label className="campo">
          <span>Il tuo nome</span>
          <input
            ref={campoNome}
            className="input"
            type="text"
            maxLength={NOME_MAX}
            placeholder="Come ti chiamano gli altri?"
            autoCapitalize="words"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint={invito || codice ? 'go' : 'next'}
            value={nome}
            onChange={e => {
              setErrore(null)
              setNome(e.target.value)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') invioSulNome()
            }}
          />
        </label>

        {invito ? entraConCodice : creaStanza}
        <div className="separatore">oppure</div>
        {invito ? creaStanza : entraConCodice}

        <details className="regole">
          <summary>Come si gioca</summary>
          <ListaRegole />
        </details>

        <p className="nota centrata">Apri il sito in Safari o Chrome, non dentro WhatsApp o Instagram.</p>
      </main>
    </div>
  )
}

// ---- Collegamento in corso ----
export function Collegamento({ annulla }: { annulla: () => void }) {
  const lento = useDopo(COLLEGAMENTO_LENTO_MS)
  return (
    <div id="schermo" className="guscio" data-schermata="collegamento">
      <main className="corpo attesa entrata">
        <p className="occhiello">Sala Sospetti</p>
        <h2 className="punti">Mi collego alla stanza</h2>
        <p className="nota">{lento ? 'Non riesco a collegarmi: controlla la connessione. Intanto continuo a provare.' : 'Se la rete è lenta riprovo da solo.'}</p>
        <button type="button" className="tasto" onClick={annulla}>
          Annulla
        </button>
      </main>
    </div>
  )
}

// ---- Uscita in corso: dura finché il server non conferma ----
export function Uscita() {
  return (
    <div id="schermo" className="guscio" data-schermata="uscita">
      <main className="corpo attesa entrata">
        <p className="occhiello">Sala Sospetti</p>
        <h2 className="punti">Esco dalla stanza</h2>
      </main>
    </div>
  )
}

// ---- Barra in alto ----

// Pressione lunga: stesso listener e stessi tempi per tutti. Che il gesto faccia qualcosa lo decide solo chi lo riceve.
function usePressioneLunga(alGesto: () => void) {
  const barra = useRef<HTMLElement>(null)
  const pressione = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const gesto = useRef(alGesto)

  useEffect(() => {
    gesto.current = alGesto
  })

  // Su iPhone Safari può prendersi il tocco prolungato per selezione o menu prima che il timer scatti.
  // React registra touchstart come passivo, quindi serve un listener vero per poterlo fermare.
  useEffect(() => {
    const elemento = barra.current
    if (!elemento) return
    const fermaTocco = (e: TouchEvent) => {
      if (!(e.target as Element).closest('button')) e.preventDefault()
    }
    elemento.addEventListener('touchstart', fermaTocco, { passive: false })
    return () => elemento.removeEventListener('touchstart', fermaTocco)
  }, [])

  function annulla() {
    if (pressione.current) clearTimeout(pressione.current.timer)
    pressione.current = null
  }

  // Conta solo il dito che ha iniziato la pressione: con il telefono in mano un altro dito può già toccare lo schermo.
  function finisce(e: PointerEvent<HTMLElement>) {
    if (pressione.current?.id === e.pointerId) annulla()
  }

  return {
    ref: barra,
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (pressione.current || (e.target as Element).closest('button')) return
      const timer = setTimeout(() => {
        pressione.current = null
        gesto.current()
      }, LONG_PRESS_MS)
      pressione.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer }
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const p = pressione.current
      if (p?.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_PX) annulla()
    },
    onPointerUp: finisce,
    onPointerCancel: finisce,
    onPointerLeave: finisce,
    onContextMenu(e: MouseEvent<HTMLElement>) {
      e.preventDefault()
    },
  }
}

function BarraAlta({ v, gesto, regole, esci }: { v: Vista; gesto: () => void; regole: () => void; esci: () => void }) {
  const pressione = usePressioneLunga(gesto)
  return (
    <header className="barra-alta" {...pressione}>
      <div className="ba-stanza">
        <span className="ba-chiave">Stanza</span>
        <b className="ba-codice">{v.codice}</b>
      </div>
      <div className="ba-io">
        <span data-privato className="ba-nome">
          {v.io.nome}
        </span>
        {!v.io.vivo && <span className="tag morto">Morto</span>}
        {/* Niente Tasto: le regole si leggono anche senza rete */}
        <button type="button" className="tasto in-barra" onClick={regole}>
          Regole
        </button>
        <Tasto className="tasto in-barra" aria-label="Esci dalla stanza" onClick={esci}>
          Esci
        </Tasto>
      </div>
    </header>
  )
}

function BarraVerde({ v }: { v: Vista }) {
  const percento = v.traguardo ? Math.round((100 * v.barra) / v.traguardo) : 0
  return (
    <div className="barra-verde">
      <span className="bv-etichetta">Task completate</span>
      <div className="binario" role="progressbar" aria-label="Task completate" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percento}>
        <div className="riempi" style={{ width: `${percento}%` }}>
          {v.barra > 0 && <span key={v.barra} className="lampo" />}
        </div>
      </div>
      <span className="bv-conta">{v.traguardo ? `${v.barra} / ${v.traguardo}` : '— / —'}</span>
    </div>
  )
}

// ---- Sala d'attesa ----
async function copia(testo: string) {
  try {
    await navigator.clipboard.writeText(testo)
    return true
  } catch {}
  // Su http della rete di casa navigator.clipboard non esiste: resta la copia classica.
  const campo = document.createElement('textarea')
  campo.value = testo
  campo.style.position = 'fixed'
  campo.style.opacity = '0'
  document.body.append(campo)
  campo.select()
  let riuscita = false
  try {
    riuscita = document.execCommand('copy')
  } catch {}
  campo.remove()
  return riuscita
}

// Il QR è il modo più rapido di entrare in 15. La libreria arriva solo qui, mai col primo caricamento.
function Qr({ testo }: { testo: string }) {
  const [disegno, setDisegno] = useState<{ d: string; lato: number } | null>(null)

  useEffect(() => {
    let attuale = true
    import('uqr')
      .then(({ encode }) => {
        if (!attuale) return
        const { data, size } = encode(testo, { ecc: 'M', border: 0 })
        let d = ''
        data.forEach((riga, y) =>
          riga.forEach((pieno, x) => {
            if (pieno) d += `M${x} ${y}h1v1h-1z`
          }),
        )
        setDisegno({ d, lato: size })
      })
      .catch(() => {}) // Senza QR resta il codice
    return () => {
      attuale = false
    }
  }, [testo])

  return (
    <div className="qr" role="img" aria-label="QR per entrare nella stanza">
      {disegno && (
        <svg viewBox={`0 0 ${disegno.lato} ${disegno.lato}`}>
          <path d={disegno.d} />
        </svg>
      )}
    </div>
  )
}

function Invito({ v, avvisa }: { v: VistaSala; avvisa: Avvisa }) {
  const link = linkStanza(v.codice)

  async function copiaCodice() {
    avvisa((await copia(v.codice)) ? 'Codice copiato' : 'Non riesco a copiare: dettalo ad alta voce')
  }

  async function condividi() {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Sala Sospetti', text: `Entra nella stanza ${v.codice}`, url: link })
      } catch {} // Chi chiude il pannello di condivisione non ha sbagliato nulla
      return
    }
    avvisa((await copia(link)) ? 'Link copiato' : 'Non riesco a copiare: dettalo ad alta voce')
  }

  return (
    <section className={v.io.host ? 'invito' : 'invito compatto'}>
      {v.io.host && <Qr testo={link} />}
      <div className="invito-dati">
        <span className="occhiello">Codice stanza</span>
        <b className="codice-grande">{v.codice}</b>
        <div className="invito-tasti">
          <Tasto className="tasto piccolo" onClick={copiaCodice}>
            Copia
          </Tasto>
          <Tasto className="tasto piccolo" onClick={condividi}>
            Condividi
          </Tasto>
        </div>
      </div>
    </section>
  )
}

function NumeroTask({ v, comanda }: { v: VistaSala; comanda: Comanda }) {
  const collegato = useContext(Collegato)
  const [bozza, setBozza] = useState<string | null>(null)

  function conferma() {
    if (bozza === null) return
    const numero = Number(bozza)
    if (Number.isSafeInteger(numero) && numero >= TASKS_MIN) comanda({ a: 'impostaTask', x: numero })
    setBozza(null)
  }

  return (
    <div className="contatore">
      <Tasto className="tasto" aria-label="Diminuisci" disabled={v.numeroTask <= TASKS_MIN} onClick={() => comanda({ a: 'impostaTask', x: v.numeroTask - 1 })}>
        −
      </Tasto>
      <input
        className="input numero"
        type="number"
        inputMode="numeric"
        enterKeyHint="done"
        min={TASKS_MIN}
        step={1}
        aria-label="Numero task"
        disabled={!collegato}
        value={bozza ?? v.numeroTask}
        onChange={e => setBozza(e.target.value)}
        onBlur={conferma}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <Tasto className="tasto" aria-label="Aumenta" onClick={() => comanda({ a: 'impostaTask', x: v.numeroTask + 1 })}>
        +
      </Tasto>
    </div>
  )
}

function Impostazioni({ v, comanda }: { v: VistaSala; comanda: Comanda }) {
  const scelte = Array.from({ length: ASSASSINI_SCEGLIBILI }, (_, i) => i + 1)
  const barra = (
    <>
      La barra si riempie dopo <b>{v.traguardoPrevisto}</b> {v.traguardoPrevisto === 1 ? 'task fatta' : 'task fatte'} in tutto.
    </>
  )

  if (!v.io.host) {
    return (
      <p className="nota">
        {barra} Assassini in gioco: <b>{v.numeroAssassini}</b>.
      </p>
    )
  }

  return (
    <section className="impostazioni">
      <div className="impostazione">
        <span className="occhiello">Numero task</span>
        <NumeroTask v={v} comanda={comanda} />
      </div>
      <div className="impostazione">
        <span className="occhiello">Assassini</span>
        <div className="selettore" role="group" aria-label="Numero di assassini">
          {scelte.map(n => (
            <Tasto
              key={n}
              className="tasto"
              aria-pressed={v.numeroAssassini === n}
              disabled={n > v.maxAssassini}
              onClick={() => comanda({ a: 'impostaAssassini', x: n })}
            >
              {n}
            </Tasto>
          ))}
        </div>
      </div>
      <p className="nota">
        Più task scegli, più dura la partita. {barra}
        {v.maxAssassini < ASSASSINI_SCEGLIBILI && ' Per 2 assassini servono almeno 5 giocatori.'}
        {v.giocatori.length >= 10 && v.numeroAssassini === 1 && ' Con 10 o più giocatori conviene sceglierne 2.'}
      </p>
    </section>
  )
}

type PropsSala = { v: VistaSala; comanda: Comanda; avvisa: Avvisa; togli: (id: number) => void; chiediStart: () => void }

function Sala({ v, comanda, avvisa, togli, chiediStart }: PropsSala) {
  const pochi = v.giocatori.length < v.minGiocatori
  const nomeHost = v.giocatori.find(g => g.host)?.nome ?? '?'
  const connessi = v.giocatori.filter(g => !g.offline).length

  const invito = <Invito v={v} avvisa={avvisa} />
  const impostazioni = <Impostazioni v={v} comanda={comanda} />
  const elenco = (
    <section className="elenco">
      <p className="occhiello">Giocatori</p>
      <ul className="griglia">
        {v.giocatori.map(g => (
          <Cella
            key={g.id}
            g={g}
            nota={
              (g.host || g.offline) && (
                <>
                  {g.host && <span className="ospite">Host</span>}
                  {g.host && g.offline && ' · '}
                  {g.offline && 'senza segnale'}
                </>
              )
            }
          >
            {g.id === v.io.id && <span className="tag tu">Tu</span>}
            {v.io.host && g.offline && g.id !== v.io.id && (
              <Tasto className="tasto togli" onClick={() => togli(g.id)}>
                Togli
              </Tasto>
            )}
          </Cella>
        ))}
      </ul>
      <p className="nota punti">In attesa di altri giocatori</p>
    </section>
  )

  return (
    <>
      <main className="corpo entrata">
        <header className="testa-sala">
          <div className="testa">
            <p className="occhiello">Sala d&apos;attesa</p>
            <h2>Aspettiamo gli altri</h2>
          </div>
          <p className="presenti">
            <b className="mono">{connessi}</b>
            <span>{connessi === 1 ? 'connesso' : 'connessi'}</span>
          </p>
        </header>
        {/* L'host deve far entrare gli altri; chi aspetta vuole sapere chi c'è */}
        {v.io.host ? (
          <>
            {invito}
            {impostazioni}
            {elenco}
          </>
        ) : (
          <>
            {elenco}
            {impostazioni}
            {invito}
          </>
        )}
        <p className="avviso-fisso">Disattiva il risparmio energetico e tieni lo schermo acceso.</p>
      </main>
      <footer className="piede">
        {v.io.host ? (
          <>
            <Tasto className="tasto verde grande" disabled={pochi} onClick={chiediStart}>
              Start
            </Tasto>
            <p className="nota centrata">
              {pochi
                ? `Servono almeno ${v.minGiocatori} giocatori per iniziare.`
                : 'Con Start ognuno vedrà il suo ruolo sul telefono.'}
            </p>
          </>
        ) : (
          <p className="avviso-fisso">
            Solo l&apos;host (<b>{nomeHost}</b>) può avviare la partita.
          </p>
        )}
      </footer>
    </>
  )
}

// ---- Rivelazione: unica schermata in cui il ruolo si vede ----
function Ruolo({ v, comanda, avvisa }: { v: VistaRuolo; comanda: Comanda; avvisa: Avvisa }) {
  const assassino = v.ruolo === 'assassino'
  const pronto = useDopo(BLOCCO_RUOLO_MS)
  const conferma = useConferma(v.schermata, () => {}, () => avvisa(TESTO_PERSO)) // se arriva, questa schermata sparisce

  // Chi legge il ruolo tiene ferma la riunione senza saperlo: segnale e avviso, come per chi è già in partita.
  useEffect(() => {
    if (v.riunioneAperta) segnaleRiunione()
  }, [v.riunioneAperta])

  return (
    <>
      <main className="corpo entrata">
        <section className={`fascicolo ${v.ruolo}`}>
          <p className="occhiello">Il tuo ruolo</p>
          <h2 className="timbro">{nomeRuolo(v.ruolo)}</h2>
          {assassino ? (
            <>
              {v.complici.length > 0 && (
                <p>
                  Complici: <b>{v.complici.join(', ')}</b>
                </p>
              )}
              <p>Elimina i civili di persona e di nascosto, senza farti scoprire. Chi elimini premerà «Sono morto».</p>
              <p>
                Dopo Ho capito, <b>tieni premuta per un secondo la barra in alto con il codice stanza</b>: si apre il riquadro Uccidi. Per
                gli altri quel gesto non fa nulla.
              </p>
              <p>
                <b>Elimina solo quando il riquadro dice «pronto»</b>, poi premi Uccidi: all&apos;inizio, dopo ogni eliminazione e dopo ogni
                riunione si aspettano {minuti(KILL_CD)} minuti.
              </p>
              <p>Attenzione: anche le tue spunte riempiono la barra dei civili.</p>
            </>
          ) : (
            <>
              <p>Completa le task e scopri chi sono gli assassini. Se ti eliminano, premi «Sono morto» e non dire chi è stato.</p>
              <p>
                Tra voi{' '}
                {v.assassini === 1 ? (
                  <>
                    c&apos;è <b>1 assassino</b>
                  </>
                ) : (
                  <>
                    ci sono <b>{v.assassini} assassini</b>
                  </>
                )}
                .
              </p>
            </>
          )}
        </section>
        <p className="nota centrata">Non mostrare lo schermo agli altri. Le regole restano nel tasto Regole, qui in alto.</p>
      </main>
      <footer className="piede">
        {v.riunioneAperta && (
          <p className="avviso-fisso caldo" role="status">
            Hanno aperto una riunione: premi Ho capito e raggiungi gli altri.
          </p>
        )}
        <Tasto
          className="tasto primario grande"
          disabled={!pronto}
          onClick={() => {
            comanda({ a: 'ruoloVisto' })
            conferma()
          }}
        >
          Ho capito
        </Tasto>
      </footer>
    </>
  )
}

// ---- Partita ----

// Montato solo dopo il gesto di un assassino vivo: per tutti gli altri questo nodo non esiste.
function RiquadroUccidi({ uccidiDa, ora, comanda }: { uccidiDa: number; ora: number; comanda: Comanda }) {
  const attesa = uccidiDa - ora
  const [perso, setPerso] = useState(false)
  const conferma = useConferma(uccidiDa, () => {}, () => setPerso(true))
  return (
    <section className="uccidi">
      <div className="uccidi-testa">
        <p className="occhiello">Solo tu vedi questo riquadro</p>
        <span className="mono uccidi-stato">{attesa > 0 ? `pronto tra ${mmss(attesa)}` : 'pronto'}</span>
      </div>
      <Tasto
        className="tasto pericolo grande"
        disabled={attesa > 0}
        onClick={() => {
          setPerso(false)
          comanda({ a: 'uccidi' })
          conferma()
        }}
      >
        Uccidi
      </Tasto>
      {perso && <p className="uccidi-perso">{TESTO_PERSO}</p>}
      <p className="nota uccidi-spiega">
        Elimina solo quando è pronto, poi premilo: riparte l&apos;attesa di {minuti(KILL_CD)} minuti. Tieni premuta la barra col codice
        stanza per nasconderlo.
      </p>
    </section>
  )
}

type PropsPartita = {
  v: VistaPartita
  ora: number
  comanda: Comanda
  avvisa: Avvisa
  sonoMorto: () => void
  uccidiVisibile: boolean
}

function Partita({ v, ora, comanda, avvisa, sonoMorto, uccidiVisibile }: PropsPartita) {
  const morto = !v.io.vivo
  // Una riunione aperta cambia la fase e toglie di mezzo questa schermata. Per Fatto vale solo taskDa: la barra cresce anche con gli altri.
  const confermaRiunione = useConferma(v.f, () => {}, () => avvisa(TESTO_PERSO))
  const confermaTask = useConferma(v.taskDa, () => {}, () => avvisa(TESTO_PERSO))
  const attesaEmergency = v.emergencyDa - ora
  const inAttesa = v.taskFatta !== null && ora < v.taskDa
  const testoTask = inAttesa ? v.taskFatta : v.task
  const chiEmergency = v.emergencyDaId === v.io.id ? 'te' : v.emergencyDaNome

  return (
    <>
      <main className="corpo entrata">
        {morto && (
          <p className="avviso-fisso caldo">Sei fuori dalle votazioni. Puoi continuare a fare le task, ma non puoi più segnalare né votare.</p>
        )}
        <div className="partita">
          <div className="azioni">
            <div className="azione">
              <Tasto
                className="tondo report"
                aria-label="Report"
                disabled={morto}
                onClick={() => {
                  comanda({ a: 'report' })
                  confermaRiunione()
                }}
              >
                <IconaReport />
              </Tasto>
              <span className="az-nome">Report</span>
              <span className="az-spiega">Hai trovato un morto? Premi e si vota.</span>
              <span className="az-stato">{morto ? 'non disponibile' : 'sempre disponibile'}</span>
            </div>
            <div className="azione">
              <Tasto
                className="tondo emergency"
                aria-label="Emergency meeting"
                disabled={morto || attesaEmergency > 0}
                onClick={() => {
                  comanda({ a: 'emergency' })
                  confermaRiunione()
                }}
              >
                <IconaCampana />
              </Tasto>
              <span className="az-nome">Emergency</span>
              <span className="az-spiega">Sospetti qualcuno? Riunione e si vota.</span>
              <span className="az-stato" data-privato>
                {morto ? 'non disponibile' : attesaEmergency > 0 ? `disponibile tra ${mmss(attesaEmergency)}` : 'disponibile'}
              </span>
            </div>
          </div>
          <div className="colonna-task">
            {chiEmergency && (
              <p className="nota centrata">
                Ultima riunione d&apos;emergenza convocata da <span data-privato>{chiEmergency}</span>.
              </p>
            )}
            <section className="task">
              <div data-privato className="task-dentro">
                <div>
                  <p className="occhiello">La tua task</p>
                  <p className="task-testo">{testoTask}</p>
                  <p className="nota">{inAttesa ? 'Prossima task appena finisce il timer.' : 'Premi Fatto quando hai finito: la barra verde cresce per tutti.'}</p>
                </div>
                {inAttesa ? (
                  <div className="spunta fatta" role="timer">
                    <IconaSpunta />
                    <span className="mono">{mmss(v.taskDa - ora)}</span>
                  </div>
                ) : (
                  <Tasto
                    className="spunta"
                    aria-label="Segna la task come fatta"
                    onClick={() => {
                      comanda({ a: 'spunta' })
                      confermaTask()
                    }}
                  >
                    Fatto
                  </Tasto>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
      <footer className="piede">
        {uccidiVisibile && v.uccidiDa !== undefined && <RiquadroUccidi uccidiDa={v.uccidiDa} ora={ora} comanda={comanda} />}
        <Tasto className="tasto grande tratteggiato" disabled={morto} onClick={sonoMorto}>
          {morto ? 'Fuori dalle votazioni' : 'Sono morto'}
        </Tasto>
        {!morto && <p className="nota centrata spiega-morto">Premilo se un assassino ti ha eliminato: uscirai dalle votazioni.</p>}
      </footer>
    </>
  )
}

// ---- Riunione: il tocco sceglie l'intera cella, il tasto fisso in basso conferma ----
type PropsRiunione = { v: VistaRiunione; comanda: Comanda; avvisa: Avvisa; sonoMorto: () => void; togli: (id: number) => void }

function Riunione({ v, comanda, avvisa, sonoMorto, togli }: PropsRiunione) {
  const [scelta, setScelta] = useState<Voto | null>(null)
  const pronto = useDopo(BLOCCO_RIUNIONE_MS)
  const conferma = useConferma(v.mioVoto, () => {}, () => avvisa(TESTO_PERSO))
  const posso = v.io.vivo && v.mioVoto === null
  const scelto = v.giocatori.find(g => g.id === scelta && g.id !== v.io.id)
  const salto = scelta === 'salta'
  const votato = v.giocatori.find(g => g.id === v.mioVoto)
  const nomeTipo = v.tipo === 'emergency' ? 'Emergency' : 'Report'

  return (
    <>
      {/* Per un secondo a tutto schermo, uguale per tutti: nome compreso, che qui non diventa mai «te» */}
      <div className="annuncio" aria-hidden="true">
        <b>{nomeTipo}</b>
        <span>Convocata da {v.daNome}</span>
      </div>
      <main className="corpo riunione entrata">
        <div className="striscia" aria-hidden="true" />
        <header className="testa-riunione">
          <div className="testa">
            <p className="occhiello">{nomeTipo}</p>
            <h2>Chi è l&apos;assassino?</h2>
          </div>
          <Tasto className="tasto piccolo tratteggiato" disabled={!v.io.vivo} onClick={sonoMorto}>
            {v.io.vivo ? 'Sono morto' : 'Sei fuori'}
          </Tasto>
        </header>
        <p className="nota nota-riunione">
          Convocata da <span data-privato>{v.daId === v.io.id ? 'te' : v.daNome}</span>.
          {v.tipo === 'emergency' && ' Il pulsante Emergency resta bloccato per 10 minuti.'}
        </p>
        <div className="conto">
          <span>Hanno votato</span>
          <span className="mono">
            {v.votati} / {v.totale}
          </span>
        </div>
        <ul className="griglia scorre">
          {v.giocatori.map(g => {
            const mia = g.id === v.io.id
            return (
              <Cella
                key={g.id}
                g={g}
                nota={g.offline ? 'senza segnale' : undefined}
                fine={
                  g.haVotato && (
                    <span className="segno" role="img" aria-label="ha votato">
                      <IconaSpunta />
                    </span>
                  )
                }
              >
                {mia && <span className="tag tu">Tu</span>}
                {posso && !mia && (
                  <Tasto className="copri" aria-label={`Scegli ${g.nome}`} aria-pressed={scelta === g.id} onClick={() => setScelta(g.id)} />
                )}
                {v.io.host && g.offline && !mia && (
                  <Tasto className="tasto togli" onClick={() => togli(g.id)}>
                    Togli
                  </Tasto>
                )}
              </Cella>
            )
          })}
        </ul>
        {v.fuori.length > 0 && <p className="nota fuori">Fuori dalle votazioni: {v.fuori.join(', ')}</p>}
      </main>
      <footer className="piede">
        <div data-privato className="piede-voto">
          {v.rivota && posso && <p className="avviso-fisso caldo">La persona che avevi votato non è più in gioco: vota di nuovo.</p>}
          {posso && (
            <>
              <p className="scelta">
                {salto && 'Hai scelto: salta il voto'}
                {!salto && scelto && (
                  <>
                    Hai scelto: <b>{scelto.nome}</b>
                  </>
                )}
                {!salto && !scelto && 'Tocca un nome per votare'}
              </p>
              <div className="conferma">
                <Tasto className="tasto" aria-pressed={salto} disabled={!pronto} onClick={() => setScelta(salto ? null : 'salta')}>
                  Salta il voto
                </Tasto>
                <Tasto
                  className="tasto primario"
                  disabled={!pronto || !(salto || scelto)}
                  onClick={() => {
                    if (salto) comanda({ a: 'vota', x: 'salta' })
                    else if (scelto) comanda({ a: 'vota', x: scelto.id })
                    conferma()
                  }}
                >
                  Conferma
                </Tasto>
              </div>
            </>
          )}
          {!posso && v.io.vivo && (
            <p className="avviso-fisso">
              {v.mioVoto === 'salta' ? 'Hai votato di saltare.' : `Hai votato ${votato?.nome ?? ''}.`}{' '}
              {/* Chi rivota resta contato: il conto pieno a riunione aperta vuol dire proprio questo */}
              {v.votati === v.totale ? 'Qualcuno deve votare di nuovo: controllate tutti il telefono.' : 'In attesa degli altri.'}
            </p>
          )}
          {!v.io.vivo && <p className="avviso-fisso">Sei fuori dalle votazioni: guardi senza votare.</p>}
        </div>
      </footer>
    </>
  )
}

// ---- Esito: il risultato sta in alto, perché resta a schermo solo pochi secondi ----
function Esito({ v, ora }: { v: VistaEsito; ora: number }) {
  // Chi ha preso voti per primo: in caso di parità i due nomi devono stare a vista.
  const votanti = [...v.votanti].sort((a, b) => b.voti - a.voti)
  const pariConISalti = v.parita && v.salti === votanti[0]?.voti

  return (
    <main className="corpo esito entrata">
      <div className="striscia" aria-hidden="true" />
      <section className="risultato">
        {v.eliminatoNome ? (
          <>
            <h2>{v.eliminatoNome} è fuori dal gioco</h2>
            {v.eliminatoRuolo && <p className={`timbro ${v.eliminatoRuolo}`}>{nomeRuolo(v.eliminatoRuolo)}</p>}
          </>
        ) : (
          <>
            <h2>Nessuno è stato eliminato</h2>
            <p className="nota">{pariConISalti ? 'Tanti voti quanti salti: non esce nessuno.' : v.parita ? 'Parità di voti.' : 'I salti sono più dei voti.'}</p>
          </>
        )}
        {v.vincitore === 'civili' && (
          <p className="esito-civili">{v.eliminatoRuolo === 'assassino' ? "Era l'ultimo assassino in gioco." : 'Non ci sono più assassini in gioco.'}</p>
        )}
        {v.vincitore === 'assassini' && <p className="esito-assassini">Gli assassini ora sono tanti quanti i civili rimasti.</p>}
        <p className="nota">
          {v.vincitore ? 'Fine partita tra' : 'Si torna in partita tra'}{' '}
          <span data-privato className="mono">
            {secondiDa(v.scadenza, ora)}
          </span>{' '}
          s
        </p>
      </section>
      <ul className="griglia">
        {votanti.map(g => (
          <Cella key={g.id} g={g} classe={g.id === v.eliminatoId ? 'eliminata' : undefined} nota={`${g.voti} ${g.voti === 1 ? 'voto' : 'voti'}`}>
            {g.id === v.io.id && <span className="tag tu">Tu</span>}
          </Cella>
        ))}
      </ul>
      {v.salti > 0 && <p className="nota">Hanno saltato il voto: {v.salti}</p>}
      {v.fuori.length > 0 && <p className="nota">Fuori dalle votazioni: {v.fuori.join(', ')}</p>}
    </main>
  )
}

// ---- Fine partita ----
function Fine({ v, ora }: { v: VistaFine; ora: number }) {
  const spiegazione = {
    barra: 'La barra delle task è piena: tutte le task sono state completate.',
    assassini: 'Non ci sono più assassini in gioco.',
    maggioranza: 'Gli assassini sono tanti quanti i civili rimasti, o di più.',
  }[v.motivo]

  // È la domanda che si fanno tutti, e la schermata dura pochi secondi: la risposta sta in alto e gli assassini in testa alla lista.
  const assassini = v.giocatori.filter(g => g.ruolo === 'assassino')
  const elenco = [...assassini, ...v.giocatori.filter(g => g.ruolo !== 'assassino')]
  const nomi = assassini.map(g => g.nome).join(' e ')

  return (
    <main className="corpo entrata">
      <section className={`fascicolo ${v.vincitore === 'civili' ? 'civile' : 'assassino'}`}>
        <p className="occhiello">Fine partita</p>
        <h2 className="vittoria">{v.vincitore === 'civili' ? 'I civili hanno vinto' : 'Gli assassini hanno vinto'}</h2>
        {assassini.length > 0 && <p className="svelati">{assassini.length === 1 ? `L’assassino era ${nomi}` : `Gli assassini erano ${nomi}`}</p>}
        <p>{spiegazione}</p>
        <p className="nota">
          Si torna in sala d&apos;attesa tra{' '}
          <span data-privato className="mono">
            {secondiDa(v.scadenza, ora)}
          </span>{' '}
          s
        </p>
      </section>
      <p className="occhiello">I ruoli erano</p>
      <ul className="griglia">
        {elenco.map(g => (
          <Cella key={g.id} g={g} classe={g.vivo ? undefined : 'eliminata'} nota={<span className={g.ruolo}>{nomeRuolo(g.ruolo)}</span>}>
            {g.id === v.io.id && <span className="tag tu">Tu</span>}
          </Cella>
        ))}
      </ul>
    </main>
  )
}

// ---- Dialoghi: esistono solo da aperti, e un cambio di fase li chiude ----
type Domanda = { tipo: 'morto' } | { tipo: 'esci' } | { tipo: 'togli'; id: number } | { tipo: 'start' } | { tipo: 'regole' }

type PropsDialogo = { titolo: string; testo: string; no: string; si: string; verde?: boolean; alNo: () => void; alSi: () => void }

function Dialogo({ titolo, testo, no, si, verde, alNo, alSi }: PropsDialogo) {
  return (
    <div className="velo">
      <div className="dialogo" role="dialog" aria-modal="true" aria-labelledby="titolo-dialogo">
        <h2 id="titolo-dialogo">{titolo}</h2>
        <p>{testo}</p>
        <div className="conferma pari">
          <Tasto className="tasto" onClick={alNo}>
            {no}
          </Tasto>
          <Tasto className={verde ? 'tasto verde' : 'tasto pericolo'} onClick={alSi}>
            {si}
          </Tasto>
        </div>
      </div>
    </div>
  )
}

// Niente Tasto: come il tasto Regole, funziona anche senza rete.
function DialogoRegole({ chiudi }: { chiudi: () => void }) {
  return (
    <div className="velo">
      <div className="dialogo" role="dialog" aria-modal="true" aria-labelledby="titolo-dialogo">
        <h2 id="titolo-dialogo">Come si gioca</h2>
        <div className="dialogo-scorre">
          <ListaRegole />
        </div>
        <button type="button" className="tasto primario" onClick={chiudi}>
          Chiudi
        </button>
      </div>
    </div>
  )
}

function testoUscita(v: Vista) {
  const inPartita = v.schermata !== 'sala' && v.schermata !== 'fine'
  const base = inPartita ? 'La partita continua senza di te: non potrai più rientrare in questa partita.' : 'Tornerai alla schermata iniziale.'
  return v.io.host && v.presenti > 1 ? `${base} Il ruolo di host passerà a un altro giocatore.` : base
}

// ---- Banner di rete: uguale per tutti ----
function BannerRete({ rete, riprova }: { rete: StatoRete; riprova: () => void }) {
  if (rete === 'ok') return null
  if (rete === 'persa') {
    return (
      <p className="banner-rete punti" role="status">
        Connessione persa. Mi ricollego
      </p>
    )
  }
  return (
    <button type="button" className="banner-rete" onClick={riprova}>
      La stanza è aperta in un&apos;altra scheda. Tocca qui per riprenderla.
    </button>
  )
}

// ---- Radice del gioco ----
type PropsGioco = {
  v: Vista
  rete: StatoRete
  comanda: Comanda
  adesso: () => number
  esci: () => void
  avvisa: Avvisa
  riprova: () => void
}

export function Gioco({ v, rete, comanda, adesso, esci, avvisa, riprova }: PropsGioco) {
  const [domanda, setDomanda] = useState<(Domanda & { f: number }) | null>(null)
  const [uccidiF, setUccidiF] = useState<number | null>(null) // contatore di fase in cui Uccidi è stato aperto: mai salvato

  useBattito(v.schermata === 'partita' || v.schermata === 'esito' || v.schermata === 'fine')
  const ora = adesso()

  // La fase cambia a ogni riunione, quindi il riquadro aperto nella fase precedente si richiude da solo.
  const uccidiVisibile = v.schermata === 'partita' && v.uccidiDa !== undefined && uccidiF === v.f
  const gesto = () => {
    if (v.schermata === 'partita' && v.uccidiDa !== undefined) setUccidiF(uccidiVisibile ? null : v.f)
  }

  const chiedi = (d: Domanda) => setDomanda({ ...d, f: v.f })
  const chiudi = () => setDomanda(null)
  const aperta = domanda?.f === v.f ? domanda : null
  const daTogliere = aperta?.tipo === 'togli' && (v.schermata === 'sala' || v.schermata === 'riunione') ? v.giocatori.find(g => g.id === aperta.id && g.offline) : undefined
  const puoPartire = v.schermata === 'sala' && v.io.host && v.giocatori.length >= v.minGiocatori

  // Una domanda che non ha più senso si chiude per sempre, altrimenti tornerebbe da sola quando riacquista senso.
  const superata = (aperta?.tipo === 'togli' && !daTogliere) || (aperta?.tipo === 'start' && !puoPartire)
  useEffect(() => {
    if (superata) setDomanda(null)
  }, [superata])

  const conferma = useConferma(
    v.io.vivo,
    () => avvisa('Sei fuori dalle votazioni per il resto della partita'),
    () => avvisa(TESTO_PERSO),
  )

  const chiediMorto = () => chiedi({ tipo: 'morto' })
  const chiediTogli = (id: number) => chiedi({ tipo: 'togli', id })

  return (
    <Collegato.Provider value={rete === 'ok'}>
      <div id="schermo" className="guscio" data-schermata={v.schermata} data-tipo={'tipo' in v ? v.tipo : undefined}>
        <BarraAlta v={v} gesto={gesto} regole={() => chiedi({ tipo: 'regole' })} esci={() => chiedi({ tipo: 'esci' })} />
        <BarraVerde v={v} />

        {v.schermata === 'sala' && <Sala v={v} comanda={comanda} avvisa={avvisa} togli={chiediTogli} chiediStart={() => chiedi({ tipo: 'start' })} />}
        {v.schermata === 'ruolo' && <Ruolo v={v} comanda={comanda} avvisa={avvisa} />}
        {v.schermata === 'partita' && <Partita key={v.f} v={v} ora={ora} comanda={comanda} avvisa={avvisa} sonoMorto={chiediMorto} uccidiVisibile={uccidiVisibile} />}
        {v.schermata === 'riunione' && <Riunione key={v.f} v={v} comanda={comanda} avvisa={avvisa} sonoMorto={chiediMorto} togli={chiediTogli} />}
        {v.schermata === 'esito' && <Esito v={v} ora={ora} />}
        {v.schermata === 'fine' && <Fine v={v} ora={ora} />}

        {aperta?.tipo === 'morto' && (
          <Dialogo
            titolo="Ti hanno eliminato?"
            testo="Per il resto della partita non potrai votare né ricevere voti, e non potrai più segnalare o convocare riunioni. Le task puoi continuare a farle. Non si torna indietro."
            no="Annulla"
            si="Sì, sono morto"
            alNo={chiudi}
            alSi={() => {
              comanda({ a: 'sonoMorto' })
              conferma()
              chiudi()
            }}
          />
        )}
        {aperta?.tipo === 'esci' && (
          <Dialogo titolo="Uscire dalla stanza?" testo={testoUscita(v)} no="Resta" si="Esci" alNo={chiudi} alSi={esci} />
        )}
        {aperta?.tipo === 'start' && puoPartire && (
          <Dialogo
            titolo={`Si parte in ${v.giocatori.length}?`}
            testo="Dopo lo Start nessun altro potrà entrare fino alla fine della partita."
            no="Aspetta"
            si="Si parte"
            verde
            alNo={chiudi}
            alSi={() => {
              comanda({ a: 'start' })
              chiudi()
            }}
          />
        )}
        {aperta?.tipo === 'regole' && <DialogoRegole chiudi={chiudi} />}
        {daTogliere && (
          <Dialogo
            titolo={`Togliere ${daTogliere.nome}?`}
            testo="È senza segnale da un po'. Uscirà dalla stanza come se avesse premuto Esci."
            no="Annulla"
            si="Togli"
            alNo={chiudi}
            alSi={() => {
              comanda({ a: 'togli', x: daTogliere.id })
              chiudi()
            }}
          />
        )}
        <BannerRete rete={rete} riprova={riprova} />
      </div>
    </Collegato.Provider>
  )
}
