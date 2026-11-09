#!/usr/bin/env node
/**
 * homelab-caldav — stdio MCP server giving dsh agents CalDAV access to the
 * homelab radicale (events + todos). Zero dependencies: plain node (≥24,
 * native type stripping + fetch), newline-delimited JSON-RPC 2.0 per the MCP
 * stdio transport.
 *
 * Config (env only, no secrets in code):
 *   RADICALE_URL   e.g. https://dav.ts.wyli.tech
 *   RADICALE_USER  radicale htpasswd user (e.g. wyli)
 *   RADICALE_PASS  that user's password
 *   RADICALE_BASIC_USER / RADICALE_BASIC_PASS  optional front-proxy Basic
 *                  credentials when a reverse proxy adds its own auth layer
 *                  (radicale itself is gated by RADICALE_USER/PASS).
 */

import { randomBytes } from 'node:crypto'
import { CalDavClient, DavError, type DavCollection, type DavObject } from './caldav.ts'
import {
  calendarDocument,
  dateFromProp,
  datePropLine,
  durationBetween,
  escapeText,
  mergeComponent,
  nowUtc,
  parseComponent,
  parseDateInput,
  parsePropLine,
  shiftDate,
  unescapeText,
  type DateForm,
  type IcsComponent,
} from './ics.ts'

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`homelab-caldav: missing ${name} (needs RADICALE_URL, RADICALE_USER, RADICALE_PASS)`)
  return v
}

function configFromEnv(): CalDavConfigShape {
  const basicUser = process.env['RADICALE_BASIC_USER']
  const basicPass = process.env['RADICALE_BASIC_PASS']
  return {
    url: requireEnv('RADICALE_URL'),
    user: requireEnv('RADICALE_USER'),
    pass: requireEnv('RADICALE_PASS'),
    ...(basicUser && basicPass ? { basicUser, basicPass } : {}),
  }
}

interface CalDavConfigShape {
  url: string
  user: string
  pass: string
  basicUser?: string
  basicPass?: string
}

let cachedClient: CalDavClient | null = null

function client(): CalDavClient {
  if (!cachedClient) {
    const cfg = configFromEnv()
    cachedClient = new CalDavClient({
      url: cfg.url,
      user: cfg.user,
      pass: cfg.pass,
      // Front-proxy Basic auth layers replace the transport credentials;
      // radicale then trusts the proxy (or re-checks the same pair).
      ...(cfg.basicUser && cfg.basicPass ? { basicUser: cfg.basicUser, basicPass: cfg.basicPass } : {}),
    })
  }
  return cachedClient
}

// ---------------------------------------------------------------------------
// domain views over parsed components
// ---------------------------------------------------------------------------

interface ItemView {
  uid: string
  summary: string
  href: string
  etag: string
  /** Displayname of the owning collection (public `calendar` value). */
  calendarName: string
  collection: string
  ics: string
  comp: IcsComponent
  raw: string[]
}

interface EventView extends ItemView {
  start: DateForm
  end?: DateForm
  location?: string
  description?: string
}

interface TodoView extends ItemView {
  due?: DateForm
  status: string
  priority?: number
  completed?: DateForm
  description?: string
}

function firstProp(comp: IcsComponent, name: string): string | undefined {
  return comp.props.find((p) => p.name === name)?.value
}

function textProp(comp: IcsComponent, name: string): string | undefined {
  const v = firstProp(comp, name)
  return v === undefined ? undefined : unescapeText(v)
}

function epochOf(d: DateForm): number {
  if (d.kind === 'date') return Date.parse(`${d.date}T00:00:00Z`)
  if (d.kind === 'floating') return Date.parse(`${d.wall}Z`)
  return Date.parse(d.iso)
}

function dateOut(d: DateForm): string {
  if (d.kind === 'date') return d.date
  if (d.kind === 'floating') return d.wall
  return d.iso
}

