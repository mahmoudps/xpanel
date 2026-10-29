import { describe, expect, it } from 'vitest'
import { applicationDigest, isApplicationArtifactPath, isVerifiedApplicationArtifact, verifyApplicationArtifact } from './application-artifact.ts'

const file = (path: string, content = '<?php echo "ok";') => ({ path, sha256: applicationDigest(content), bytes: Buffer.byteLength(content), mode: '0644', contentBase64: Buffer.from(content).toString('base64') })
const bundle = (files = [file('index.php')], extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'sample', version: '1.2.3', files, ...extra }))
const read = (bytes: Buffer) => verifyApplicationArtifact(bytes, { format: 'xpanel-files-v1', sha256: applicationDigest(bytes), bytes: bytes.length }, 'sample', '1.2.3')

describe('content-addressed application file artifacts', () => {
  it('verifies every byte and returns immutable metadata with private defensive content copies', () => {
    const verified = read(bundle())
    expect(isVerifiedApplicationArtifact(verified)).toBe(true)
    expect(isVerifiedApplicationArtifact({ ...verified })).toBe(false)
    expect(Object.isFrozen(verified) && Object.isFrozen(verified.files) && Object.isFrozen(verified.files[0])).toBe(true)
    const first = verified.readFile('index.php'); first[0] = 0
    expect(Buffer.from(verified.readFile('index.php')).toString()).toBe('<?php echo "ok";')
    expect(() => verified.readFile('../root')).toThrow()
  })
  it.each(['/etc/passwd', '../a', 'a/../b', './index.php', 'a//b', 'a\\b', 'a/.git/config', '.ssh/key', 'C:/root', 'a\u0000b', '', 'a/'.repeat(121)])('refuses unconfined artifact path %j', path => {
    expect(isApplicationArtifactPath(path)).toBe(false)
    expect(() => read(bundle([file(path)]))).toThrow()
  })
  it('refuses aliases, directory/file conflicts, unsigned modes/types, extra fields and ambiguous JSON', () => {
    for (const files of [[file('a'), file('a')], [file('A'), file('a')], [file('a'), file('a/b')], [file('b'), file('a')], [{ ...file('index.php'), mode: '0755' }], [{ ...file('index.php'), type: 'symlink', target: '/root' }]]) expect(() => read(bundle(files))).toThrow()
    expect(() => read(bundle(undefined, { url: 'https://untrusted.invalid/app.tgz' }))).toThrow()
    expect(() => read(Buffer.from(bundle().toString().replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1')))).toThrow()
    expect(() => read(Buffer.from(' ' + bundle().toString()))).toThrow()
  })
  it('rejects wrong total/file digest, size, identity, noncanonical base64 and malformed UTF-8', () => {
    const bytes = bundle()
    for (const descriptor of [{ format: 'xpanel-files-v1' as const, sha256: '0'.repeat(64), bytes: bytes.length }, { format: 'xpanel-files-v1' as const, sha256: applicationDigest(bytes), bytes: bytes.length + 1 }]) expect(() => verifyApplicationArtifact(bytes, descriptor, 'sample', '1.2.3')).toThrow()
    for (const files of [[{ ...file('a'), sha256: '0'.repeat(64) }], [{ ...file('a'), bytes: 999 }], [{ ...file('a'), contentBase64: 'YQ' }]]) expect(() => read(bundle(files))).toThrow()
    expect(() => read(bundle(undefined, { appId: 'other' }))).toThrow()
    expect(() => read(Buffer.from([0xff]))).toThrow()
    expect(() => read(bundle([]))).toThrow()
  })
})
