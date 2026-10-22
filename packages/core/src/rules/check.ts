// Internal guards shared by the rule modules. Not part of the public surface.
import { fail } from '../errors.ts'
import type { Limit } from '../types.ts'

export const invalid = (message: string, detail?: Record<string, unknown>): never =>
  fail('VALIDATION', message, detail)

export const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export const isLimit = (v: unknown, min = 0): v is Limit => v === 'unlimited' || isInt(v, min)

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Throws one VALIDATION error carrying every problem found, so the UI can show them together. */
export const throwIfErrors = (what: string, errors: string[]): void => {
  if (errors.length > 0) invalid(`invalid ${what}: ${errors.join('; ')}`, { errors })
}

/** C0/C1 controls, line separators, bidi embeddings/overrides/isolates and the BOM (display spoofing). */
export const hasControlChars = (s: string): boolean => /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(s)

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length
