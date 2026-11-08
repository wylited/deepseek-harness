#!/usr/bin/env node
/**
 * Build keys into the two files the host serves:
 *
 *   lib/index.js   — node half, plain ESM
 *   lib/client.js  — browser half, in the host's lazy-CJS factory form
 *                    (window.__ModuleLoader__.load({id, factory}); same
 *                    shape as plugins/restyle/build.mjs)
 *
 *   Build command:  node build.mjs
 *
 * esbuild resolves from the enclosing dsh workspace store
 * (node_modules/.pnpm) — this package adds no dependency of its own.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))

/** Locate esbuild inside the workspace store; newest store entry wins. */
function resolveEsbuildDir() {
  const direct = path.join(repoRoot, 'node_modules', 'esbuild')
  if (existsSync(direct)) return direct
  const store = path.join(repoRoot, 'node_modules', '.pnpm')
  const entries = readdirSync(store).filter(name => /^esbuild@\d/.test(name)).sort()
  for (const name of entries.reverse()) {
    const candidate = path.join(store, name, 'node_modules', 'esbuild')
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`esbuild not found under ${store} — run pnpm install in ${repoRoot}`)
}

const esbuildDir = resolveEsbuildDir()
const esbuild = createRequire(path.join(esbuildDir, 'package.json'))(esbuildDir)

mkdirSync(path.join(here, 'lib'), { recursive: true })

esbuild.buildSync({
  entryPoints: [path.join(here, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(here, 'lib/client.js'),
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
})

esbuild.buildSync({
  entryPoints: [path.join(here, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: path.join(here, 'lib/index.js'),
  legalComments: 'none',
  logLevel: 'info',
})
