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
import { apply as mcpClientApply, type Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { DashboardService, resolveDshHome } from './host/service.ts'
import { makeDashboardOverviewRoute } from './host/routes.ts'

/** Host services this plugin requires: the web server that owns /api routes, and the invocation flags (--trusted-host list). */
export const inject = ['webServer', 'webStartup']

/**
 * One stdio MCP bridge composed as a dashboard child fiber. `scriptPath` is
 * clone-root relative (resolved from this build output:
 * plugins/dashboard/lib → repo root), so entries track the active slot's
 * clone across blue-green flips without absolute paths. `envFromProcess`
 * names service-environment variables (/etc/nix/dsh-env) copied into the
 * child: mcp-client scrubs ambient env, so a bridge needing credentials
 * lists them here; absent variables are omitted and the bridge still boots.
 */
export interface McpBridge {
  /** Tool namespace: agents see `mcp__<serverName>__<tool>`. */
  serverName: string
  /** Clone-root-relative script entry, run on this process's node. */
  scriptPath: string
  /** Process-env names restated into the child environment. */
  envFromProcess: string[]
  /** Fail dashboard activation when the bridge cannot start (default false). */
  failOnStartupError: boolean
}

type McpBridgeInput = Omit<McpBridge, 'envFromProcess' | 'failOnStartupError'>
  & Partial<Pick<McpBridge, 'envFromProcess' | 'failOnStartupError'>>

const McpBridgeSchema = z.object({
  serverName: z.string().required(),
  scriptPath: z.string().required(),
  envFromProcess: z.array(String).default([]),
  failOnStartupError: z.boolean().default(false),
}) as z<McpBridgeInput, McpBridge>

/** Plugin configuration: MCP bridges are instance config (cordis.user.yml). */
export interface Config {
  /** Bridges to compose; empty by default — capability code ships no mounts. */
  mcpBridges: McpBridge[]
}

export const Config = z.object({
  mcpBridges: z.array(McpBridgeSchema).default([]),
}) as z<{ mcpBridges?: McpBridgeInput[] }, Config>

/** Resolve one bridge row into an mcp-client stdio config. */
function mcpBridgeConfig(entry: McpBridge): McpClientConfig {
  const cloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const env = Object.fromEntries(entry.envFromProcess.flatMap(name =>
    process.env[name] !== undefined ? [[name, process.env[name] as string]] : [],
  ))
  return {
    transport: 'stdio',
    serverName: entry.serverName,
    command: process.execPath,
    args: [resolve(cloneRoot, entry.scriptPath)],
    env,
    failOnStartupError: entry.failOnStartupError,
  // StdioConfig's schema-defaulted fields (cwd, timeouts, expandTemplates)
  // read as required on the exported type; cordis validates this row through
  // mcp-client's Config schema and fills those defaults at mount time.
  } as McpClientConfig
}

/** Host plugin body: ledger service + overview route + MCP bridges, tied to this fiber. */
export function apply(ctx: Context, config: Config): void {
  console.error('[dbg] dashboard apply config:', JSON.stringify(config))
  const dshHomeDir = resolveDshHome()
  // The ledger dir is created on demand by the flush, but an early missing
  // dir turns the first write into an ELOOP-free, predictable failure; make
  // it here so the first fold already persists.
  mkdirSync(dshHomeDir, { recursive: true })
  const service = new DashboardService(ctx, dshHomeDir)
  const disposeRoute = ctx.webServer.register(makeDashboardOverviewRoute(ctx, service))
  service.start()
  // Composed children: one mcp-client fiber per configured bridge — own
  // lifecycle (connect, register `mcp__<name>__*` tools, reconnect, dispose)
  // scoped to this fiber; dashboard going away takes its bridges with it.
  // Startup failure degrades to no tools from that bridge (unless the row
  // opts into failOnStartupError); the dashboard itself keeps working.
  for (const entry of config.mcpBridges) {
    ctx.plugin(mcpClientApply, mcpBridgeConfig(entry))
  }
}
