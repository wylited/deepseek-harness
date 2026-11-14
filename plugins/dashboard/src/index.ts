/**
 * dashboard, node half. Registers the usage-ledger service and its
 * same-origin overview route; the browser half ships through
 * `exports["./client"]` (same split as packages/client/ui-brand-official
 * and plugins/restyle).
 * @module dashboard
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { apply as mcpClientApply, type Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { DashboardService, resolveDshHome } from './host/service.ts'
import { makeDashboardOverviewRoute } from './host/routes.ts'

/** Host services this plugin requires: the web server that owns /api routes, and the invocation flags (--trusted-host list). */
export const inject = ['webServer', 'webStartup']

/**
 * Homelab CalDAV bridge: compose the mcp-client plugin to spawn the fork's
 * zero-dependency radicale MCP server and project its tools to agents
 * (`mcp__caldav__<tool>`). Script path resolves relative to this build output
 * (plugins/dashboard/lib → clone root), so it tracks the active slot's clone
 * across blue-green flips without absolute paths. Radicale credentials ride
 * the service environment (/etc/nix/dsh-env); mcp-client scrubs ambient env,
 * so they are restated explicitly and omitted when absent.
 */
function caldavMcpConfig(): McpClientConfig {
  const cloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const radicaleEnv = ['RADICALE_URL', 'RADICALE_USER', 'RADICALE_PASS'].flatMap(name =>
    process.env[name] ? { [name]: process.env[name] as string } : [],
  )
  return {
    transport: 'stdio',
    serverName: 'caldav',
    command: process.execPath,
    args: [resolve(cloneRoot, 'mcp', 'homelab-caldav', 'src', 'index.ts')],
    env: Object.assign({}, ...radicaleEnv),
    failOnStartupError: false,
  }
}

/** Host plugin body: ledger service + overview route + caldav MCP bridge, tied to this fiber. */
export function apply(ctx: Context): void {
  const dshHomeDir = resolveDshHome()
  // The ledger dir is created on demand by the flush, but an early missing
  // dir turns the first write into an ELOOP-free, predictable failure; make
  // it here so the first fold already persists.
  mkdirSync(dshHomeDir, { recursive: true })
  const service = new DashboardService(ctx, dshHomeDir)
  const disposeRoute = ctx.webServer.register(makeDashboardOverviewRoute(ctx, service))
  service.start()
  // Composed child: own lifecycle (connect, register `mcp__caldav__*` tools,
  // reconnect, dispose) scoped to this fiber — dashboard going away takes the
  // bridge with it. Startup failure degrades to no calendar tools; the
  // dashboard itself must keep working with radicale down.
  ctx.plugin(mcpClientApply, caldavMcpConfig())
  ctx.effect(() => {
    return async () => {
      disposeRoute()
      await service.stop()
    }
  }, 'dashboard: runtime')
}
