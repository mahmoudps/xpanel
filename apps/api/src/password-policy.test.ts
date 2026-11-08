import { describe, expect, it } from 'vitest'
import { assertPasswordAllowed, defaultPasswordStrength, passwordAllowed, passwordStrength, requiredPasswordStrength, servicePasswordKinds, usePasswordStrengthPolicy, type PasswordService } from './password-policy.ts'
import { passwordHashFromInput } from './auth.ts'

const SERVICES: PasswordService[] = ['panel', 'mail', 'ftp', 'database', 'webdisk', 'directory']

describe('password policy', { tags: ['unit'] }, () => {
  it('keeps the 8-character rule for every service', () => {
    for (const service of SERVICES) {
      expect(assertPasswordAllowed('12345678', service)).toBe('12345678')
      expect([passwordAllowed('12345678', service), passwordAllowed('1234567', service)]).toEqual([true, false])
      expect(() => assertPasswordAllowed('1234567', service)).toThrow(/at least 8 characters/)
    }
  })

  it('scores strength from length and character classes, capped at 100', () => {
    expect([passwordStrength(''), passwordStrength('12345678'), passwordStrength('abcdefgh'), passwordStrength('aaaaaaaaaaaa'), passwordStrength('Xq7!kP2#mZ9$vL4@')]).toEqual([0, 26, 37, 4, 100])
    expect(passwordStrength('Passw0rd')).toBeLessThan(passwordStrength('Pa55w0rd!x'))
  })

  it('requires the saved strength of each service, falling back to the default', () => {
    try {
      usePasswordStrengthPolicy({ default: 30, perService: { ...defaultPasswordStrength().perService, mail: 70 } })
      expect([requiredPasswordStrength('mail'), requiredPasswordStrength('ftp')]).toEqual([70, 30])
      expect(() => assertPasswordAllowed('abcdefgh', 'mail')).toThrow(expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ reason: 'weak_password', strength: 37, required: 70 }) }))
      expect(assertPasswordAllowed('abcdefgh', 'ftp')).toBe('abcdefgh')
      expect(passwordAllowed('12345678', 'panel')).toBe(false)
      expect(passwordAllowed('Xq7!kP2#mZ9$vL4@', 'mail')).toBe(true)
    } finally { usePasswordStrengthPolicy(defaultPasswordStrength()) }
  })

  it('names the services a service user signs in to', () => {
    expect(servicePasswordKinds({ email: true, ftp: false, webdisk: true })).toEqual(['mail', 'webdisk'])
    expect(servicePasswordKinds({ email: false, ftp: true, webdisk: false })).toEqual(['ftp'])
    expect(servicePasswordKinds(undefined)).toEqual([])
    expect(servicePasswordKinds({ email: 'yes' })).toEqual([])
  })

  it('refuses a short or service-less password before hashing', async () => {
    await expect(passwordHashFromInput({ password: 'short' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(passwordHashFromInput({ password: 'short' }, { service: ['ftp'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(passwordHashFromInput({ password: 'long enough' }, { service: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
