import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { OS_RELEASE_PATHS, detectOs, profileFor, readOsRelease } from './detect.ts'
import { parseOsRelease } from './osRelease.ts'
import { SUPPORTED_OS, classifyRelease } from './support.ts'
import { SUPPORTED_FIXTURES, UBUNTU_2204, UBUNTU_2404, UNSUPPORTED_FIXTURES } from './fixtures.ts'

const error = (fn: () => unknown): XpanelError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof XpanelError) return e
    throw e
  }
  throw new Error('expected an XpanelError')
}

const expected: Record<keyof typeof SUPPORTED_FIXTURES, [string, string, string, number, 'apt' | 'dnf']> = {
  'ubuntu 22.04': ['ubuntu', '22.04', 'debian', 22, 'apt'],
  'ubuntu 24.04': ['ubuntu', '24.04', 'debian', 24, 'apt'],
  'centos stream 9': ['centos', '9', 'rhel', 9, 'dnf'],
  'centos stream 10': ['centos', '10', 'rhel', 10, 'dnf'],
  'almalinux 9': ['almalinux', '9.4', 'rhel', 9, 'dnf'],
  'almalinux 10': ['almalinux', '10.0', 'rhel', 10, 'dnf'],
  'rocky 9': ['rocky', '9.4', 'rhel', 9, 'dnf'],
  'rocky 10': ['rocky', '10.0', 'rhel', 10, 'dnf'],
}

describe('profileFor', () => {
  for (const [name, text] of Object.entries(SUPPORTED_FIXTURES)) {
    it(`supports ${name}`, () => {
      const [id, versionId, family, major, pm] = expected[name as keyof typeof SUPPORTED_FIXTURES]
      const p = profileFor(parseOsRelease(text))
      expect([p.id, p.versionId, p.family, p.major, p.packageManager]).toEqual([id, versionId, family, major, pm])
    })
  }

  for (const [name, text] of Object.entries(UNSUPPORTED_FIXTURES)) {
    it(`stops on ${name} with UNSUPPORTED_OS`, () => {
      const e = error(() => profileFor(parseOsRelease(text)))
      expect(e.code).toBe('UNSUPPORTED_OS')
      expect(e.status).toBe(409)
    })
  }

  it('names CentOS Linux 7 as end-of-life', () => {
    expect(error(() => profileFor(UNSUPPORTED_FIXTURES['centos linux 7'])).message).toMatch(/CentOS Linux 7/)
  })

  it('does not follow ID_LIKE to a supported parent', () => {
    expect(error(() => profileFor('ID=pop\nID_LIKE="ubuntu debian"\nVERSION_ID="22.04"')).code).toBe('UNSUPPORTED_OS')
  })

  it('accepts raw os-release text', () => {
    expect(profileFor(UBUNTU_2204).codename).toBe('jammy')
  })

  it('rejects unknown, empty or garbage releases', () => {
    for (const text of ['', 'garbage', 'ID=ubuntu', 'ID=ubuntu\nVERSION_ID=22.10', 'ID=ubuntu\nVERSION_ID=26.04', 'ID=Ubuntu\nVERSION_ID=22.04']) {
      expect(error(() => profileFor(text)).code).toBe('UNSUPPORTED_OS')
    }
  })

  it('is strict about EL version shapes', () => {
    for (const v of ['9.0', '9.4', '11', '9a', ' 9', '9 ']) {
      expect(error(() => profileFor(`ID=centos\nVERSION_ID="${v}"`)).code).toBe('UNSUPPORTED_OS')
    }
    for (const v of ['9', '9.10', '10.1']) expect(profileFor(`ID=rocky\nVERSION_ID="${v}"`).family).toBe('rhel')
    for (const v of ['8', '8.10', '11.0', '9.', '9.1.2', '9.1234']) {
      expect(error(() => profileFor(`ID=almalinux\nVERSION_ID="${v}"`)).code).toBe('UNSUPPORTED_OS')
    }
  })

  it('rejects contradictory codename or platform fields', () => {
    expect(error(() => profileFor('ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=noble')).code).toBe('UNSUPPORTED_OS')
    expect(error(() => profileFor('ID=rocky\nVERSION_ID="9.4"\nPLATFORM_ID="platform:el10"')).code).toBe('UNSUPPORTED_OS')
  })

  it('rejects a malformed release object', () => {
    expect(error(() => profileFor(null as never)).code).toBe('UNSUPPORTED_OS')
    expect(error(() => profileFor({ id: 1 } as never)).code).toBe('UNSUPPORTED_OS')
    expect(error(() => classifyRelease({ id: 'ubuntu', versionId: 22.04 } as never)).code).toBe('UNSUPPORTED_OS')
  })

  it('truncates hostile values in error detail', () => {
    const e = error(() => profileFor(`ID=${'x'.repeat(500)}`))
    expect(String(e.detail.id).length).toBeLessThanOrEqual(64)
  })

  it('publishes a frozen support matrix', () => {
    expect(SUPPORTED_OS.map(e => e.id)).toEqual(['ubuntu', 'centos', 'almalinux', 'rocky'])
    expect(Object.isFrozen(SUPPORTED_OS)).toBe(true)
    expect(Object.isFrozen(SUPPORTED_OS[0]!.versions)).toBe(true)
  })
})

