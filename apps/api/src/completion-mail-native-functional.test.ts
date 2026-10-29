import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { ExtendedFeaturesStore } from './extended-routes.ts'
import { composeIdentityRevision } from './mail/compose-identity.ts'
import { MimeCodecAndSanitizer } from './mail/mime.ts'
import { SmtpSubmissionClient } from './mail/smtp.ts'
import type { MailboxSendInput, MailboxTransport } from './mail/inbox.ts'
import { createLocalMailboxTransport } from './mail/inbox.ts'
import { ImapProtocolClient } from './mail/imap.ts'
import type { MailSearchClient } from './mail/search-workspace.ts'
import type { ImapFetchedMessage, ImapSelectedMailboxState } from './mail/imap.ts'
import type { DraftIdentity, DraftTransport } from './mail/draft-workspace.ts'

// Actual loopback HTTP, real sealed login/cookies/CSRF and disposable state/database.
// Explicit trusted IMAP/SMTP/actual-byte ports isolate native services; no live-service qualification.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const ORIGIN = 'https://mail.example.test:2096'
const cleanup: Array<() => Promise<unknown>> = []
const codec = new MimeCodecAndSanitizer()
type Session = { cookie: string; csrf: string }
const draft = { to: 'reader@example.test', subject: 'NATIVE review', text: 'Actual native body' }

async function submissionFixture(password: string) {
  const sockets = new Set<net.Socket>(), submitted: string[] = []
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let buffer = '', data = false
    socket.write('220 declared-loopback.example ESMTP\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (data) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; submitted.push(buffer.slice(0,end)); buffer = buffer.slice(end+5); data=false; socket.write('250 queued as SYNTHETIC123\r\n'); continue }
        const end=buffer.indexOf('\r\n'); if(end<0)return
        const line=buffer.slice(0,end); buffer=buffer.slice(end+2)
        if (/^EHLO /i.test(line)) socket.write('250-declared-loopback.example\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) { const credentials=Buffer.from(line.slice(11),'base64').toString().split('\u0000'); socket.write(credentials.at(-1)===password ? '235 authenticated\r\n' : '535 refused\r\n') }
        else if (/^(?:MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n')
        else if (line==='DATA') { data=true; socket.write('354 end with dot\r\n') }
        else if (line==='QUIT') socket.end('221 bye\r\n')
        else socket.write('500 unsupported fixture command\r\n')
      }
    })
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanup.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))})
  return {port:(server.address() as net.AddressInfo).port,submitted}
}

