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
import z from '@deepseek-ai/schemastery'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { DashboardService, resolveDshHome } from './host/service.ts'
import { makeDashboardOverviewRoute } from './host/routes.ts'

/** Host services this plugin requires: the web server that owns /api routes, the invocation flags (--trusted-host list), and the MCP server manager that owns bridge instance lifecycles. */
export const inject = ['webServer', 'webStartup', 'mcpManager']

/**
 * One stdio MCP bridge contributed to the mcp-manager. `scriptPath` is
 * clone-root relative (resolved from this build output: plugins/dashboard/lib
 * → repo root), so entries track the active slot's clone across blue-green
 * flips without absolute paths. `envFromProcess` names service-environment
 * variables (/etc/nix/dsh-env) copied into the child: mcp-client scrubs
 * ambient env, so a bridge needing credentials lists them here; absent
 * variables are omitted and the bridge still boots.
 */
export interface McpBridge {
  /** Tool namespace: agents see `mcp__<serverName>__<tool>`. */
  serverName: string
  /** Clone-root-relative script entry, run on this process's node. */
  scriptPath: string
  /** Process-env names restated into the child environment. */
  envFromProcess: string[]
}

type McpBridgeInput = Omit<McpBridge, 'envFromProcess'> & Partial<Pick<McpBridge, 'envFromProcess'>>

const McpBridgeSchema = z.object({
  serverName: z.string().required(),
  scriptPath: z.string().required(),
  envFromProcess: z.array(String).default([]),
}) as z<McpBridgeInput, McpBridge>

/** Plugin configuration: MCP bridges are instance config (cordis.user.yml). */
export interface Config {
  /** Bridges to contribute; empty by default — capability code ships no mounts. */
  mcpBridges: McpBridge[]
}

export const Config = z.object({
  mcpBridges: z.array(McpBridgeSchema).default([]),
}) as z<{ mcpBridges?: McpBridgeInput[] }, Config>

/** Resolve one bridge row into an mcp-manager server registration. */
function mcpBridgeRegistration(entry: McpBridge): McpServerRegistration {
  const cloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const env = Object.fromEntries(entry.envFromProcess.flatMap(name =>
    process.env[name] !== undefined ? [[name, process.env[name] as string]] : [],
  ))
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [resolve(cloneRoot, entry.scriptPath)],
    env,
  }
}


/** Host plugin body: ledger service + overview route + MCP bridges, tied to this fiber. */
export function apply(ctx: Context, config: Config): void {
  const dshHomeDir = resolveDshHome()
  // The ledger dir is created on demand by the flush, but an early missing
  // dir turns the first write into an ELOOP-free, predictable failure; make
  // it here so the first fold already persists.
  mkdirSync(dshHomeDir, { recursive: true })
  const service = new DashboardService(ctx, dshHomeDir)
  const disposeRoute = ctx.webServer.register(makeDashboardOverviewRoute(ctx, service))
  service.start()
  // One manager registration per configured bridge: the manager owns the
  // mcp-client instance (connect, `mcp__<name>__*` tool registration,
  // reconnect, status) under its own fiber; this effect ties the
  // registration to the dashboard fiber, so dashboard going away takes its
  // bridges with it.
  for (const entry of config.mcpBridges) {
    ctx.effect(() => ctx.mcpManager.register(entry.serverName, mcpBridgeRegistration(entry)), `dashboard: mcp bridge ${entry.serverName}`)
  }
}
