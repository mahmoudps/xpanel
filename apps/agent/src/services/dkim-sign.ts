import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'
import { parseOpenDkimSigning } from './opendkim-live.ts'

const SIGNING_PATH = '/etc/opendkim/signing.json'

const canonicalizeHeaderRelaxed = (name: string, value: string): string => {
  const cleanName = name.trim().toLowerCase()
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ')
  const collapsed = unfolded.replace(/[ \t]+/g, ' ').trim()
  return `${cleanName}:${collapsed}`
}

const canonicalizeBodyRelaxed = (body: string): string => {
  const normalized = body.replace(/\r?\n/g, '\r\n')
  const lines = normalized.split('\r\n').map(line => line.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' '))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length === 0 ? '\r\n' : `${lines.join('\r\n')}\r\n`
}

const headerMapOf = (headerBlock: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const line of headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim().toLowerCase()
    if (!map.has(name)) map.set(name, line.slice(idx + 1).trim())
  }
  return map
}

/**
 * Prepends an rsa-sha256 relaxed/relaxed DKIM-Signature. The signature uses the
 * on-disk domain key, the same key OpenDKIM publishes in DNS.
 */
export const signSubmittedMime = (
  rawMime: string,
  domain: string,
  selector: string,
  privatePem: string,
  now = new Date(),
): string => {
  const normDomain = services.normalizeHostname(domain, 'DKIM domain')
  services.assertDkimSelector(selector)
  const normalizedMime = rawMime.replace(/\r?\n/g, '\r\n')
  const splitIdx = normalizedMime.indexOf('\r\n\r\n')
  const rawHeaderBlock = splitIdx >= 0 ? normalizedMime.slice(0, splitIdx) : normalizedMime
  const rawBody = splitIdx >= 0 ? normalizedMime.slice(splitIdx + 4) : ''
  const bodyHash = createHash('sha256').update(canonicalizeBodyRelaxed(rawBody), 'utf8').digest('base64')
  const headerMap = headerMapOf(rawHeaderBlock)
  const signedHeaderNames = ['from', 'to', 'subject', 'date', 'message-id'].filter(name => headerMap.has(name))
  const timestamp = Math.floor(now.getTime() / 1000)
  const dkimValueWithoutB = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${normDomain}; s=${selector}; t=${timestamp}; bh=${bodyHash}; h=${signedHeaderNames.join(':')}; b=`
  const canonHeaders = [
    ...signedHeaderNames.map(name => canonicalizeHeaderRelaxed(name, headerMap.get(name)!)),
    canonicalizeHeaderRelaxed('dkim-signature', dkimValueWithoutB),
  ].join('\r\n')
  const signature = sign('sha256', Buffer.from(canonHeaders, 'utf8'), createPrivateKey(privatePem)).toString('base64')
  return `DKIM-Signature: ${dkimValueWithoutB}${signature}\r\n${normalizedMime}`
}

/** True when the prepended signature verifies against the domain public key. */
export const verifySignedMime = (signedMime: string, publicPem: string): boolean => {
  const normalized = signedMime.replace(/\r?\n/g, '\r\n')
  const splitIdx = normalized.indexOf('\r\n\r\n')
  if (splitIdx < 0) return false
  const headerBlock = normalized.slice(0, splitIdx)
  const body = normalized.slice(splitIdx + 4)
  const lines = headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')
  const dkimLine = lines.find(line => line.toLowerCase().startsWith('dkim-signature:'))
  if (!dkimLine) return false
  const headerValue = dkimLine.slice(dkimLine.indexOf(':') + 1).trim()
  const bAt = headerValue.lastIndexOf('; b=')
  if (bAt < 0) return false
  const signature = headerValue.slice(bAt + 4).trim()
  const withoutB = headerValue.slice(0, bAt + 4)
  const tags = new Map<string, string>()
  for (const part of withoutB.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    tags.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim())
  }
  const signedNames = (tags.get('h') ?? '').split(':').map(name => name.trim().toLowerCase()).filter(Boolean)
  const rest = lines.filter(line => line !== dkimLine).join('\r\n')
  const headerMap = headerMapOf(rest)
  const bodyHash = createHash('sha256').update(canonicalizeBodyRelaxed(body), 'utf8').digest('base64')
  if (tags.get('bh') !== bodyHash) return false
  const canonHeaders = [
    ...signedNames.filter(name => headerMap.has(name)).map(name => canonicalizeHeaderRelaxed(name, headerMap.get(name)!)),
    canonicalizeHeaderRelaxed('dkim-signature', withoutB),
  ].join('\r\n')
  try {
    return verify('sha256', Buffer.from(canonHeaders, 'utf8'), createPublicKey(publicPem), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

const headerLines = (rawMime: string): string[] => {
  const normalized = rawMime.replace(/\r?\n/g, '\r\n')
  const split = normalized.indexOf('\r\n\r\n')
  const header = (split >= 0 ? normalized.slice(0, split) : normalized).replace(/\r\n[ \t]+/g, ' ')
  return header.split('\r\n').filter(line => line.length > 0)
}

const ATOM = /[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]/

/**
 * RFC 5322 mailbox-list. Every addr-spec is returned, including those inside a
 * group. Quoted display names keep their commas. Null means the list is not a
 * single parseable address list.
 */
const parseMailboxList = (input: string): string[] | null => {
  const addresses: string[] = []
  let i = 0
  const s = input

  const skipWs = (): void => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1
  }

  const skipComment = (): boolean => {
    if (s[i] !== '(') return true
    let depth = 0
    while (i < s.length) {
      const c = s[i]!
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') {
        depth -= 1
        i += 1
        if (depth === 0) return true
        continue
      }
      i += 1
    }
    return false
  }

  const skipCfws = (): boolean => {
    while (i < s.length) {
      skipWs()
      if (s[i] === '(') {
        if (!skipComment()) return false
        continue
      }
      break
    }
    return true
  }

  const readQuoted = (): string | null => {
    if (s[i] !== '"') return null
    i += 1
    let out = ''
    while (i < s.length) {
      const c = s[i]!
      if (c === '\\') {
        if (i + 1 >= s.length) return null
        out += s[i + 1]
        i += 2
        continue
      }
      if (c === '"') {
        i += 1
        return out
      }
      out += c
      i += 1
    }
    return null
  }

  const readDotAtom = (): string | null => {
    const atom = (): string | null => {
      const start = i
      while (i < s.length && ATOM.test(s[i]!)) i += 1
      return i > start ? s.slice(start, i) : null
    }
    const first = atom()
    if (!first) return null
    let out = first
    while (s[i] === '.') {
      i += 1
      const next = atom()
      if (!next) return null
      out += `.${next}`
    }
    return out
  }

  const readAddrSpec = (): string | null => {
    if (!skipCfws()) return null
    const local = s[i] === '"' ? readQuoted() : readDotAtom()
    if (!local) return null
    if (!skipCfws() || s[i] !== '@') return null
    i += 1
    if (!skipCfws()) return null
    let domain: string | null
    if (s[i] === '[') {
      const end = s.indexOf(']', i + 1)
      if (end < 0) return null
      domain = s.slice(i, end + 1)
      i = end + 1
    } else domain = readDotAtom()
    if (!domain || !skipCfws()) return null
    const address = `${local}@${domain}`.toLowerCase()
    return address.length <= 254 ? address : null
  }

  const readPhrase = (): boolean => {
    let saw = false
    while (i < s.length) {
      if (!skipCfws()) return false
      if (s[i] === '"') {
        if (readQuoted() === null) return false
        saw = true
        continue
      }
      if (s[i] && ATOM.test(s[i]!)) {
        if (!readDotAtom()) return false
        saw = true
        continue
      }
      break
    }
    return saw
  }

  const structural = (): { angle: boolean; at: boolean; colon: boolean } => {
    let j = i
    let inQuote = false
    let comment = 0
    while (j < s.length) {
      const c = s[j]!
      if (inQuote) {
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '"') inQuote = false
        j += 1
        continue
      }
      if (comment > 0) {
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '(') comment += 1
        else if (c === ')') comment -= 1
        j += 1
        continue
      }
      if (c === '"') {
        inQuote = true
        j += 1
        continue
      }
      if (c === '(') {
        comment += 1
        j += 1
        continue
      }
      if (c === '<') return { angle: true, at: false, colon: false }
      if (c === '@') return { angle: false, at: true, colon: false }
      if (c === ':') return { angle: false, at: false, colon: true }
      if (c === ',' || c === ';') break
      j += 1
    }
    return { angle: false, at: false, colon: false }
  }

  const readMailbox = (): boolean => {
    if (!skipCfws()) return false
    const shape = structural()
    if (shape.angle) {
      if (s[i] !== '<') readPhrase()
      if (!skipCfws() || s[i] !== '<') return false
      i += 1
      const addr = readAddrSpec()
      if (!addr || s[i] !== '>') return false
      i += 1
      if (!skipCfws()) return false
      addresses.push(addr)
      return true
    }
    if (!shape.at) return false
    const addr = readAddrSpec()
    if (!addr) return false
    addresses.push(addr)
    return true
  }

  const readGroupOrMailbox = (): boolean => {
    if (!skipCfws()) return false
    if (structural().colon) {
      if (!readPhrase() || !skipCfws() || s[i] !== ':') return false
      i += 1
      if (!skipCfws()) return false
      if (s[i] === ';') {
        i += 1
        return skipCfws()
      }
      while (i < s.length) {
        if (!readMailbox() || !skipCfws()) return false
        if (s[i] === ',') {
          i += 1
          continue
        }
        if (s[i] === ';') {
          i += 1
          return skipCfws()
        }
        return false
      }
      return false
    }
    return readMailbox()
  }

  if (!skipCfws() || i >= s.length) return null
  while (i < s.length) {
    if (!readGroupOrMailbox() || !skipCfws()) return null
    if (i >= s.length) break
    if (s[i] !== ',') return null
    i += 1
    if (!skipCfws() || i >= s.length) return null
  }
  return addresses.length > 0 ? addresses : null
}

/**
 * Domain of every mailbox in the single From header (RFC 5322 §3.6.2).
 * A missing From, a second From, or a mailbox that cannot be parsed returns null.
 */
export const submissionFromDomains = (rawMime: string): string[] | null => {
  const fromValues = headerLines(rawMime)
    .filter(line => /^from:/i.test(line))
    .map(line => line.slice(line.indexOf(':') + 1))
  if (fromValues.length !== 1) return null
  const addresses = parseMailboxList(fromValues[0]!)
  if (!addresses) return null
  const domains: string[] = []
  for (const address of addresses) {
    const at = address.lastIndexOf('@')
    if (at <= 0) return null
    try {
      domains.push(services.normalizeHostname(address.slice(at + 1), 'From domain'))
    } catch {
      return null
    }
  }
  return domains
}

/** The From domain when every mailbox in the one From header shares it. */
export const submissionFromDomain = (rawMime: string): string | null => {
  const domains = submissionFromDomains(rawMime)
  if (!domains || domains.length === 0) return null
  const domain = domains[0]!
  return domains.every(item => item === domain) ? domain : null
}

export interface SignRateLimit {
  (key: string, now?: number): boolean
  /** Accounts that still have a hit inside the window. Quiet keys are removed. */
  size(): number
}

/** Per-account window. The 31st call inside the window is refused. Quiet accounts leave the map. */
export const createSignRateLimit = (limit = 30, windowMs = 60_000): SignRateLimit => {
  const hits = new Map<string, number[]>()
  const allow = (key: string, now = Date.now()): boolean => {
    for (const [name, stamps] of hits) {
      const recent = stamps.filter(at => now - at < windowMs)
      if (recent.length === 0) hits.delete(name)
      else if (recent.length !== stamps.length) hits.set(name, recent)
    }
    const recent = hits.get(key) ?? []
    if (recent.length >= limit) return false
    recent.push(now)
    hits.set(key, recent)
    return true
  }
  return Object.assign(allow, { size: () => hits.size })
}

/**
 * Signs with the domain key from signing.json. Every mailbox in the one From
 * header must use that domain. A missing key, a second From, an unparseable
 * address, or any other domain returns null and does not produce a signature.
 */
export const signMailboxSubmission = async (
  executor: AgentExecutor,
  mailbox: string,
  rawMime: string,
  domainOverride?: string,
): Promise<string | null> => {
  const at = mailbox.lastIndexOf('@')
  if (at <= 0) return null
  const fromDomains = submissionFromDomains(rawMime)
  if (!fromDomains || fromDomains.length === 0) return null
  const fromDomain = fromDomains[0]!
  if (fromDomains.some(domain => domain !== fromDomain)) return null
  let domain = ''
  try {
    domain = domainOverride
      ? services.normalizeHostname(domainOverride, 'DKIM domain')
      : services.normalizeHostname(mailbox.slice(at + 1), 'DKIM domain')
  } catch {
    return null
  }
  if (fromDomain !== domain) return null
  const material = parseOpenDkimSigning(await executor.readFile(SIGNING_PATH)).domains[domain]
  if (!material) return null
  try {
    services.assertDkimSelector(material.selector)
  } catch {
    return null
  }
  const privatePem = await executor.readFile(`/etc/opendkim/keys/${domain}/${material.selector}.private`)
  if (!privatePem || !privatePem.includes('PRIVATE KEY')) return null
  try {
    const signed = signSubmittedMime(rawMime, domain, material.selector, privatePem)
    return signed.includes('DKIM-Signature:') ? signed : null
  } catch {
    return null
  }
}