async function fixture() {
  const secret = randomBytes(32).toString('hex'), password = randomBytes(24).toString('hex')
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Native functional mail', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Native functional mail', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 4, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.31', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.31', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await makeAccount('nativea'), foreignOwner = await makeAccount('nativeb')
  const mailbox = (accountId: string, local: string, domain: string) => state.store.createServiceUser({ accountId, login: local + '@' + domain, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await mailbox(owner.id, 'inbox', owner.primaryDomain), sibling = await mailbox(owner.id, 'support', owner.primaryDomain), foreign = await mailbox(foreignOwner.id, 'inbox', foreignOwner.primaryDomain)
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const submission = await submissionFixture(password)
  const sent: Array<{ mailbox: string; input: MailboxSendInput; mime: string }> = [], reads: string[] = [], downloads: string[] = [], searchLogins: string[] = []
  const moved: Array<{ uid:number;from:string;to:string;uidValidity:number }> = [], removed: Array<{uid:number;folder:string;uidValidity:number}> = []
  const drafts = new Map<string, Map<number, Buffer>>(), retired: Buffer[] = []
  let nextUid = 10, inboxValidity = 17, draftAppendFault = false, attachmentBytes: Buffer = Buffer.from([0, 255, 1, 2]), searchHook: (() => Promise<void>) | undefined, attachmentHook: (() => Promise<void>) | undefined
  const validity = (folder:string) => folder==='INBOX'?inboxValidity:folder==='Archive'?31:folder==='Trash'?41:51
  const transport: MailboxTransport = {
    async verify(address, submittedPassword) { if (submittedPassword !== password || ![inbox.login,sibling.login,foreign.login].includes(address)) fail('UNAUTHENTICATED', 'synthetic mailbox credentials refused') },
    async list() { return [] }, async read() { return fail('NOT_FOUND', 'not in the declared fixture') },
    async remove(address, submittedPassword, uid, folder='INBOX', options) {
      await this.verify(address,submittedPassword)
      if(options?.uidValidity!==validity(folder))return fail('CONFLICT','declared native UIDVALIDITY changed',{stateChanged:false})
      removed.push({uid,folder,uidValidity:options.uidValidity})
    },
    async move(address, submittedPassword, uid, from, to, options) {
      await this.verify(address,submittedPassword)
      if(options?.uidValidity!==validity(from))return fail('CONFLICT','declared native UIDVALIDITY changed',{stateChanged:false})
      moved.push({uid,from,to,uidValidity:options.uidValidity})
      return {uid:uid+100,uidValidity:validity(to),uidValidityObserved:true,sourceUidValidity:options.uidValidity,sourceUidValidityObserved:true}
    },
    async send(address, submittedPassword, input) {
      await this.verify(address, submittedPassword)
      const smtp = new SmtpSubmissionClient({host:'127.0.0.1',port:submission.port,starttls:false,timeoutMs:2000})
      const accepted = await smtp.submitMessage({username:address,password:submittedPassword},{idempotencyKey:input.idempotencyKey,authenticatedMailbox:address,from:address,fromName:input.fromName,replyTo:input.replyTo,
        to:input.to.split(',').map(value=>value.trim()).filter(Boolean),cc:input.cc,bcc:input.bcc,subject:input.subject,textBody:input.text,htmlBody:input.html,attachments:input.attachments})
      sent.push({ mailbox: address, input, mime: accepted.rawMime })
      return { messageId: accepted.messageId, savedToSent: false }
    },
  }
  const searchFactory = (): MailSearchClient => {
    let address = ''
    const selected = (folder: string): ImapSelectedMailboxState => ({ folder, exists: 1, recent: 0, uidValidity: 17, uidValidityObserved: true, uidNext: 8, flags: [], resynced: false, previousUidValidity: null })
    const fetched = (folder: string): ImapFetchedMessage => {
      const rawMime = 'From: sender@example.test\r\nTo: ' + address + '\r\nSubject: NATIVE ' + address + '\r\nDate: Mon, 26 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nNATIVE actual bytes for ' + address
      return { mailbox: address, folder, uid: 7, uidValidity: 17, flags: [], internalDate: null, sizeBytes: Buffer.byteLength(rawMime), rawMime, rawMimeBytes: Buffer.from(rawMime), rfc822SizeObserved: true, bodyComplete: true, parsed: codec.parseMimeMessage(rawMime), attachmentTokens: [] }
    }
    return { async connect() { return '* OK declared IMAP fixture' }, async logout() {}, async login(mailbox, submittedPassword) { await transport.verify(mailbox, submittedPassword); address = mailbox; searchLogins.push(mailbox); if (searchHook) await searchHook() },
      async selectFolder(folder) { return selected(folder) }, async searchByUtf8Query(_folder, query, mailbox) { expect(mailbox).toBe(address); return query.toUpperCase().includes('LEGACY') ? [] : [7] },
      async fetchMessagesByUid(folder, uid) { reads.push(address); return { state: selected(folder), messages: Number(uid) === 7 ? [fetched(folder)] : [] } },
    }
  }
  const draftTransport = (address: string): DraftTransport => {
    const rows = drafts.get(address) ?? new Map<number, Buffer>(); drafts.set(address, rows)
    return { async appendDraft(bytes, flags) { expect(flags).toEqual(['\\Draft']); const uid = ++nextUid; rows.set(uid, Buffer.from(bytes)); if(draftAppendFault)throw new Error('Declared lost APPEND acknowledgement'); return { appendedUid: uid, appendedUidValidity: 17 } },
      async observeDraft(uid) { const bytes = rows.get(uid); return { mailbox: address, folder: 'Drafts', uidValidity: 17, uidValidityObserved: true,
        message: bytes ? { mailbox: address, folder: 'Drafts', uid, uidValidity: 17, sizeBytes: bytes.byteLength, rfc822SizeObserved: true, bodyComplete: true, rawMimeBytes: bytes } : null } },
      async retireDraft(identity) { const bytes = rows.get(identity.uid); if (!bytes) return fail('NOT_FOUND', 'previous fixture draft missing'); retired.push(bytes); rows.delete(identity.uid) },
    }
  }
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: secret, entryPoint: 'xmail', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true, requireOriginHeader: true,
    mailboxTransport: transport, mailSearchClientFactory: searchFactory,
    mailAttachmentSource: { async read(opened, folder, uid) { downloads.push(opened.record.mailbox); if (attachmentHook) await attachmentHook(); return { mailbox: opened.record.mailbox, folder, uid, uidValidity: 17, parts: [{ filename: 'actual.bin', contentType: 'application/octet-stream', content: attachmentBytes }] } } },
    mailDraftTransport: opened => draftTransport(opened.record.mailbox),
  })
  const listener = await listenApiServer(app); cleanup.push(async () => { listener.server.closeAllConnections(); await listener.close() })
  const call = (path: string, method = 'GET', body?: unknown, session?: Session, extra: Record<string,string> = {}): Promise<Response> => new Promise((resolve,reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ hostname: '127.0.0.1', port: listener.port, path, method, headers: { host: new URL(ORIGIN).host, origin: ORIGIN, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...extra } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.once('error',reject)
      res.once('end', () => { const headers = new Headers(); for (const [name,value] of Object.entries(res.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value); resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers })) })
    }); req.once('error',reject); req.end(payload)
  })
  const login = async (address = inbox.login): Promise<Session> => { const response = await call('/api/auth/login','POST',{ username: address, password }); expect(response.status).toBe(200); const body = await response.json() as { csrfToken: string }; return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrfToken } }
  const identity = { id: randomUUID(), mailbox: inbox.login, email: inbox.login, displayName: 'Saved sender', replyTo: 'reply@example.test', textSignature: '', htmlSignature: '', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z', ownerAuthority: { accountId: inbox.accountId, serviceUserId: inbox.id, mailbox: inbox.login } }
  const identityPath = join(state.rootDir,'extended','webmail','identities.json'); await atomicWriteJson(identityPath,[identity])
  const selected = { identityId: identity.id, expectedIdentityRevision: composeIdentityRevision(identity) }
  await atomicWriteJson(join(state.rootDir,'extended','webmail','messages.json'),[{ id: randomUUID(), mailbox: inbox.login, folder: 'INBOX', from: 'sender@example.test', to: [inbox.login], cc: [], bcc: [], subject: 'LEGACY_METADATA', textBody: 'LEGACY_METADATA', htmlBody: '', attachments: [], identityId: null, read: false, starred: false, sentAt: new Date().toISOString() }])
  return { database,state,features,owner,inbox,sibling,foreign,principal,transport,secret,call,login,identity,identityPath,selected,sent,reads,downloads,searchLogins,drafts,retired,submission,moved,removed,
    setSearchHook(value: typeof searchHook) { searchHook = value }, setAttachmentHook(value: typeof attachmentHook) { attachmentHook = value }, setAttachmentBytes(value: Buffer) { attachmentBytes = value }, setDraftAppendFault(value: boolean) {draftAppendFault=value},setInboxValidity(value:number){inboxValidity=value} }
}

