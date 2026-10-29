import { createHash } from 'node:crypto'
import { fail } from './errors.ts'
import { assertEmail } from './schemas.ts'
import type { Account } from './types.ts'

/** A current-value representation tag; changing a value away and back restores its tag. */
export const accountContactRevision = (
  account: Pick<Account, 'id' | 'contactEmail' | 'planId' | 'ownerId' | 'status' | 'createdAt'>,
): string => createHash('sha256').update(JSON.stringify({
  id: account.id,
  contactEmail: assertEmail(account.contactEmail, 'contactEmail'),
  planId: account.planId,
  ownerId: account.ownerId,
  status: account.status,
  createdAt: account.createdAt,
}), 'utf8').digest('hex')

export const assertAccountContactRevision = (value: unknown): string => {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) {
    return fail('VALIDATION', 'invalid account contact revision', { what: 'accountContactRevision' })
  }
  return value
}
