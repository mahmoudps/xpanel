import { resolve4 } from 'node:dns/promises'

/** Where a new domain points now. A resolver that cannot answer proves nothing, so it never refuses a domain. */
export async function observeDomainResolution(name: string, localAddresses: readonly string[], resolve: (name: string) => Promise<string[]> = resolve4): Promise<'here' | 'elsewhere' | 'unregistered' | 'unknown'> {
  try {
    const addresses = await resolve(name)
    return addresses.some(address => localAddresses.includes(address)) ? 'here' : 'elsewhere'
  } catch (error) {
    return ['ENOTFOUND', 'ENODATA'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'unregistered' : 'unknown'
  }
}
