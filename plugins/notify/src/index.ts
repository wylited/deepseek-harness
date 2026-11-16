/**
 * notify, node half. Watches the global Session feed for user-attention
 * moments — an `ask_user_question` tool call, or a completed turn that left a
 * final assistant message — and routes them: a connected web client gets the
 * in-page toast (browser half) and Discord stays silent; with no client
 * connected, one rich Discord webhook message goes out after a short delay,
 * re-checked and cancelled if a client appears meanwhile. The webhook URL is
 * a credential-seam secret, resolved per operation and never logged.
 * @module notify
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NotifyService, type NotifyServices } from './host/notify.ts'
import { makeNotifyAttentionRoute } from './host/attention-route.ts'
import type { CredentialsFace, GatewayFace, LoggerFace, SessionEventsFace } from './host/faces.ts'

/**
 * Services `apply` consumes (tryGet below). Declaring them pins plugin start
 * AFTER these services exist — without it, apply can run before webServer /
 * typertGateway / credentials are up and every integration silently no-ops.
 */
export const inject = ['webServer', 'typertGateway', 'credentials', 'webApp']

/**
 * Plugin configuration (cordis.user.yml row). Defaults notify on with the
 * 45-second delay; a row that replaces the config only needs the fields it
 * wants to change.
 */
export interface Config {
  /** Master switch; false keeps the plugin fully inert. */
  enabled: boolean
  /** Delay between the attention moment and the Discord send, in seconds. */
  delaySeconds: number
  /** Credential reference (or service-environment name) holding the webhook URL. */
  credential: string
  /** Explicit web-UI origin for the embed link; default is the advertised URL. */
  siteUrl: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  delaySeconds: z.number().default(45),
  credential: z.string().default('discord-notify'),
  siteUrl: z.string().default(''),
}) as z<{ enabled?: boolean; delaySeconds?: number; credential?: string; siteUrl?: string }, Config>

/** Read a service that may be absent (optional integration points). */
function tryGet<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Host plugin body: one global feed subscription tied to this fiber. */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('notify')
  logger.warn(`notify: plugin apply — enabled=${String(config.enabled)} delay=${String(config.delaySeconds)}s credential=${config.credential}`)
  const webApp = tryGet<{ getAdvertisedUrl(): string }>(ctx, 'webApp')
  const services: NotifyServices = {
    // Owner-client presence ("is dsh open anywhere"): the gateway's live
    // $events stream. There is no per-session subscriber registry host-side —
    // the browser half refines suppression to the viewed session.
    gateway: tryGet<GatewayFace>(ctx, 'typertGateway'),
    credentials: tryGet<CredentialsFace>(ctx, 'credentials'),
    advertisedUrl: webApp === undefined ? undefined : () => webApp.getAdvertisedUrl(),
    logger: logger as LoggerFace,
  }
  const service = new NotifyService({
    enabled: config.enabled,
    delaySeconds: config.delaySeconds,
    credential: config.credential,
    siteUrl: config.siteUrl,
  }, services)
  const register: SessionEventsFace['on'] = (name, listener, options) =>
    (ctx as Context & SessionEventsFace).on(name, listener, options)
  ctx.effect(() => service.start(register), 'notify: session feed')
  // Focus gate: with a web server, pages report focus and suppression keys
  // on attentive viewers (a backgrounded phone must not silence Discord).
  // Without one the service falls back to the gateway's live-client check.
  const webServer = tryGet<{ register(route: unknown): (() => void) | undefined }>(ctx, 'webServer')
  if (webServer !== undefined) {
    const disposeAttention = webServer.register(makeNotifyAttentionRoute((pageId, focused) => service.setAttention(pageId, focused)))
    service.enableAttentionGate()
    if (disposeAttention !== undefined) ctx.effect(() => disposeAttention, 'notify: attention route')
  }
}
