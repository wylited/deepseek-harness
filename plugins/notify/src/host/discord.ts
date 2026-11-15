/**
 * Discord webhook delivery: one POST per ≤10-embed batch, rich embeds colored
 * by workspace. The webhook URL is a secret resolved per operation from the
 * credential seam (or the service environment); it is never logged — every
 * reference masks it down to its last four characters.
 * @module notify/host/discord
 */

import type { LoggerFace } from './faces.ts'

/** One queued notification rendered as one Discord embed. */
export interface NoticeEmbed {
  readonly kind: 'question' | 'done'
  readonly sessionId: string
  readonly title: string | undefined
  readonly cwd: string | undefined
  readonly text: string
}

/** Maximum snippet length for the embed description. */
export const SNIPPET_MAX = 200

/** Embeds accepted per webhook request. */
const EMBEDS_PER_REQUEST = 10

/** Webhook POST budget before the delivery gives up (and only logs). */
const FETCH_TIMEOUT_MS = 10_000

/** Pleasant embed colors, indexed by a stable workspace hash. */
const PALETTE = [
  0x58_65_f2, // blurple
  0x57_f2_87, // green
  0xfe_e7_5c, // yellow
  0xeb_45_9e, // fuchsia
  0x00_b0_f4, // blue
  0xe6_7e_22, // carrot
  0x9b_59_b6, // amethyst
  0x1a_bc_9c, // teal
] as const

/** FNV-1a over a UTF-8 string; stable across restarts, no deps. */
export function stableHash(text: string): number {
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01_00_01_93)
  }
  return hash >>> 0
}

/** Final path segment of a workspace path, or the path when segment-less. */
export function workspaceName(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined
  const trimmed = cwd.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return name.length > 0 ? name : trimmed
}

/** Whitespace-collapsed snippet capped at {@link SNIPPET_MAX}. */
export function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= SNIPPET_MAX) return collapsed
  return `${collapsed.slice(0, SNIPPET_MAX - 1).trimEnd()}…`
}

/** The webhook URL reduced to its last four characters — safe to log. */
export function maskUrl(url: string): string {
  return `***${url.slice(-4)}`
}

/** Build one Discord embed payload for a notice. */
export function buildEmbed(notice: NoticeEmbed, link: string | undefined): Record<string, unknown> {
  const workspace = workspaceName(notice.cwd)
  const color = PALETTE[stableHash(notice.cwd ?? notice.sessionId) % PALETTE.length]
  const title = notice.title ?? `Session ${notice.sessionId.slice(0, 8)}`
  const description = snippet(notice.text)
  return {
    title: `${notice.kind === 'question' ? '❓' : '✅'} ${title}`,
    ...(description.length > 0 ? { description } : {}),
    ...(link === undefined ? {} : { url: link }),
    color,
    timestamp: new Date().toISOString(),
    fields: [{ name: 'Workspace', value: workspace ?? '—', inline: true }],
    footer: { text: 'dsh' },
  }
}

/**
 * POST one batch of embeds. Never throws: failure logs a warn with the URL
 * masked and the delivery is dropped — a missed ping is better than a crash
 * in the session feed.
 * @returns whether every chunk was accepted (2xx).
 */
export async function sendEmbeds(url: string, embeds: readonly Record<string, unknown>[],
  logger: LoggerFace): Promise<boolean> {
  let accepted = true
  for (let start = 0; start < embeds.length; start += EMBEDS_PER_REQUEST) {
    const chunk = embeds.slice(start, start + EMBEDS_PER_REQUEST)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: chunk }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        logger.warn(`notify: discord webhook ${maskUrl(url)} answered ${String(response.status)}`)
        accepted = false
      }
    } catch (error: unknown) {
      logger.warn(`notify: discord webhook ${maskUrl(url)} failed:`, error)
      accepted = false
    }
  }
  return accepted
}
