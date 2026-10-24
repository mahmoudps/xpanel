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

/** Signs with the domain key from signing.json. Returns null when the key or selector is missing. */
export const signMailboxSubmission = async (
  executor: AgentExecutor,
  mailbox: string,
  rawMime: string,
): Promise<string | null> => {
  const at = mailbox.lastIndexOf('@')
  if (at <= 0) return null
  let domain = ''
  try {
    domain = services.normalizeHostname(mailbox.slice(at + 1), 'DKIM domain')
  } catch {
    return null
  }
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
