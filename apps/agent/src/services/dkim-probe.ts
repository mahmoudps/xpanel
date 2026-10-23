import { spawnSync } from 'node:child_process'
import { OPENDKIM_SOCKET_PATH } from './opendkim-live.ts'

export type DkimProbeStatus = 'signing' | 'refused' | 'unknown'

/** Exit status of a postfix-uid connect. A missing uid is unknown, not a refusal. */
export const dkimProbeFromExit = (code: number | null, uidKnown: boolean): DkimProbeStatus => {
  if (!uidKnown || code === null) return 'unknown'
  return code === 0 ? 'signing' : 'refused'
}

/**
 * Connects to the chroot socket as the postfix user. A milter line in main.cf
 * is not a connection: smtpd runs chrooted and a refused socket stays refused.
 */
export const probeOpenDkimAsPostfix = (): DkimProbeStatus => {
  const id = spawnSync('/usr/bin/id', ['-u', 'postfix'], { encoding: 'utf8', timeout: 1500 })
  const uid = Number((id.stdout ?? '').trim())
  if (id.status !== 0 || !Number.isInteger(uid) || uid < 0) return 'unknown'
  const script = [
    "const net = require('node:net')",
    `const socket = net.connect(${JSON.stringify(OPENDKIM_SOCKET_PATH)})`,
    'const timer = setTimeout(() => { socket.destroy(); process.exit(2) }, 1500)',
    "socket.on('connect', () => { clearTimeout(timer); socket.end(); process.exit(0) })",
    "socket.on('error', () => { clearTimeout(timer); process.exit(1) })",
  ].join('; ')
  const probed = spawnSync(process.execPath, ['-e', script], { uid, timeout: 4000, encoding: 'utf8' })
  if (probed.error) return 'unknown'
  return dkimProbeFromExit(probed.status, true)
}