function eventView(coll: DavCollection, obj: DavObject): EventView | null {
  const comp = parseComponent(obj.ics, 'VEVENT')
  if (!comp) return null
  const uid = firstProp(comp, 'UID')
  const startRaw = comp.props.find((p) => p.name === 'DTSTART')
  if (!uid || !startRaw) return null
  const start = dateFromProp(startRaw)
  if (!start) return null
  const endRaw = comp.props.find((p) => p.name === 'DTEND')
  const end = endRaw ? dateFromProp(endRaw) ?? undefined : undefined
  return {
    uid,
    summary: textProp(comp, 'SUMMARY') ?? '',
    href: obj.href,
    etag: obj.etag,
    calendarName: coll.name,
    collection: coll.path,
    ics: obj.ics,
    comp,
    raw: comp.raw,
    start,
    ...(end ? { end } : {}),
    ...(textProp(comp, 'LOCATION') ? { location: textProp(comp, 'LOCATION') } : {}),
    ...(textProp(comp, 'DESCRIPTION') ? { description: textProp(comp, 'DESCRIPTION') } : {}),
  }
}

function todoView(coll: DavCollection, obj: DavObject): TodoView | null {
  const comp = parseComponent(obj.ics, 'VTODO')
  if (!comp) return null
  const uid = firstProp(comp, 'UID')
  if (!uid) return null
  const dueRaw = comp.props.find((p) => p.name === 'DUE')
  const completedRaw = comp.props.find((p) => p.name === 'COMPLETED')
  const prioRaw = firstProp(comp, 'PRIORITY')
  return {
    uid,
    summary: textProp(comp, 'SUMMARY') ?? '',
    href: obj.href,
    etag: obj.etag,
    calendarName: coll.name,
    collection: coll.path,
    ics: obj.ics,
    comp,
    raw: comp.raw,
    ...(dueRaw ? { due: dateFromProp(dueRaw) ?? undefined } : {}),
    status: firstProp(comp, 'STATUS') ?? 'NEEDS-ACTION',
    ...(prioRaw !== undefined && /^\d+$/.test(prioRaw.trim()) ? { priority: Number(prioRaw.trim()) } : {}),
    ...(completedRaw ? { completed: dateFromProp(completedRaw) ?? undefined } : {}),
    ...(textProp(comp, 'DESCRIPTION') ? { description: textProp(comp, 'DESCRIPTION') } : {}),
  }
}

// ---------------------------------------------------------------------------
// collection resolution + fetching
// ---------------------------------------------------------------------------

async function collections(): Promise<DavCollection[]> {
  return client().listCollections()
}

function matchCollection(query: string, list: DavCollection[]): DavCollection | undefined {
  const q = query.trim().toLowerCase().replace(/^\/+|\/+$/g, '')
  return (
    list.find((c) => c.name.toLowerCase() === q) ??
    list.find((c) => c.path.replace(/^\/+|\/+$/g, '').toLowerCase() === q) ??
    list.find((c) => c.path.replace(/^\/+|\/+$/g, '').toLowerCase().endsWith(`/${q}`)) ??
    list.find((c) => c.name.toLowerCase().includes(q))
  )
}

async function resolveCollection(
  name: string | undefined,
  need: 'VEVENT' | 'VTODO',
): Promise<DavCollection> {
  const list = await collections()
  const capable = list.filter((c) => c.components.includes(need))
  if (capable.length === 0) {
    throw new Error(`no calendar collection supports ${need}; have: ${list.map((c) => c.name).join(', ') || 'none'}`)
  }
  if (name === undefined || name === '') {
    const preferred =
      capable.find((c) => /task|todo/i.test(c.name)) ?? (capable.length === 1 ? capable[0] : undefined)
    if (!preferred) {
      throw new Error(`'calendar' is required — VTODO-capable calendars: ${capable.map((c) => c.name).join(', ')}`)
    }
    return preferred
  }
  const c = matchCollection(name, capable)
  if (!c) {
    const all = matchCollection(name, list)
    throw new Error(
      all
        ? `calendar "${all.name}" does not support ${need} (components: ${all.components.join(',')})`
        : `no calendar matches "${name}"; have: ${list.map((c) => c.name).join(', ')}`,
    )
  }
  return c
}

