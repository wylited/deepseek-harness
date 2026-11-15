/**
 * Dashboard host routes: one same-origin JSON endpoint serving the overview
 * document. Route shape, JSON writing, and the loopback fence follow
 * @linxin666/dsh-usage v0.4.16 (`host/routes.ts`, `host/http.ts`), Apache
 * License 2.0 — Copyright (c) 2025 linxin666 and contributors.
 * @module dashboard/host/routes
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isDashboardRequestAllowed } from './loopback.ts'
import type { DashboardService } from './service.ts'

export const DASHBOARD_API_PREFIX = '/api/dashboard'

/** Family-default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

/** Write one JSON response; caller headers append (cache-control). */
function writeJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

/**
 * Overview route: `GET /api/dashboard/overview` answers the aggregated
 * ledger document (headline windows, heatmap series, per-model and
 * per-session leaderboards). Personal usage data behind the loopback fence —
 * see loopback.ts.
 */
export function makeDashboardOverviewRoute(ctx: Context, service: DashboardService): WebRoute {
  return {
    kind: 'exact',
    path: DASHBOARD_API_PREFIX + '/overview',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      const trustedHosts = ctx.get('webStartup')?.trustedHosts ?? []
      if (!isDashboardRequestAllowed(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      writeJson(res, 200, { ok: true, overview: service.overview() }, { 'cache-control': 'no-store' })
    },
  }
}

/** At most this many session ids one summaries request may name. */
const SUMMARIES_ID_CAP = 40

/**
 * Summaries route: `GET /api/dashboard/summaries?ids=<session ids>` answers
 * each session's dashboard facts — host running state, open user question,
 * cached idle summary, staleness. Stale idle sessions regenerate in the
 * background; the answer is always the immediate cache read. Behind the
 * same loopback fence as the overview.
 */
export function makeDashboardSummariesRoute(ctx: Context, service: DashboardService): WebRoute {
  return {
    kind: 'exact',
    path: DASHBOARD_API_PREFIX + '/summaries',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      const trustedHosts = ctx.get('webStartup')?.trustedHosts ?? []
      if (!isDashboardRequestAllowed(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const ids = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ids')
        ?.split(',')
        .filter(id => id !== '')
        .slice(0, SUMMARIES_ID_CAP)
        ?? []
      writeJson(res, 200, { ok: true, summaries: service.pollSummaries(ids) }, { 'cache-control': 'no-store' })
    },
  }
}
