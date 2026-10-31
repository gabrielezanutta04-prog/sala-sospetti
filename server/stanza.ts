import { DurableObject } from 'cloudflare:workers'

type Env = { STANZA: DurableObjectNamespace<Stanza> }

// Scheletro per provare il percorso di pubblicazione: eco del WebSocket e pagina di salute.
export class Stanza extends DurableObject<Env> {
  async fetch() {
    const coppia = new WebSocketPair()
    this.ctx.acceptWebSocket(coppia[1])
    return new Response(null, { status: 101, webSocket: coppia[0] })
  }

  async webSocketMessage(ws: WebSocket, testo: string | ArrayBuffer) {
    ws.send(String(testo))
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const trovato = new URL(req.url).pathname.match(/^\/stanza\/([A-Z0-9]{5})$/)
    if (!trovato) return new Response('Sala Sospetti: server attivo')
    return env.STANZA.get(env.STANZA.idFromName(trovato[1]), { locationHint: 'weur' }).fetch(req)
  },
}
