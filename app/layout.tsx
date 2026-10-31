import type { ReactNode } from 'react'
import { Chakra_Petch, IBM_Plex_Mono } from 'next/font/google'

const titolo = Chakra_Petch({ weight: '700', subsets: ['latin'], variable: '--titolo' })
const mono = IBM_Plex_Mono({ weight: '600', subsets: ['latin'], variable: '--mono' })

export const metadata = { title: 'Sala Sospetti' }
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' }

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="it" className={`${titolo.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
