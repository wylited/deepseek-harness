/**
 * dashboard, node half. Registers the usage-ledger service and its
 * same-origin overview route; the browser half ships through
 * `exports["./client"]` (same split as packages/client/ui-brand-official
 * and plugins/restyle).
 * @module dashboard
 */

import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { DashboardService, resolveDshHome } from './host/service.ts'
import { makeDashboardOverviewRoute } from './host/routes.ts'

/** Host services this plugin requires: the web server that owns /api routes, and the invocation flags (--trusted-host list). */
export const inject = ['webServer', 'webStartup']

/** Host plugin body: ledger service + overview route, tied to this fiber. */
export function apply(ctx: Context): void {
  const dshHomeDir = resolveDshHome()
  // The ledger dir is created on demand by the flush, but an early missing
  // dir turns the first write into an ELOOP-free, predictable failure; make
  // it here so the first fold already persists.
  mkdirSync(dshHomeDir, { recursive: true })
  const service = new DashboardService(ctx, dshHomeDir)
  const disposeRoute = ctx.webServer.register(makeDashboardOverviewRoute(ctx, service))
  service.start()
  ctx.effect(() => {
    return async () => {
      disposeRoute()
      await service.stop()
    }
  }, 'dashboard: runtime')
}
