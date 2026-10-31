'use client'

// Radice del sito: una sola pagina statica. Legge l'indirizzo, tiene il collegamento e mostra la schermata giusta.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TESTI_RIFIUTO, codiceValido } from '../gioco/regole.ts'
import type { Azione, Schermata } from '../gioco/regole.ts'
import {
  aggiornaIndirizzo,
  dimenticaStanza,
  nomeSalvato,
  nuovoCodice,
  salvaNome,
  sbloccaAudio,
  segnaleRiunione,
  stanzaSalvata,
  useSchermoAcceso,
  useStanza,
} from './connessione.ts'
import type { Comando, Errore, Fine, Ingresso } from './connessione.ts'
import { Collegamento, Gioco, Home, TESTO_CODICE_ERRATO, Uscita } from './schermate.tsx'

const DURATA_AVVISO_MS = 2200

function testoErrore(motivo: Errore): string {
  switch (motivo) {
    case 'stanza-inesistente':
      return 'Stanza non trovata: controlla il codice o chiedilo di nuovo a chi l’ha creata.'
    case 'codice-non-valido':
      return TESTO_CODICE_ERRATO
    case 'codice-occupato':
      return 'Non sono riuscito a creare la stanza: riprova.'
    case 'tolto':
      return 'L’host ti ha tolto dalla stanza.'
    case 'partita-in-corso':
      return 'Partita già iniziata. Se stavi giocando, scrivi lo stesso nome di prima e premi Entra. Altrimenti aspetta che finisca e premi di nuovo Entra.'
    case 'nome-usato':
      return 'Questo nome è già usato in questa stanza. Se sei tu da un altro telefono o browser, chiudilo e riprova tra 30 secondi. Altrimenti scrivi un nome diverso, per esempio con l’iniziale del cognome.'
    default:
      return TESTI_RIFIUTO[motivo]
  }
}

export default function Pagina() {
  const [ingresso, setIngresso] = useState<Ingresso | null>(null)
  const [invito, setInvito] = useState('')
  const [codiceProvato, setCodiceProvato] = useState('')
  const [nomeIniziale, setNomeIniziale] = useState('')
  const [messaggio, setMessaggio] = useState<string | null>(null)
  const [avviso, setAvviso] = useState<{ testo: string; n: number } | null>(null)
  const schermataPrima = useRef<Schermata | null>(null)

  const avvisa = useCallback((testo: string) => setAvviso(a => ({ testo, n: (a?.n ?? 0) + 1 })), [])

  function tornaAllaHome() {
    aggiornaIndirizzo(null)
    setInvito('')
    setCodiceProvato('')
    setIngresso(null)
  }

  // In memoria c'è la stanza della partita in corso: restare fuori da un'altra stanza non deve toccarla.
  function dimenticaQuesta() {
    if ((vista?.codice ?? ingresso?.codice) === stanzaSalvata()) dimenticaStanza()
  }

  function annulla() {
    dimenticaQuesta()
    tornaAllaHome()
  }

  function finisce(motivo: Fine) {
    if (motivo === 'uscito') {
      dimenticaStanza()
      return tornaAllaHome()
    }
    dimenticaQuesta()
    if (motivo === 'uscito-altrove') return tornaAllaHome()
    // Chi resta fuori per ora riprova dallo stesso link: l'indirizzo sparisce solo se quella stanza non è più per lui.
    if (motivo !== 'partita-in-corso' && motivo !== 'nome-usato' && motivo !== 'stanza-piena') aggiornaIndirizzo(null)
    // Una stanza salvata che non esiste più non è un errore di chi apre il sito: non ha scritto nessun codice.
    const sparita = ingresso?.rientro && motivo === 'stanza-inesistente'
    setMessaggio(sparita ? null : testoErrore(motivo))
    // Il codice resta nel campo, altrimenti i messaggi che dicono di controllarlo o di premere di nuovo Entra sarebbero falsi.
    setCodiceProvato(!ingresso || ingresso.crea || sparita || motivo === 'tolto' ? '' : ingresso.codice)
    setIngresso(null)
  }

  const { vista, rete, uscendo, invia, adesso, riprova, esci } = useStanza(ingresso, finisce, () => avvisa('Non riesco a uscire: controlla la rete e riprova'))
  useSchermoAcceso(ingresso !== null)

  // Prima del disegno, così chi ricarica la pagina durante la partita non vede passare la Home.
  useLayoutEffect(() => {
    const dalLink = new URLSearchParams(window.location.search).get('stanza')?.toUpperCase() ?? ''
    const invitato = codiceValido(dalLink) ? dalLink : ''
    const miaStanza = stanzaSalvata()
    const nome = nomeSalvato()
    setNomeIniziale(nome)
    if (miaStanza && (!invitato || invitato === miaStanza)) setIngresso({ codice: miaStanza, nome, crea: false, rientro: true })
    else setInvito(invitato)
    delete document.documentElement.dataset.rientro
    delete document.documentElement.dataset.attesa
  }, [])

  useEffect(() => {
    window.addEventListener('pointerup', sbloccaAudio)
    window.addEventListener('click', sbloccaAudio)
    return () => {
      window.removeEventListener('pointerup', sbloccaAudio)
      window.removeEventListener('click', sbloccaAudio)
    }
  }, [])

  const codiceVista = vista?.codice ?? null
  useEffect(() => {
    if (codiceVista) aggiornaIndirizzo(codiceVista)
  }, [codiceVista])

  // Suono e vibrazione all'apertura di una riunione, mai dopo una ricarica a riunione già aperta.
  // Da Ruolo si arriva con Ho capito: lì il segnale è già partito quando la riunione si è aperta.
  const schermata = vista?.schermata ?? null
  useEffect(() => {
    const prima = schermataPrima.current
    if (schermata === 'riunione' && prima && prima !== 'riunione' && prima !== 'ruolo') segnaleRiunione()
    schermataPrima.current = schermata
  }, [schermata])

  useEffect(() => {
    if (!avviso) return
    const timer = setTimeout(() => setAvviso(null), DURATA_AVVISO_MS)
    return () => clearTimeout(timer)
  }, [avviso])

  function entra(nome: string, codice: string | null) {
    sbloccaAudio()
    salvaNome(nome)
    setNomeIniziale(nome)
    setMessaggio(null)
    setIngresso(codice ? { codice, nome, crea: false } : { codice: nuovoCodice(), nome, crea: true })
  }

  function comanda(comando: Comando) {
    if (vista) invia({ ...comando, f: vista.f } as Azione)
  }

  return (
    <>
      {uscendo ? (
        <Uscita />
      ) : vista ? (
        <Gioco key={vista.codice} v={vista} rete={rete} comanda={comanda} adesso={adesso} esci={esci} avvisa={avvisa} riprova={riprova} />
      ) : ingresso ? (
        <Collegamento annulla={annulla} />
      ) : (
        <Home invito={invito} codiceProvato={codiceProvato} nomeIniziale={nomeIniziale} messaggio={messaggio} entra={entra} />
      )}
      <div className="avvisi" aria-live="polite">
        {avviso && (
          <div key={avviso.n} className="avviso">
            {avviso.testo}
          </div>
        )}
      </div>
    </>
  )
}
