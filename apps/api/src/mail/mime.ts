import { createHash, randomBytes } from 'node:crypto'
import { inflateRawSync, unzipSync } from 'node:zlib'
import { fail } from '@xpanel/core'

export interface MimeAttachmentInput {
  filename: string
  contentType: string
  content: Buffer | Uint8Array | string
  contentId?: string
  inline?: boolean
}

export interface MimeBuildInput {
  from: string
  fromName?: string
  to: readonly string[]
  cc?: readonly string[]
  replyTo?: string
  subject: string
  messageId?: string
  date?: Date
  inReplyTo?: string
  references?: readonly string[]
  textBody?: string
  htmlBody?: string
  attachments?: readonly MimeAttachmentInput[]
  extraHeaders?: Readonly<Record<string, string>>
}

export interface ParsedMimeAttachment {
  id: string
  filename: string
  contentType: string
  disposition: 'attachment' | 'inline'
  contentId: string | null
  sizeBytes: number
  sha256: string
  content: Buffer
  dangerousExtension: boolean
}

export interface HtmlSanitizeReport {
  sanitizedHtml: string
  blockedTags: string[]
  blockedAttributes: string[]
  blockedUrls: string[]
  blockedRemoteImages: string[]
  resolvedCids: string[]
  cspHeader: string
  iframeSandboxAttribute: string
}

export interface ParsedMimeMessage {
  headers: Record<string, string>
  messageId: string | null
  from: string
  to: string[]
  cc: string[]
  subject: string
  date: string | null
  textBody: string
  rawHtmlBody: string
  sanitizedHtmlBody: string
  sanitizeReport: HtmlSanitizeReport
  attachments: ParsedMimeAttachment[]
  inlineCidMap: Record<string, string>
}

export interface MimeParseLimits {
  maxTotalBytes?: number
  maxHeaderBytes?: number
  maxNestingDepth?: number
  maxParts?: number
  maxDecompressedBytes?: number
  maxCompressionRatio?: number
  allowRemoteImages?: boolean
}

const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024 // 25 MiB
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024 // 64 KiB
const DEFAULT_MAX_NESTING_DEPTH = 6
const DEFAULT_MAX_PARTS = 64
const DEFAULT_MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024 // 10 MiB
const DEFAULT_MAX_COMPRESSION_RATIO = 25

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'msi', 'hta', 'jar', 'cpl', 'reg', 'lnk',
])

const SAFE_INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

const DROP_ELEMENT_WITH_CONTENT_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'style',
  'head',
  'title',
  'noscript',
  'template',
  'svg',
  'math',
  'xml',
  'xss',
])

const DROP_TAG_ONLY_ELEMENTS = new Set([
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'optgroup',
  'fieldset',
  'base',
  'meta',
  'link',
  'audio',
  'video',
  'source',
  'track',
  'portal',
  'slot',
  'marquee',
  'blink',
])

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'bdi', 'bdo', 'article', 'section', 'header', 'footer', 'main',
])

const ALLOWED_ATTRS = new Set([
  'dir', 'lang', 'align', 'valign', 'colspan', 'rowspan',
  'alt', 'title', 'href', 'src', 'width', 'height', 'style',
  'border', 'cellpadding', 'cellspacing',
])

export const WEBMAIL_SANDBOX_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export const WEBMAIL_IFRAME_SANDBOX = ''

/**
 * Encodes a header value using RFC 2047 `=?UTF-8?B?...?=` if it contains non-ASCII characters.
 */
export const encodeRfc2047Word = (value: string): string => {
  const clean = value.replace(/[\r\n]+/g, ' ').trim()
  if (/^[\x20-\x7e]*$/.test(clean) && !clean.includes('=?')) {
    return clean
  }
  const b64 = Buffer.from(clean, 'utf8').toString('base64')
  return `=?UTF-8?B?${b64}?=`
}

/**
 * Decodes RFC 2047 encoded-words (`=?charset?B?...?=` and `=?charset?Q?...?=`) into UTF-8.
 */