describe('mounted sealed native mail functionality', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
  it('uses declared actual IMAP data and never sealed metadata-search fallback', async () => {
    const session = await f.login(), response = await f.call('/api/webmail/search?q=NATIVE', 'GET', undefined, session)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json() as { context: { mailbox: string }; messages: Array<{uid:number}> }
    expect(body.context.mailbox).toBe(f.inbox.login); expect(body.messages[0]!.uid).toBe(7)
    const read = await f.call('/api/webmail/search-message?uid=7&folder=INBOX&uidValidity=17','GET',undefined,session)
    expect(read.status).toBe(200); expect(await read.text()).toContain('NATIVE actual bytes for ' + f.inbox.login)
    expect((await (await f.call('/api/webmail/search?q=LEGACY_METADATA','GET',undefined,session)).json() as {messages:unknown[]}).messages).toEqual([])
    expect((await f.call('/api/webmail/search?q=NATIVE&mailbox='+encodeURIComponent(f.sibling.login),'GET',undefined,session)).status).toBe(422)
  })
  it.each([
    { observed: true, messageValidity: 17, selectedValidity: 17, expected: true },
    { observed: false, messageValidity: 1, selectedValidity: 1, expected: false },
    { observed: true, messageValidity: 1, selectedValidity: 17, expected: false },
  ])('projects only observed matching read UIDVALIDITY through actual HTTP: %j', async scenario => {
    const session = await f.login(), rawMime = 'From: sender@example.test\r\nTo: '+f.inbox.login+'\r\nSubject: Identity\r\n\r\nActual read body'
    await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-search']})
    vi.spyOn(ImapProtocolClient.prototype,'connect').mockResolvedValue('* OK declared read fixture')
    vi.spyOn(ImapProtocolClient.prototype,'login').mockResolvedValue(undefined)
    vi.spyOn(ImapProtocolClient.prototype,'logout').mockResolvedValue(undefined)
    vi.spyOn(ImapProtocolClient.prototype,'storeFlagsByUid').mockResolvedValue(undefined)
    vi.spyOn(ImapProtocolClient.prototype,'fetchMessagesByUid').mockResolvedValue({state:{folder:'INBOX',exists:1,recent:0,uidValidity:scenario.selectedValidity,uidValidityObserved:scenario.observed,uidNext:8,flags:[],resynced:false,previousUidValidity:null},
      messages:[{mailbox:f.inbox.login,folder:'INBOX',uid:7,uidValidity:scenario.messageValidity,flags:[],internalDate:null,sizeBytes:Buffer.byteLength(rawMime),rawMime,rawMimeBytes:Buffer.from(rawMime),rfc822SizeObserved:true,bodyComplete:true,parsed:codec.parseMimeMessage(rawMime),attachmentTokens:[]}]})
    const local = createLocalMailboxTransport({XPANEL_IMAP_HOST:'127.0.0.1',XPANEL_IMAP_PORT:'143'})
    vi.spyOn(f.transport,'read').mockImplementation((...args)=>local.read(...args))
    const response = await f.call('/api/webmail/inbox/7?folder=INBOX','GET',undefined,session)
    expect(response.status).toBe(200)
    const result = await response.json() as {mailbox:string;folder:string;message:{uidValidity?:number;uidValidityObserved:boolean}}
    expect(result).toMatchObject({mailbox:f.inbox.login,folder:'INBOX',message:{uidValidityObserved:scenario.expected}})
    if(scenario.expected)expect(result.message.uidValidity).toBe(17)
    else expect(result.message).not.toHaveProperty('uidValidity')
    if(scenario.expected)expect(ImapProtocolClient.prototype.storeFlagsByUid).toHaveBeenCalledWith('INBOX',7,'add',['\\Seen'],f.inbox.login,17)
    else expect(ImapProtocolClient.prototype.storeFlagsByUid).not.toHaveBeenCalled()
  })
  it('enforces actual search and attachment features without legacy native fallthrough or byte transport access', async()=>{
    const session=await f.login(), manifest=await f.call('/api/webmail/attachment-workspace?uid=7','GET',undefined,session)
    expect(manifest.status).toBe(200)
    const path=(await manifest.json() as {attachments:Array<{downloadPath:string}>}).attachments[0]!.downloadPath
    const beforeDownloads=f.downloads.length
    await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-search']})
    expect((await f.call('/api/webmail/search?q=LEGACY_METADATA','GET',undefined,session)).status).toBe(403)
    expect((await f.call('/api/webmail/search-message?uid=7&folder=INBOX&uidValidity=17','GET',undefined,session)).status).toBe(403)
    expect(f.searchLogins).toEqual([]);expect(f.reads).toEqual([])
    await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-attachments']})
    expect((await f.call('/api/webmail/attachment-workspace?uid=7','GET',undefined,session)).status).toBe(403)
    expect((await f.call(path,'GET',undefined,session)).status).toBe(403)
    expect(f.downloads).toHaveLength(beforeDownloads)
    expect((await f.call('/api/webmail/search?q=NATIVE','GET',undefined,session)).status).toBe(200)
  })
  it('rechecks feature authority after native search or attachment transport awaits', async()=>{
    const session=await f.login()
    f.setSearchHook(async()=>{await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-search']})})
    expect((await f.call('/api/webmail/search?q=NATIVE','GET',undefined,session)).status).toBe(403);expect(f.reads).toEqual([])
    await f.state.store.updateFeatureList(f.features.id,{disabled:[]})
    f.setAttachmentHook(async()=>{await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-attachments']})})
    expect((await f.call('/api/webmail/attachment-workspace?uid=7','GET',undefined,session)).status).toBe(403)
  })
  it('refuses missing or reset namespaces before move/delete and uses only observed mapped destination for Undo', async()=>{
    const session=await f.login()
    expect((await f.call('/api/webmail/inbox/7/move','POST',{from:'INBOX',folder:'Archive'},session)).status).toBe(422)
    expect((await f.call('/api/webmail/inbox/7?folder=Trash&confirm=delete','DELETE',{},session)).status).toBe(422)
    f.setInboxValidity(18)
    expect((await f.call('/api/webmail/inbox/7/move','POST',{from:'INBOX',folder:'Archive',uidValidity:17},session)).status).toBe(409)
    expect(f.moved).toEqual([]);expect(f.removed).toEqual([])
    f.setInboxValidity(17)
    const moved=await f.call('/api/webmail/inbox/7/move','POST',{from:'INBOX',folder:'Archive',uidValidity:17},session)
    expect(moved.status).toBe(200);expect(await moved.json()).toMatchObject({sourceUid:7,sourceUidValidity:17,uid:107,uidValidity:31,uidValidityObserved:true,destinationUidKnown:true,stateChanged:true})
    expect((await f.call('/api/webmail/inbox/107/move','POST',{from:'Archive',folder:'INBOX',uidValidity:17},session)).status).toBe(409)
    expect(f.moved).toHaveLength(1)
    expect((await f.call('/api/webmail/inbox/107/move','POST',{from:'Archive',folder:'INBOX',uidValidity:31},session)).status).toBe(200)
    expect((await f.call('/api/webmail/inbox/7?folder=Trash&confirm=delete','DELETE',{uidValidity:17},session)).status).toBe(409)
    expect(f.removed).toEqual([])
    const removed=await f.call('/api/webmail/inbox/7?folder=Trash&confirm=delete','DELETE',{uidValidity:41},session)
    expect(removed.status).toBe(200);expect(await removed.json()).toMatchObject({sourceUidValidity:41,uid:7,permanent:true,stateChanged:true});expect(f.removed).toHaveLength(1)
  })
  it('locks unknown move mapping instead of reusing the requested UID or namespace', async()=>{
    const session=await f.login();vi.spyOn(f.transport,'move').mockResolvedValueOnce(undefined)
    const response=await f.call('/api/webmail/inbox/7/move','POST',{from:'INBOX',folder:'Archive',uidValidity:17},session)
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({uid:null,uidValidityObserved:false,destinationUidKnown:false,stateChanged:true,unknownOutcome:true,verificationRequired:true})
  })
  it('revocation during FETCH prevents Seen and withholds the private read body', async()=>{
    const session=await f.login(),rawMime='From: sender@example.test\r\nTo: '+f.inbox.login+'\r\nSubject: Private\r\n\r\nPRIVATE_FETCH_BODY'
    vi.spyOn(ImapProtocolClient.prototype,'connect').mockResolvedValue('* OK declared read fixture');vi.spyOn(ImapProtocolClient.prototype,'login').mockResolvedValue(undefined);vi.spyOn(ImapProtocolClient.prototype,'logout').mockResolvedValue(undefined)
    vi.spyOn(ImapProtocolClient.prototype,'storeFlagsByUid').mockResolvedValue(undefined)
    vi.spyOn(ImapProtocolClient.prototype,'fetchMessagesByUid').mockImplementationOnce(async()=>{await f.state.store.suspendAccount(f.owner.id,'Declared during-FETCH revocation');return {state:{folder:'INBOX',exists:1,recent:0,uidValidity:17,uidValidityObserved:true,uidNext:8,flags:[],resynced:false,previousUidValidity:null},messages:[{mailbox:f.inbox.login,folder:'INBOX',uid:7,uidValidity:17,flags:[],internalDate:null,sizeBytes:Buffer.byteLength(rawMime),rawMime,rawMimeBytes:Buffer.from(rawMime),rfc822SizeObserved:true,bodyComplete:true,parsed:codec.parseMimeMessage(rawMime),attachmentTokens:[]}]}})
    const local=createLocalMailboxTransport({XPANEL_IMAP_HOST:'127.0.0.1',XPANEL_IMAP_PORT:'143'});vi.spyOn(f.transport,'read').mockImplementation((...args)=>local.read(...args))
    const response=await f.call('/api/webmail/inbox/7?folder=INBOX','GET',undefined,session)
    expect(response.status).toBe(403);expect(await response.text()).not.toContain('PRIVATE_FETCH_BODY');expect(ImapProtocolClient.prototype.storeFlagsByUid).not.toHaveBeenCalled()
  })
  it.each([
    { name: 'header-only fetch', patch: { rawMimeBytes: Buffer.alloc(0), bodyComplete: false } },
    { name: 'partial body', patch: { bodyComplete: false } },
    { name: 'unobserved RFC822.SIZE', patch: { rfc822SizeObserved: false } },
    { name: 'size and byte mismatch', patch: { sizeBytes: 1 } },
    { name: 'missing raw MIME bytes', patch: { rawMimeBytes: undefined } },
  ])('refuses an incomplete native source before Seen or body exposure: $name', async ({ patch }) => {
    const session=await f.login(),rawMime='From: sender@example.test\r\nTo: '+f.inbox.login+'\r\nSubject: Partial\r\n\r\nPRIVATE_PARTIAL_BODY'
    await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-search']})
    vi.spyOn(ImapProtocolClient.prototype,'connect').mockResolvedValue('* OK declared read fixture');vi.spyOn(ImapProtocolClient.prototype,'login').mockResolvedValue(undefined);vi.spyOn(ImapProtocolClient.prototype,'logout').mockResolvedValue(undefined)
    vi.spyOn(ImapProtocolClient.prototype,'storeFlagsByUid').mockResolvedValue(undefined)
    let limits: unknown = null
    vi.spyOn(ImapProtocolClient.prototype,'fetchMessagesByUid').mockImplementation(async function(this: ImapProtocolClient){limits=(this as unknown as {config:unknown}).config;return {state:{folder:'INBOX',exists:1,recent:0,uidValidity:17,uidValidityObserved:true,uidNext:8,flags:[],resynced:false,previousUidValidity:null},
      messages:[{mailbox:f.inbox.login,folder:'INBOX',uid:7,uidValidity:17,flags:[],internalDate:null,sizeBytes:Buffer.byteLength(rawMime),rawMime,rawMimeBytes:Buffer.from(rawMime),rfc822SizeObserved:true,bodyComplete:true,parsed:codec.parseMimeMessage(rawMime),attachmentTokens:[],...patch}]} as never})
    const local=createLocalMailboxTransport({XPANEL_IMAP_HOST:'127.0.0.1',XPANEL_IMAP_PORT:'143'});vi.spyOn(f.transport,'read').mockImplementation((...args)=>local.read(...args))
    const response=await f.call('/api/webmail/inbox/7?folder=INBOX','GET',undefined,session)
    expect(limits).toMatchObject({maxLiteralBytes:25*1024*1024,maxResponseLineBytes:1024*1024})
    expect(response.status).toBe(412);expect(await response.text()).not.toContain('PRIVATE_PARTIAL_BODY');expect(ImapProtocolClient.prototype.storeFlagsByUid).not.toHaveBeenCalled()
  })
  it('preserves administrative metadata search as a separate response contract', async () => {
    await f.state.store.updateFeatureList(f.features.id,{disabled:['webmail-search']})
    const raw = randomBytes(32).toString('hex'); await createApiToken(f.database.db,{principalId:f.principal.id,name:'Declared metadata search fixture',tokenHash:sha256Hex(raw),scopes:['webmail:read'],expiresAt:new Date(Date.now()+60000).toISOString()})
    const app = createApiApp({db:f.database.db,store:f.state.store,serverSecret:f.secret,mailboxTransport:f.transport})
    const response = await app.fetch(new Request('http://localhost/api/webmail/search?q=LEGACY_METADATA&mailbox='+encodeURIComponent(f.inbox.login),{headers:{authorization:'Bearer '+raw}}))
    expect(response.status).toBe(200); expect(await response.text()).toContain('LEGACY_METADATA'); expect(f.reads).toEqual([])
  })
  it('requires actual sealed login, origin and CSRF before native effects', async () => {
    expect((await f.call('/api/webmail/search?q=NATIVE')).status).toBe(401)
    expect((await f.call('/api/webmail/send','POST',draft)).status).toBe(401)
    const session = await f.login()
    expect((await f.call('/api/webmail/send','POST',draft,session,{'x-csrf-token':'invalid'})).status).toBe(403)
    expect((await f.call('/api/webmail/drafts','POST',draft,session,{origin:'https://foreign.example.test'})).status).toBe(403)
    expect(f.sent).toEqual([]); expect(f.drafts.size).toBe(0)
  })
  it('sends selected saved identity and actual attachment bytes without a Bcc MIME header', async () => {
    const session = await f.login(), bytes = Buffer.from([0,255,42]), response = await f.call('/api/webmail/send','POST',{...draft,...f.selected,bcc:'hidden@example.test',attachments:[{filename:'actual.bin',contentType:'application/octet-stream',contentBase64:bytes.toString('base64')}]},session)
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({mailbox:f.inbox.login,identityId:f.identity.id,identityRevision:f.selected.expectedIdentityRevision,savedToSent:false})
    expect(f.sent).toHaveLength(1); const sent = f.sent[0]!
    expect(sent.input).toMatchObject({fromName:'Saved sender',replyTo:'reply@example.test',bcc:['hidden@example.test']})
    expect(Buffer.from(sent.input.attachments![0]!.content as Uint8Array)).toEqual(bytes)
    expect(sent.mime).not.toMatch(/^Bcc:/im); expect(codec.parseMimeMessage(sent.mime).attachments[0]!.content).toEqual(bytes)
    expect(f.submission.submitted[0]).not.toMatch(/^Bcc:/im)
  })
  it.each(['cc','bcc'] as const)('submits a genuine %s-only envelope without an empty To or private Bcc MIME header', async field => {
    const session = await f.login(), response = await f.call('/api/webmail/send','POST',{...draft,to:'',[field]:'only@example.test'},session)
    expect(response.status).toBe(201); expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.input.to).toBe(''); expect(f.sent[0]!.mime).not.toMatch(/^(?:To:\s*$|Bcc:)/im)
    expect(f.submission.submitted).toHaveLength(1)
    expect((await f.call('/api/webmail/send','POST',{...draft,to:'',cc:'',bcc:''},session)).status).toBe(422)
    expect(f.sent).toHaveLength(1)
  })
  it('refuses forged headers, malformed bytes and stale/unbound identities before SMTP', async () => {
    const session = await f.login()
    for (const patch of [{from:'foreign@example.test'},{replyTo:'foreign@example.test'},{mailbox:f.sibling.login},{headers:{Bcc:'hidden@example.test'}}]) expect((await f.call('/api/webmail/send','POST',{...draft,...patch},session)).status).toBe(422)
    expect((await f.call('/api/webmail/send','POST',{...draft,attachments:[{filename:'x.bin',contentType:'application/octet-stream',contentBase64:'!!!='}]},session)).status).toBe(400)
    await atomicWriteJson(f.identityPath,[{...f.identity,displayName:'Changed'}])
    expect((await f.call('/api/webmail/send','POST',{...draft,...f.selected},session)).status).toBe(409)
    const {ownerAuthority:_pin,...unbound}=f.identity; await atomicWriteJson(f.identityPath,[unbound])
    expect((await f.call('/api/webmail/send','POST',{...draft,...f.selected},session)).status).toBe(404)
    expect(f.sent).toEqual([])
  })
  it('rechecks authority after identity read and before SMTP', async () => {
    const session = await f.login(), original = ExtendedFeaturesStore.prototype.readOrDefault
    let changed = false
    vi.spyOn(ExtendedFeaturesStore.prototype,'readOrDefault').mockImplementation(async function<T>(this: ExtendedFeaturesStore, key: string, fallback: T): Promise<T> {
      const value = await original.call(this,key,fallback) as T
      if (key==='webmail/identities.json'&&!changed) { changed=true; await f.state.store.suspendAccount(f.owner.id,'Declared concurrent suspension') }
      return value
    })
    expect((await f.call('/api/webmail/send','POST',{...draft,...f.selected},session)).status).toBe(403); expect(f.sent).toEqual([])
  })
  it('saves unfinished private-Bcc MIME, verifies bytes and replaces only the reviewed old draft', async () => {
    const session = await f.login(), response = await f.call('/api/webmail/drafts','POST',{to:'',subject:'',text:'Unfinished draft',bcc:'hidden@example.test',...f.selected},session)
    expect(response.status).toBe(201)
    const body = await response.json() as {draft:DraftIdentity;identityId:string;identityRevision:string}
    expect(body).toMatchObject({identityId:f.identity.id,identityRevision:f.selected.expectedIdentityRevision})
    expect(f.drafts.get(f.inbox.login)!.get(body.draft.uid)!.toString()).toContain('Bcc: hidden@example.test\r\n')
    const expectedDraft = {uid:body.draft.uid,uidValidity:body.draft.uidValidity,revision:body.draft.revision}
    const next = await f.call('/api/webmail/drafts','POST',{...draft,...f.selected,expectedDraft},session)
    expect(next.status).toBe(201); expect(await next.json()).toMatchObject({status:'saved',previousDraft:'retired',reviewRequired:false})
    expect(f.retired).toHaveLength(1); expect(f.drafts.get(f.inbox.login)!.has(expectedDraft.uid)).toBe(false); expect(f.sent).toEqual([])
    expect((await f.call('/api/webmail/drafts','POST',{...draft,expectedDraft},session)).status).toBe(409)
  })
  it('downloads exact bytes with session-bound references and refuses changed content', async () => {
    const session = await f.login(), response = await f.call('/api/webmail/attachment-workspace?uid=7&folder=INBOX&uidValidity=17','GET',undefined,session)
    expect(response.status).toBe(200); const body = await response.json() as {attachments:Array<{downloadPath:string}>}, path=body.attachments[0]!.downloadPath
    const downloaded = await f.call(path,'GET',undefined,session)
    expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from([0,255,1,2])); expect(downloaded.headers.get('content-disposition')).toContain('attachment;')
    const sibling = await f.login(f.sibling.login)
    expect((await f.call(path,'GET',undefined,sibling)).status).toBe(404)
    f.setAttachmentBytes(Buffer.from([0,255,1,3])); expect((await f.call(path,'GET',undefined,session)).status).toBe(409)
  })
  it('withholds search/download results if authorization changes during transport work', async () => {
    const session = await f.login(); f.setSearchHook(async()=>{await f.state.store.suspendAccount(f.owner.id,'Declared search suspension')})
    expect((await f.call('/api/webmail/search?q=NATIVE','GET',undefined,session)).status).toBe(403); expect(f.reads).toEqual([])
    await f.state.store.unsuspendAccount(f.owner.id); f.setSearchHook(undefined); f.setAttachmentHook(async()=>{await f.state.store.suspendAccount(f.owner.id,'Declared byte-read suspension')})
    expect((await f.call('/api/webmail/attachment-workspace?uid=7','GET',undefined,session)).status).toBe(403)
  })
  it('retains unknown-effect flags when authorization changes after SMTP actually accepted', async () => {
    const session = await f.login(), original=f.transport.send.bind(f.transport)
    vi.spyOn(f.transport,'send').mockImplementationOnce(async(...args)=>{const sent=await original(...args);await f.state.store.suspendAccount(f.owner.id,'Declared post-SMTP suspension');return sent})
    const response=await f.call('/api/webmail/send','POST',draft,session)
    expect(response.status).toBe(403);expect(await response.json()).toMatchObject({details:{stateChanged:true,unknownOutcome:true,verificationRequired:true}})
    expect(f.submission.submitted).toHaveLength(1)
  })
  it('retains an uncertain appended draft for review and never reports a known save', async () => {
    const session=await f.login();f.setDraftAppendFault(true)
    const response=await f.call('/api/webmail/drafts','POST',draft,session)
    expect(response.status).toBe(412);expect(await response.json()).toMatchObject({details:{stateChanged:true,unknownOutcome:true,verificationRequired:true,draftReviewRequired:true}})
    expect(f.drafts.get(f.inbox.login)!.size).toBe(1)
  })
  it('marks post-dispatch send failures as unknown instead of advertising safe retry', async () => {
    const session = await f.login(); vi.spyOn(f.transport,'send').mockRejectedValueOnce(new Error('Declared lost remote acknowledgement'))
    const response = await f.call('/api/webmail/send','POST',draft,session)
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({details:{stateChanged:true,unknownOutcome:true,verificationRequired:true}})
  })
})
