/**
 * workspace-settings, node half. Per-workspace defaults for NEW sessions:
 * settings persist as one JSON document per workspace under
 * `$DSH_HOME/workspace-settings/<workspaceId>.json`, are read and replaced
 * over `/api/workspace-settings`, and are enforced host-side when a fresh
 * top-level session is announced inside the workspace (sandbox mode,
 * session-scoped model selection, MCP tool allowlist). Host-only plugin:
 * the `dsh.bundle.patch` manifest declares the profile insert row (the
 * perplexity-web pattern for plugins without a client half).
 * @module workspace-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { wireEnforcement } from './host/apply.ts'
import type { LoggerFace, PluginContextFace, WebServerFace, WorkspaceRegistryFace } from './host/faces.ts'
import { makeWorkspaceSettingsRoutes } from './host/routes.ts'
import { resolveHomePath } from './host/store.ts'

/**
 * Services enforcement and the routes consume (tryGet below). Declaring them
 * pins plugin start AFTER these services exist — without it, apply can run
 * before the web server or registry is up and every integration silently
 * no-ops. A profile mounting none of them (desktop/tui) simply never starts
 * the plugin.
 */
export const inject = ['webServer', 'workspaceRegistry', 'tools', 'sandboxPolicy']

/**
 * Plugin configuration (cordis.user.yml row). Defaults the plugin on; a row
 * that replaces the config only needs the fields it wants to change.
 */
export interface Config {
  /** Master switch; false keeps the plugin fully inert. */
  enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
}) as z<{ enabled?: boolean }, Config>

/** Read a service that may be absent (optional integration points). */
function tryGet<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Host plugin body: settings routes plus the session-feed enforcement. */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('workspace-settings')
  logger.warn(`workspace-settings: plugin apply — enabled=${String(config.enabled)}`)
  if (!config.enabled) return
  const faces = ctx as unknown as PluginContextFace
  const homePath = resolveHomePath()
  const registry = tryGet<WorkspaceRegistryFace>(ctx, 'workspaceRegistry')
  const tools = tryGet<{ schemas(agent: object): readonly { name: string }[] }>(ctx, 'tools')
  const sandboxPolicy = tryGet<object>(ctx, 'sandboxPolicy')
  const webServer = tryGet<WebServerFace>(ctx, 'webServer')
  if (webServer !== undefined && registry !== undefined) {
    for (const route of makeWorkspaceSettingsRoutes({ homePath, registry, logger: logger as LoggerFace })) {
      const dispose = webServer.register(route)
      if (dispose !== undefined) faces.effect(() => dispose, `workspace-settings: route ${route.path}`)
    }
  }
  if (registry !== undefined) {
    const disposeEnforcement = wireEnforcement(faces, {
      homePath,
      registry,
      tools,
      sandboxPolicyReady: sandboxPolicy !== undefined,
      logger: logger as LoggerFace,
    })
    faces.effect(() => disposeEnforcement, 'workspace-settings: session feed')
  }
}