/** Fetch every object of one kind across the given (or all capable) collections. */
async function fetchAll(kind: 'VEVENT' | 'VTODO', calendar?: string): Promise<Array<{ coll: DavCollection; obj: DavObject }>> {
  const list = await collections()
  const targets = calendar ? [await resolveCollection(calendar, kind)] : list.filter((c) => c.components.includes(kind))
  const results = await Promise.all(targets.map((c) => client().queryCollection(c, kind).catch(() => [])))
  return results.flatMap((objs, i) => objs.map((obj) => ({ coll: targets[i], obj })))
}

async function findItem(kind: 'VEVENT' | 'VTODO', uid: string): Promise<{ view: ItemView; coll: DavCollection }> {
  const found = await fetchAll(kind)
  for (const { coll, obj } of found) {
    const view = kind === 'VEVENT' ? eventView(coll, obj) : todoView(coll, obj)
    if (view && view.uid === uid) return { view, coll }
  }
  throw new Error(`no ${kind === 'VEVENT' ? 'event' : 'todo'} with uid ${uid} found in any calendar`)
}

function matchesText(v: { summary: string; location?: string; description?: string }, query: string): boolean {
  const q = query.toLowerCase()
  return (
    v.summary.toLowerCase().includes(q) ||
    (v.location?.toLowerCase().includes(q) ?? false) ||
    (v.description?.toLowerCase().includes(q) ?? false)
  )
}

// ---------------------------------------------------------------------------
// ICS builders
// ---------------------------------------------------------------------------

function newUid(): string {
  return `hmc-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}@dsh`
}

function parseStart(input: string, field: string): DateForm {
  const d = parseDateInput(input)
  if (!d) throw new Error(`${field} must be ISO 8601: 'YYYY-MM-DD' (all-day), naive 'YYYY-MM-DDTHH:MM' (floating local), or with offset/Z`)
  return d
}

