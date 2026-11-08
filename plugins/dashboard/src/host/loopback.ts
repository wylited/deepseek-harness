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

/**
 * Whether this request may read the dashboard overview: a loopback socket
 * (the local browser and anything on this machine), or a request carrying
 * the browser same-origin markers toward a loopback authority — never a
 * proxied request.
 */
export function isDashboardRequestAllowed(request: IncomingMessage): boolean {
  if (isProxiedRequest(request)) return false
  if (isLoopbackAddress(request.socket.remoteAddress)) return true
  const site = request.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'same-site') {
    return isLoopbackAuthority(request.headers.origin) || isLoopbackAuthority(request.headers.referer)
  }
  return false
}
