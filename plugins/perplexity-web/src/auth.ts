/**
 * Perplexity session-JWT resolution for the ask endpoint's cookie auth.
 *
 * The consumer `perplexity_ask` endpoint authenticates with the next-auth
 * session cookie — never a Bearer header, which it silently ignores and
 * downgrades to the anonymous free tier. The JWT sources, in priority order:
 *
 * 1. `PERPLEXITY_JWT` — the raw session JWT.
 * 2. `PERPLEXITY_COOKIES` — a raw cookie string, passed verbatim as the whole
 *    `Cookie` header (for users who export their full browser cookie).
 * 3. The native macOS app's UserDefaults (`defaults read ai.perplexity.mac
 *    authToken`) — tokens live outside the Keychain, readable by any
 *    same-UID process.
 * 4. oh-my-pi's credential store (`~/.omp/agent/agent.db`, read-only SELECT).
 *
 * The token IS the account's session: never log it, never persist it into
 * configuration. Local machine reads only.
 * @module perplexity-web/auth
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Next-auth session cookie name the ask endpoint authenticates with. */
export const PERPLEXITY_SESSION_COOKIE = '__Secure-next-auth.session-token'

/** Path of oh-my-pi's agent credential store, when that harness is installed. */
const OMP_AGENT_DB = join(homedir(), '.omp', 'agent', 'agent.db')

/** One resolved credential: a bare JWT (sent as the canonical single cookie) or a verbatim cookie string. */
export type PerplexityCredential =
  | { readonly kind: 'jwt'; readonly token: string; readonly source: string }
  | { readonly kind: 'cookies'; readonly cookies: string; readonly source: string }

/** `Cookie` header value for one credential. */
export function cookieHeaderOf(credential: PerplexityCredential): string {
  return credential.kind === 'cookies' ? credential.cookies : `${PERPLEXITY_SESSION_COOKIE}=${credential.token}`
}

/** Env-based credential: `PERPLEXITY_JWT` wins over `PERPLEXITY_COOKIES`; undefined when neither is set. */
function credentialFromEnv(env: NodeJS.ProcessEnv = process.env): PerplexityCredential | undefined {
  const jwt = env.PERPLEXITY_JWT?.trim()
  if (jwt) return { kind: 'jwt', token: jwt, source: 'PERPLEXITY_JWT' }
  const cookies = env.PERPLEXITY_COOKIES?.trim()
  if (cookies) return { kind: 'cookies', cookies, source: 'PERPLEXITY_COOKIES' }
  return undefined
}

/** Native macOS Perplexity app token (UserDefaults, not Keychain); undefined when the app is absent. */
async function credentialFromMacApp(): Promise<PerplexityCredential | undefined> {
  if (process.platform !== 'darwin') return undefined
  try {
    const { stdout } = await execFileAsync('defaults', ['read', 'ai.perplexity.mac', 'authToken'])
    const token = stdout.trim()
    if (token.length > 0) return { kind: 'jwt', token, source: 'ai.perplexity.mac defaults' }
  } catch { /* app not installed or token unreadable */ }
  return undefined
}

/** oh-my-pi's stored Perplexity OAuth session (`auth_credentials.data.access`); undefined when absent. */
async function credentialFromOmpStore(dbPath = OMP_AGENT_DB): Promise<PerplexityCredential | undefined> {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch { /* store absent or unreadable */ return undefined }
  try {
    const row = db.prepare(
      `SELECT data FROM auth_credentials
       WHERE provider = 'perplexity' AND credential_type = 'oauth' AND disabled_cause IS NULL
       ORDER BY updated_at DESC LIMIT 1`,
    ).get()
    const parsed: unknown = typeof row?.data === 'string' ? JSON.parse(row.data) : undefined
    const token = (parsed as { access?: unknown } | null)?.access
    if (typeof token === 'string' && token.length > 0) return { kind: 'jwt', token, source: 'omp agent.db' }
  } catch { /* schema drift or malformed row: fall through */ } finally {
    db.close()
  }
  return undefined
}

let cachedCredential: Promise<PerplexityCredential> | undefined

/**
 * Resolve the credential to send, in priority order; the process-wide result is
 * cached because every source is a local read. Rejects when no source supplies
 * a credential.
 */
export function resolvePerplexityCredential(): Promise<PerplexityCredential> {
  cachedCredential ??= (async () => {
    const fromEnv = credentialFromEnv()
    if (fromEnv) return fromEnv
    const fromMacApp = await credentialFromMacApp()
    if (fromMacApp) return fromMacApp
    const fromOmpStore = await credentialFromOmpStore()
    if (fromOmpStore) return fromOmpStore
    throw new Error(
      'no Perplexity session credential found: set PERPLEXITY_JWT (session JWT) or PERPLEXITY_COOKIES '
      + '(raw cookie string), or sign in via the Perplexity macOS app or oh-my-pi',
    )
  })()
  // A rejection (no credential anywhere) must not stick: drop the memo so the
  // next call re-reads every source. Resolved successes stay cached — the
  // extra .catch branch only resets the memo; callers still see the rejection.
  cachedCredential.catch(() => {
    cachedCredential = undefined
  })
  return cachedCredential
}

/**
 * Drop the cached credential so the next resolution re-reads every source.
 * Called when Perplexity rejects the cookie (HTTP 401/403): the stored session
 * may have been rotated or signed out.
 */
export function invalidatePerplexityCredential(): void {
  cachedCredential = undefined
}