function eventComponentLines(args: {
  uid: string
  summary: string
  start: DateForm
  end?: DateForm
  location?: string
  description?: string
}): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${args.uid}`,
    `DTSTAMP:${nowUtc()}`,
    `SUMMARY:${escapeText(args.summary)}`,
    datePropLine('DTSTART', args.start),
  ]
  if (args.end) lines.push(datePropLine('DTEND', args.end))
  if (args.location !== undefined) lines.push(`LOCATION:${escapeText(args.location)}`)
  if (args.description !== undefined) lines.push(`DESCRIPTION:${escapeText(args.description)}`)
  lines.push('END:VEVENT')
  return lines
}

function todoComponentLines(args: {
  uid: string
  summary: string
  due?: DateForm
  priority?: number
  description?: string
}): string[] {
  const lines = [
    'BEGIN:VTODO',
    `UID:${args.uid}`,
    `DTSTAMP:${nowUtc()}`,
    `SUMMARY:${escapeText(args.summary)}`,
  ]
  if (args.due) lines.push(datePropLine('DUE', args.due))
  lines.push('STATUS:NEEDS-ACTION')
  if (args.priority !== undefined) lines.push(`PRIORITY:${args.priority}`)
  if (args.description !== undefined) lines.push(`DESCRIPTION:${escapeText(args.description)}`)
  lines.push('END:VTODO')
  return lines
}

/** Effective end of an event view (DTEND or default: +1d all-day, +1h timed). */
function eventEnd(ev: EventView): DateForm {
  if (ev.end) return ev.end
  return ev.start.kind === 'date' ? shiftDate(ev.start, 86_400_000) : shiftDate(ev.start, 3_600_000)
}

/** Event public shape (no hrefs/etags/ics internals). */
function eventPublic(ev: EventView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    uid: ev.uid,
    summary: ev.summary,
    start: dateOut(ev.start),
    end: dateOut(eventEnd(ev)),
    allDay: ev.start.kind === 'date',
    calendar: ev.calendarName,
  }
  if (ev.location !== undefined) out['location'] = ev.location
  if (ev.description !== undefined) out['description'] = ev.description
  return out
}

function todoPublic(t: TodoView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    uid: t.uid,
    summary: t.summary,
    status: t.status,
    calendar: t.calendarName,
  }
  if (t.due) out['due'] = dateOut(t.due)
  if (t.priority !== undefined) out['priority'] = t.priority
  if (t.completed) out['completed'] = dateOut(t.completed)
  if (t.description !== undefined) out['description'] = t.description
  return out
}

// ---------------------------------------------------------------------------
// tool handlers
// ---------------------------------------------------------------------------

async function toolListCalendars() {
  const list = await collections()
  return list.map((c) => ({
    name: c.name,
    path: c.path,
    ...(c.color ? { color: c.color } : {}),
    components: c.components,
    supports: {
      events: c.components.includes('VEVENT'),
      todos: c.components.includes('VTODO'),
    },
  }))
}

async function toolSearch(args: Record<string, unknown>) {
  const kind = args['kind'] === 'todo' ? 'VTODO' : 'VEVENT'
  const query = typeof args['query'] === 'string' ? args['query'] : undefined
  const calendar = typeof args['collection'] === 'string' ? args['collection'] : undefined
  const limit = typeof args['limit'] === 'number' ? Math.min(Math.max(Math.trunc(args['limit']), 1), 500) : 50
  const from = typeof args['from'] === 'string' ? parseStart(args['from'], 'from') : undefined
  const to = typeof args['to'] === 'string' ? parseStart(args['to'], 'to') : undefined
  if (from && to && epochOf(from) > epochOf(to)) throw new Error("'from' must be ≤ 'to'")

  const items = await fetchAll(kind, calendar)
  const views: EventView[] | TodoView[] =
    kind === 'VEVENT'
      ? items.map((it) => eventView(it.coll, it.obj)).filter((v): v is EventView => v !== null)
      : items.map((it) => todoView(it.coll, it.obj)).filter((v): v is TodoView => v !== null)

  const dueInRange = (d: DateForm | undefined): boolean => {
    if (!from && !to) return true
    if (!d) return false
    const t = epochOf(d)
    if (from && t < epochOf(from)) return false
    if (to && t > epochOf(to)) return false
    return true
  }
  /** Event overlaps [from, to]: started before `to` ends and ends after `from` starts. */
  const overlaps = (ev: EventView): boolean => {
    if (!from && !to) return true
    if (to && epochOf(ev.start) > epochOf(to)) return false
    if (from && epochOf(eventEnd(ev)) <= epochOf(from)) return false
    return true
  }

  if (kind === 'VEVENT') {
    const evs = views as EventView[]
    const hits = evs
      .filter((ev) => (!query || matchesText(ev, query)) && overlaps(ev))
      .sort((a, b) => epochOf(a.start) - epochOf(b.start))
      .slice(0, limit)
    return { kind: 'event', count: hits.length, events: hits.map(eventPublic) }
  }
  const todos = views as TodoView[]
  const hits = todos
    .filter((t) => (!query || matchesText(t, query)) && dueInRange(t.due))
    .sort((a, b) => {
      const openA = a.status === 'COMPLETED' || a.status === 'CANCELLED' ? 1 : 0
      const openB = b.status === 'COMPLETED' || b.status === 'CANCELLED' ? 1 : 0
      if (openA !== openB) return openA - openB
      const pa = a.priority ?? 10
      const pb = b.priority ?? 10
      if (pa !== pb) return pa - pb
      const da = a.due ? epochOf(a.due) : Number.MAX_SAFE_INTEGER
      const db = b.due ? epochOf(b.due) : Number.MAX_SAFE_INTEGER
      return da - db
    })
    .slice(0, limit)
  return { kind: 'todo', count: hits.length, todos: hits.map(todoPublic) }
}

async function toolAddEvent(args: Record<string, unknown>) {
  const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : ''
  if (!summary) throw new Error("'summary' is required")
  const start = parseStart(String(args['start']), 'start')
  const coll = await resolveCollection(typeof args['calendar'] === 'string' ? args['calendar'] : undefined, 'VEVENT')
  if (!coll.components.includes('VEVENT')) throw new Error(`calendar "${coll.name}" does not support events`)

  let end: DateForm | undefined
  const endRaw = typeof args['end'] === 'string' ? parseStart(args['end'], 'end') : undefined
  const durationMin = typeof args['durationMin'] === 'number' ? args['durationMin'] : undefined
  if (endRaw && durationMin !== undefined) throw new Error("give either 'end' or 'durationMin', not both")
  if (endRaw) {
    if (start.kind === 'date' && endRaw.kind !== 'date') throw new Error("all-day start needs an all-day 'end' (YYYY-MM-DD)")
    if (start.kind !== 'date' && endRaw.kind === 'date') throw new Error("timed start needs a timed 'end'")
    if (epochOf(endRaw) <= epochOf(start)) throw new Error("'end' must be after 'start'")
    end = endRaw
  } else if (durationMin !== undefined) {
    if (!Number.isFinite(durationMin) || durationMin <= 0) throw new Error("'durationMin' must be a positive number of minutes")
    end = shiftDate(start, durationMin * 60_000)
  } else {
    end = start.kind === 'date' ? shiftDate(start, 86_400_000) : shiftDate(start, 3_600_000)
  }

  const uid = newUid()
  const lines = eventComponentLines({
    uid,
    summary,
    start,
    end,
    ...(typeof args['location'] === 'string' ? { location: args['location'] } : {}),
    ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
  })
  const href = `${coll.path}${uid}.ics`
  await client().putObject(href, calendarDocument(lines))
  return { uid, href, calendar: coll.name, summary, start: dateOut(start), end: dateOut(end), allDay: start.kind === 'date' }
}

async function toolUpdateEvent(args: Record<string, unknown>) {
  const uid = String(args['uid'] ?? '')
  if (!uid) throw new Error("'uid' is required")
  const { view, coll } = await findItem('VEVENT', uid)
  const ev = view as EventView
  const replacements: Array<{ name: string; line?: string }> = []

  const summary = args['summary']
  if (typeof summary === 'string') replacements.push({ name: 'SUMMARY', line: `SUMMARY:${escapeText(summary)}` })
  const location = args['location']
  if (location === null) replacements.push({ name: 'LOCATION' })
  else if (typeof location === 'string') replacements.push({ name: 'LOCATION', line: `LOCATION:${escapeText(location)}` })
  const description = args['description']
  if (description === null) replacements.push({ name: 'DESCRIPTION' })
  else if (typeof description === 'string') replacements.push({ name: 'DESCRIPTION', line: `DESCRIPTION:${escapeText(description)}` })

  const startRaw = args['start']
  const endRaw = args['end']
  const durationMin = typeof args['durationMin'] === 'number' ? args['durationMin'] : undefined
  let newStart: DateForm | undefined
  let newEnd: DateForm | undefined

  if (typeof startRaw === 'string') {
    newStart = parseStart(startRaw, 'start')
    if (endRaw === undefined && durationMin === undefined) {
      // keep the previous duration when the old event had one of the same class
      if (ev.end) {
        const dur = durationBetween(ev.start, ev.end)
        newEnd = dur !== null && (ev.start.kind === newStart.kind) ? shiftDate(newStart, dur) : undefined
      }
    }
  }
  if (typeof endRaw === 'string') newEnd = parseStart(endRaw, 'end')
  else if (durationMin !== undefined) {
    const base = newStart ?? ev.start
    newEnd = shiftDate(base, durationMin * 60_000)
  }
  if (newStart && newEnd && epochOf(newEnd) <= epochOf(newStart)) throw new Error("'end' must be after 'start'")
  if (newStart) replacements.push({ name: 'DTSTART', line: datePropLine('DTSTART', newStart) })
  if (newEnd) {
    replacements.push({ name: 'DTEND', line: datePropLine('DTEND', newEnd) })
  } else if (newStart && ev.end && ev.start.kind !== newStart.kind) {
    // start changed date↔timed with no new end: a stale cross-class DTEND is invalid — drop it
    replacements.push({ name: 'DTEND' })
  }

  if (replacements.length === 0) throw new Error('nothing to update: give summary/start/end/durationMin/location/description')

  // RFC 5546: bump SEQUENCE on modification when present.
  const seqLine = ev.raw.map(parsePropLine).find((p) => p?.name === 'SEQUENCE')
  if (seqLine && /^\d+$/.test(seqLine.value.trim())) {
    replacements.push({ name: 'SEQUENCE', line: `SEQUENCE:${Number(seqLine.value.trim()) + 1}` })
  }

  const merged = mergeComponent(ev.raw, replacements)
  try {
    await client().putObject(ev.href, calendarDocument(merged), ev.etag)
  } catch (e) {
    if (e instanceof DavError && e.status === 412) {
      throw new Error(`event ${uid} changed on the server since it was read (etag conflict) — retry the update`)
    }
    throw e
  }
  const fresh = parseComponent(calendarDocument(merged), 'VEVENT')
  const out: Record<string, unknown> = { uid, updated: replacements.map((r) => r.name.toLowerCase()), calendar: coll.name }
  if (fresh) {
    const sProp = fresh.props.find((p) => p.name === 'DTSTART')
    const eProp = fresh.props.find((p) => p.name === 'DTEND')
    const sForm = sProp ? dateFromProp(sProp) : undefined
    const eForm = eProp ? dateFromProp(eProp) : undefined
    if (sForm) out['start'] = dateOut(sForm)
    if (eForm) out['end'] = dateOut(eForm)
    out['summary'] = unescapeText(fresh.props.find((p) => p.name === 'SUMMARY')?.value ?? '')
  }
  return out
}

async function toolDeleteEvent(args: Record<string, unknown>) {
  const uid = String(args['uid'] ?? '')
  if (!uid) throw new Error("'uid' is required")
  const { view, coll } = await findItem('VEVENT', uid)
  await client().deleteObject(view.href, view.etag)
  return { deleted: uid, summary: view.summary, calendar: coll.name }
}

async function toolAddTodo(args: Record<string, unknown>) {
  const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : ''
  if (!summary) throw new Error("'summary' is required")
  const coll = await resolveCollection(typeof args['calendar'] === 'string' ? args['calendar'] : undefined, 'VTODO')
  if (!coll.components.includes('VTODO')) throw new Error(`calendar "${coll.name}" does not support todos`)
  const due = typeof args['due'] === 'string' ? parseStart(args['due'], 'due') : undefined
  const priority = typeof args['priority'] === 'number' ? Math.trunc(args['priority']) : undefined
  if (priority !== undefined && !(priority >= 1 && priority <= 9)) throw new Error("'priority' must be 1 (highest) … 9 (lowest)")
  const uid = newUid()
  const lines = todoComponentLines({
    uid,
    summary,
    ...(due ? { due } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(typeof args['notes'] === 'string' ? { description: args['notes'] } : {}),
  })
  const href = `${coll.path}${uid}.ics`
  await client().putObject(href, calendarDocument(lines))
  return {
    uid,
    href,
    calendar: coll.name,
    summary,
    ...(due ? { due: dateOut(due) } : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
}

async function toolTodos(args: Record<string, unknown>) {
  const calendar = typeof args['calendar'] === 'string' ? args['calendar'] : undefined
  const includeCompleted = args['includeCompleted'] === true
  const items = await fetchAll('VTODO', calendar)
  const views = items.map((it) => todoView(it.coll, it.obj)).filter((v): v is TodoView => v !== null)
  const hits = views
    .filter((t) => includeCompleted || !(t.status === 'COMPLETED' || t.status === 'CANCELLED'))
    .sort((a, b) => {
      const openA = a.status === 'COMPLETED' || a.status === 'CANCELLED' ? 1 : 0
      const openB = b.status === 'COMPLETED' || b.status === 'CANCELLED' ? 1 : 0
      if (openA !== openB) return openA - openB
      const pa = a.priority ?? 10
      const pb = b.priority ?? 10
      if (pa !== pb) return pa - pb
      const da = a.due ? epochOf(a.due) : Number.MAX_SAFE_INTEGER
      const db = b.due ? epochOf(b.due) : Number.MAX_SAFE_INTEGER
      return da - db
    })
  return { count: hits.length, todos: hits.map(todoPublic) }
}

async function toolCompleteTodo(args: Record<string, unknown>) {
  const uid = String(args['uid'] ?? '')
  if (!uid) throw new Error("'uid' is required")
  const { view, coll } = await findItem('VTODO', uid)
  const t = view as TodoView
  const completed: DateForm = { kind: 'utc', iso: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }
  const replacements: Array<{ name: string; line?: string }> = [
    { name: 'STATUS', line: 'STATUS:COMPLETED' },
    { name: 'COMPLETED', line: datePropLine('COMPLETED', completed) },
    { name: 'PERCENT-COMPLETE', line: 'PERCENT-COMPLETE:100' },
  ]
  const seqLine = t.raw.map(parsePropLine).find((p) => p?.name === 'SEQUENCE')
  if (seqLine && /^\d+$/.test(seqLine.value.trim())) {
    replacements.push({ name: 'SEQUENCE', line: `SEQUENCE:${Number(seqLine.value.trim()) + 1}` })
  }
  const merged = mergeComponent(t.raw, replacements)
  try {
    await client().putObject(t.href, calendarDocument(merged), t.etag)
  } catch (e) {
    if (e instanceof DavError && e.status === 412) {
      throw new Error(`todo ${uid} changed on the server since it was read (etag conflict) — retry`)
    }
    throw e
  }
  return { completed: uid, summary: t.summary, calendar: coll.name }
}

// ---------------------------------------------------------------------------
// MCP stdio JSON-RPC server (zero-dep, newline-delimited)
// ---------------------------------------------------------------------------

interface ToolDef {
  description: string
  inputSchema: Record<string, unknown>
}

const s = (desc: string): Record<string, unknown> => ({ type: 'string', description: desc })
const b = (desc: string): Record<string, unknown> => ({ type: 'boolean', description: desc })
const n = (desc: string): Record<string, unknown> => ({ type: 'number', description: desc })

const TOOLS: Record<string, ToolDef> = {
  cal_list_calendars: {
    description:
      'List the user’s CalDAV calendars on the homelab radicale server: name, path, color, and whether each supports events (VEVENT) and/or todos (VTODO).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  cal_search: {
    description:
      'Search events or todos across calendars. `kind` defaults to "event". `query` is a case-insensitive substring match on summary/location/description. `from`/`to` (ISO 8601) filter events by start (todos by due date). Returns uid/summary/start|due/location fields.',
    inputSchema: {
      type: 'object',
      properties: {
        query: s('substring to match in summary, location, or description'),
        kind: { type: 'string', enum: ['event', 'todo'], description: 'what to search (default event)' },
        collection: s('calendar name or path to restrict the search'),
        from: s('range start, ISO 8601 (date or datetime)'),
        to: s('range end, ISO 8601 (date or datetime)'),
        limit: n('max results (default 50, max 500)'),
      },
      additionalProperties: false,
    },
  },
  cal_add_event: {
    description:
      'Add a calendar event. `start` accepts YYYY-MM-DD (all-day), naive YYYY-MM-DDTHH:MM (floating local time), or ISO with offset/Z. Give `end` or `durationMin`; default duration is 1 hour (1 day for all-day).',
    inputSchema: {
      type: 'object',
      required: ['calendar', 'summary', 'start'],
      properties: {
        calendar: s('calendar name or path (see cal_list_calendars)'),
        summary: s('event title'),
        start: s('ISO 8601 start: YYYY-MM-DD all-day, naive local datetime, or with offset/Z'),
        end: s('ISO 8601 end (same form class as start)'),
        durationMin: n('duration in minutes (alternative to end)'),
        location: s('location text'),
        description: s('description/notes'),
      },
      additionalProperties: false,
    },
  },
  cal_update_event: {
    description:
      'Update an existing event by uid. Only given fields change; `location`/`description` accept null to clear. Start accepts the same forms as cal_add_event; end moves to keep duration if only start changes.',
    inputSchema: {
      type: 'object',
      required: ['uid'],
      properties: {
        uid: s('event uid (from cal_search)'),
        summary: s('new title'),
        start: s('new start (ISO 8601)'),
        end: s('new end (ISO 8601)'),
        durationMin: n('new duration in minutes'),
        location: { ...s('new location'), nullable: true, type: ['string', 'null'] },
        description: { ...s('new description'), nullable: true, type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  },
  cal_delete_event: {
    description: 'Delete an event by uid (permanent).',
    inputSchema: {
      type: 'object',
      required: ['uid'],
      properties: { uid: s('event uid (from cal_search)') },
      additionalProperties: false,
    },
  },
  cal_add_todo: {
    description:
      'Add a todo (VTODO). Defaults to the Tasks calendar. `due` accepts YYYY-MM-DD, naive local datetime, or ISO with offset/Z. `priority` is 1 (highest) … 9 (lowest).',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        calendar: s('calendar name or path (default: the Tasks calendar)'),
        summary: s('todo title'),
        due: s('due date/datetime (ISO 8601)'),
        priority: n('1 (highest) … 9 (lowest)'),
        notes: s('description/notes'),
      },
      additionalProperties: false,
    },
  },
  cal_todos: {
    description: 'List todos, open ones first (then by priority, then due). Completed todos are hidden unless includeCompleted.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar: s('calendar name or path (default: all todo-capable calendars)'),
        includeCompleted: b('include completed/cancelled todos (default false)'),
      },
      additionalProperties: false,
    },
  },
  cal_complete_todo: {
    description: 'Mark a todo completed by uid: sets STATUS:COMPLETED, COMPLETED:now, PERCENT-COMPLETE:100.',
    inputSchema: {
      type: 'object',
      required: ['uid'],
      properties: { uid: s('todo uid (from cal_todos or cal_search)') },
      additionalProperties: false,
    },
  },
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  if (isError) out['isError'] = true
  return out
}

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'cal_list_calendars':
      return toolResult(await toolListCalendars())
    case 'cal_search':
      return toolResult(await toolSearch(args))
    case 'cal_add_event':
      return toolResult(await toolAddEvent(args))
    case 'cal_update_event':
      return toolResult(await toolUpdateEvent(args))
    case 'cal_delete_event':
      return toolResult(await toolDeleteEvent(args))
    case 'cal_add_todo':
      return toolResult(await toolAddTodo(args))
    case 'cal_todos':
      return toolResult(await toolTodos(args))
    case 'cal_complete_todo':
      return toolResult(await toolCompleteTodo(args))
    default:
      return toolResult({ error: `unknown tool: ${name}` }, true)
  }
}

function reply(msg: { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: unknown }): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

interface IncomingMessage {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: Record<string, unknown>
}

async function handleMessage(msg: IncomingMessage): Promise<void> {
  if (typeof msg.method !== 'string') return
  const isRequest = msg.id !== undefined && msg.id !== null
  try {
    if (msg.method === 'initialize') {
      const requested = typeof msg.params?.['protocolVersion'] === 'string' ? (msg.params['protocolVersion'] as string) : '2025-06-18'
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'homelab-caldav', version: '0.1.0' },
        },
      })
      return
    }
    if (msg.method === 'ping') {
      if (isRequest) reply({ jsonrpc: '2.0', id: msg.id, result: {} })
      return
    }
    if (msg.method === 'tools/list') {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, ...t })) },
      })
      return
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.['name']
      const rawArgs = msg.params?.['arguments']
      const args = typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {}
      if (typeof name !== 'string') {
        if (isRequest) reply({ jsonrpc: '2.0', id: msg.id, result: toolResult({ error: 'tools/call: missing tool name' }, true) })
        return
      }
      try {
        const result = await dispatchTool(name, args)
        if (isRequest) reply({ jsonrpc: '2.0', id: msg.id, result })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        process.stderr.write(`homelab-caldav: ${name}: ${message}\n`)
        if (isRequest) reply({ jsonrpc: '2.0', id: msg.id, result: toolResult({ error: message }, true) })
      }
      return
    }
    if (isRequest) {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
    }
    // notifications (initialized, cancelled, …) are silently ignored
  } catch (e) {
    if (isRequest) {
      const message = e instanceof Error ? e.message : String(e)
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } })
    }
  }
}

async function main(): Promise<void> {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.length === 0) continue
      let msg: IncomingMessage
      try {
        msg = JSON.parse(line) as IncomingMessage
      } catch {
        process.stderr.write(`homelab-caldav: dropping unparseable line: ${line.slice(0, 120)}\n`)
        continue
      }
      await handleMessage(msg)
    }
  }
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
main().catch((e) => {
  process.stderr.write(`homelab-caldav: fatal: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
