'use client'

import { useEffect, useState } from 'react'

const SERVER = 'wss://sala-sospetti.INDIRIZZO.workers.dev'

// Scheletro per provare il percorso di pubblicazione: verrà sostituito dal gioco.
export default function Pagina() {
  const [stato, setStato] = useState('collegamento…')

  useEffect(() => {
    const server = new URLSearchParams(window.location.search).get('server') ?? SERVER
    const ws = new WebSocket(`${server}/stanza/PROVA`)
    ws.onopen = () => ws.send('ciao')
    ws.onmessage = e => setStato(`server raggiungibile: ${e.data}`)
    ws.onerror = () => setStato('server non raggiungibile')
    return () => ws.close()
  }, [])

  return (
    <main>
      <h1>Sala Sospetti</h1>
      <p>{stato}</p>
    </main>
  )
}
