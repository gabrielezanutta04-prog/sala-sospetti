import type { NextConfig } from 'next'

// Sito statico per GitHub Pages: il percorso base arriva dal workflow di pubblicazione.
const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.PAGES_BASE_PATH || '',
  images: { unoptimized: true },
}

export default nextConfig
