// Si arriva qui di solito scrivendo il codice nell'indirizzo invece di usare il link d'invito.
import Link from 'next/link'

export default function NonTrovata() {
  return (
    <div id="schermo" className="guscio" data-schermata="non-trovata">
      <main className="corpo attesa entrata">
        <p className="occhiello">Sala Sospetti</p>
        <h2>Pagina non trovata</h2>
        <p className="nota">Se hai un codice stanza, scrivilo nella pagina iniziale del gioco.</p>
        <Link className="tasto" href="/">
          Vai al gioco
        </Link>
      </main>
    </div>
  )
}