export const decodeRfc2047 = (raw: string): string => {
  if (!raw.includes('=?')) return raw
  // Remove whitespace between adjacent encoded-words per RFC 2047 section 6.2
  const collapsed = raw.replace(/(\?=)\s+(=\?)/g, '$1$2')
  return collapsed.replace(/=\?([A-Za-z0-9_-]+)\?([BbQq])\?([^?]*)\?=/g, (_full, charsetRaw: string, encodingRaw: string, payload: string) => {
    const enc = encodingRaw.toUpperCase()
    const charset = charsetRaw.toLowerCase()
    let bytes: Buffer
    if (enc === 'B') {
      bytes = Buffer.from(payload, 'base64')
    } else {
      const qNormalized = payload.replace(/_/g, ' ')
      const buf: number[] = []
      for (let i = 0; i < qNormalized.length; i++) {
        if (qNormalized[i] === '=' && i + 2 < qNormalized.length) {
          const hex = qNormalized.slice(i + 1, i + 3)
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            buf.push(Number.parseInt(hex, 16))
            i += 2
            continue
          }
        }
        buf.push(qNormalized.charCodeAt(i))
      }
      bytes = Buffer.from(buf)
    }
    if (charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii') {
      return bytes.toString('utf8')
    }
    if (charset === 'iso-8859-1' || charset === 'latin1') {
      return bytes.toString('latin1')
    }
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      return bytes.toString('utf8')
    }
  })
}

/**
 * Encodes a filename parameter using both RFC 2231 (`filename*=UTF-8''...`) and an ASCII fallback.
 */
export const encodeRfc2231Filename = (filename: string): string => {
  const sanitized = sanitizeAttachmentFilename(filename)
  if (/^[A-Za-z0-9._-]+$/.test(sanitized)) {
    return `filename="${sanitized}"`
  }
  const encoded = encodeURIComponent(sanitized).replace(/'/g, '%27')
  const asciiFallback = sanitized.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

/**
 * Sanitizes an attachment filename, decoding RFC 2047 / RFC 2231 and stripping path traversal,
 * null bytes, BiDi override characters (e.g. RLO U+202E used for extension spoofing), and slashes.
 */
export const sanitizeAttachmentFilename = (rawFilename: string): string => {
  const decoded = decodeRfc2047(rawFilename)
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? 'attachment.bin'
  const trimmed = decoded.replace(/^\.+/, '').trim()
  return trimmed.length > 0 ? trimmed.slice(0, 255) : 'attachment.bin'
}

/**
 * Decodes HTML numeric & named entities so obfuscated `&#x6a;avascript:` URLs cannot bypass scheme filters.
 */
const decodeHtmlEntitiesForCheck = (input: string): string =>
  input
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d{1,7});?/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '')
    .replace(/&newline;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")

const normalizeUrlForSchemeCheck = (rawUrl: string): string =>
  decodeHtmlEntitiesForCheck(rawUrl)
    .replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
    .toLowerCase()

const sanitizeInlineStyle = (
  rawStyle: string,
  blockedUrls: string[],
): string => {
  const decoded = decodeHtmlEntitiesForCheck(rawStyle).replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = decoded.split(';')
  const safeDecls: string[] = []

  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':')
    if (colonIdx <= 0) continue
    const prop = decl.slice(0, colonIdx).trim().toLowerCase()
    const val = decl.slice(colonIdx + 1).trim()
    const valNorm = val.replace(/\s+/g, '').toLowerCase()

    if (!/^[a-z-]{1,40}$/.test(prop)) continue
    if (prop === 'position' && (valNorm.includes('fixed') || valNorm.includes('absolute'))) {
      continue
    }
    if (prop === 'behavior' || prop === '-moz-binding') {
      blockedUrls.push(`css:${prop}:${val}`)
      continue
    }
    if (
      valNorm.includes('expression(') ||
      valNorm.includes('javascript:') ||
      valNorm.includes('vbscript:') ||
      valNorm.includes('data:') ||
      valNorm.includes('@import') ||
      valNorm.includes('url(')
    ) {
      blockedUrls.push(`css:${val}`)
      continue
    }
    if (/^[\p{L}\p{N}\s#%.,()+-]+$/u.test(val)) {
      safeDecls.push(`${prop}: ${val}`)
    }
  }

  return safeDecls.join('; ')
}

/**
 * Sanitizes untrusted HTML email body for A44:
 * - Completely removes `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<svg>`, `<math>` and their contents
 * - Strips `<form>`, `<input>`, `<base>`, `<meta>`, `<link>` tags
 * - Strips all `on*` inline event handlers (`onerror`, `onload`, `onclick`, etc.) and `srcdoc`
 * - Rejects `javascript:`, `vbscript:`, `data:text/html`, and CSS `expression()` / `url()`
 * - Blocks remote tracking images (`http://`, `https://`, `//`) by default unless `allowRemoteImages: true`
 * - Resolves safe `cid:` inline images from `cidMap`
 * - Preserves Arabic UTF-8 text and `dir="rtl"` / `dir="ltr"` / `dir="auto"` formatting
 */
