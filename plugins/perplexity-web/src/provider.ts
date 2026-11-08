/**
 * The Perplexity web-search provider: one `perplexity_ask` round trip per query,
 * grounded by the account's session JWT sent as a cookie. Registered on the web
 * capability seam (`ctx.web`) so `dsh-web` can select it via `searchProvider`.
 * @module perplexity-web/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { askPerplexity } from './ask.ts'
import { resolvePerplexityCredential } from './auth.ts'

/** Stable id this provider registers under. */
export const PERPLEXITY_WEB_PROVIDER_ID = 'perplexity-web'

/** Resolved provider options (the plugin's `apply` supplies config defaults). */
export interface PerplexityWebProviderOptions {
  /** Consumer subscription model preference sent as `model_preference`. */
  readonly model: string
  /** Hard budget for one ask, including the stream. */
  readonly timeoutMs: number
}

/** Map an ask source onto the seam's citeable source. */
function toWebSearchSource(source: { url: string; title: string; snippet?: string; publishedAt?: string }): WebSearchSource {
  return {
    url: source.url,
    title: source.title,
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
    ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
  }
}

/**
 * The Perplexity-backed search provider. The ask endpoint returns a natural
 * language answer plus its citations; the answer becomes the result's
 * `content`, the citations the `sources`. `maxResults` is enforced by the seam,
 * and the ask API has no result-count control to push down.
 */
export class PerplexityWebProvider implements WebSearchProvider {
  readonly id = PERPLEXITY_WEB_PROVIDER_ID

  readonly title = 'Perplexity'

  /** Picker description: what this provider suits and what it costs or cannot do. */
  readonly description: NonNullable<WebSearchProvider['description']> = {
    en: 'Searches through a Perplexity account session (Pro models when signed in), returning a synthesized answer with citations. Requires a Perplexity session credential; every search uses account quota.',
    zh: '通过 Perplexity 账号会话进行搜索（登录后使用 Pro 模型），返回带引用的综合答案。需要 Perplexity 会话凭据；每次搜索都会消耗账号配额',
    ja: 'Perplexity アカウントセッションで検索し（サインイン時は Pro モデル）、引用付きの回答を返します。Perplexity セッション資格情報が必要で、検索ごとにアカウント枠を消費します。',
    es: 'Busca mediante una sesión de cuenta de Perplexity (modelos Pro al iniciar sesión) y devuelve una respuesta sintetizada con citas. Requiere una credencial de sesión de Perplexity; cada búsqueda consume cuota de la cuenta.',
    fr: 'Recherche via une session de compte Perplexity (modèles Pro une fois connecté), renvoyant une réponse synthétisée avec citations. Nécessite des identifiants de session Perplexity ; chaque recherche consomme le quota du compte.',
    de: 'Durchsucht das Web über eine Perplexity-Kontositzung (Pro-Modelle bei Anmeldung) und liefert eine synthetisierte Antwort mit Zitaten. Erfordert eine Perplexity-Sitzungsanmeldeinformation; jede Suche verbraucht Kontingent.',
    ru: 'Поиск через сессию аккаунта Perplexity (модели Pro после входа) возвращает синтезированный ответ со ссылками. Требуются учётные данные сессии Perplexity; каждый поиск расходует квоту аккаунта.',
    pt: 'Pesquisa por meio de uma sessão de conta do Perplexity (modelos Pro quando autenticado), retornando uma resposta sintetizada com citações. Requer uma credencial de sessão do Perplexity; cada pesquisa consome a cota da conta.',
  }

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted at
   * each operation's entry so one search never mixes two config sections.
   */
  constructor(private readonly resolveOptions: () => PerplexityWebProviderOptions) {}

  /** Cheap local check: the ask endpoint URL is fixed and options carry no credential. */
  available(): boolean {
    const options = this.resolveOptions()
    return options.model.length > 0 && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
  }

  /**
   * Whether the next search would have a session credential to send. Local
   * reads only (env, macOS defaults, omp's SQLite store) — no network calls.
   */
  async ready(): Promise<boolean> {
    try {
      await resolvePerplexityCredential()
      return true
    } catch {
      return false
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    if (request.query.length === 0) {
      throw new WebError('Perplexity search requires a non-empty query', 'WEB_PROVIDER_ERROR')
    }
    const { answer, sources } = await askPerplexity({
      query: request.query,
      model: options.model,
      timeoutMs: options.timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    })
    return {
      ...(answer.length > 0 ? { content: answer } : {}),
      sources: sources.map(toWebSearchSource),
      truncated: false,
    }
  }
}
