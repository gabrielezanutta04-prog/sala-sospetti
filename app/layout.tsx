import type { ReactNode } from 'react'
import type { Viewport } from 'next'
import { Chakra_Petch, IBM_Plex_Mono } from 'next/font/google'
import './stile.css'

const titolo = Chakra_Petch({ weight: '700', subsets: ['latin'], variable: '--titolo' })
const mono = IBM_Plex_Mono({ weight: '600', subsets: ['latin'], variable: '--mono' })

// Icona dentro al documento: nessun file in più e nessuna richiesta a vuoto.
const icona = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0e1322"/><path fill="#ff5265" d="M5 32c0-9 4-13 11-13s11 4 11 13zM16 4c4 0 7 3 7 7.500S20 19 16 19s-7-3-7-7.500S12 4 16 4z"/><path fill="#0e1322" d="M11 11l4 1.500-4 .7zM21 11l-4 1.500 4 .7z"/></svg>',
)}`

export const metadata = {
  title: 'Sala Sospetti',
  description: 'Un gioco di deduzione da fare nella stessa stanza, ognuno col proprio telefono.',
  icons: { icon: icona },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0e1322' },
    { media: '(prefers-color-scheme: light)', color: '#e9edf5' },
  ],
}

// Eseguito prima del disegno: chi rientra in una stanza non deve veder passare la Home, e finché il JavaScript non arriva
// i tasti della Home non devono sembrare attivi. Dal link d'invito non si propone nemmeno Crea stanza. Pagina toglie entrambi.
const avvio = `document.documentElement.dataset.attesa=/[?&]stanza=[a-z0-9]{5}(&|$)/i.test(location.search)?'invito':'1';try{if(localStorage.getItem('sala-sospetti:stanza'))document.documentElement.dataset.rientro='1'}catch(e){}`

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="it" className={`${titolo.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: avvio }} />
        {children}
      </body>
    </html>
  )
}
