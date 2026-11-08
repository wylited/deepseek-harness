/**
 * Perplexity web-search provider plugin for the DeepSeek Harness web capability
 * seam. Port of oh-my-pi's consumer ask-endpoint search: `POST
 * https://www.perplexity.ai/rest/sse/perplexity_ask` authenticated with the
 * account's session JWT as a cookie (never a Bearer header — the endpoint
 * ignores it and silently downgrades to the anonymous free tier).
 * @module perplexity-web
 */

import type { Volatile } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { PerplexityWebProvider } from './provider.ts'
import type { PerplexityWebProviderOptions } from './provider.ts'

export { PERPLEXITY_ASK_URL, askPerplexity } from './ask.ts'
export type { AskOptions, AskResult, AskSource, PerplexityFailure } from './ask.ts'
export {
  PERPLEXITY_SESSION_COOKIE,
  invalidatePerplexityCredential,
  resolvePerplexityCredential,
} from './auth.ts'
export type { PerplexityCredential } from './auth.ts'
export { PERPLEXITY_WEB_PROVIDER_ID, PerplexityWebProvider } from './provider.ts'
export type { PerplexityWebProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'perplexity-web'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /**
   * Consumer subscription model preference (`model_preference`), e.g.
   * `experimental`, `sonar`, `turbo`. Defaults to `$PI_PERPLEXITY_MODEL`, then
   * `experimental` (the account's model selection).
   */
  model: Volatile<string | undefined>
  /** Hard budget for one ask including the stream, in ms. */
  timeoutMs: Volatile<number>
}

export const Config = z.object({
  // No schema default on purpose: a rendered section would freeze the env
  // fallback into a value the environment can no longer override.
  model: z.string().volatile(),
  timeoutMs: z.number().step(1).min(1000).default(60_000).volatile(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 */
function resolveOptions(config: { [K in keyof Config]: ReturnType<Config[K]['get']> }): PerplexityWebProviderOptions {
  return {
    model: config.model ?? process.env.PI_PERPLEXITY_MODEL?.trim() ?? 'experimental',
    timeoutMs: config.timeoutMs,
  }
}

/** Register the Perplexity search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const options = () => resolveOptions({
    model: config.model.get(),
    timeoutMs: config.timeoutMs.get(),
  })
  const provider = new PerplexityWebProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    title: provider.title,
    description: provider.description,
    available: () => provider.available(),
    ready: () => provider.ready(),
    search: (request, signal) => provider.search(request, signal),
  })
}
