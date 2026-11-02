import { describe, expect, it } from 'vitest'
import { readOsRelease } from './os-release.ts'

const reader = (files: Record<string, string | Error | null>) => ({
  async readFile(path: string) {
    const value = files[path] ?? null
    if (value instanceof Error) throw value
    return value
  },
})
const symlinkRefusal = Object.assign(new Error('ELOOP: too many symbolic links encountered'), { code: 'ELOOP' })

describe('os-release reader', () => {
  it('reads the vendor file when /etc/os-release is the usual symlink', async () => {
    await expect(readOsRelease(reader({ '/etc/os-release': symlinkRefusal, '/usr/lib/os-release': 'ID=ubuntu\n' }))).resolves.toBe('ID=ubuntu\n')
  })

  it('prefers a regular /etc/os-release and falls back when it is absent', async () => {
    await expect(readOsRelease(reader({ '/etc/os-release': 'ID=debian\n', '/usr/lib/os-release': 'ID=ubuntu\n' }))).resolves.toBe('ID=debian\n')
    await expect(readOsRelease(reader({ '/usr/lib/os-release': 'ID=almalinux\n' }))).resolves.toBe('ID=almalinux\n')
  })

  it('does not hide other read failures', async () => {
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    await expect(readOsRelease(reader({ '/etc/os-release': denied }))).rejects.toBe(denied)
  })
})
