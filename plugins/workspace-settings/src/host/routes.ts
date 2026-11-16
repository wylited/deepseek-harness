/**
 * The settings HTTP API, served behind the webserver's auth fence with the
 * same-origin discipline of notify's attention route:
 *
 *   GET  /api/workspace-settings          — every registry workspace with its settings
 *   GET  /api/workspace-settings/<id>     — one workspace's settings
 *   PUT  /api/workspace-settings/<id>     — replace one workspace's settings (POST also
 *                                           accepted); JSON body ≤ 8 KiB, unknown fields
 *                                           rejected, returns the stored document
 *
 * Settings for ids outside the registry are refused: the list is registry-
 * projected, so unconstrained writes could only create invisible files.
 * @module workspace-settings/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { LoggerFace, WorkspaceRegistryFace } from './faces.ts'
import {
  assertWorkspaceId,
  loadSettings,
  parseWorkspaceSettings,
  saveSettings,
  unknownSettingKeys,
  type WorkspaceSettings,
} from './store.ts'

/** The list route path; item routes address `<id>` segments under it. */
export const WORKSPACE_SETTINGS_PATH = '/api/workspace-settings'

/** Maximum accepted JSON body (matches notify's push-store budget). */
const MAX_BODY_BYTES = 8 * 1024

/** Route-construction dependencies. */
export interface WorkspaceSettingsRouteDeps {
  /** Settings home (`$DSH_HOME`), holding `workspace-settings/<id>.json`. */
  homePath: string
  /** Registry backing the list and the per-id existence check. */
  registry: WorkspaceRegistryFace
  /** Activation/failure logging. */
  logger: LoggerFace
}

/** Whether the request names this origin (same-origin marker or loopback). */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  const address = req.socket.remoteAddress
  return address !== undefined
    && (address === '::1' || address === '::ffff:127.0.0.1' || address.endsWith(':127.0.0.1'))
}

/** Write one JSON body and finish the response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read a small JSON body; `overflow` reports an over-budget request. */
function readBody(req: IncomingMessage, res: ServerResponse, onBody: (raw: string, overflow: boolean) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    else overflow = true
  })
  req.on('end', () => onBody(Buffer.concat(chunks).toString('utf8'), overflow))
  req.on('error', () => writeJson(res, 400, { ok: false, error: 'bad body' }))
}

/**
 * The workspace id addressed by one item request, or `undefined` when the
 * path does not name exactly one decodable segment.
 */
function routeIdOf(req: IncomingMessage): string | undefined {
  const pathname = (req.url ?? '').split('?')[0] ?? ''
  const prefix = `${WORKSPACE_SETTINGS_PATH}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  if (rest === '' || rest.includes('/')) return undefined
  try {
    const id = decodeURIComponent(rest)
    return id.includes('/') ? undefined : id
  } catch {
    return undefined
  }
}

/** One workspace projected with its stored settings (the list element shape). */
function projectWorkspace(deps: WorkspaceSettingsRouteDeps, workspace: { id: string; path: string; title: string }): {
  id: string
  path: string
  title: string
  settings: WorkspaceSettings
} {
  return {
    id: workspace.id,
    path: workspace.path,
    title: workspace.title,
    settings: loadSettings(deps.homePath, workspace.id),
  }
}

/** Store one validated document, answering with the stored shape. */
function storeSettings(
  deps: WorkspaceSettingsRouteDeps,
  res: ServerResponse,
  id: string,
  raw: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    writeJson(res, 400, { ok: false, error: 'bad body: invalid JSON' })
    return
  }
  const unknownKeys = unknownSettingKeys(parsed)
  if (unknownKeys.length > 0) {
    writeJson(res, 400, { ok: false, error: `unknown setting field(s): ${unknownKeys.join(', ')}` })
    return
  }
  let settings: WorkspaceSettings
  try {
    settings = parseWorkspaceSettings(parsed)
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `invalid settings: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  if (deps.registry.get(id) === undefined) {
    writeJson(res, 404, { ok: false, error: `unknown workspace ${JSON.stringify(id)}` })
    return
  }
  try {
    saveSettings(deps.homePath, id, settings)
  } catch (error) {
    deps.logger.warn(`workspace-settings: could not store settings for workspace "${id}": ${String(error)}`)
    writeJson(res, 500, { ok: false, error: 'storage failed' })
    return
  }
  writeJson(res, 200, { ok: true, id, settings })
}

/**
 * Build the settings routes. Registration order in the webserver is exact
 * before longest-prefix, so the list route answers the bare path and the
 * prefix route only ever sees `<id>` paths.
 */
export function makeWorkspaceSettingsRoutes(deps: WorkspaceSettingsRouteDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: WORKSPACE_SETTINGS_PATH,
      handler: (req, res): void => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'GET only' })
          return
        }
        if (!isSameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: same-origin only' })
          return
        }
        writeJson(res, 200, { workspaces: deps.registry.list().map(workspace => projectWorkspace(deps, workspace)) })
      },
    },
    {
      kind: 'prefix',
      path: WORKSPACE_SETTINGS_PATH,
      handler: (req, res): void => {
        if (!isSameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: same-origin only' })
          return
        }
        const id = routeIdOf(req)
        if (id === undefined) {
          writeJson(res, 404, { ok: false, error: 'workspace id required' })
          return
        }
        try {
          assertWorkspaceId(id)
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid workspace id' })
          return
        }
        if (req.method === 'GET') {
          const workspace = deps.registry.list().find(candidate => candidate.id === id)
          if (workspace === undefined) {
            writeJson(res, 404, { ok: false, error: `unknown workspace ${JSON.stringify(id)}` })
            return
          }
          writeJson(res, 200, projectWorkspace(deps, workspace))
          return
        }
        if (req.method !== 'PUT' && req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'GET, PUT, or POST only' })
          return
        }
        readBody(req, res, (raw, overflow) => {
          if (overflow) {
            writeJson(res, 413, { ok: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` })
            return
          }
          storeSettings(deps, res, id, raw)
        })
      },
    },
  ]
}
