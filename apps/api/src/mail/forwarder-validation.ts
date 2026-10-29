import { fail, validateDomainName } from '@xpanel/core'

/** A conservative mailbox grammar; transport commands and display names are never configuration addresses. */
export const canonicalForwarderAddress = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return fail('VALIDATION', 'A valid mailbox address is required')
  const address = value.trim().toLowerCase()
  if (address.length > 254 || /\s/u.test(address)) return fail('VALIDATION', 'A valid mailbox address is required')
  const parts = address.split('@')
  const local = parts[0] ?? ''
  const domain = parts[1] ?? ''
  if (parts.length !== 2 || local.length > 64 || !/^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/.test(local) || !domain.includes('.') || domain.length > 253) return fail('VALIDATION', 'A valid mailbox address is required')
  validateDomainName(domain)
  return address
}

export const validateForwarderInput = (input: unknown): { sourceAddress: string; destinations: string[]; accountId?: string } => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('VALIDATION', 'A forwarder object is required')
  const body = input as Record<string, unknown>
  if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId)) return fail('VALIDATION', 'accountId must be a string')
  const sourceAddress = canonicalForwarderAddress(body.sourceAddress)
  const values = body.destinations !== undefined ? body.destinations : body.destination !== undefined ? [body.destination] : []
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) return fail('VALIDATION', 'Between 1 and 100 destinations are required')
  const destinations = [...new Set(values.map(canonicalForwarderAddress))]
  if (destinations.includes(sourceAddress)) return fail('VALIDATION', 'A forwarder cannot target its own source address')
  return { sourceAddress, destinations, ...(body.accountId === undefined ? {} : { accountId: body.accountId as string }) }
}
