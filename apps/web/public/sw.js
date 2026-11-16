/*
 * dsh web-push service worker. Deliberately minimal: push display +
 * notificationclick handoff. NO fetch/caching logic — the app is served
 * no-cache by the host and a caching SW here could strand stale bundles.
 *
 * `notificationclick` focuses an existing dsh window and posts it the
 * session id to open (the client half owns routing); with no window it
 * opens the configured site (or the origin root).
 */

self.addEventListener('install', () => {
  // Activate immediately; there is no precache to wait for.
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', event => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
  const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : 'dsh'
  const body = typeof data.body === 'string' ? data.body : 'New dsh activity'
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: `dsh-notify-${sessionId ?? 'activity'}`,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { sessionId, link: typeof data.link === 'string' ? data.link : '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const sessionId = event.notification.data && typeof event.notification.data.sessionId === 'string'
    ? event.notification.data.sessionId
    : undefined
  const link = event.notification.data && typeof event.notification.data.link === 'string'
    ? event.notification.data.link
    : '/'
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windowClients) {
      try {
        const url = new URL(client.url)
        if (url.origin !== self.location.origin) continue
        await client.focus()
        if (sessionId !== undefined) await client.postMessage({ type: 'dsh-notify-open', sessionId })
        return
      } catch {
        // Focus can reject on some platforms; fall through to openWindow.
      }
    }
    await self.clients.openWindow(link || '/')
  })())
})
