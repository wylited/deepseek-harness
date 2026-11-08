/**
 * Formatting helpers for the dashboard client: compact token counts, short
 * relative times, and local-day labels. No locale dependency — the dashboard
 * is a personal page and mirrors the shell's English chrome.
 * @module dashboard/client/format
 */

/** Compact token count: 940, 12.4k, 3.1M. */
export function compactTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) {
    const value = count / 1_000
    return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}k`
  }
  if (count < 1_000_000_000) {
    const value = count / 1_000_000
    return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}M`
  }
  return `${Math.round((count / 1_000_000_000) * 10) / 10}B`
}

/** Elapsed label: just now, 42s, 5m, 3h, 6d, then a local date. */
export function relativeTime(ms: number, now: number): string {
  const delta = Math.max(0, now - ms)
  if (delta < 15_000) return 'just now'
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`
  return localDayLabel(ms)
}

/** `Nov 8`-style local day label. */
export function localDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Clock+day label for tooltips. */
export function fullTimeLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Basename of a workspace path, or the raw value when it has none. */
export function pathBase(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}
