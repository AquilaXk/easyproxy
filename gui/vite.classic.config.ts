import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * The classic dashboard: the pre-redesign UI, built into dist/classic and served at /classic/.
 *
 * classic/src holds only the files the redesign changed, frozen at their pre-redesign content
 * (plus every old stylesheet, so CSS @import chains resolve inside the snapshot). Everything
 * else (API clients, hooks, locale catalogues, icons, pure helpers) is shared with src/, so the
 * classic UI keeps talking to the current proxy through the same code. The overlay plugin below
 * makes that work: an import resolves to the classic copy when one exists, otherwise to src/.
 */
const GUI = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(GUI, 'src')
const CLASSIC_SRC = join(GUI, 'classic', 'src')

/** The parent package version, baked in as the fallback shown before /healthz answers. */
function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.0.0'
  } catch (error) {
    throw new Error('classic dashboard build: cannot read ../package.json', { cause: error })
  }
}
const version = packageVersion()

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) ? rel : null
}

function classicOverlay(): Plugin {
  return {
    name: 'easyproxy-classic-overlay',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0') || !(source.startsWith('.') || source.startsWith('/'))) return null
      const importerPath = importer.split('?')[0]!
      // A classic file resolves its relative imports as if it still sat in src/.
      const fromClassic = inside(CLASSIC_SRC, importerPath)
      const asImporter = fromClassic ? join(SRC, fromClassic) : importerPath
      const resolved = await this.resolve(source, asImporter, { ...options, skipSelf: true })
      if (!resolved || resolved.external) return resolved
      const [file, query = ''] = resolved.id.split('?')
      const rel = inside(SRC, file!)
      if (!rel) return resolved
      const classic = join(CLASSIC_SRC, rel)
      return existsSync(classic) ? { ...resolved, id: query ? `${classic}?${query}` : classic } : resolved
    },
  }
}

function stripTestCatalogBarrel(): Plugin {
  return {
    name: 'easyproxy-strip-test-catalog-barrel',
    transform(code, id, options) {
      if (options?.ssr) return null
      const cleanId = id.split('?')[0]?.replaceAll('\\', '/') ?? ''
      if (!cleanId.endsWith('/src/i18n/shared.ts')) return null
      return code
        .replace(/import\s*\{\s*DICTS\s*\}\s*from\s*["']\.\/catalogs["'];?\s*/g, '')
        .replace(/\bDICTS\s*,\s*/g, '')
    },
  }
}

const HASHED_BUNDLE_NAME = /-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deduplicateSharedMainAssets(): Plugin {
  return {
    name: 'easyproxy-dedup-classic-main-assets',
    closeBundle() {
      const mainAssetsDir = join(GUI, 'dist', 'assets')
      const classicDir = join(GUI, 'dist', 'classic')
      const classicAssetsDir = join(classicDir, 'assets')
      if (!existsSync(mainAssetsDir) || !existsSync(classicAssetsDir)) return

      const deduped = new Set<string>()
      for (const entry of readdirSync(classicAssetsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !HASHED_BUNDLE_NAME.test(entry.name)) continue
        const mainPath = join(mainAssetsDir, entry.name)
        const classicPath = join(classicAssetsDir, entry.name)
        try {
          if (!statSync(mainPath).isFile()) continue
        } catch {
          continue
        }
        if (Buffer.compare(readFileSync(classicPath), readFileSync(mainPath)) === 0) {
          deduped.add(entry.name)
        }
      }
      if (deduped.size === 0) return

      const nameAlt = [...deduped].map(escapeRegex).join('|')
      const htmlPath = join(classicDir, 'index.html')
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf8')
        const rewritten = html.replace(
          new RegExp(`/classic/assets/(${nameAlt})(?=["'\\s?#])`, 'g'),
          '/assets/$1',
        )
        if (rewritten !== html) writeFileSync(htmlPath, rewritten, 'utf8')
      }

      const relQuoteRe = new RegExp(`(["'\`])\\./(${nameAlt})\\1`, 'g')
      const preloadMapRe = new RegExp(`(["'])assets/(${nameAlt})\\1`, 'g')
      const explicitBaseRe = new RegExp(`/classic/assets/(${nameAlt})(?=["'\`\\s?#)])`, 'g')
      for (const entry of readdirSync(classicAssetsDir, { withFileTypes: true })) {
        if (!entry.isFile() || deduped.has(entry.name)) continue
        if (!entry.name.endsWith('.js') && !entry.name.endsWith('.css')) continue
        const assetPath = join(classicAssetsDir, entry.name)
        const original = readFileSync(assetPath, 'utf8')
        const rewritten = original
          .replace(relQuoteRe, '$1/assets/$2$1')
          .replace(preloadMapRe, '$1../assets/$2$1')
          .replace(explicitBaseRe, '/assets/$1')
        if (rewritten !== original) writeFileSync(assetPath, rewritten, 'utf8')
      }

      for (const name of deduped) {
        unlinkSync(join(classicAssetsDir, name))
      }
    },
  }
}

export default defineConfig({
  root: join(GUI, 'classic'),
  base: '/classic/',
  // The favicon and logo are served from the dashboard root, which the main build fills.
  publicDir: false,
  plugins: [stripTestCatalogBarrel(), classicOverlay(), react(), deduplicateSharedMainAssets()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: join(GUI, 'dist', 'classic'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
  resolve: { alias: { '@': SRC } },
})
