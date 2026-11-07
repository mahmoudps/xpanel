import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, validateRemoteServiceIps } from '@xpanel/core'
import type { RemoteServiceIps } from '@xpanel/core'

/**
 * Remote Service IPs (cPanel WHM): remote SMTP servers that bypass the local Postfix connection and rate limits (never relay
 * permission: mynetworks is unchanged) and remote nameservers PowerDNS admits for zone transfers.
 */
export const REMOTE_SERVICE_IPS_STATE = 'extended/server/remote-service-ips.json'

/** The saved lists; null when nothing was ever saved, so the managed configuration keeps its defaults. */
export async function readRemoteServiceIps(rootDir: string): Promise<RemoteServiceIps | null> {
  let text: string
  try { text = await readFile(join(rootDir, REMOTE_SERVICE_IPS_STATE), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'the saved remote service IPs could not be read', { stateChanged: false })
  }
  try { return validateRemoteServiceIps(JSON.parse(text)) } catch { return fail('PRECONDITION_FAILED', 'the saved remote service IPs are invalid', { stateChanged: false, reason: 'remote_service_ips_invalid' }) }
}

/** The one allow-axfr-ips line: loopback, then the DNS cluster peers in their saved order, then remote nameservers not already listed. */
export function renderAllowAxfrIps(peers: readonly string[], remoteNameservers: readonly string[]): string {
  const listed = ['127.0.0.0/8', '::1', ...peers]
  return `allow-axfr-ips=${[...listed, ...[...remoteNameservers].sort().filter(address => !listed.includes(address))].join(',')}`
}
