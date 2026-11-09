/**
 * Loopback trust fence for the dashboard routes, forked (simplified: no
 * remote-web-ui pairing arm) from @linxin666/dsh-usage's shared
 * `host/loopback.ts` + `host/access.ts`, Apache License 2.0 — Copyright (c)
 * 2025 linxin666 and contributors.
 *
 * Semantics: RFC 5735 IPv4 127/8, ::1, IPv4-mapped ::ffff:127/8, plus the
 * browser same-origin markers (Sec-Fetch-Site / Origin) so a LAN-bound
 * same-origin page the host itself served keeps working. A request that
 * carries forwarding headers came through a proxy and is never local.
 * @module dashboard/host/loopback
 */

import type { IncomingMessage } from 'node:http'

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a request carries headers stamped by a forwarding hop (proxy/tunnel). */
function isProxiedRequest(request: IncomingMessage): boolean {
  return request.headers['cf-connecting-ip'] !== undefined || request.headers['x-forwarded-for'] !== undefined
}

/** Whether an Origin/Referer authority names the loopback host. */
function isLoopbackAuthority(authority: string | undefined): boolean {
  if (authority === undefined) return false
  try {
    const host = new URL(authority).hostname.toLowerCase()
    return host === 'localhost' || isIPv4Loopback(host) || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** Whether an HTTP `Host` header (`host[:port]`) names the loopback host. */
function isLoopbackHostAuthority(host: string | undefined): boolean {
  return isLoopbackAuthority(host === undefined ? undefined : `http://${host}`)
}

/**
 * Whether an authority header matches a `--trusted-host` entry. Mirrors the
 * connection layer's rule: an entry with a port matches exactly, a port-less
 * entry matches any port on that hostname.
 */
function isTrustedHostAuthority(header: string | undefined, trusted: readonly string[]): boolean {
  if (header === undefined || trusted.length === 0) return false
  const url = parseAuthorityLenient(header)
  if (url === undefined) return false
  const port = url.port === '' ? undefined : url.port
  return trusted.some((entry) => {
    const entryUrl = parseAuthorityLenient(entry)
    return entryUrl !== undefined && entryUrl.hostname === url.hostname && (entryUrl.port === '' || entryUrl.port === port)
  })
}

/** Parse a bare `host[:port]` authority or an absolute URL; undefined when neither. */
function parseAuthorityLenient(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    try {
      return new URL(`http://${value}`)
    } catch {
      return undefined
    }
  }
}

/**
 * Whether this request may read the dashboard overview.
 *
 * Remote sockets are always rejected — the same-origin markers are
 * client-supplied and forgeable, so only a loopback socket (the local
 * browser, or a same-host reverse proxy such as caddy fronting the tailnet)
 * may in. On a loopback socket:
 * - a direct local caller (curl, CLI, local browser) is admitted as before;
 * - a browser-proxied request (the proxy sets X-Forwarded-For) must carry
 *   same-site markers whose Host/Origin/Referer name the loopback host or a
 *   `--trusted-host` authority — forged markers from a remote socket never
 *   reach this arm, and a foreign Host (evil.example) is still rejected.
 */
export function isDashboardRequestAllowed(request: IncomingMessage, trustedHosts: readonly string[] = []): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const site = request.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  if (site === 'same-origin' || site === 'same-site') {
    const host = request.headers.host
    const originOk =
      isLoopbackAuthority(request.headers.origin) ||
      isTrustedHostAuthority(request.headers.origin, trustedHosts) ||
      isLoopbackAuthority(request.headers.referer) ||
      isTrustedHostAuthority(request.headers.referer, trustedHosts)
    if (!originOk) return false
    return isLoopbackHostAuthority(host) || isTrustedHostAuthority(host, trustedHosts)
  }
  return true
}