describe('detectOs', () => {
  const enoent = (path: string): never => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
  }

  it('reads /etc/os-release first', () => {
    const seen: string[] = []
    const p = detectOs(path => {
      seen.push(path)
      return path === '/etc/os-release' ? UBUNTU_2404 : UBUNTU_2204
    })
    expect(p.versionId).toBe('24.04')
    expect(seen).toEqual(['/etc/os-release'])
  })

  it('falls back to /usr/lib/os-release when /etc is missing', () => {
    const seen: string[] = []
    const p = detectOs(path => {
      seen.push(path)
      return path === '/usr/lib/os-release' ? UBUNTU_2204 : enoent(path)
    })
    expect(p.versionId).toBe('22.04')
    expect(seen).toEqual([...OS_RELEASE_PATHS])
  })

  it('treats null and undefined as missing', () => {
    expect(detectOs(path => (path === '/usr/lib/os-release' ? UBUNTU_2204 : null)).id).toBe('ubuntu')
    expect(detectOs(path => (path === '/usr/lib/os-release' ? UBUNTU_2204 : undefined)).id).toBe('ubuntu')
  })

  it('stops with UNSUPPORTED_OS when neither file exists', () => {
    const e = error(() => detectOs(enoent))
    expect(e.code).toBe('UNSUPPORTED_OS')
    expect(e.detail.tried).toEqual(['/etc/os-release', '/usr/lib/os-release'])
    expect((e.detail.errors as string[]).length).toBe(2)
  })

  it('does not fall back when /etc/os-release exists but is unsupported', () => {
    expect(error(() => detectOs(path => (path === '/etc/os-release' ? UNSUPPORTED_FIXTURES['debian 12'] : UBUNTU_2404))).code)
      .toBe('UNSUPPORTED_OS')
  })

  it('falls back when a path component of /etc/os-release is not a directory (ENOTDIR)', () => {
    const enotdir = (path: string): never => {
      throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: 'ENOTDIR' })
    }
    expect(detectOs(path => (path === '/usr/lib/os-release' ? UBUNTU_2404 : enotdir(path))).versionId).toBe('24.04')
  })

  it('stops instead of falling back when /etc/os-release exists but cannot be read', () => {
    for (const code of ['EACCES', 'EISDIR', 'EIO', undefined]) {
      const seen: string[] = []
      const e = error(() => detectOs(path => {
        seen.push(path)
        if (path === '/usr/lib/os-release') return UBUNTU_2404
        throw Object.assign(new Error(`${code ?? 'boom'}: open '${path}'`), code === undefined ? {} : { code })
      }))
      expect(e.code).toBe('UNSUPPORTED_OS')
      expect(e.detail.path).toBe('/etc/os-release')
      expect(seen).toEqual(['/etc/os-release'])
    }
    expect(error(() => detectOs(() => {
      throw 'not an error object'
    })).detail.error).toBe('read failed')
  })

  it('ignores non-string reader results', () => {
    expect(error(() => readOsRelease(() => 42 as unknown as string)).code).toBe('UNSUPPORTED_OS')
  })
})