export const sanitizeEmailHtml = (
  rawHtml: string,
  options: {
    cidMap?: Readonly<Record<string, string>>
    allowRemoteImages?: boolean
  } = {},
): HtmlSanitizeReport => {
  const cidMap = options.cidMap ?? {}
  const allowRemoteImages = options.allowRemoteImages ?? false

  const blockedTags: string[] = []
  const blockedAttributes: string[] = []
  const blockedUrls: string[] = []
  const blockedRemoteImages: string[] = []
  const resolvedCids: string[] = []

  let html = rawHtml

  // Remove HTML comments including conditional IE comments
  html = html.replace(/<!--[\s\S]*?-->/g, '')

  // 1. Strip dangerous elements along with their inner content (loop until stable)
  const contentTagPattern = [...DROP_ELEMENT_WITH_CONTENT_TAGS].join('|')
  const pairedRe = new RegExp(`<(${contentTagPattern})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi')
  const unclosedRe = new RegExp(`<(${contentTagPattern})\\b[^>]*>`, 'gi')
  let prev = ''
  while (prev !== html) {
    prev = html
    html = html.replace(pairedRe, (_m, tag: string) => {
      blockedTags.push(tag.toLowerCase())
      return ''
    })
  }
  html = html.replace(unclosedRe, (_m, tag: string) => {
    blockedTags.push(tag.toLowerCase())
    return ''
  })

  // 2. Process all remaining HTML tags and attributes
  html = html.replace(/<\/?([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g, (fullMatch, rawTagName: string, rawAttrs: string) => {
    const tag = rawTagName.toLowerCase()
    const isClosing = fullMatch.startsWith('</')

    if (DROP_ELEMENT_WITH_CONTENT_TAGS.has(tag) || DROP_TAG_ONLY_ELEMENTS.has(tag)) {
      if (!isClosing) blockedTags.push(tag)
      return ''
    }

    if (!ALLOWED_TAGS.has(tag)) {
      if (!isClosing) blockedTags.push(tag)
      return ''
    }

    if (isClosing) {
      return `</${tag}>`
    }

    const safeAttrStrings: string[] = []
    const attrRe = /([A-Za-z_:@][A-Za-z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    let match: RegExpExecArray | null
    let isTrackingPixel = false
    let parsedWidth: number | null = null
    let parsedHeight: number | null = null

    const extractedAttrs: { name: string; value: string }[] = []
    while ((match = attrRe.exec(rawAttrs)) !== null) {
      const attrName = (match[1] ?? '').toLowerCase()
      const attrVal = match[2] ?? match[3] ?? match[4] ?? ''
      extractedAttrs.push({ name: attrName, value: attrVal })
    }

    for (const { name, value } of extractedAttrs) {
      if (name === 'width') {
        const n = Number.parseInt(value, 10)
        if (!Number.isNaN(n)) parsedWidth = n
      }
      if (name === 'height') {
        const n = Number.parseInt(value, 10)
        if (!Number.isNaN(n)) parsedHeight = n
      }
    }
    if (
      tag === 'img' &&
      ((parsedWidth !== null && parsedWidth <= 1) || (parsedHeight !== null && parsedHeight <= 1))
    ) {
      isTrackingPixel = true
    }

    for (const { name, value } of extractedAttrs) {
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'xlink:href' || name === 'xmlns') {
        blockedAttributes.push(name)
        continue
      }

      if (!ALLOWED_ATTRS.has(name)) {
        blockedAttributes.push(name)
        continue
      }

      if (name === 'dir') {
        const d = value.trim().toLowerCase()
        if (d === 'rtl' || d === 'ltr' || d === 'auto') {
          safeAttrStrings.push(`dir="${d}"`)
        }
        continue
      }

      if (name === 'style') {
        const cleanStyle = sanitizeInlineStyle(value, blockedUrls)
        if (cleanStyle) {
          safeAttrStrings.push(`style="${cleanStyle.replace(/"/g, '&quot;')}"`)
        } else if (value.trim()) {
          blockedAttributes.push('style')
        }
        continue
      }

      if (name === 'href') {
        if (tag !== 'a') {
          blockedAttributes.push('href')
          continue
        }
        const schemeCheck = normalizeUrlForSchemeCheck(value)
        if (
          schemeCheck.startsWith('javascript:') ||
          schemeCheck.startsWith('vbscript:') ||
          schemeCheck.startsWith('data:') ||
          schemeCheck.startsWith('file:') ||
          schemeCheck.startsWith('blob:')
        ) {
          blockedUrls.push(value)
          blockedAttributes.push('href')
          continue
        }
        if (
          schemeCheck.startsWith('https://') ||
          schemeCheck.startsWith('http://') ||
          schemeCheck.startsWith('mailto:') ||
          schemeCheck.startsWith('#')
        ) {
          const escapedHref = value.replace(/"/g, '&quot;').replace(/[\r\n]/g, '')
          safeAttrStrings.push(`href="${escapedHref}"`)
        } else {
          blockedUrls.push(value)
        }
        continue
      }

      if (name === 'src') {
        if (tag !== 'img') {
          blockedAttributes.push('src')
          continue
        }
        const schemeCheck = normalizeUrlForSchemeCheck(value)
        if (schemeCheck.startsWith('cid:')) {
          const cidKey = value.trim().slice(4).replace(/^<|>$/g, '').trim()
          const resolved = cidMap[cidKey] ?? cidMap[cidKey.toLowerCase()]
          if (resolved && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(resolved)) {
            resolvedCids.push(cidKey)
            safeAttrStrings.push(`src="${resolved}"`)
            safeAttrStrings.push('data-cid-resolved="true"')
          } else {
            blockedUrls.push(value)
            safeAttrStrings.push('data-cid-unresolved="true"')
          }
          continue
        }

        if (
          schemeCheck.startsWith('javascript:') ||
          schemeCheck.startsWith('vbscript:') ||
          schemeCheck.startsWith('data:text/html') ||
          schemeCheck.startsWith('data:image/svg')
        ) {
          blockedUrls.push(value)
          blockedAttributes.push('src')
          continue
        }

        if (schemeCheck.startsWith('http://') || schemeCheck.startsWith('https://') || schemeCheck.startsWith('//')) {
          if (!allowRemoteImages || isTrackingPixel) {
            blockedRemoteImages.push(value)
            safeAttrStrings.push('data-blocked-remote-image="true"')
            if (isTrackingPixel) {
              safeAttrStrings.push('data-blocked-tracking-pixel="true"')
            }
            continue
          }
          safeAttrStrings.push(`src="${value.replace(/"/g, '&quot;')}"`)
          continue
        }

        blockedUrls.push(value)
        continue
      }

      const escapedVal = value.replace(/"/g, '&quot;').replace(/[<>]/g, '')
      safeAttrStrings.push(`${name}="${escapedVal}"`)
    }

    if (tag === 'a') {
      safeAttrStrings.push('rel="noopener noreferrer nofollow"')
      safeAttrStrings.push('target="_blank"')
    }

    const attrSuffix = safeAttrStrings.length > 0 ? ` ${safeAttrStrings.join(' ')}` : ''
    const selfClosing = tag === 'br' || tag === 'hr' || tag === 'img'
    return `<${tag}${attrSuffix}${selfClosing ? ' />' : '>'}`
  })

  return {
    sanitizedHtml: html,
    blockedTags,
    blockedAttributes,
    blockedUrls,
    blockedRemoteImages,
    resolvedCids,
    cspHeader: WEBMAIL_SANDBOX_CSP,
    iframeSandboxAttribute: WEBMAIL_IFRAME_SANDBOX,
  }
}

