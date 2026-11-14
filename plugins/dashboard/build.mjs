#!/usr/bin/env node
/**
 * Build dashboard into the two files the host serves:
 *
 *   lib/index.js   — node half, plain ESM
 *   lib/client.js  — browser half, in the host's lazy-CJS factory form:
 *                    window.__ModuleLoader__.load({ id, factory: (require) => {…} })
 *                    (same banner/footer shape as plugins/restyle, which
 *                    follows packages/client/tsdown.client.ts)
 *
 *   Build command:  node build.mjs
 *
 * Browser runtime externals (resolved by the client module system's boot
 * graph, never bundled): `react` and `react/jsx-runtime`. Everything
 * `@deepseek-ai/*` here is type-only and erased. esbuild resolves from the
 * enclosing dsh workspace store — this package adds no dependency of its own.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

try {
  esbuild.buildSync({
    entryPoints: [path.join(here, 'src/client/index.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    outfile: path.join(here, 'lib/client.js'),
    legalComments: 'none',
    logLevel: 'info',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
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
    // Plugins are not pnpm workspace members, so bare imports resolve only
    // against the repo root's own deps; schemastery is a vendored override
    // (link:vendor/schemastery) that only workspace members see. Alias to its
    // source — lib/ is a build output a fresh clone may not have.
    alias: { '@deepseek-ai/schemastery': path.join(repoRoot, 'vendor/schemastery/src/index.ts') },
  })
} finally {
  rmSync(path.join(here, 'src/client/none.generated.ts'), { force: true })
}
