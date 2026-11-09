/**
 * Radicale CalDAV client (RFC 4791 subset, mirrors the shapes proven by
 * wycal): Basic auth on every request, discovery via current-user-principal +
 * calendar-home-set, collection listing, calendar-query REPORT fetching full
 * objects, PUT with etag guards, DELETE, MKCOL. Radicale's XML is machine-
 * generated with stable prefixes, so the multistatus reader matches elements
 * by local name with any prefix.
 */

const XML_DECL = '<?xml version="1.0" encoding="utf-8" ?>'

export class DavError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'DavError'
    this.status = status
    this.body = body
  }
}

export interface DavCollection {
  /** Server path with trailing slash, e.g. `/wyli/tasks/`. */
  path: string
  name: string
  color?: string
  components: string[] // subset of ['VEVENT', 'VTODO']
}

export interface DavObject {
  href: string
  etag: string
  ics: string
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** First descendant match of `<any-prefix:local …>text</any-prefix:local>` inside a chunk. */
function tagText(chunk: string, local: string): string | undefined {
  const m = new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${local}>`).exec(chunk)
  return m ? m[1] : undefined
}

interface MultistatusEntry {
  href: string
  propchunk: string
  status?: string
}

/** Split a 207 body into {href, propchunk, status} entries (200 propstats only by caller's choice). */
function parseMultistatus(xmlText: string): MultistatusEntry[] {
  const entries: MultistatusEntry[] = []
  const res = /<(?:[A-Za-z][\w.-]*:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?response>/g
  for (const m of xmlText.matchAll(res)) {
    const chunk = m[1]
    const href = (tagText(chunk, 'href') ?? '').trim()
    // Concatenate every 2xx propstat body; skip non-2xx propstats (404 branch).
    let propchunk = ''
    let status: string | undefined
    const propstats = chunk.match(/<(?:[A-Za-z][\w.-]*:)?propstat(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z][\w.-]*:)?propstat>/g)
    if (propstats) {
      for (const ps of propstats) {
        const st = (tagText(ps, 'status') ?? '').trim()
        if (!/\b2\d\d\b/.test(st)) continue
        const prop = tagText(ps, 'prop') ?? ''
        propchunk += prop
        status = st
      }
    } else {
      propchunk = tagText(chunk, 'prop') ?? ''
      status = tagText(chunk, 'status')
    }
    entries.push({ href, propchunk, status })
  }
  return entries
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export interface CalDavConfig {
  url: string
  user: string
  pass: string
  /** Optional reverse-proxy Basic credentials (when the front gate differs). */
  basicUser?: string
  basicPass?: string
}

export class CalDavClient {
  private readonly base: string
  private readonly auth: string
  private collectionsCache: { at: number; collections: DavCollection[] } | null = null

  constructor(cfg: CalDavConfig) {
    this.base = cfg.url.replace(/\/+$/, '')
    const user = cfg.basicUser ?? cfg.user
    const pass = cfg.basicPass ?? cfg.pass
    this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
  }

  private async request(
    method: string,
    path: string,
    opts: { depth?: string; body?: string; contentType?: string; headers?: Record<string, string> } = {},
  ): Promise<{ text: string; status: number; location?: string; etag?: string }> {
    const headers: Record<string, string> = { Authorization: this.auth, ...opts.headers }
    if (opts.depth !== undefined) headers['Depth'] = opts.depth
    if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/xml; charset=utf-8'
    let res: Response
    try {
      res = await fetch(this.base + path, { method, headers, body: opts.body, redirect: 'manual' })
    } catch (e) {
      throw new DavError(`caldav: ${method} ${path} network error: ${e instanceof Error ? e.message : String(e)}`, 0, '')
    }
    const text = await res.text()
    if (res.status < 200 || res.status >= 300) {
      throw new DavError(`caldav: ${method} ${path} → HTTP ${res.status}`, res.status, text)
    }
    return { text, status: res.status, location: res.headers.get('location') ?? undefined, etag: res.headers.get('etag') ?? undefined }
  }

  private async propfind(path: string, depth: '0' | '1', props: string[]): Promise<MultistatusEntry[]> {
    const body =
      `${XML_DECL}<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/"><D:prop>` +
      props.map((p) => `<${p}/>`).join('') +
      '</D:prop></D:propfind>'
    const { text } = await this.request('PROPFIND', path, { depth, body })
    return parseMultistatus(text)
  }

  /** PROPFIND Depth:0 current-user-principal at the server root (radicale: `/{user}/`). */
  async discoverPrincipal(): Promise<string> {
    const rs = await this.propfind('/', '0', ['D:current-user-principal'])
    const inner = tagText(rs[0]?.propchunk ?? '', 'current-user-principal')
    const href = inner ? tagText(inner, 'href') : undefined
    if (!href) throw new Error('caldav: no current-user-principal (check RADICALE_USER/RADICALE_PASS)')
    return normalizeHref(href)
  }

