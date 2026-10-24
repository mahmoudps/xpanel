import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { OPENDKIM_SOCKET_PATH } from './opendkim-live.ts'

export type DkimProbeStatus = 'signing' | 'refused' | 'unknown'

export interface DkimProbeOutcome {
  status: DkimProbeStatus
  selector?: string
}

/** Exit status of a postfix connect. A missing uid is unknown, not a refusal. */
export const dkimProbeFromExit = (code: number | null, uidKnown: boolean): DkimProbeStatus => {
  if (!uidKnown || code === null) return 'unknown'
  return code === 0 ? 'signing' : 'refused'
}

const signingLine = (line: string): boolean =>
  /DKIM-Signature (?:field|header) added/i.test(line) || /opendkim\[\d+\].*DKIM-Signature/i.test(line)

const refusedLine = (line: string): boolean =>
  /milter/i.test(line) && /permission denied|connection refused|no such file/i.test(line)

/**
 * Last matching mail-log line wins. A later successful signature replaces an
 * older milter refusal, and the reverse.
 */
export const dkimOutcomeFromMailLog = (text: string): DkimProbeOutcome | null => {
  let found: DkimProbeOutcome | null = null
  for (const line of text.split('\n')) {
    if (signingLine(line)) {
      const selector = /\bs=([A-Za-z0-9._-]+)/.exec(line)?.[1]
      found = selector ? { status: 'signing', selector } : { status: 'signing' }
    } else if (refusedLine(line)) {
      found = { status: 'refused' }
    }
  }
  return found
}

const readTail = (path: string, bytes = 512 * 1024): string => {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, Math.max(0, size - length))
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

const connectScript = [
  "const net = require('node:net')",
  `const socket = net.connect(${JSON.stringify(OPENDKIM_SOCKET_PATH)})`,
  'const timer = setTimeout(() => { socket.destroy(); process.exit(2) }, 1500)',
  "socket.on('connect', () => { clearTimeout(timer); socket.end(); process.exit(0) })",
  "socket.on('error', () => { clearTimeout(timer); process.exit(1) })",
].join('; ')

/** Connects as postfix through runuser so supplementary groups (opendkim) are set. */
const probeOpenDkimViaRunuser = (): DkimProbeStatus => {
  for (const bin of ['/usr/sbin/runuser', '/usr/bin/runuser']) {
    const probed = spawnSync(bin, ['-u', 'postfix', '--', process.execPath, '-e', connectScript], {
      timeout: 4000,
      encoding: 'utf8',
    })
    if (probed.error && (probed.error as NodeJS.ErrnoException).code === 'ENOENT') continue
    if (probed.error) return 'unknown'
    return dkimProbeFromExit(probed.status, true)
  }
  return 'unknown'
}

/**
 * The label follows the last signed or refused line in the mail log. When the
 * log has neither, a runuser connect reports the live socket. A uid-only spawn
 * is not used: it lacks the opendkim group and reports refused while signing works.
 */
export const probeDkimOutcome = (): DkimProbeOutcome => {
  const logged = dkimOutcomeFromMailLog(`${readTail('/var/log/mail.log')}\n${readTail('/var/log/maillog')}`)
  if (logged) return logged
  return { status: probeOpenDkimViaRunuser() }
}
