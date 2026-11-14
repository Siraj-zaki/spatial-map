/**
 * Detects and classifies media + complex values in a Bin's
 * `customProperties` so the tooltip and the editor can render them
 * appropriately. No DOM, no React — pure value inspection.
 *
 * Detection rules:
 *   - `data:image/...;base64,...` → image
 *   - `data:video/...;base64,...` → video
 *   - URL ending in image extension → image
 *   - URL ending in video extension → video
 *   - URL ending in `.m3u8` / `.mpd` → adaptive stream
 *   - `rtsp://` / `rtmp://` / `srt://` / `udp://` → camera-style stream
 *     (browsers can't play these directly; we surface them as a link
 *     with a "open in player" affordance the user can copy)
 *   - Other `http(s)://` URL → generic link
 *   - Arrays whose items all classify the same way → combined gallery /
 *     playlist (so `images: ['u1', 'u2']` becomes one carousel, not two
 *     separate entries)
 *   - Plain primitives / nested objects → fall through to "non-media"
 *
 * `Bin.notes`, `bin.externalCode`, `bin.sku`, and certain well-known
 * custom keys (`image`, `images`, `photo`, `photos`, `thumbnail`,
 * `video`, `videos`, `stream`, `camera`) get scanned eagerly even when
 * the value alone wouldn't have triggered detection — important for
 * RTSP URLs that have no extension and HTTP URLs that point at
 * extension-less endpoints.
 */

