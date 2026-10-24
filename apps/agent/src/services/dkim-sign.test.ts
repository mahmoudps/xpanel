import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from '../executor.ts'
import { signMailboxSubmission, signSubmittedMime, verifySignedMime } from './dkim-sign.ts'

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
  })
})
