// Tutte le schermate del gioco: React disegna la vista che arriva dal server e non decide nessuna regola.
//
// Vincolo: civile e assassino vedono lo stesso identico schermo finché l'assassino non apre il riquadro Uccidi.
// Quindi fuori da Ruolo nessun nodo dipende dal ruolo, e tutto ciò che cambia da un giocatore all'altro
// (nome proprio, task, timer, «Tu», tasti di voto) vive dentro un elemento con l'attributo data-privato.
import { createContext, useContext, useEffect, useReducer, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  ASSASSINI_SCEGLIBILI,
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
} from '../gioco/regole.ts'
import { linkStanza } from './connessione.ts'
import type { Comando, StatoRete } from './connessione.ts'

type Comanda = (comando: Comando) => void
type Avvisa = (testo: string) => void

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

type PropsHome = {
  invito: string
  nomeIniziale: string
  messaggio: string | null
  entra: (nome: string, codice: string | null) => void
}

export function Home({ invito, nomeIniziale, messaggio, entra }: PropsHome) {
  const [nome, setNome] = useState(nomeIniziale)
  const [codice, setCodice] = useState(invito)
  const [errore, setErrore] = useState<string | null>(null)
  const campoNome = useRef<HTMLInputElement>(null)
  const campoCodice = useRef<HTMLInputElement>(null)

  // Chi arriva dal QR ha già il codice: resta solo da scrivere il nome.
  useEffect(() => {
    if (invito && !nomeIniziale) campoNome.current?.focus()
  }, [invito, nomeIniziale])

  function nomeOk() {
    if (nome.trim()) return true
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
    setErrore(`Inserisci il codice della stanza (${LUNGHEZZA_CODICE} caratteri)`)
    campoCodice.current?.focus()
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
      <p>{invito ? 'Il codice è già scritto: premi Entra.' : 'Chiedi il codice a chi ha creato la stanza.'}</p>
      <div className="riga">
        <input
          ref={campoCodice}
          className="input codice"
          type="text"
          aria-label="Codice stanza"
          maxLength={LUNGHEZZA_CODICE}
          placeholder="ABCDE"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={codice}
          onChange={e => {
            setErrore(null)
            setCodice(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
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
            enterKeyHint="go"
            value={nome}
            onChange={e => {
              setErrore(null)
              setNome(e.target.value)
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              if (codice) unisciti()
              else crea()
            }}
          />
        </label>

        {invito ? entraConCodice : creaStanza}
        <div className="separatore">oppure</div>
        {invito ? creaStanza : entraConCodice}

        <details className="regole">
          <summary>Come si gioca</summary>
          <ul>
            <li>Ognuno riceve in segreto un ruolo: civile o assassino.</li>
            <li>Tutti hanno delle task da fare davvero, in casa. Ogni spunta fa crescere la barra verde.</li>
            <li>
              Gli assassini eliminano di nascosto. Chi viene eliminato preme <b>Sono morto</b>.
            </li>
            <li>
              Hai trovato un morto? <b>Report</b>. Sospetti qualcuno? <b>Emergency</b>. Si vota e chi prende più voti è
              fuori.
            </li>
            <li>I civili vincono con la barra piena o senza più assassini. Gli assassini vincono se pareggiano i civili.</li>
          </ul>
        </details>

        <p className="nota centrata">Apri il sito in Safari o Chrome, non dentro WhatsApp o Instagram.</p>
      </main>
    </div>
  )
}

// ---- Collegamento in corso ----
export function Collegamento({ annulla }: { annulla: () => void }) {
  return (
    <div id="schermo" className="guscio" data-schermata="collegamento">
      <main className="corpo attesa entrata">
        <p className="occhiello">Sala Sospetti</p>
        <h2 className="punti">Mi collego alla stanza</h2>
        <p className="nota">Se la rete è lenta riprovo da solo.</p>
        <button type="button" className="tasto" onClick={annulla}>
          Annulla
        </button>
      </main>
    </div>
  )
}

// ---- Barra in alto ----

// Pressione lunga: stesso listener e stessi tempi per tutti. Che il gesto faccia qualcosa lo decide solo chi lo riceve.
function usePressioneLunga(alGesto: () => void) {
  const barra = useRef<HTMLElement>(null)
  const pressione = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
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

  return {
    ref: barra,
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (!e.isPrimary || (e.target as Element).closest('button')) return
      annulla()
      const timer = setTimeout(() => {
        pressione.current = null
        gesto.current()
      }, LONG_PRESS_MS)
      pressione.current = { x: e.clientX, y: e.clientY, timer }
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const p = pressione.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_PX) annulla()
    },
    onPointerUp: annulla,
    onPointerCancel: annulla,
    onPointerLeave: annulla,
    onContextMenu(e: MouseEvent<HTMLElement>) {
      e.preventDefault()
    },
  }
}

function BarraAlta({ v, gesto, esci }: { v: Vista; gesto: () => void; esci: () => void }) {
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
        <Tasto className="tasto esci" aria-label="Esci dalla stanza" onClick={esci}>
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
    <section className="invito">
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
  const giocatori = v.giocatori.length
  const assassini = `${v.numeroAssassini} assassin${v.numeroAssassini === 1 ? 'o' : 'i'}`
  const scelte = Array.from({ length: ASSASSINI_SCEGLIBILI }, (_, i) => i + 1)
  return (
    <section className="impostazioni">
      <div className="impostazione" data-privato>
        <span className="occhiello">Numero task</span>
        {v.io.host ? <NumeroTask v={v} comanda={comanda} /> : <b className="valore">{v.numeroTask}</b>}
      </div>
      <div className="impostazione" data-privato>
        <span className="occhiello">Assassini</span>
        {v.io.host ? (
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
        ) : (
          <b className="valore">{v.numeroAssassini}</b>
        )}
      </div>
      <p className="nota">
        <span data-privato>{v.io.host ? 'Lo scegli tu. ' : 'Lo sceglie l’host. '}</span>
        Barra piena con <b>{v.traguardoPrevisto}</b> spunte (civili × {v.numeroTask} ÷ 2, con {giocatori}{' '}
        {giocatori === 1 ? 'giocatore' : 'giocatori'} e {assassini}).
        {v.maxAssassini < ASSASSINI_SCEGLIBILI && ' Per 2 assassini servono almeno 5 giocatori.'}
      </p>
    </section>
  )
}

type PropsSala = { v: VistaSala; comanda: Comanda; avvisa: Avvisa; togli: (id: number) => void }

function Sala({ v, comanda, avvisa, togli }: PropsSala) {
  const pochi = v.giocatori.length < v.minGiocatori
  const nomeHost = v.giocatori.find(g => g.host)?.nome ?? '?'
  const connessi = v.giocatori.filter(g => !g.offline).length

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
        <Invito v={v} avvisa={avvisa} />
        <Impostazioni v={v} comanda={comanda} />
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
        <p className="avviso-fisso">Disattiva il risparmio energetico e tieni lo schermo acceso.</p>
      </main>
      <footer className="piede">
        {v.io.host ? (
          <>
            <Tasto className="tasto verde grande" disabled={pochi} onClick={() => comanda({ a: 'start' })}>
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
function Ruolo({ v, comanda }: { v: VistaRuolo; comanda: Comanda }) {
  const assassino = v.ruolo === 'assassino'
  return (
    <>
      <main className="corpo entrata">
        <section className={`fascicolo ${v.ruolo}`}>
          <p className="occhiello">Il tuo ruolo</p>
          <h2 className="timbro">{nomeRuolo(v.ruolo)}</h2>
          {assassino ? (
            <>
              <p>Elimina i civili senza farti scoprire. Dopo ogni eliminazione premi «Uccidi»: chi elimini premerà «Sono morto».</p>
              <p>
                <b>Tieni premuta la barra in alto</b> (dove c&apos;è il codice stanza) per far apparire o sparire il tasto Uccidi: per
                gli altri quel gesto non fa nulla.
              </p>
              {v.complici.length > 0 && (
                <p>
                  Complici: <b>{v.complici.join(', ')}</b>
                </p>
              )}
            </>
          ) : (
            <>
              <p>Completa le task e scopri chi sono gli assassini. Se vieni eliminato, premi «Sono morto».</p>
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
        <p className="nota centrata">Non mostrare lo schermo agli altri.</p>
      </main>
      <footer className="piede">
        <Tasto className="tasto primario grande" onClick={() => comanda({ a: 'ruoloVisto' })}>
          Ho capito
        </Tasto>
      </footer>
    </>
  )
}

// ---- Partita ----

// Montato solo dopo il gesto di un assassino vivo: per tutti gli altri questo nodo non esiste.
function RiquadroUccidi({ uccidiDa, ora, comanda, avvisa }: { uccidiDa: number; ora: number; comanda: Comanda; avvisa: Avvisa }) {
  const attesa = uccidiDa - ora
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
          comanda({ a: 'uccidi' })
          avvisa('Uccisione registrata: 5 minuti di attesa')
        }}
      >
        Uccidi
      </Tasto>
      <p className="nota uccidi-spiega">Premilo dopo ogni eliminazione: fa partire i 5 minuti di attesa. Tieni premuta la barra in alto per nasconderlo.</p>
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
  const attesaEmergency = v.emergencyDa - ora
  const inAttesa = v.taskFatta !== null && ora < v.taskDa
  const testoTask = inAttesa ? v.taskFatta : v.task
  const chiEmergency = v.emergencyDaId === v.io.id ? 'te' : v.emergencyDaNome

  return (
    <>
      <main className="corpo entrata">
        {morto && (
          <p className="avviso-fisso caldo">
            {v.io.causa === 'eliminato' ? 'Sei stato eliminato dalla votazione.' : 'Sei morto.'} Puoi continuare a fare le task, ma non puoi
            più segnalare né votare.
          </p>
        )}
        <div className="partita">
          <div className="azioni">
            <div className="azione">
              <Tasto className="tondo report" aria-label="Report" disabled={morto} onClick={() => comanda({ a: 'report' })}>
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
                onClick={() => comanda({ a: 'emergency' })}
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
                  <p className="nota">{inAttesa ? 'Prossima task tra due minuti.' : 'Spunta il riquadro quando hai finito: la barra verde cresce per tutti.'}</p>
                </div>
                {inAttesa ? (
                  <div className="spunta fatta" role="timer">
                    <IconaSpunta />
                    <span className="mono">{mmss(v.taskDa - ora)}</span>
                  </div>
                ) : (
                  <Tasto className="spunta" aria-label="Segna la task come fatta" onClick={() => comanda({ a: 'spunta' })}>
                    Fatto
                  </Tasto>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
      <footer className="piede">
        {uccidiVisibile && v.uccidiDa !== undefined && <RiquadroUccidi uccidiDa={v.uccidiDa} ora={ora} comanda={comanda} avvisa={avvisa} />}
        <Tasto className="tasto grande tratteggiato" disabled={morto} onClick={sonoMorto}>
          {morto ? 'Sei fuori dalla partita' : 'Sono morto'}
        </Tasto>
        {!morto && <p className="nota centrata spiega-morto">Premilo se un assassino ti ha eliminato: uscirai dalle votazioni.</p>}
      </footer>
    </>
  )
}

// ---- Riunione: il tocco sceglie l'intera cella, il tasto fisso in basso conferma ----
type PropsRiunione = { v: VistaRiunione; comanda: Comanda; sonoMorto: () => void; togli: (id: number) => void }

function Riunione({ v, comanda, sonoMorto, togli }: PropsRiunione) {
  const [scelta, setScelta] = useState<number | null>(null)
  const posso = v.io.vivo && v.mioVoto === null
  const scelto = v.giocatori.find(g => g.id === scelta && g.id !== v.io.id)
  const votato = v.giocatori.find(g => g.id === v.mioVoto)

  return (
    <>
      <main className="corpo riunione entrata">
        <div className="striscia" aria-hidden="true" />
        <header className="testa-riunione">
          <div className="testa">
            <p className="occhiello">{v.tipo === 'emergency' ? "Riunione d'emergenza" : 'Segnalazione'}</p>
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
                  <span className={g.haVotato ? 'segno si' : 'segno'} title={g.haVotato ? 'ha votato' : 'non ha ancora votato'}>
                    {g.haVotato ? <IconaSpunta /> : '…'}
                  </span>
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
        {v.fuori.length > 0 && <p className="nota fuori">Fuori dalla partita: {v.fuori.join(', ')}</p>}
      </main>
      <footer className="piede">
        <div data-privato className="piede-voto">
          {v.rivota && posso && <p className="avviso-fisso caldo">Il giocatore che avevi votato è uscito: vota di nuovo.</p>}
          {posso && (
            <div className="conferma">
              <Tasto className="tasto" onClick={() => comanda({ a: 'vota', x: 'salta' })}>
                Salta il voto
              </Tasto>
              <Tasto className="tasto primario" disabled={!scelto} onClick={() => scelto && comanda({ a: 'vota', x: scelto.id })}>
                {scelto ? `Vota ${scelto.nome}` : 'Scegli un nome'}
              </Tasto>
            </div>
          )}
          {!posso && v.io.vivo && (
            <p className="avviso-fisso">{v.mioVoto === 'salta' ? 'Hai votato di saltare.' : `Hai votato ${votato?.nome ?? ''}.`} In attesa degli altri.</p>
          )}
          {!v.io.vivo && (
            <p className="avviso-fisso">{v.io.causa === 'eliminato' ? 'Sei stato eliminato' : 'Sei morto'}: osservi senza votare.</p>
          )}
        </div>
      </footer>
    </>
  )
}

// ---- Esito: il risultato sta in alto, perché resta a schermo solo pochi secondi ----
function Esito({ v, ora }: { v: VistaEsito; ora: number }) {
  return (
    <main className="corpo esito entrata">
      <div className="striscia" aria-hidden="true" />
      <section className="risultato">
        {v.eliminatoNome ? (
          <>
            <h2>{v.eliminatoNome} è stato eliminato</h2>
            {v.eliminatoRuolo && <p className={`era ${v.eliminatoRuolo}`}>Era un {nomeRuolo(v.eliminatoRuolo)}</p>}
          </>
        ) : (
          <>
            <h2>Nessuno è stato eliminato</h2>
            <p className="nota">{v.parita ? 'Parità di voti.' : 'La maggioranza ha saltato il voto.'}</p>
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
        {v.votanti.map(g => (
          <Cella key={g.id} g={g} classe={g.id === v.eliminatoId ? 'eliminata' : undefined} nota={`${g.voti} ${g.voti === 1 ? 'voto' : 'voti'}`}>
            {g.id === v.io.id && <span className="tag tu">Tu</span>}
          </Cella>
        ))}
      </ul>
      {v.salti > 0 && <p className="nota">Hanno saltato il voto: {v.salti}</p>}
      {v.fuori.length > 0 && <p className="nota">Fuori dalla partita: {v.fuori.join(', ')}</p>}
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

  return (
    <main className="corpo entrata">
      <section className={`fascicolo ${v.vincitore === 'civili' ? 'civile' : 'assassino'}`}>
        <p className="occhiello">Fine partita</p>
        <h2 className="vittoria">{v.vincitore === 'civili' ? 'I civili hanno vinto' : 'Gli assassini hanno vinto'}</h2>
        <p>{spiegazione}</p>
      </section>
      <p className="occhiello">I ruoli erano</p>
      <ul className="griglia">
        {v.giocatori.map(g => (
          <Cella key={g.id} g={g} classe={g.vivo ? undefined : 'eliminata'} nota={<span className={g.ruolo}>{nomeRuolo(g.ruolo)}</span>}>
            {g.id === v.io.id && <span className="tag tu">Tu</span>}
          </Cella>
        ))}
      </ul>
      <p className="nota centrata">
        Si torna nella stanza tra{' '}
        <span data-privato className="mono">
          {secondiDa(v.scadenza, ora)}
        </span>{' '}
        s
      </p>
    </main>
  )
}

// ---- Dialoghi: esistono solo da aperti, e un cambio di fase li chiude ----
type Domanda = { tipo: 'morto' } | { tipo: 'esci' } | { tipo: 'togli'; id: number }

type PropsDialogo = { titolo: string; testo: string; no: string; si: string; alNo: () => void; alSi: () => void }

function Dialogo({ titolo, testo, no, si, alNo, alSi }: PropsDialogo) {
  return (
    <div className="velo">
      <div className="dialogo" role="dialog" aria-modal="true" aria-labelledby="titolo-dialogo">
        <h2 id="titolo-dialogo">{titolo}</h2>
        <p>{testo}</p>
        <div className="conferma pari">
          <Tasto className="tasto" onClick={alNo}>
            {no}
          </Tasto>
          <Tasto className="tasto pericolo" onClick={alSi}>
            {si}
          </Tasto>
        </div>
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

  const chiediMorto = () => chiedi({ tipo: 'morto' })
  const chiediTogli = (id: number) => chiedi({ tipo: 'togli', id })

  return (
    <Collegato.Provider value={rete === 'ok'}>
      <div id="schermo" className="guscio" data-schermata={v.schermata} data-tipo={'tipo' in v ? v.tipo : undefined}>
        <BarraAlta v={v} gesto={gesto} esci={() => chiedi({ tipo: 'esci' })} />
        <BarraVerde v={v} />

        {v.schermata === 'sala' && <Sala v={v} comanda={comanda} avvisa={avvisa} togli={chiediTogli} />}
        {v.schermata === 'ruolo' && <Ruolo v={v} comanda={comanda} />}
        {v.schermata === 'partita' && (
          <Partita key={v.f} v={v} ora={ora} comanda={comanda} avvisa={avvisa} sonoMorto={chiediMorto} uccidiVisibile={uccidiVisibile} />
        )}
        {v.schermata === 'riunione' && <Riunione key={v.f} v={v} comanda={comanda} sonoMorto={chiediMorto} togli={chiediTogli} />}
        {v.schermata === 'esito' && <Esito v={v} ora={ora} />}
        {v.schermata === 'fine' && <Fine v={v} ora={ora} />}

        {aperta?.tipo === 'morto' && (
          <Dialogo
            titolo="Sei morto?"
            testo="Per il resto della partita non potrai votare né essere votato, e non potrai più segnalare o convocare riunioni. Le task puoi continuare a farle. Non si torna indietro."
            no="Annulla"
            si="Sì, sono morto"
            alNo={chiudi}
            alSi={() => {
              comanda({ a: 'sonoMorto' })
              avvisa('Sei fuori dalle votazioni per il resto della partita')
              chiudi()
            }}
          />
        )}
        {aperta?.tipo === 'esci' && (
          <Dialogo titolo="Uscire dalla stanza?" testo={testoUscita(v)} no="Resta" si="Esci" alNo={chiudi} alSi={esci} />
        )}
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
