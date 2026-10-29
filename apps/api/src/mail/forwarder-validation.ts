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

export type ForwarderAction = 'forward' | 'reject'

export interface ForwarderInput { sourceAddress: string; action: ForwarderAction; destinations: string[]; rejectMessage?: string; accountId?: string }

/** Postfix access(5) text after "REJECT 5.1.1": one line of printable ASCII. */
export const canonicalRejectMessage = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[ -~]{1,200}$/.test(text)) return fail('VALIDATION', 'The rejection message must be 1 to 200 printable ASCII characters')
  return text
}

export const validateForwarderInput = (input: unknown): ForwarderInput => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('VALIDATION', 'A forwarder object is required')
  const body = input as Record<string, unknown>
  if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId)) return fail('VALIDATION', 'accountId must be a string')
  const sourceAddress = canonicalForwarderAddress(body.sourceAddress)
  const accountId = body.accountId === undefined ? {} : { accountId: body.accountId as string }
  if (body.action !== undefined && body.action !== 'forward' && body.action !== 'reject') return fail('VALIDATION', 'action must be forward or reject')
  if (body.action === 'reject') {
    if (body.destinations !== undefined || body.destination !== undefined) return fail('VALIDATION', 'A rejecting forwarder has no destinations')
    return { sourceAddress, action: 'reject', destinations: [], rejectMessage: canonicalRejectMessage(body.rejectMessage), ...accountId }
  }
  if (body.rejectMessage !== undefined) return fail('VALIDATION', 'rejectMessage is only valid when action is reject')
  const values = body.destinations !== undefined ? body.destinations : body.destination !== undefined ? [body.destination] : []
  if (!Array.isArray(values) || values.length === 0 || values.length > 50) return fail('VALIDATION', 'Between 1 and 50 destinations are required')
  const destinations = [...new Set(values.map(canonicalForwarderAddress))]
  if (destinations.includes(sourceAddress)) return fail('VALIDATION', 'A forwarder cannot target its own source address')
  return { sourceAddress, action: 'forward', destinations, ...accountId }
}