const wrapBase64Lines = (b64: string, lineLen = 76): string => {
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += lineLen) {
    chunks.push(b64.slice(i, i + lineLen))
  }
  return chunks.join('\r\n')
}

const decodeQuotedPrintableBytes = (input: string): Buffer => {
  const softJoined = input.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < softJoined.length; i++) {
    if (softJoined[i] === '=' && i + 2 < softJoined.length) {
      const hex = softJoined.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    out.push(softJoined.charCodeAt(i) & 0xff)
  }
  return Buffer.from(out)
}

const parseHeaderBlock = (rawHeaderBlock: string): Record<string, string> => {
  const unfolded = rawHeaderBlock.replace(/\r?\n[ \t]+/g, ' ')
  const lines = unfolded.split(/\r?\n/)
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const val = line.slice(colon + 1).trim()
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val
  }
  return headers
}

const extractHeaderParam = (headerValue: string, paramName: string): string | null => {
  const lowerName = paramName.toLowerCase()
  // Check RFC 2231 param*=charset''value first
  const rfc2231Re = new RegExp(`(?:;|\\s)${lowerName}\\*=([^;]+)`, 'i')
  const m2231 = rfc2231Re.exec(headerValue)
  if (m2231 && m2231[1]) {
    const raw = m2231[1].trim().replace(/^"|"$/g, '')
    const quoteIdx = raw.indexOf("''")
    const encodedPart = quoteIdx >= 0 ? raw.slice(quoteIdx + 2) : raw
    try {
      return decodeURIComponent(encodedPart)
    } catch {
      return encodedPart
    }
  }

  // Check RFC 2231 multi-segment continuations param*0*=..., param*1*=...
  const contRe = new RegExp(`(?:;|\\s)${lowerName}\\*(\\d+)(\\*?)=([^;]+)`, 'gi')
  const segments: { idx: number; val: string; encoded: boolean }[] = []
  let cm: RegExpExecArray | null
  while ((cm = contRe.exec(headerValue)) !== null) {
    segments.push({
      idx: Number.parseInt(cm[1]!, 10),
      encoded: cm[2] === '*',
      val: (cm[3] ?? '').trim().replace(/^"|"$/g, ''),
    })
  }
  if (segments.length > 0) {
    segments.sort((a, b) => a.idx - b.idx)
    const combined = segments
      .map((seg, idx) => {
        let v = seg.val
        if (idx === 0 && seg.encoded && v.includes("''")) {
          v = v.slice(v.indexOf("''") + 2)
        }
        if (seg.encoded) {
          try {
            return decodeURIComponent(v)
          } catch {
            return v
          }
        }
        return v
      })
      .join('')
    return decodeRfc2047(combined)
  }

  // Standard param="value" or param=value
  const stdRe = new RegExp(`(?:;|\\s)${lowerName}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i')
  const mStd = stdRe.exec(headerValue)
  if (mStd) {
    return decodeRfc2047(mStd[1] ?? mStd[2] ?? '')
  }
  return null
}

const verifyNotDecompressionBomb = (
  buf: Buffer,
  contentType: string,
  filename: string,
  limits: Required<Pick<MimeParseLimits, 'maxDecompressedBytes' | 'maxCompressionRatio'>>,
): void => {
  const lowerType = contentType.toLowerCase()
  const lowerName = filename.toLowerCase()
  const isGzip =
    (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) ||
    lowerType.includes('gzip') ||
    lowerName.endsWith('.gz')

  if (isGzip) {
    try {
      const decompressed = unzipSync(buf, { maxOutputLength: limits.maxDecompressedBytes + 1 })
      if (decompressed.length > limits.maxDecompressedBytes) {
        fail('VALIDATION', `compressed MIME attachment "${filename}" exceeds max decompressed size`)
      }
      if (buf.length > 0 && decompressed.length / buf.length > limits.maxCompressionRatio) {
        fail('VALIDATION', `compressed MIME attachment "${filename}" rejected due to suspicious compression ratio`)
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'VALIDATION') throw err
      fail('VALIDATION', `compressed MIME attachment "${filename}" exceeded safe decompression limits`)
    }
  }

  // Check ZIP local file header (PK\x03\x04)
  if (buf.length >= 30 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const compMethod = buf.readUInt16LE(8)
    const compressedSize = buf.readUInt32LE(18)
    const uncompressedSize = buf.readUInt32LE(22)
    if (uncompressedSize > limits.maxDecompressedBytes) {
      fail('VALIDATION', `ZIP attachment "${filename}" declares uncompressed size (${uncompressedSize}) exceeding limit`)
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      fail('VALIDATION', `ZIP attachment "${filename}" rejected as a potential decompression bomb`)
    }
    if (compMethod === 8) {
      const nameLen = buf.readUInt16LE(26)
      const extraLen = buf.readUInt16LE(28)
      const dataStart = 30 + nameLen + extraLen
      if (dataStart < buf.length && compressedSize > 0 && dataStart + compressedSize <= buf.length) {
        try {
          const out = inflateRawSync(buf.subarray(dataStart, dataStart + compressedSize), {
            maxOutputLength: limits.maxDecompressedBytes,
          })
          if (out.length / compressedSize > limits.maxCompressionRatio) {
            fail('VALIDATION', `ZIP attachment "${filename}" rejected as a decompression bomb`)
          }
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'VALIDATION') throw err
          fail('VALIDATION', `ZIP attachment "${filename}" exceeded safe decompression limits`)
        }
      }
    }
  }
}

/**
 * M02 MimeCodecAndSanitizer:
 * Full RFC 2047 / RFC 2231 / multipart MIME builder, parser, bomb guard, and HTML/CSS sanitizer.
 */
export class MimeCodecAndSanitizer {
  /**
   * Builds a standards-compliant RFC 5322 / MIME 1.0 message supporting:
   * - UTF-8 Arabic headers (`Subject`, `From`, `To`, `Cc`) via RFC 2047
   * - UTF-8 Arabic attachment filenames via RFC 2231
   * - `multipart/alternative` (`text/plain` + `text/html`)
   * - `multipart/related` (inline `cid:` images)
   * - `multipart/mixed` (file attachments)
   */
  buildMimeMessage(input: MimeBuildInput): { rawMime: string; messageId: string } {
    if (!input.from || !input.from.includes('@')) {
      fail('VALIDATION', 'valid From address is required')
    }
    if (!Array.isArray(input.to) || input.to.length === 0) {
      fail('VALIDATION', 'at least one To recipient is required')
    }

    const fromDomain = input.from.split('@')[1] ?? 'localhost'
    const messageId =
      input.messageId ?? `<${Date.now()}.${randomBytes(8).toString('hex')}@${fromDomain}>`
    const dateStr = (input.date ?? new Date()).toUTCString()
    const fromHeader = input.fromName
      ? `${encodeRfc2047Word(input.fromName)} <${input.from}>`
      : input.from

    const topHeaders: string[] = [
      `From: ${fromHeader}`,
      `To: ${input.to.join(', ')}`,
      ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []),
      ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
      `Subject: ${encodeRfc2047Word(input.subject ?? '')}`,
      `Date: ${dateStr}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
    ]

    if (input.inReplyTo) topHeaders.push(`In-Reply-To: ${input.inReplyTo}`)
    if (input.references && input.references.length > 0) {
      topHeaders.push(`References: ${input.references.join(' ')}`)
    }
    if (input.extraHeaders) {
      for (const [k, v] of Object.entries(input.extraHeaders)) {
        if (/^[A-Za-z0-9-]+$/.test(k) && !/[\r\n]/.test(v)) {
          topHeaders.push(`${k}: ${v}`)
        }
      }
    }

    const textBody = input.textBody ?? ''
    const htmlBody = input.htmlBody ?? ''
    const allAttachments = input.attachments ?? []
    const inlineParts = allAttachments.filter((a) => a.inline || Boolean(a.contentId))
    const regularAttachments = allAttachments.filter((a) => !a.inline && !a.contentId)

    const buildTextAlternativeBlock = (): { contentTypeHeader: string; body: string } => {
      if (textBody && htmlBody) {
        const altBoundary = `=_xpanel_alt_${randomBytes(12).toString('hex')}`
        const textB64 = wrapBase64Lines(Buffer.from(textBody, 'utf8').toString('base64'))
        const htmlB64 = wrapBase64Lines(Buffer.from(htmlBody, 'utf8').toString('base64'))
        const body = [
          `--${altBoundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          textB64,
          `--${altBoundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          htmlB64,
          `--${altBoundary}--`,
        ].join('\r\n')
        return {
          contentTypeHeader: `multipart/alternative; boundary="${altBoundary}"`,
          body,
        }
      }
      if (htmlBody) {
        return {
          contentTypeHeader: 'text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64',
          body: wrapBase64Lines(Buffer.from(htmlBody, 'utf8').toString('base64')),
        }
      }
      return {
        contentTypeHeader: 'text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64',
        body: wrapBase64Lines(Buffer.from(textBody, 'utf8').toString('base64')),
      }
    }

    const formatAttachmentPart = (att: MimeAttachmentInput, disposition: 'inline' | 'attachment'): string => {
      const buf =
        typeof att.content === 'string'
          ? Buffer.from(att.content, 'utf8')
          : Buffer.from(att.content)
      const fnParam = encodeRfc2231Filename(att.filename)
      const cidClean = att.contentId?.replace(/^<|>$/g, '').trim()
      const headers = [
        `Content-Type: ${att.contentType}; ${fnParam}`,
        `Content-Disposition: ${disposition}; ${fnParam}`,
        ...(cidClean ? [`Content-ID: <${cidClean}>`] : []),
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64Lines(buf.toString('base64')),
      ]
      return headers.join('\r\n')
    }

    let contentBlock = buildTextAlternativeBlock()

    if (inlineParts.length > 0) {
      const relBoundary = `=_xpanel_rel_${randomBytes(12).toString('hex')}`
      const relSegments = [
        `--${relBoundary}`,
        `Content-Type: ${contentBlock.contentTypeHeader}`,
        '',
        contentBlock.body,
        ...inlineParts.flatMap((inl) => [`--${relBoundary}`, formatAttachmentPart(inl, 'inline')]),
        `--${relBoundary}--`,
      ]
      contentBlock = {
        contentTypeHeader: `multipart/related; boundary="${relBoundary}"`,
        body: relSegments.join('\r\n'),
      }
    }

    if (regularAttachments.length > 0) {
      const mixBoundary = `=_xpanel_mix_${randomBytes(12).toString('hex')}`
      const mixSegments = [
        `--${mixBoundary}`,
        `Content-Type: ${contentBlock.contentTypeHeader}`,
        '',
        contentBlock.body,
        ...regularAttachments.flatMap((att) => [
          `--${mixBoundary}`,
          formatAttachmentPart(att, 'attachment'),
        ]),
        `--${mixBoundary}--`,
      ]
      contentBlock = {
        contentTypeHeader: `multipart/mixed; boundary="${mixBoundary}"`,
        body: mixSegments.join('\r\n'),
      }
    }

    const rawMime = `${topHeaders.join('\r\n')}\r\nContent-Type: ${contentBlock.contentTypeHeader}\r\n\r\n${contentBlock.body}\r\n`
    return { rawMime, messageId }
  }

  /**
   * Parses a raw MIME message with strict nesting, part count, header size, and decompression bomb guards,
   * and sanitizes any HTML body and inline CID references.
   */
  parseMimeMessage(rawInput: string | Buffer, limits: MimeParseLimits = {}): ParsedMimeMessage {
    const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    const maxHeaderBytes = limits.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES
    const maxNestingDepth = limits.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH
    const maxParts = limits.maxParts ?? DEFAULT_MAX_PARTS
    const maxDecompressedBytes = limits.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES
    const maxCompressionRatio = limits.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO

    const rawBuffer = typeof rawInput === 'string' ? Buffer.from(rawInput, 'utf8') : rawInput
    if (rawBuffer.length > maxTotalBytes) {
      fail('VALIDATION', `MIME message size (${rawBuffer.length} bytes) exceeds limit (${maxTotalBytes} bytes)`)
    }

    const rawString = rawBuffer.toString('utf8')
    let partsSeen = 0
    const textBodies: string[] = []
    const htmlBodies: string[] = []
    const attachments: ParsedMimeAttachment[] = []
    const inlineCidMap: Record<string, string> = {}

    const splitHeaderAndBody = (entity: string): { headers: Record<string, string>; body: string } => {
      const crlfMatch = /\r?\n\r?\n/.exec(entity)
      if (!crlfMatch) {
        if (Buffer.byteLength(entity, 'utf8') > maxHeaderBytes) {
          fail('VALIDATION', 'MIME header block exceeds maximum size')
        }
        return { headers: parseHeaderBlock(entity), body: '' }
      }
      const headerRaw = entity.slice(0, crlfMatch.index)
      if (Buffer.byteLength(headerRaw, 'utf8') > maxHeaderBytes) {
        fail('VALIDATION', 'MIME header block exceeds maximum size')
      }
      const body = entity.slice(crlfMatch.index + crlfMatch[0].length)
      return { headers: parseHeaderBlock(headerRaw), body }
    }

    const decodePartBytes = (bodyText: string, transferEncoding: string): Buffer => {
      const enc = transferEncoding.trim().toLowerCase()
      if (enc === 'base64') {
        return Buffer.from(bodyText.replace(/\s+/g, ''), 'base64')
      }
      if (enc === 'quoted-printable') {
        return decodeQuotedPrintableBytes(bodyText)
      }
      return Buffer.from(bodyText, 'utf8')
    }

    const walkEntity = (entity: string, depth: number): Record<string, string> => {
      if (depth > maxNestingDepth) {
        fail('VALIDATION', `MIME nesting depth (${depth}) exceeds maximum allowed depth (${maxNestingDepth})`)
      }
      partsSeen++
      if (partsSeen > maxParts) {
        fail('VALIDATION', `MIME message part count (${partsSeen}) exceeds maximum allowed parts (${maxParts})`)
      }

      const { headers, body } = splitHeaderAndBody(entity)
      const contentTypeRaw = headers['content-type'] ?? 'text/plain; charset=utf-8'
      const mimeType = (contentTypeRaw.split(';')[0] ?? 'text/plain').trim().toLowerCase()
      const dispositionRaw = headers['content-disposition'] ?? ''
      const dispositionType = (dispositionRaw.split(';')[0] ?? '').trim().toLowerCase()
      const transferEncoding = headers['content-transfer-encoding'] ?? '7bit'

      if (mimeType.startsWith('multipart/')) {
        const boundary = extractHeaderParam(contentTypeRaw, 'boundary')
        if (!boundary) {
          fail('VALIDATION', 'multipart MIME entity is missing boundary parameter')
        }
        const delim = `--${boundary}`
        const segments = body.split(delim)
        // First segment is preamble; segments after `--` are epilogue
        for (let i = 1; i < segments.length; i++) {
          const seg = segments[i]!
          if (seg.startsWith('--')) break
          const cleaned = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
          walkEntity(cleaned, depth + 1)
        }
        return headers
      }

      const filenameRaw =
        extractHeaderParam(dispositionRaw, 'filename') ??
        extractHeaderParam(contentTypeRaw, 'name')
      const contentIdRaw = headers['content-id']?.replace(/^<|>$/g, '').trim() ?? null
      const decodedBytes = decodePartBytes(body, transferEncoding)

      const isAttachment =
        dispositionType === 'attachment' ||
        (dispositionType === 'inline' && Boolean(filenameRaw || contentIdRaw)) ||
        Boolean(filenameRaw) ||
        (!mimeType.startsWith('text/plain') && !mimeType.startsWith('text/html'))

      if (isAttachment) {
        const safeFilename = sanitizeAttachmentFilename(filenameRaw ?? 'attachment.bin')
        verifyNotDecompressionBomb(decodedBytes, mimeType, safeFilename, {
          maxDecompressedBytes,
          maxCompressionRatio,
        })

        const ext = safeFilename.includes('.')
          ? (safeFilename.split('.').pop() ?? '').toLowerCase()
          : ''
        const dangerousExtension = DANGEROUS_EXTENSIONS.has(ext)
        const sha256 = createHash('sha256').update(decodedBytes).digest('hex')

        if (contentIdRaw && SAFE_INLINE_IMAGE_TYPES.has(mimeType)) {
          const dataUri = `data:${mimeType};base64,${decodedBytes.toString('base64')}`
          inlineCidMap[contentIdRaw] = dataUri
          inlineCidMap[contentIdRaw.toLowerCase()] = dataUri
        }

        attachments.push({
          id: `att-${attachments.length + 1}-${sha256.slice(0, 12)}`,
          filename: safeFilename,
          contentType: mimeType,
          disposition: dispositionType === 'inline' || Boolean(contentIdRaw) ? 'inline' : 'attachment',
          contentId: contentIdRaw,
          sizeBytes: decodedBytes.length,
          sha256,
          content: decodedBytes,
          dangerousExtension,
        })
      } else if (mimeType === 'text/html') {
        htmlBodies.push(decodedBytes.toString('utf8'))
      } else {
        textBodies.push(decodedBytes.toString('utf8'))
      }

      return headers
    }

    const topHeaders = walkEntity(rawString, 0)
    const rawHtmlBody = htmlBodies.join('\n')
    const textBody = textBodies.join('\n')

    const sanitizeReport = sanitizeEmailHtml(rawHtmlBody, {
      cidMap: inlineCidMap,
      allowRemoteImages: limits.allowRemoteImages ?? false,
    })

    const parseAddressList = (hdr: string | undefined): string[] => {
      if (!hdr) return []
      return hdr
        .split(',')
        .map((item) => {
          const decoded = decodeRfc2047(item).trim()
          const angle = /<([^>]+)>/.exec(decoded)
          return (angle ? angle[1]! : decoded).trim().toLowerCase()
        })
        .filter(Boolean)
    }

    const fromDecoded = decodeRfc2047(topHeaders['from'] ?? '')
    const fromAngle = /<([^>]+)>/.exec(fromDecoded)
    const fromAddr = (fromAngle ? fromAngle[1]! : fromDecoded).trim().toLowerCase()

    return {
      headers: topHeaders,
      messageId: topHeaders['message-id']?.trim() ?? null,
      from: fromAddr,
      to: parseAddressList(topHeaders['to']),
      cc: parseAddressList(topHeaders['cc']),
      subject: decodeRfc2047(topHeaders['subject'] ?? ''),
      date: topHeaders['date'] ?? null,
      textBody,
      rawHtmlBody,
      sanitizedHtmlBody: sanitizeReport.sanitizedHtml,
      sanitizeReport,
      attachments,
      inlineCidMap,
    }
  }
}
