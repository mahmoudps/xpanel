import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from '../executor.ts'
import { createSignRateLimit, signMailboxSubmission, signSubmittedMime, submissionFromDomains, verifySignedMime } from './dkim-sign.ts'

const mime = [
  'From: a@demo.example.test',
  'To: b@demo.example.test',
  'Subject: hi',
  'Date: Sat, 24 Oct 2026 00:00:00 +0000',
  'Message-ID: <1@demo.example.test>',
  '',
  'Hello',
  '',
].join('\r\n')

describe('submitted DKIM signature', () => {
  it('prepends a signature that verifies with the domain key', () => {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const signed = signSubmittedMime(mime, 'Demo.Example.Test', 'xp202610', pair.privateKey, new Date('2026-10-24T00:00:00.000Z'))
    expect(signed.startsWith('DKIM-Signature:')).toBe(true)
    expect(signed).toContain('s=xp202610')
    expect(signed).toContain('d=demo.example.test')
    expect(signed).toContain('a=rsa-sha256')
    expect(verifySignedMime(signed, pair.publicKey)).toBe(true)
    expect(verifySignedMime(mime, pair.publicKey)).toBe(false)
  })

  it('signs from the on-disk selector and private key', async () => {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const executor = new FakeHostExecutor()
    const signing = {
      domains: {
        'demo.example.test': { selector: 'xp202610', publicKeyPem: pair.publicKey, dnsTxt: 'v=DKIM1; k=rsa; p=abc' },
      },
    }
    executor.files.set('/etc/opendkim/signing.json', {
      path: '/etc/opendkim/signing.json',
      content: `${JSON.stringify(signing)}\n`,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
    executor.files.set('/etc/opendkim/keys/demo.example.test/xp202610.private', {
      path: '/etc/opendkim/keys/demo.example.test/xp202610.private',
      content: pair.privateKey,
      mode: 0o600,
      owner: 'opendkim',
      group: 'opendkim',
    })
    const signed = await signMailboxSubmission(executor, 'a@demo.example.test', mime)
    expect(signed?.includes('DKIM-Signature:')).toBe(true)
    expect(verifySignedMime(signed ?? '', pair.publicKey)).toBe(true)
    expect(await signMailboxSubmission(executor, 'a@other.example.test', mime)).toBeNull()
    const foreign = mime.replace('From: a@demo.example.test', 'From: a@foreign.example')
    expect(await signMailboxSubmission(executor, 'a@demo.example.test', foreign)).toBeNull()
    const mixed = mime.replace('From: a@demo.example.test', 'From: a@foreign.example, b@demo.example.test')
    expect(submissionFromDomains(mixed)).toEqual(['foreign.example', 'demo.example.test'])
    expect(await signMailboxSubmission(executor, 'a@demo.example.test', mixed)).toBeNull()
    const secondFrom = mime.replace(
      'From: a@demo.example.test',
      'From: a@demo.example.test\r\nFrom: b@foreign.example',
    )
    expect(submissionFromDomains(secondFrom)).toBeNull()
    expect(await signMailboxSubmission(executor, 'a@demo.example.test', secondFrom)).toBeNull()
    const quoted = mime.replace('From: a@demo.example.test', 'From: "Doe, Jane" <a@demo.example.test>')
    const quotedSigned = await signMailboxSubmission(executor, 'a@demo.example.test', quoted)
    expect(quotedSigned?.includes('DKIM-Signature:')).toBe(true)
    expect(verifySignedMime(quotedSigned ?? '', pair.publicKey)).toBe(true)
  })

  it('refuses the 31st signature inside one minute', () => {
    const allow = createSignRateLimit(2, 60_000)
    expect(allow('acc', 1_000)).toBe(true)
    expect(allow('acc', 1_500)).toBe(true)
    expect(allow('acc', 2_000)).toBe(false)
    expect(allow('other', 2_000)).toBe(true)
    expect(allow('acc', 61_001)).toBe(true)
  })

  it('drops an account that has gone quiet', () => {
    const allow = createSignRateLimit(2, 60_000)
    expect(allow('quiet', 1_000)).toBe(true)
    expect(allow.size()).toBe(1)
    expect(allow('other', 70_000)).toBe(true)
    expect(allow.size()).toBe(1)
  })
})
