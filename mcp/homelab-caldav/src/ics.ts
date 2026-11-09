/**
 * Minimal RFC 5545 subset for Radicale round-trips: line unfolding, one
 * component (VEVENT/VTODO) parser that keeps raw lines for lossless updates,
 * text escaping, byte-safe folding, and the three date forms the store uses
 * (VALUE=DATE all-day, UTC `...Z`, floating wall time).
 *
 * Same date-form law as wycal: an ISO input with an offset (incl. Z) is
 * normalized to UTC Z form; a naive local input stays floating (no Z).
 */

export type DateForm =
  | { kind: 'date'; date: string } // YYYY-MM-DD all-day
  | { kind: 'utc'; iso: string } // instant, stored ...Z
  | { kind: 'floating'; wall: string } // local wall time, no Z

/** RFC 5545 text escape: backslash, semicolon, comma, newline. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

/** Inverse of escapeText (also handles the legacy \N line break). */
export function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1')
}

/** Unfold (CRLF + SP continuation) and split one ICS object into lines. */
export function unfoldLines(ics: string): string[] {
  return ics.replace(/\r\n[ \t]|\n[ \t]/g, '').split(/\r\n|\r|\n/)
}

/** Fold one logical line: first line ≤75 octets, continuations ' ' + ≤74. */
export function foldLine(line: string): string {
  const enc = Buffer.byteLength
  if (enc(line, 'utf8') <= 75) return line
  const parts: string[] = []
  let cur = ''
  let curBytes = 0
  let limit = 75
  for (const ch of line) {
    const b = enc(ch, 'utf8')
    if (curBytes + b > limit) {
      parts.push(cur)
      cur = ' '
      curBytes = 1
      limit = 74
    }
    cur += ch
    curBytes += b
  }
  if (cur.trim() !== '' || cur === ' ') parts.push(cur)
  return parts.join('\r\n')
}

export interface IcsProp {
  name: string
  /** Parameter names uppercased, values verbatim (unquoted). */
  params: Record<string, string>
  value: string
}

export interface IcsComponent {
  /** Raw unfolded lines of the component, BEGIN/END included. */
  raw: string[]
  props: IcsProp[]
}

/** Parse one component instance (first BEGIN:<name>…END:<name> block). */
export function parseComponent(ics: string, name: string): IcsComponent | null {
  const lines = unfoldLines(ics)
  const up = name.toUpperCase()
  const start = lines.findIndex((l) => l.toUpperCase() === `BEGIN:${up}`)
  if (start === -1) return null
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].toUpperCase() === `END:${up}`) {
      end = i
      break
    }
  }
  if (end === -1) return null
  const raw = lines.slice(start, end + 1)
  const props: IcsProp[] = []
  for (const line of raw.slice(1, -1)) {
    const p = parsePropLine(line)
    if (p) props.push(p)
  }
  return { raw, props }
}

/** One unfolded content line → {name, params, value}, or null for junk. */
export function parsePropLine(line: string): IcsProp | null {
  const colon = valueColonIndex(line)
  if (colon === -1) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segs = head.split(';')
  const name = segs[0].trim().toUpperCase()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=')
    if (eq === -1) continue
    const k = seg.slice(0, eq).trim().toUpperCase()
    let v = seg.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
    params[k] = v
  }
  return { name, params, value }
}

/** Index of the value colon (first colon outside double quotes). */
function valueColonIndex(line: string): number {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) return i
  }
  return -1
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Parse an ISO-ish date/datetime input into a DateForm; null when invalid. */
export function parseDateInput(input: string): DateForm | null {
  const s = input.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: 'date', date: s }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const wall = `${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}`
    return { kind: 'floating', wall }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return null
    return { kind: 'utc', iso: d.toISOString().replace(/\.\d{3}Z$/, 'Z') }
  }
  return null
}

/** Compact ICS value of a DateForm (e.g. `20260101T090000Z`). */
export function dateIcsValue(d: DateForm): string {
  if (d.kind === 'date') return d.date.replace(/-/g, '')
  if (d.kind === 'floating') return d.wall.replace(/[-:]/g, '')
  return d.iso.replace(/[-:]/g, '')
}

/** ICS property line for a DateForm (DTSTART/DUE/COMPLETED/…). */
export function datePropLine(name: string, d: DateForm): string {
  if (d.kind === 'date') return `${name};VALUE=DATE:${dateIcsValue(d)}`
  return `${name}:${dateIcsValue(d)}`
}

/** DateForm from a parsed ICS prop (VALUE=DATE / trailing Z / floating). */
export function dateFromProp(p: IcsProp): DateForm | null {
  const v = p.value.trim()
  if (p.params['VALUE'] === 'DATE' || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
    return m ? { kind: 'date', date: `${m[1]}-${m[2]}-${m[3]}` } : null
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (!m) return null
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  if (m[7] === 'Z') return { kind: 'utc', iso: new Date(`${wall}Z`).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  return { kind: 'floating', wall }
}

/** Duration in ms between two same-kind DateForms; null if kinds differ. */
export function durationBetween(a: DateForm, b: DateForm): number | null {
  if (a.kind === 'date' && b.kind === 'date') {
    return Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${a.date}T00:00:00Z`)
  }
  if (a.kind === 'floating' && b.kind === 'floating') {
    return Date.parse(`${b.wall}Z`) - Date.parse(`${a.wall}Z`)
  }
  if (a.kind === 'utc' && b.kind === 'utc') return Date.parse(b.iso) - Date.parse(a.iso)
  return null
}

/** Shift a DateForm by ms, preserving its form class. */
export function shiftDate(d: DateForm, ms: number): DateForm {
  if (d.kind === 'date') {
    const t = new Date(Date.parse(`${d.date}T00:00:00Z`) + ms)
    return { kind: 'date', date: t.toISOString().slice(0, 10) }
  }
  if (d.kind === 'floating') {
    const t = new Date(Date.parse(`${d.wall}Z`) + ms)
    return { kind: 'floating', wall: t.toISOString().slice(0, 19) }
  }
  const t = new Date(Date.parse(d.iso) + ms)
  return { kind: 'utc', iso: t.toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

/** Now as UTC DTSTAMP/COMPLETED value. */
export function nowUtc(): string {
  const d = new Date()
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  )
}

/**
 * Replace/remove modeled properties inside a raw component, preserving every
 * other line (RRULE, CATEGORIES, X-props, VALARMs) and line order: modeled
 * lines are dropped, replacements appended before END.
 */
export function mergeComponent(
  raw: string[],
  replacements: Array<{ name: string; line?: string }>,
): string[] {
  const drop = new Set(replacements.map((r) => r.name))
  const add: string[] = []
  for (const r of replacements) {
    if (r.line !== undefined) add.push(r.line)
  }
  const out: string[] = []
  for (const line of raw) {
    const colon = valueColonIndex(line)
    const name = (colon === -1 ? line : line.slice(0, colon)).split(';')[0].trim().toUpperCase()
    if (drop.has(name)) continue
    out.push(line)
  }
  out.splice(Math.max(out.length - 1, 0), 0, ...add)
  return out
}

/** Wrap component lines in a VCALENDAR document (CRLF, folded). */
export function calendarDocument(componentLines: string[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dsh//homelab-caldav//EN',
    'CALSCALE:GREGORIAN',
    ...componentLines,
    'END:VCALENDAR',
  ]
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