import type { Bin } from '@/lib/db'

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|bmp|ico|avif|tiff?)(\?|#|$)/i
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v|mkv|avi)(\?|#|$)/i
const STREAM_EXT = /\.(m3u8|mpd)(\?|#|$)/i
const STREAM_SCHEME = /^(rtsp|rtmp|rtmps|srt|udp|mms):\/\//i
const HTTP_SCHEME = /^https?:\/\//i
const ROOT_PATH = /^\/(?!\/)/

// Matches keys that MEAN "this string is a media URL", even when they
// carry a `Url` / `Uri` / `Src` / `Href` suffix or a plural `s`.
// Examples we now catch:
//   image, images, imageUrl, imageURL, image_url, imagePath, photo,
//   photoUrl, photoUri, photos, thumbnail, thumbnailUrl, avatar,
//   avatarUrl, picture, coverImage (via wordEnd), gallery, video,
//   videoSrc, stream, streamUrl, camera, cameraFeed, cameraUri, feed,
//   preview, previewUrl, banner, bannerUrl, logo, logoUrl, icon,
//   iconUrl.
// Anchored to end-of-key so keys like `image_count` still fall
// through as ordinary numbers. Case-insensitive for camelCase +
// snake_case mixes.
const MEDIA_KEY_HINT =
  /^(?:.*?)(image|photo|thumb(?:nail)?|picture|avatar|video|stream|camera|feed|preview|cover|gallery|banner|logo|icon)s?(?:[_-]?(?:url|uri|src|href|path|link))?$/i

export type MediaKind = 'image' | 'video' | 'stream' | 'link'

export interface MediaItem {
  kind: MediaKind
  /** URL or data: URI; rendered directly into <img>/<video> for image+video. */
  src: string
  /** Human-friendly label — falls back to the property key. */
  label?: string
  /** Original source key (for editing / removal). */
  sourceKey: string
}

export interface PrimaryFieldRow {
  label: string
  value: string
  /** Optional status badge — only set for the BinStatus row. */
  status?: 'empty' | 'occupied' | 'reserved'
}

export interface ClassifiedBin {
  /** Images and videos first; one carousel per kind, ordered images → videos. */
  media: MediaItem[]
  /** Stream / camera / link entries — rendered as tiles below the carousel. */
  links: MediaItem[]
  /** Built-in fields (externalCode, sku, capacity, notes, status) with values. */
  primary: PrimaryFieldRow[]
  /** Non-media custom properties — values may be primitives, arrays, or objects. */
  custom: Array<{ key: string; value: unknown }>
}

// ---------------------------------------------------------------- detection

export function classifyValue(key: string, value: unknown): MediaItem[] {
  if (value === null || value === undefined) return []
  const hint = MEDIA_KEY_HINT.test(key)
  // Arrays — recurse into each item, then collapse media of the same
  // kind under one shared sourceKey so the carousel stays a single unit.
  if (Array.isArray(value)) {
    const out: MediaItem[] = []
    for (let i = 0; i < value.length; i++) {
      const items = classifyValue(key, value[i])
      for (const it of items) out.push({ ...it, sourceKey: key })
    }
    return out
  }
  if (typeof value !== 'string') return []
  const s = value.trim()
  if (s.length === 0) return []

  // base64-encoded data URIs
  if (/^data:image\//i.test(s)) return [{ kind: 'image', src: s, sourceKey: key }]
  if (/^data:video\//i.test(s)) return [{ kind: 'video', src: s, sourceKey: key }]

  // Stream by scheme (RTSP / RTMP / SRT / UDP / MMS — camera feeds)
  if (STREAM_SCHEME.test(s)) return [{ kind: 'stream', src: s, sourceKey: key }]

  // A video file on a stream / camera / feed / live key is a camera feed
  // (an NVR relay or a recorded loop), shown live rather than as a clip.
  const streamKey = /stream|camera|feed|cctv|live/i.test(key)
  // Same-origin paths (`/files/…`, `/camera-feeds/…`) count when they name
  // a media file; any other path stays plain text.
  if (ROOT_PATH.test(s) && (IMAGE_EXT.test(s) || VIDEO_EXT.test(s) || STREAM_EXT.test(s))) {
    if (IMAGE_EXT.test(s)) return [{ kind: 'image', src: s, sourceKey: key }]
    if (STREAM_EXT.test(s) || streamKey) return [{ kind: 'stream', src: s, sourceKey: key }]
    return [{ kind: 'video', src: s, sourceKey: key }]
  }

  // HTTP(S) URLs — classify by extension or by key hint
  if (HTTP_SCHEME.test(s)) {
    if (IMAGE_EXT.test(s)) return [{ kind: 'image', src: s, sourceKey: key }]
    if (VIDEO_EXT.test(s)) return [{ kind: streamKey ? 'stream' : 'video', src: s, sourceKey: key }]
    if (STREAM_EXT.test(s)) return [{ kind: 'stream', src: s, sourceKey: key }]
    if (hint) {
      // Extensionless URL on a media-named key — assume it serves the
      // implied kind. The renderer will gracefully fall back to a broken
      // image if the assumption is wrong.
      if (/image|photo|thumb|picture|cover|gallery/i.test(key)) {
        return [{ kind: 'image', src: s, sourceKey: key }]
      }
      if (/video/i.test(key)) return [{ kind: 'video', src: s, sourceKey: key }]
      if (/stream|camera|feed/i.test(key)) {
        return [{ kind: 'stream', src: s, sourceKey: key }]
      }
    }
    // Plain link
    return [{ kind: 'link', src: s, sourceKey: key }]
  }
  return []
}

// ----------------------------------------------------------------- top level

export function classifyBin(bin: Bin): ClassifiedBin {
  const media: MediaItem[] = []
  const links: MediaItem[] = []
  const custom: Array<{ key: string; value: unknown }> = []

  // Walk customProperties — classify each value, peel media out, leave
  // everything else for the "other attributes" section.
  const entries = Object.entries(bin.customProperties ?? {})
  for (const [key, value] of entries) {
    const detected = classifyValue(key, value)
    if (detected.length === 0) {
      // Skip nullish / empty-string values from the "other attributes"
      // section but keep `0`, `false`, `[]`, `{}`.
      if (value === null || value === undefined) continue
      if (typeof value === 'string' && value.trim() === '') continue
      custom.push({ key, value })
      continue
    }
    for (const item of detected) {
      if (item.kind === 'image' || item.kind === 'video') media.push(item)
      else links.push(item)
    }
  }

  // Order: images first, then videos. Inside each kind, preserve insertion.
  media.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))

  const primary: PrimaryFieldRow[] = []
  if (bin.externalCode) primary.push({ label: 'External code', value: bin.externalCode })
  if (bin.sku) primary.push({ label: 'SKU', value: bin.sku })
  if (typeof bin.capacity === 'number') {
    primary.push({ label: 'Capacity', value: bin.capacity.toLocaleString() })
  }
  if (bin.status && bin.status !== 'empty') {
    primary.push({ label: 'Status', value: bin.status, status: bin.status })
  }
  if (bin.notes) primary.push({ label: 'Notes', value: bin.notes })

  return { media, links, primary, custom }
}

function kindOrder(k: MediaKind): number {
  switch (k) {
    case 'image': return 0
    case 'video': return 1
    case 'stream': return 2
    case 'link': return 3
  }
}

/** Does the bin carry anything worth showing? Tooltip / editor entry gate. */
export function hasAnyContent(bin: Bin): boolean {
  if (bin.externalCode) return true
  if (bin.sku) return true
  if (typeof bin.capacity === 'number') return true
  if (bin.notes) return true
  if (bin.status && bin.status !== 'empty') return true
  if (bin.customProperties && Object.keys(bin.customProperties).length > 0) return true
  return false
}
