#!/usr/bin/env node
/**
 * Build workspace-settings into the one file the host loads:
 *
 *   lib/index.js — node half, plain ESM, fully self-contained
 *                  (zero external imports; verified with grep -cE '^import').
 *
 *   Build command:  node build.mjs
 *
 * Plugins are not pnpm workspace members, so bare imports resolve only
 * against the repo root's own deps. `@deepseek-ai/schemastery` is a vendored
 * override (link:vendor/schemastery) only workspace members see, so it is
 * aliased to its source — lib/ is a build output a fresh clone may not have.
 * Every `@deepseek-ai/*` import besides that is type-only and erased; the
 * one runtime cross-package import (the sandbox-mode write path) is a
 * relative source import esbuild bundles verbatim.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
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
  entryPoints: [path.join(here, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: path.join(here, 'lib/index.js'),
  legalComments: 'none',
  logLevel: 'info',
  alias: { '@deepseek-ai/schemastery': path.join(repoRoot, 'vendor/schemastery/src/index.ts') },
})
