import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { opensslRequestArgv, parseStoreCertificate, parseStoreCsr, parseStoreKey, requestConfig } from './ssl-store.ts'

// The reviewed `openssl req` tail against the host's real openssl, run as this unprivileged test user in a scratch home.
const run = promisify(execFile)
describe.skipIf(!existsSync('/usr/bin/openssl'))('openssl req grammar on this host', () => {
  it('writes a CSR and a non-CA self-signed certificate signed by the stored key with the requested names', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ssl-store-'))
    try {
      await mkdir(join(home, 'ssl/keys'), { recursive: true, mode: 0o700 })
      const key = parseStoreKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
      await writeFile(join(home, 'ssl/keys/k1.key'), key.pem, { mode: 0o600 })
      const request = { names: ['example.test', '*.example.test'], subject: { organization: 'شركة المثال', country: 'SA', email: 'admin@example.test' } }
      const exec = async (days: number | null, config: string | null = null) => { const [binary, ...args] = opensslRequestArgv('ssl/keys/k1.key', request, days, config); return (await run(binary!, args, { cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home } })).stdout }
      const csr = parseStoreCsr(await exec(null))
      expect(csr.item).toMatchObject({ commonName: 'example.test', names: request.names, publicKeySha256: key.item.publicKeySha256 })
      const certificate = parseStoreCertificate(await exec(30))
      expect(certificate.item).toMatchObject({ commonName: 'example.test', names: request.names, selfSigned: true, publicKeySha256: key.item.publicKeySha256 })
      expect(certificate.certificate.ca).toBe(false)
      expect(certificate.certificate.subject).toContain('O=شركة المثال')
      // A challenge passphrase reaches openssl only through the 0600 request file, which also carries the subject.
      await writeFile(join(home, 'ssl/.req-0123456789abcdef.cnf'), requestConfig({ ...request, subject: { ...request.subject, organization: "O'Neil & Sons" } }, 'p#ss$w"rd'), { mode: 0o600 })
      const protectedCsr = await exec(null, 'ssl/.req-0123456789abcdef.cnf')
      expect(parseStoreCsr(protectedCsr).item).toMatchObject({ commonName: 'example.test', names: request.names })
      const decoded = await new Promise<string>((resolve, reject) => { const child = execFile('/usr/bin/openssl', ['req', '-noout', '-text'], (error, stdout) => error ? reject(error) : resolve(stdout)); child.stdin!.end(protectedCsr) })
      expect(decoded).toContain('challengePassword')
      expect(decoded).toContain('p#ss$w"rd')
      expect(decoded).toMatch(/O ?= ?O'Neil & Sons/)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
