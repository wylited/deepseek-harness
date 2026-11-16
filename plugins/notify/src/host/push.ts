/**
 * Web Push sender (RFC 8291 payload encryption `aes128gcm`, RFC 8292 VAPID).
 * Implemented directly on node:crypto — no dependency, the payload is tiny,
 * and every browser push service accepts exactly this shape:
 *
 *   POST <endpoint>
 *   Authorization: vapid t=<JWT>, k=<server public key, base64url>
 *   Content-Encoding: aes128gcm
 *   TTL: <seconds>
 *   <salt(16) || rs(4 BE) || keylen(1) || server pubkey(65) || ciphertext>
 */

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto'

/** One stored browser subscription (the PushSubscription JSON the client POSTs). */
export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
  addedAt: string
}

export interface WebPushKeyMaterial {
  /** Uncompressed P-256 point of the VAPID key, base64url (65 bytes). */
  publicKey: string
  /** JWK `d` parameter of the VAPID key, base64url. */
  privateKey: string
  /** `mailto:` contact for the VAPID `sub` claim. */
  subject: string
}

const b64url = (input: Buffer): string => input.toString('base64url')
const fromB64url = (input: string): Buffer => Buffer.from(input, 'base64url')

/** JS `number` big-endian into `length` bytes. */
function uint32be(value: number, length = 4): Buffer {
  const out = Buffer.alloc(length)
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = value & 0xff
    value = Math.floor(value / 256)
  }
  return out
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

/** Sign the VAPID JWT (ES256 = ECDSA P-256/SHA-256, raw r||s — `ieee-p1363`). */
export function vapidAuthorization(endpoint: string, keys: WebPushKeyMaterial, now = Date.now()): string {
  const audience = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: keys.subject,
  })))
  const signingInput = `${header}.${payload}`
  // The stored public key is the uncompressed point: 0x04 || X(32) || Y(32).
  const point = fromB64url(keys.publicKey)
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('VAPID public key is not an uncompressed P-256 point')
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url(point.subarray(1, 33)),
    y: b64url(point.subarray(33, 65)),
    d: keys.privateKey,
  } as const
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey({ key: jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  })
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`
}

/** RFC 8188 `aes128gcm` record: salt || rs || keyid || ciphertext. */
export function encryptPayload(
  plaintext: string,
  subscriptionKeys: { p256dh: string; auth: string },
): Buffer {
  const userPublicKey = fromB64url(subscriptionKeys.p256dh)
  const userAuth = fromB64url(subscriptionKeys.auth)

  if (userPublicKey.length !== 65 || userPublicKey[0] !== 0x04) {
    throw new Error('push subscription p256dh key is not an uncompressed P-256 point')
  }

  // ECDH(ephemeral, user) → HKDF with the auth secret (RFC 8291 §3.3).
  // The application-server key for BOTH the keyid field and key_info is the
  // fresh ephemeral pair — the VAPID static key never enters the payload.
  const ephemeral = createECDH('prime256v1')
  ephemeral.generateKeys()
  const ephemeralPublic = ephemeral.getPublicKey()
  const shared = Buffer.from(ephemeral.computeSecret(userPublicKey))
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info', 'utf8'), Buffer.from([0x00]), userPublicKey, ephemeralPublic])
  const prkKey = hkdf(shared, userAuth, keyInfo, 32)

  const salt = randomBytes(16)
  const prk = hkdf(prkKey, salt, Buffer.from('Content-Encoding: aes128gcm\x00'), 16)
  const nonce = hkdf(prkKey, salt, Buffer.from('Content-Encoding: nonce\x00'), 12)

  // aes128gcm padding: message || 0x02 delimiter (+ zero pad up to rs-overhead).
  const RECORD_SIZE = 4096
  const overhead = 17 // 16 tag + 1 delimiter
  const maxBody = RECORD_SIZE - overhead
  const body = Buffer.from(plaintext, 'utf8')
  if (body.length > maxBody) throw new Error(`push payload too large (${String(body.length)} > ${String(maxBody)})`)
  const padded = Buffer.concat([body, Buffer.from([0x02])])

  const cipher = createCipheriv('aes-128-gcm', prk, nonce)
  // RFC 8188: the record header (salt || rs || keyid) is the GCM AAD; keyid
  // carries the ephemeral public key so the user agent can derive the secret.
  const header = Buffer.concat([
    salt,
    uint32be(RECORD_SIZE),
    Buffer.from([ephemeralPublic.length]),
    ephemeralPublic,
  ])
  cipher.setAAD(header)
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([header, ciphertext])
}

export interface PushSendResult {
  ok: boolean
  /** true = the subscription is gone; prune it. */
  gone: boolean
  status?: number
}

/** Send one encrypted push. Never throws on HTTP errors; reports them. */
export async function sendWebPush(
  subscription: PushSubscriptionRecord,
  payload: Record<string, unknown>,
  keys: WebPushKeyMaterial,
): Promise<PushSendResult> {
  if (!/^https:\/\//.test(subscription.endpoint)) return { ok: false, gone: true }
  try {
    const body = encryptPayload(JSON.stringify(payload), subscription.keys)
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '3600',
        Urgency: 'normal',
      },
      body: new Uint8Array(body),
    })
    if (response.ok) return { ok: true, gone: false, status: response.status }
    return { ok: false, gone: response.status === 404 || response.status === 410, status: response.status }
  } catch (error: unknown) {
    return { ok: false, gone: false }
  }
}

/** Generate a fresh VAPID keypair (one-time provisioning helper). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  // getPublicKey() is already the uncompressed point (0x04 || X || Y).
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  }
}