  /** PROPFIND Depth:0 calendar-home-set on the principal (radicale: same as principal). */
  async discoverCalendarHome(principal: string): Promise<string> {
    const rs = await this.propfind(principal, '0', ['C:calendar-home-set'])
    const inner = tagText(rs[0]?.propchunk ?? '', 'calendar-home-set')
    const href = inner ? tagText(inner, 'href') : undefined
    return href ? normalizeHref(href) : principal
  }

  /** Depth:1 PROPFIND under the home → calendar collections (home itself skipped). */
  async listCollections(force = false): Promise<DavCollection[]> {
    if (!force && this.collectionsCache && Date.now() - this.collectionsCache.at < 60_000) {
      return this.collectionsCache.collections
    }
    const principal = await this.discoverPrincipal()
    const home = await this.discoverCalendarHome(principal)
    const rs = await this.propfind(home, '1', [
      'D:resourcetype',
      'D:displayname',
      'ICAL:calendar-color',
      'C:supported-calendar-component-set',
    ])
    const homeNoSlash = home.replace(/\/+$/, '')
    const collections: DavCollection[] = []
    for (const r of rs) {
      const path = normalizeHref(r.href)
      const chunk = r.propchunk
      const resourcetype = tagText(chunk, 'resourcetype') ?? ''
      if (!/calendar\b/.test(resourcetype)) continue
      if (path.replace(/\/+$/, '') === homeNoSlash) continue
      const setRaw = tagText(chunk, 'supported-calendar-component-set') ?? ''
      const components = [...setRaw.matchAll(/name="(VEVENT|VTODO)"/g)].map((m) => m[1])
      const name = decodeXml(tagText(chunk, 'displayname') ?? path.split('/').filter(Boolean).pop() ?? path)
      const colorRaw = tagText(chunk, 'calendar-color')
      collections.push({
        path: path.endsWith('/') ? path : path + '/',
        name,
        ...(colorRaw ? { color: decodeXml(colorRaw).trim() } : {}),
        ...(components.length > 0 ? { components } : { components: ['VEVENT', 'VTODO'] }),
      })
    }
    this.collectionsCache = { at: Date.now(), collections }
    return collections
  }

  /** calendar-query REPORT on one collection: every VEVENT or VTODO with data. */
  async queryCollection(coll: DavCollection, kind: 'VEVENT' | 'VTODO'): Promise<DavObject[]> {
    const body =
      `${XML_DECL}<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
      `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${kind}"/></C:comp-filter></C:filter>` +
      '</C:calendar-query>'
    const { text } = await this.request('REPORT', coll.path, { depth: '1', body })
    const out: DavObject[] = []
    for (const r of parseMultistatus(text)) {
      const etag = tagText(r.propchunk, 'getetag')
      const data = tagText(r.propchunk, 'calendar-data')
      if (!data) continue
      out.push({ href: normalizeHref(r.href), etag: (etag ?? '').replace(/^"|"$/g, ''), ics: decodeXml(data) })
    }
    return out
  }

  /** PUT an object; create → If-None-Match:*, update → If-Match. Returns new etag. */
  async putObject(href: string, ics: string, etag?: string): Promise<string> {
    const headers: Record<string, string> = {
      Prefer: 'return=minimal',
      ...(etag !== undefined ? { 'If-Match': `"${etag.replace(/^"|"$/g, '')}"` } : { 'If-None-Match': '*' }),
    }
    const res = await this.request('PUT', href, { body: ics, contentType: 'text/calendar; charset=utf-8', headers })
    return res.etag ?? ''
  }

  /** DELETE with If-Match; an already-gone 404 counts as success. */
  async deleteObject(href: string, etag: string): Promise<void> {
    try {
      await this.request('DELETE', href, { headers: { 'If-Match': `"${etag.replace(/^"|"$/g, '')}"` } })
    } catch (e) {
      if (e instanceof DavError && e.status === 404) return
      throw e
    }
  }

  /** Extended MKCOL: create a calendar collection with displayname + components. */
  async mkcol(path: string, name: string, components: string[]): Promise<void> {
    const comps = (components.length > 0 ? components : ['VEVENT', 'VTODO'])
      .map((c) => `<C:comp name="${c}"/>`)
      .join('')
    const body =
      `${XML_DECL}<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">` +
      '<D:set><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype>' +
      `<D:displayname>${xmlEscape(name)}</D:displayname>` +
      `<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>` +
      '</D:prop></D:set></D:mkcol>'
    await this.request('MKCOL', path, { body })
    this.collectionsCache = null
  }
}

/** Server path of a root-absolute (or full-URL) href, leading slash guaranteed. */
function normalizeHref(href: string): string {
  let p = href.trim()
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p)) {
    try {
      p = new URL(p).pathname
    } catch {
      return p
    }
  }
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep raw */
  }
  return p.startsWith('/') ? p : '/' + p
}
