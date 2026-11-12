import { createHash, createHmac } from 'node:crypto'
import { tool } from './kit.mjs'

const API = '/api/webmail'
const folderQuery = folder => `${API}/inbox?folder=${encodeURIComponent(folder)}`
const messagesOf = response => response.data?.messages ?? []
const hasSubject = (response, subject) => response.status === 200 && messagesOf(response).some(item => item.subject === subject)
const only = (response, subject) => messagesOf(response).filter(item => item.subject === subject)
const statusOf = response => ({ status: response?.status ?? null })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
/** Marks every owed check failed when the set-up the criterion needs could not be built. */
const failAll = (check, ids, observed) => ids.forEach(id => check(id, false, observed))
const sendTo = (mailbox, to, subject, text, extra = {}) => mailbox.post(`${API}/send`, { to, subject, text, ...extra })
/** Waits for local delivery of one subject into a folder. */
const delivered = (until, mailbox, folder, subject) => until(() => mailbox.get(folderQuery(folder)), response => hasSubject(response, subject), { attempts: 15, delayMs: 2000 })

/** A personal subfolder under INBOX; the undo removes it (with its messages, after the confirmation the route demands). */
const removeFolder = (mailbox, folder) => async () => {
  const view = await mailbox.get(`${API}/folders`)
  if (view.status !== 200) return false
  const entry = view.data?.folders?.find(item => item.folder === folder)
  if (!entry) return true
  const gone = await mailbox.post(`${API}/folders/delete`, { folder, ...(entry.messages ? { confirm: { folder, messages: entry.messages } } : {}) })
  return gone.status === 200 && !gone.data?.view?.folders?.some(item => item.folder === folder)
}
async function makeFolder(mailbox, name, undo) {
  const created = await mailbox.post(`${API}/folders`, { name, parent: 'INBOX' })
  const folder = created.status === 200 && typeof created.data?.folder === 'string' ? created.data.folder : null
  if (folder) undo(`folder ${name}`, removeFolder(mailbox, folder))
  return { created, folder }
}
/** Removes one saved filter by the revision read now, for an undo step. */
const removeFilter = (mailbox, id) => async () => {
  const view = await mailbox.get(`${API}/filters`)
  if (view.status !== 200) return false
  if (!view.data?.filters?.some(item => item.id === id)) return true
  const gone = await mailbox.delete(`${API}/filters/${id}`, { expectedRevision: view.data.revision })
  return gone.status === 200 && !gone.data?.filters?.some(item => item.id === id)
}

/** RFC 6238 code for a base32 secret, shifted by whole 30 second steps. */
const totp = (secret, steps = 0) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = [...secret.replace(/=+$/, '').toUpperCase()].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('')
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2))), counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps))
  const digest = createHmac('sha1', key).update(counter).digest(), offset = digest[19] & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

const spamFields = view => view.preferences
  ? { inherit: view.preferences.inherit, enabled: view.preferences.enabled, addHeaderScore: view.preferences.addHeaderScore, spamBoxEnabled: view.preferences.spamBoxEnabled, autoDeleteScore: view.preferences.autoDeleteScore ?? null, allowlist: view.preferences.allowlist, blocklist: view.preferences.blocklist }
  : { inherit: true, enabled: view.inherited.enabled, addHeaderScore: view.inherited.addHeaderScore, spamBoxEnabled: view.inherited.spamBoxEnabled, autoDeleteScore: view.inherited.autoDeleteScore ?? null, allowlist: [], blocklist: [] }

export default [
  tool('webmail-signin', {
    prefix: 'WMSI', as: 'mailbox', also: ['owner'], needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/(?:webmail\/inbox|service-users(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'WMSI-UNIT-BOUND', file: 'apps/api/src/mail/mailbox-scope.test.ts', name: 'live mailbox session policy opens only the mailbox bound to the caller and account' }],
    checks: ['SESSION-ESTABLISHED-ON-LOGIN', 'SUSPENDED-MAILBOX-NO-SESSION', 'WRONG-CREDENTIAL-REFUSED'],
    async run({ owner, fixture, tag, check, signIn, undo }) {
      const { client, response } = await signIn('mailbox', { username: fixture.mailbox.address, password: fixture.mailbox.password })
      check('SESSION-ESTABLISHED-ON-LOGIN', client !== null && response.status === 200, statusOf(response))
      const tempLogin = `wmsi${tag}@${fixture.domain}`, tempSecret = `Xq-${tag}-Wm7!kP3#nB2zLq8`
      const created = await owner.post('/api/service-users', { login: tempLogin, password: tempSecret, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 32 })
      const tempId = created.data?.serviceUser?.id
      if (created.status === 201 && typeof tempId === 'string') {
        undo('signin probe mailbox', async () => {
          const removed = await owner.delete(`/api/service-users/${tempId}`)
          if ([200, 202, 204, 404].includes(removed.status)) return true
          if (removed.status !== 412) return false
          const listed = await owner.get('/api/service-users')
          return listed.status === 200 && !(listed.data?.serviceUsers ?? []).some(item => item?.id === tempId)
        })
        const suspended = await owner.patch(`/api/service-users/${tempId}`, { services: { email: false, ftp: false, webdisk: true }, ftpDir: 'public_html', webdiskReadOnly: true })
        const blockedLogin = suspended.status === 200 ? await signIn('mailbox', { username: tempLogin, password: tempSecret }) : null
        check('SUSPENDED-MAILBOX-NO-SESSION', suspended.status === 200 && blockedLogin?.client === null && blockedLogin.response.status >= 400, { suspend: suspended.status, status: blockedLogin?.response?.status ?? null })
      } else check('SUSPENDED-MAILBOX-NO-SESSION', false, statusOf(created))
      const wrong = await signIn('mailbox', { username: fixture.mailbox.address, password: 'Wrong-Password-0' })
      check('WRONG-CREDENTIAL-REFUSED', wrong.client === null && wrong.response.status === 401, statusOf(wrong.response))
    },
  }),

  tool('webmail-folders', {
    prefix: 'WMFD', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/webmail\/folders(?:\/(?:rename|delete))?$/,
    page: { route: '/mail/folders', read: `${API}/folders`, shows: data => [data?.mailbox] },
    unit: [{ id: 'WMFD-UNIT-LIST', file: 'apps/api/src/mail/folder-admin.test.ts', name: '/api/webmail/folders list lists the sealed mailbox with special-use protection, hierarchy, counts and subscriptions' }],
    checks: ['CREATE-CHILD-LISTED', 'RENAME-INBOX-PROTECTED-FOLDER', 'RENAME-SENT-PROTECTED-FOLDER', 'RENAME-DRAFTS-PROTECTED-FOLDER', 'RENAME-TRASH-PROTECTED-FOLDER',
      'DELETE-INBOX-PROTECTED-FOLDER', 'DELETE-SENT-PROTECTED-FOLDER', 'DELETE-DRAFTS-PROTECTED-FOLDER', 'DELETE-TRASH-PROTECTED-FOLDER', 'DUPLICATE-FOLDER-EXISTS'],
    async run({ mailbox, tag, check, refused, undo }) {
      const name = `xq-${tag}`
      const first = await mailbox.get(`${API}/folders`)
      const inbox = first.data?.folders?.find(item => item.folder.toUpperCase() === 'INBOX'), delimiter = inbox?.delimiter
      const created = await makeFolder(mailbox, name, undo)
      const listed = await mailbox.get(`${API}/folders`)
      check('CREATE-CHILD-LISTED', created.folder === `INBOX${delimiter}${name}` && listed.data?.folders?.some(item => item.folder === created.folder) === true, { status: created.created.status, listed: listed.status })
      const find = leaf => listed.data?.folders?.find(item => item.folder.toUpperCase() === 'INBOX' ? leaf === 'inbox' : item.leaf?.toLowerCase() === leaf || item.specialUse?.toLowerCase() === `\\${leaf}`)
      for (const leaf of ['inbox', 'sent', 'drafts', 'trash']) {
        const entry = find(leaf), id = leaf.toUpperCase()
        if (!entry) { check(`RENAME-${id}-PROTECTED-FOLDER`, false, { found: false }); check(`DELETE-${id}-PROTECTED-FOLDER`, false, { found: false }); continue }
        refused(`RENAME-${id}-PROTECTED-FOLDER`, await mailbox.post(`${API}/folders/rename`, { folder: entry.folder, name: `xq-${tag}-renamed` }), 'CONFLICT')
        refused(`DELETE-${id}-PROTECTED-FOLDER`, await mailbox.post(`${API}/folders/delete`, { folder: entry.folder }), 'CONFLICT')
      }
      refused('DUPLICATE-FOLDER-EXISTS', await mailbox.post(`${API}/folders`, { name, parent: 'INBOX' }), 'CONFLICT')
    },
  }),

  tool('webmail-message-list', {
    prefix: 'WMML', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 75, deadlineMs: 240000,
    paths: /^\/api\/webmail\/(?:send|folders(?:\/delete)?|inbox(?:\/[1-9]\d*(?:\/move)?)?(?:\?folder=[A-Za-z0-9._%-]+(?:&confirm=delete)?)?)$/,
    unit: [{ id: 'WMML-UNIT-LIST', file: 'apps/api/src/mail/folder-workspace.test.ts', name: 'mail folder request and selected-result boundary returns a complete selected-folder list with a real move capability and no arbitrary transport fields' }],
    checks: ['MOVE-LOWERS-SOURCE-BY-3', 'MOVE-RAISES-TARGET-BY-3', 'MOVED-BODIES-PRESERVED', 'TRASH-DELETE-EXPUNGES-UID'],
    async run({ mailbox, fixture, tag, check, until, undo }) {
      const ids = ['MOVE-LOWERS-SOURCE-BY-3', 'MOVE-RAISES-TARGET-BY-3', 'MOVED-BODIES-PRESERVED', 'TRASH-DELETE-EXPUNGES-UID']
      const target = await makeFolder(mailbox, `xq-${tag}`, undo)
      if (!target.folder) return failAll(check, ids, statusOf(target.created))
      const subjects = [1, 2, 3].map(n => `xq-${tag}-m${n}`)
      for (const subject of subjects) await sendTo(mailbox, fixture.mailbox.address, subject, `message list body ${subject}`)
      const landed = await until(() => mailbox.get(folderQuery('INBOX')), response => subjects.every(subject => hasSubject(response, subject)), { attempts: 15, delayMs: 2000 })
      if (!landed.settled) return failAll(check, ids, { delivered: false })
      const base = messagesOf(landed.last).length, moves = []
      for (const subject of subjects) {
        const message = only(landed.last, subject)[0]
        moves.push((await mailbox.post(`${API}/inbox/${message.uid}/move`, { from: 'INBOX', folder: target.folder, uidValidity: message.uidValidity })).status)
      }
      const after = await mailbox.get(folderQuery('INBOX')), dest = await mailbox.get(folderQuery(target.folder))
      check('MOVE-LOWERS-SOURCE-BY-3', moves.every(status => status === 200) && after.status === 200 && messagesOf(after).length === base - 3, { moves, before: base, after: messagesOf(after).length })
      check('MOVE-RAISES-TARGET-BY-3', dest.status === 200 && messagesOf(dest).length === 3 && subjects.every(subject => hasSubject(dest, subject)), { target: messagesOf(dest).length })
      const readBodies = dest.status === 200 ? await Promise.all(subjects.map(async subject => {
        const row = only(dest, subject)[0]
        if (!row) return false
        const detail = await mailbox.get(`${API}/inbox/${row.uid}?folder=${encodeURIComponent(target.folder)}`)
        return detail.status === 200 && typeof detail.data?.message?.body === 'string' && detail.data.message.body.includes(`message list body ${subject}`)
      })) : []
      check('MOVED-BODIES-PRESERVED', readBodies.length === 3 && readBodies.every(Boolean), { matched: readBodies.filter(Boolean).length })
      const victim = only(dest, subjects[0])[0]
      const trashed = victim ? await mailbox.delete(`${API}/inbox/${victim.uid}?folder=${encodeURIComponent(target.folder)}`, { uidValidity: victim.uidValidity }) : null
      const inTrash = trashed?.status === 200 ? await mailbox.get(folderQuery('Trash')) : null
      const doomed = inTrash ? only(inTrash, subjects[0])[0] : undefined
      if (!doomed) return check('TRASH-DELETE-EXPUNGES-UID', false, { moved: trashed?.status ?? null })
      const purged = await mailbox.delete(`${API}/inbox/${doomed.uid}?folder=Trash&confirm=delete`, { uidValidity: doomed.uidValidity })
      const gone = await mailbox.get(folderQuery('Trash'))
      check('TRASH-DELETE-EXPUNGES-UID', purged.status === 200 && gone.status === 200 && !messagesOf(gone).some(item => item.uid === doomed.uid), { purged: purged.status, listed: gone.status })
    },
  }),

  tool('webmail-compose', {
    prefix: 'WMCP', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 40,
    paths: /^\/api\/webmail\/(?:send|drafts|inbox(?:\/[1-9]\d*)?\?folder=(?:Sent|Drafts))$/,
    unit: [{ id: 'WMCP-UNIT-RECIPIENT', file: 'apps/api/src/mail/compose-send.test.ts', name: 'approved compose send contract requires an actual envelope recipient and plain text while allowing genuine Cc or Bcc-only send' }],
    checks: ['ONE-SENT-COPY-WITH-MESSAGE-ID-AND-DATE', 'DRAFT-REMOVED-BY-SEND', 'MISSING-RECIPIENT-REFUSED'],
    async run({ mailbox, fixture, tag, check, refused, until }) {
      const subject = `xq-${tag}-compose`, to = fixture.mailbox.address
      const draft = await mailbox.post(`${API}/drafts`, { to, subject, text: 'draft body' })
      const savedDraft = draft.data?.draft
      const drafted = await mailbox.get(folderQuery('Drafts'))
      const sent = await sendTo(mailbox, to, subject, 'compose body')
      const inSent = await until(() => mailbox.get(folderQuery('Sent')), response => hasSubject(response, subject), { attempts: 10, delayMs: 2000 })
      const copies = inSent.settled ? only(inSent.last, subject) : []
      check('ONE-SENT-COPY-WITH-MESSAGE-ID-AND-DATE', sent.status === 201 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(sent.data?.messageId ?? '') && copies.length === 1 && copies[0].receivedAt.length > 0, { send: sent.status, copies: copies.length })
      const retired = sent.status === 201 && savedDraft?.uid ? await mailbox.delete(`${API}/inbox/${savedDraft.uid}?folder=Drafts`, { uidValidity: savedDraft.uidValidity }) : null
      const remaining = await mailbox.get(folderQuery('Drafts'))
      check('DRAFT-REMOVED-BY-SEND', draft.status < 300 && hasSubject(drafted, subject) && retired?.status === 200 && remaining.status === 200 && !hasSubject(remaining, subject), { draft: draft.status, before: hasSubject(drafted, subject), retired: retired?.status ?? null, after: hasSubject(remaining, subject) })
      refused('MISSING-RECIPIENT-REFUSED', await mailbox.post(`${API}/send`, { to: '', subject, text: 'compose body' }), 'VALIDATION')
    },
  }),

  tool('webmail-search', {
    prefix: 'WMSR', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 60, deadlineMs: 240000,
    paths: /^\/api\/webmail\/(?:send|folders(?:\/delete)?|inbox(?:\/[1-9]\d*\/move|\/[1-9]\d*\?folder=(?:Sent|Trash(?:&confirm=delete)?)|\?folder=(?:INBOX|Sent|Trash))?|search\?q=[A-Za-z0-9%._-]+&folder=[A-Za-z0-9._~!'()*%-]+)$/,
    unit: [{ id: 'WMSR-UNIT-QUERY', file: 'apps/api/src/mail/search-workspace.test.ts', name: 'native mailbox search workspace normalizes bounded UTF-8 search text without changing the authoritative folder grammar' }],
    checks: ['ALL-FOLDERS-BODY-SEARCH-EXACT', 'CURRENT-FOLDER-FROM-INBOX-NONE'],
    async run({ mailbox, fixture, tag, check, until, undo }) {
      const ids = ['ALL-FOLDERS-BODY-SEARCH-EXACT', 'CURRENT-FOLDER-FROM-INBOX-NONE'], term = `invoice-${tag}`, subject = `xq-${tag}-search`
      const target = await makeFolder(mailbox, `xq-${tag}`, undo)
      if (!target.folder) return failAll(check, ids, statusOf(target.created))
      await sendTo(mailbox, fixture.mailbox.address, subject, `Payment reference ${term} attached.`)
      const landed = await delivered(until, mailbox, 'INBOX', subject)
      const message = landed.settled ? only(landed.last, subject)[0] : undefined
      const moved = message ? await mailbox.post(`${API}/inbox/${message.uid}/move`, { from: 'INBOX', folder: target.folder, uidValidity: message.uidValidity }) : null
      if (moved?.status !== 200) return failAll(check, ids, { moved: moved?.status ?? null })
      const inSent = await delivered(until, mailbox, 'Sent', subject)
      const sentCopy = inSent.settled ? only(inSent.last, subject)[0] : undefined
      if (sentCopy) {
        const trashed = await mailbox.delete(`${API}/inbox/${sentCopy.uid}?folder=Sent`, { uidValidity: sentCopy.uidValidity })
        if (trashed.status === 200) {
          const inTrash = await mailbox.get(folderQuery('Trash'))
          const doomed = only(inTrash, subject)[0]
          if (doomed) await mailbox.delete(`${API}/inbox/${doomed.uid}?folder=Trash&confirm=delete`, { uidValidity: doomed.uidValidity })
        }
      }
      const search = folder => mailbox.get(`${API}/search?q=${encodeURIComponent(term)}&folder=${encodeURIComponent(folder)}`)
      const inTarget = await search(target.folder), inInbox = await search('INBOX')
      const folderList = await mailbox.get(`${API}/folders`)
      const selectable = (folderList.data?.folders ?? []).filter(item => !item.noselect && typeof item.folder === 'string').map(item => item.folder)
      const acrossFolders = selectable.length > 0 ? await Promise.all(selectable.map(search)) : []
      const hits = acrossFolders.flatMap(messagesOf)
      check('CURRENT-FOLDER-FROM-INBOX-NONE', inTarget.status === 200 && messagesOf(inTarget).length === 1 && inInbox.status === 200 && messagesOf(inInbox).length === 0, { target: messagesOf(inTarget).length, inbox: messagesOf(inInbox).length })
      check('ALL-FOLDERS-BODY-SEARCH-EXACT', folderList.status === 200 && selectable.length >= 2 && acrossFolders.every(res => res.status === 200) && hits.length === 1 && hits[0].subject === subject, { folders: selectable.length, found: hits.length })
    },
  }),

  tool('webmail-attachments', {
    prefix: 'WMAT', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 50, deadlineMs: 240000,
    paths: /^\/api\/webmail\/(?:send|drafts|inbox\?folder=(?:Drafts|INBOX)|attachment-workspace\?uid=[1-9]\d*&folder=INBOX&uidValidity=[1-9]\d*|attachment-download\/[A-Za-z0-9_.-]+)$/,
    unit: [
      { id: 'WMAT-UNIT-LIMIT', file: 'apps/api/src/mail/compose-attachments.test.ts', name: 'shared Send and Save draft attachment byte validation enforces file count and the decoded aggregate boundary exactly' },
      { id: 'WMAT-UNIT-DOWNLOAD', file: 'apps/api/src/mail/attachment-workspace.test.ts', name: 'authenticated MIME attachment workspace downloads exact binary content with safe headers and a scoped audit' },
    ],
    checks: ['OVER-LIMIT-413-ATTACHMENT-TOO-LARGE', 'DRAFT-KEEPS-EARLIER-ATTACHMENTS', 'ARABIC-NAME-AND-SHA256-IDENTICAL'],
    async run({ mailbox, fixture, tag, check, until }) {
      const to = fixture.mailbox.address, subject = `xq-${tag}-attach`, file = (filename, content) => ({ filename, contentType: 'text/plain', contentBase64: Buffer.from(content).toString('base64') })
      const first = await mailbox.post(`${API}/drafts`, { to, subject, text: 'draft', attachments: [file('earlier.txt', 'earlier')] })
      const draft = first.data?.draft
      const big = { filename: 'big.txt', contentType: 'text/plain', contentBase64: Buffer.alloc(600 * 1024, 97).toString('base64') }
      const over = await mailbox.post(`${API}/drafts`, { to, subject, text: 'draft', attachments: [file('earlier.txt', 'earlier'), big], ...(draft ? { expectedDraft: { uid: draft.uid, uidValidity: draft.uidValidity, revision: draft.revision } } : {}) })
      check('OVER-LIMIT-413-ATTACHMENT-TOO-LARGE', over.status === 413 && over.data?.code === 'VALIDATION', { status: over.status, code: over.data?.code ?? null })
      const drafts = await mailbox.get(folderQuery('Drafts'))
      const kept = only(drafts, subject)
      check('DRAFT-KEEPS-EARLIER-ATTACHMENTS', first.status < 300 && over.status === 413 && kept.length === 1 && kept[0].attachments?.some(item => item.name === 'earlier.txt') === true, { first: first.status, over: over.status, drafts: kept.length })
      const name = `ملف-${tag}.txt`, content = `محتوى عربي ${tag}\n`, mail = `xq-${tag}-arabic`
      await sendTo(mailbox, to, mail, 'arabic attachment', { attachments: [file(name, content)] })
      const landed = await delivered(until, mailbox, 'INBOX', mail), message = landed.settled ? only(landed.last, mail)[0] : undefined
      const manifest = message ? await mailbox.get(`${API}/attachment-workspace?uid=${message.uid}&folder=INBOX&uidValidity=${message.uidValidity}`) : null
      const part = manifest?.data?.attachments?.[0]
      const download = part ? await mailbox.get(part.downloadPath) : null
      check('ARABIC-NAME-AND-SHA256-IDENTICAL', part?.filename === name && download?.status === 200 && typeof download.text === 'string' && sha256(Buffer.from(download.text, 'utf8')) === sha256(Buffer.from(content, 'utf8')) && part.sha256 === sha256(Buffer.from(content, 'utf8')),
        { manifest: manifest?.status ?? null, download: download?.status ?? null, sameName: part?.filename === name })
    },
  }),

  tool('webmail-preferences', {
    prefix: 'WMPF', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 25,
    paths: /^\/(?:api\/(?:webmail\/preferences|auth\/personal-preferences)|mail\/settings\/preferences)$/,
    page: { route: '/mail/settings/preferences', read: `${API}/preferences`, shows: data => [data?.context?.mailbox] },
    unit: [{ id: 'WMPF-UNIT-VIEW', file: 'apps/api/src/mail/mailbox-preferences.test.ts', name: 'mailbox preferences view starts empty with bound identities and the rendered plus-addressing state' }],
    checks: ['DISPLAY-PREFERENCES-SAVED', 'ARABIC-CHOICE-SAVED', 'ARABIC-PERSISTS-RELOGIN-DIR-RTL'],
    async run({ mailbox, fixture, check, signIn, undo }) {
      const [view, personal] = await Promise.all([mailbox.get(`${API}/preferences`), mailbox.get('/api/auth/personal-preferences')])
      const origPrefs = view.data?.preferences ?? { density: 'comfortable', messagesPerPage: 25, replyIdentityId: null, dateFormat: 'utc' }
      if (view.status === 200 && typeof view.data?.revision === 'string') {
        undo('mailbox display preferences', async () => {
          const now = await mailbox.get(`${API}/preferences`)
          if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
          if (JSON.stringify(now.data.preferences) === JSON.stringify(origPrefs)) return true
          return (await mailbox.put(`${API}/preferences`, { ...origPrefs, expectedRevision: now.data.revision })).status === 200
        })
      }
      const origPersonal = {
        locale: personal.data?.locale ?? null,
        noticePosition: personal.data?.noticePosition ?? 'top-right',
        notifications: personal.data?.notifications ?? { disk: true, bandwidth: true, announcements: true },
        onboardingDismissed: Boolean(personal.data?.onboardingDismissed),
      }
      if (personal.status === 200 && typeof personal.data?.revision === 'string') {
        undo('mailbox personal locale', async () => {
          const now = await mailbox.get('/api/auth/personal-preferences')
          if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
          if (now.data?.locale === origPersonal.locale) return true
          return (await mailbox.put('/api/auth/personal-preferences', { ...origPersonal, expectedRevision: now.data.revision })).status === 200
        })
      }
      const display = await mailbox.put(`${API}/preferences`, { density: 'compact', messagesPerPage: 50, replyIdentityId: null, dateFormat: 'local', expectedRevision: view.data?.revision ?? '0'.repeat(64) })
      check('DISPLAY-PREFERENCES-SAVED', view.status === 200 && display.status === 200 && display.data?.preferences?.density === 'compact' && display.data?.preferences?.messagesPerPage === 50, { read: view.status, save: display.status })
      const arabic = await mailbox.put('/api/auth/personal-preferences', { ...origPersonal, locale: 'ar', expectedRevision: personal.data?.revision ?? '0'.repeat(64) })
      check('ARABIC-CHOICE-SAVED', personal.status === 200 && arabic.status === 200 && arabic.data?.locale === 'ar', { save: arabic.status })
      const again = arabic.status === 200 ? await signIn('mailbox', { username: fixture.mailbox.address, password: fixture.mailbox.password }) : { client: null, response: { status: 0 } }
      const page = again.client ? await again.client.get('/mail/settings/preferences') : null
      check('ARABIC-PERSISTS-RELOGIN-DIR-RTL', arabic.status === 200 && page?.status === 200 && /<html[^>]*\sdir="rtl"/.test(page.text ?? ''), { relogin: again.response.status, page: page?.status ?? null })
    },
  }),

  tool('webmail-forwarders', {
    prefix: 'WMFW', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 45,
    paths: /^\/api\/webmail\/(?:forwarders|send|inbox\?folder=INBOX)$/,
    page: { route: '/mail/settings/forwarders', read: `${API}/forwarders`, shows: () => ['Forwarders'] },
    unit: [
      { id: 'WMFW-UNIT-VIEW', file: 'apps/api/src/mail/mailbox-forwarders.test.ts', name: 'mailbox forwarders view shows only the sealed mailbox record and never another mailbox or account' },
      { id: 'WMFW-UNIT-WRITE', file: 'apps/api/src/mail/mailbox-forwarders.test.ts', name: 'mailbox forwarder writes creates, updates and deletes only the record whose source is the sealed mailbox' },
    ],
    checks: ['ADD-EXTERNAL-ACCEPTED', 'ONE-LOCAL-COPY-KEPT', 'STALE-REVISION-CONFLICT', 'OWN-ADDRESS-FORWARD-LOOP'],
    async run({ mailbox, fixture, tag, check, refused, until, undo }) {
      const external = `xq-${tag}@example.org`, own = fixture.mailbox.address, before = await mailbox.get(`${API}/forwarders`)
      if (before.status !== 200) return failAll(check, ['ADD-EXTERNAL-ACCEPTED', 'ONE-LOCAL-COPY-KEPT', 'STALE-REVISION-CONFLICT', 'OWN-ADDRESS-FORWARD-LOOP'], statusOf(before))
      undo('mailbox forwarder', async () => {
        const now = await mailbox.get(`${API}/forwarders`)
        if (now.status !== 200) return false
        if (now.data.forwarding === null) return true
        const cleared = await mailbox.put(`${API}/forwarders`, { destinations: [], keepCopy: true, expectedRevision: now.data.revision })
        return cleared.status === 200 && cleared.data?.forwarding === null
      })
      const added = await mailbox.put(`${API}/forwarders`, { destinations: [external], keepCopy: true, expectedRevision: before.data.revision })
      check('ADD-EXTERNAL-ACCEPTED', added.status === 200 && added.data?.forwarding?.destinations?.includes(external) === true, statusOf(added))
      const subject = `xq-${tag}-forward`
      await sendTo(mailbox, own, subject, 'forwarder test delivery')
      const landed = await delivered(until, mailbox, 'INBOX', subject)
      check('ONE-LOCAL-COPY-KEPT', added.status === 200 && landed.settled && only(landed.last, subject).length === 1, { delivered: landed.settled })
      refused('STALE-REVISION-CONFLICT', await mailbox.put(`${API}/forwarders`, { destinations: [], keepCopy: true, expectedRevision: '0'.repeat(64) }), 'CONFLICT')
      const now = await mailbox.get(`${API}/forwarders`)
      refused('OWN-ADDRESS-FORWARD-LOOP', await mailbox.put(`${API}/forwarders`, { destinations: [own], keepCopy: true, expectedRevision: now.data?.revision }), 'VALIDATION')
    },
  }),

  tool('webmail-identities', {
    prefix: 'WMID', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/webmail\/identities(?:\/[0-9a-f-]{36})?$/,
    unit: [{ id: 'WMID-UNIT-FOREIGN', file: 'apps/api/src/completion-mail-identities-security.test.ts', name: 'mailbox identities HTTP security acceptance refuses an identity email that differs from the authorized mailbox' }],
    checks: ['FOREIGN-ADDRESS-IDENTITY-NOT-OWNED', 'SWITCH-IDENTITY-REPLACES-SIGNATURE'],
    async run({ mailbox, fixture, tag, check, refused, undo }) {
      refused('FOREIGN-ADDRESS-IDENTITY-NOT-OWNED', await mailbox.post(`${API}/identities`, { email: `xq-${tag}-other@${fixture.domain}`, displayName: `xq-${tag}` }), 'FORBIDDEN')
      const sigA = `sig-a-${tag}`, sigB = `sig-b-${tag}`
      const first = await mailbox.post(`${API}/identities`, { email: fixture.mailbox.address, displayName: `xq-${tag}-a`, textSignature: sigA, isDefault: true })
      const idA = first.data?.identity?.id
      if (first.status === 201 && typeof idA === 'string') undo('identity a', async () => [200, 404].includes((await mailbox.delete(`${API}/identities/${idA}`, {})).status))
      const second = await mailbox.post(`${API}/identities`, { email: fixture.mailbox.address, displayName: `xq-${tag}-b`, textSignature: sigB, isDefault: false })
      const idB = second.data?.identity?.id
      if (second.status === 201 && typeof idB === 'string') undo('identity b', async () => [200, 404].includes((await mailbox.delete(`${API}/identities/${idB}`, {})).status))
      const switched = typeof idB === 'string' ? await mailbox.patch(`${API}/identities/${idB}`, { isDefault: true }) : null
      const listed = switched?.status === 200 ? await mailbox.get(`${API}/identities`) : null
      const active = (listed?.data?.identities ?? []).find(item => item.isDefault === true)
      check('SWITCH-IDENTITY-REPLACES-SIGNATURE', first.status === 201 && second.status === 201 && switched?.status === 200 && active?.id === idB && active?.textSignature === sigB, { first: first.status, second: second.status, switched: switched?.status ?? null })
    },
  }),

  tool('webmail-email-filters', {
    prefix: 'WMFL', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 60, deadlineMs: 240000,
    paths: /^\/api\/webmail\/(?:filters(?:\/[0-9a-f-]{36})?|folders(?:\/delete)?|send|inbox\?folder=[A-Za-z0-9._%-]+)$/,
    unit: [{ id: 'WMFL-UNIT-CONTRACT', file: 'apps/api/src/mail/filter-validation.test.ts', name: 'pure filter input contract requires explicit content and never returns authority or revision metadata' }],
    checks: ['SUBJECT-INVOICE-FILES-INTO-FOLDER', 'ANYOF-CONDITIONS-COMPILED', 'PIPE-ACTION-FEATURE-DISABLED'],
    async run({ mailbox, fixture, tag, check, refused, until, undo }) {
      const term = `invoice-${tag}`, target = await makeFolder(mailbox, `xq-${tag}`, undo)
      const condition = value => ({ field: 'subject', comparator: 'contains', value })
      if (target.folder) {
        const created = await mailbox.post(`${API}/filters`, { name: `xq-${tag}`, conditions: [condition(term)], actions: [{ type: 'fileinto', target: target.folder }] })
        const id = created.data?.filter?.id
        if (typeof id === 'string') undo('saved filter', removeFilter(mailbox, id))
        const subject = `${term} billing`
        if (created.status === 201) await sendTo(mailbox, fixture.mailbox.address, subject, 'filter delivery')
        const filed = created.status === 201 ? await delivered(until, mailbox, target.folder, subject) : null
        check('SUBJECT-INVOICE-FILES-INTO-FOLDER', created.status === 201 && filed?.settled === true && only(filed.last, subject).length === 1, { create: created.status, filed: filed?.settled ?? false })
      } else check('SUBJECT-INVOICE-FILES-INTO-FOLDER', false, statusOf(target.created))
      const mixed = await mailbox.post(`${API}/filters`, { name: `xq-${tag}-mix`, matchAll: false, conditions: [condition('a'), condition('b'), condition('c')], actions: [{ type: 'keep' }] })
      if (typeof mixed.data?.filter?.id === 'string') undo('saved mixed filter', removeFilter(mailbox, mixed.data.filter.id))
      check('ANYOF-CONDITIONS-COMPILED', mixed.status === 201 && /\banyof\s*\(/.test(mixed.data?.filter?.compiledSieve ?? ''), statusOf(mixed))
      refused('PIPE-ACTION-FEATURE-DISABLED', await mailbox.post(`${API}/filters`, { name: `xq-${tag}-pipe`, conditions: [condition('pipe')], actions: [{ type: 'pipe', target: '/bin/true' }] }), 'VALIDATION')
    },
  }),

  tool('webmail-filter-test', {
    prefix: 'WMFT', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/webmail\/(?:filters(?:\/test|\/[0-9a-f-]{36})?|inbox\?folder=INBOX)$/,
    unit: [{ id: 'WMFT-UNIT-DRYRUN', file: 'apps/api/src/completion-security-email-filters.test.ts', name: 'mail-filter configuration HTTP security acceptance with disposable state dry-runs a sample message through account-wide then mailbox rules without writing, hiding rules the caller may not read' }],
    checks: ['SUBJECT-CONDITION-TRUE', 'DISPOSITION-SAVE-TO-BILLING', 'NO-MESSAGE-WRITTEN'],
    async run({ mailbox, tag, check, undo }) {
      const ids = ['SUBJECT-CONDITION-TRUE', 'DISPOSITION-SAVE-TO-BILLING', 'NO-MESSAGE-WRITTEN'], folder = `INBOX.xq-${tag}`
      const created = await mailbox.post(`${API}/filters`, { name: `xq-${tag}`, conditions: [{ field: 'subject', comparator: 'contains', value: 'invoice' }], actions: [{ type: 'fileinto', target: folder }] })
      const id = created.data?.filter?.id
      if (typeof id === 'string') undo('saved filter', removeFilter(mailbox, id))
      if (created.status !== 201) return failAll(check, ids, statusOf(created))
      const before = await mailbox.get(folderQuery('INBOX'))
      const trace = await mailbox.post(`${API}/filters/test`, { message: { subject: 'invoice 42' } })
      const step = trace.data?.rules?.find(rule => rule.id === id), after = await mailbox.get(folderQuery('INBOX'))
      check('SUBJECT-CONDITION-TRUE', trace.status === 200 && step?.tests?.[0]?.matched === true, { status: trace.status, matched: step?.matched ?? null })
      check('DISPOSITION-SAVE-TO-BILLING', trace.status === 200 && trace.data?.outcome?.folders?.includes(folder) === true, { status: trace.status })
      check('NO-MESSAGE-WRITTEN', before.status === 200 && after.status === 200 && messagesOf(before).length === messagesOf(after).length, { before: messagesOf(before).length, after: messagesOf(after).length })
    },
  }),

  tool('webmail-autoresponder', {
    prefix: 'WMAR', as: 'mailbox', also: ['owner'], needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 80, deadlineMs: 240000,
    paths: /^\/api\/(?:webmail\/(?:vacation|send|inbox\?folder=INBOX)|service-users(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'WMAR-UNIT-WINDOW', file: 'apps/api/src/mail/vacation-workspace.test.ts', name: 'vacation workspace sealed fields accepts independent whole-second UTC bounds and strictly ordered windows' }],
    checks: ['ONE-REPLY-PER-SENDER-INSIDE-INTERVAL', 'STOP-BEFORE-START-INVALID-SCHEDULE', 'SECOND-AUTORESPONDER-AUTORESPONDER-EXISTS'],
    async run({ mailbox, owner, fixture, tag, check, refused, signIn, sleep, until, undo }) {
      const view = await mailbox.get(`${API}/vacation`), fields = { enabled: true, subject: `xq-${tag}-away`, body: 'away', htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 24 }
      if (view.status !== 200) return failAll(check, ['ONE-REPLY-PER-SENDER-INSIDE-INTERVAL', 'STOP-BEFORE-START-INVALID-SCHEDULE', 'SECOND-AUTORESPONDER-AUTORESPONDER-EXISTS'], statusOf(view))
      undo('autoresponder', async () => {
        const now = await mailbox.get(`${API}/vacation`)
        if (now.status !== 200) return false
        if (!now.data.vacation?.enabled) return true
        const off = await mailbox.put(`${API}/vacation`, { ...fields, enabled: false, expectedRevision: now.data.revision })
        return off.status === 200 && off.data?.vacation?.enabled === false
      })
      refused('STOP-BEFORE-START-INVALID-SCHEDULE', await mailbox.put(`${API}/vacation`, { ...fields, startDate: '2030-01-02T00:00:00.000Z', endDate: '2030-01-01T00:00:00.000Z', expectedRevision: view.data.revision }), 'VALIDATION')
      const first = await mailbox.put(`${API}/vacation`, { ...fields, expectedRevision: view.data.revision })
      if (first.status !== 200) return failAll(check, ['ONE-REPLY-PER-SENDER-INSIDE-INTERVAL', 'SECOND-AUTORESPONDER-AUTORESPONDER-EXISTS'], statusOf(first))
      refused('SECOND-AUTORESPONDER-AUTORESPONDER-EXISTS', await mailbox.put(`${API}/vacation`, { ...fields, expectedRevision: view.data.revision }), 'CONFLICT')
      const senderLogin = `ar${tag}@${fixture.domain}`, senderSecret = `Xq-${tag}-Ar6!vP3#nK8zLm2`
      const senderCreated = await owner.post('/api/service-users', { login: senderLogin, password: senderSecret, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 32 })
      const senderId = senderCreated.data?.serviceUser?.id
      if (senderCreated.status === 201 && typeof senderId === 'string') {
        undo('autoresponder sender', async () => {
          const removed = await owner.delete(`/api/service-users/${senderId}`)
          if ([200, 202, 204, 404].includes(removed.status)) return true
          if (removed.status !== 412) return false
          const listed = await owner.get('/api/service-users')
          return listed.status === 200 && !(listed.data?.serviceUsers ?? []).some(item => item?.id === senderId)
        })
      }
      let senderClient = null
      for (let attempt = 0; attempt < 2 && senderCreated.status === 201 && !senderClient; attempt++) {
        const session = await signIn('mailbox', { username: senderLogin, password: senderSecret })
        senderClient = session.client
        if (session.response?.status === 403 || session.response?.status === 429) break
        if (!senderClient) await sleep(1500)
      }
      if (!senderClient) return check('ONE-REPLY-PER-SENDER-INSIDE-INTERVAL', false, { senderCreated: senderCreated.status })
      await sendTo(senderClient, fixture.mailbox.address, `xq-${tag}-in1`, 'first trigger')
      await sendTo(senderClient, fixture.mailbox.address, `xq-${tag}-in2`, 'second trigger')
      const both = await until(() => mailbox.get(folderQuery('INBOX')), response => hasSubject(response, `xq-${tag}-in1`) && hasSubject(response, `xq-${tag}-in2`), { attempts: 12, delayMs: 2000 })
      const replied = both.settled ? await until(() => senderClient.get(folderQuery('INBOX')), response => response.status === 200 && messagesOf(response).some(item => String(item.subject ?? '').includes(`xq-${tag}-away`)), { attempts: 10, delayMs: 2000 }) : null
      if (replied?.settled) await sleep(2000)
      const afterWait = replied?.settled ? await senderClient.get(folderQuery('INBOX')) : null
      const replies = afterWait ? messagesOf(afterWait).filter(item => String(item.subject ?? '').includes(`xq-${tag}-away`)).length : null
      check('ONE-REPLY-PER-SENDER-INSIDE-INTERVAL', both.settled && replied?.settled === true && replies === 1, { bothDelivered: both.settled, replies })
    },
  }),

  tool('webmail-spam-autodelete', {
    prefix: 'WMSD', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/webmail\/spam-preferences$/,
    page: { route: '/mail/settings/spam', read: `${API}/spam-preferences`, shows: () => ['Spam'] },
    unit: [{ id: 'WMSD-UNIT-SCORES', file: 'apps/api/src/mail/mailbox-spam.test.ts', name: 'sealed mailbox spam preferences refuses selectors, unknown fields, invalid scores and contradictory sender lists' }],
    checks: ['THRESHOLD-0-OUT-OF-RANGE', 'THRESHOLD-51-OUT-OF-RANGE', 'CUSTOM-THRESHOLD-SAVED', 'CONTRADICTORY-LISTS-REFUSED'],
    async run({ mailbox, check, refused, undo }) {
      const view = await mailbox.get(`${API}/spam-preferences`)
      if (view.status !== 200) return failAll(check, ['THRESHOLD-0-OUT-OF-RANGE', 'THRESHOLD-51-OUT-OF-RANGE', 'CUSTOM-THRESHOLD-SAVED', 'CONTRADICTORY-LISTS-REFUSED'], statusOf(view))
      const initial = view.data
      undo('spam preferences', async () => {
        const now = await mailbox.get(`${API}/spam-preferences`)
        if (now.status !== 200) return false
        if (JSON.stringify(spamFields(now.data)) === JSON.stringify(spamFields(initial))) return true
        const back = await mailbox.put(`${API}/spam-preferences`, { ...spamFields(initial), expectedRevision: now.data.revision })
        const read = await mailbox.get(`${API}/spam-preferences`)
        return back.status === 200 && read.status === 200 && JSON.stringify(spamFields(read.data)) === JSON.stringify(spamFields(initial))
      })
      let revision = initial.revision
      for (const [id, score] of [['THRESHOLD-0-OUT-OF-RANGE', 0], ['THRESHOLD-51-OUT-OF-RANGE', 51]]) {
        const response = await mailbox.put(`${API}/spam-preferences`, { ...spamFields(initial), inherit: false, enabled: true, autoDeleteScore: score, expectedRevision: revision })
        refused(id, response, 'VALIDATION')
        if (response.status === 200) revision = response.data.revision
      }
      const threshold = Math.max(8, initial.inherited?.autoDeleteFloor ?? 1)
      const saved = await mailbox.put(`${API}/spam-preferences`, { ...spamFields(initial), inherit: false, enabled: true, autoDeleteScore: threshold, expectedRevision: revision })
      check('CUSTOM-THRESHOLD-SAVED', saved.status === 200 && saved.data?.preferences?.autoDeleteScore === threshold && saved.data?.preferences?.inherit === false, statusOf(saved))
      if (saved.status === 200) revision = saved.data.revision
      refused('CONTRADICTORY-LISTS-REFUSED', await mailbox.put(`${API}/spam-preferences`, { ...spamFields(initial), inherit: false, allowlist: ['same@example.org'], blocklist: ['same@example.org'], expectedRevision: revision }), 'VALIDATION')
    },
  }),

  tool('webmail-mail-client-setup', {
    prefix: 'WMCS', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/webmail\/connect-devices(?:\/(?:autoconfig\.xml|send-instructions))?$/,
    page: { route: '/mail/tools/connect-devices', read: `${API}/connect-devices`, shows: data => [data?.mailbox] },
    unit: [
      { id: 'WMCS-UNIT-SETTINGS', file: 'apps/api/src/mail/device-setup.test.ts', name: 'mail client settings from trusted configuration returns the sealed mailbox as username, rendered ports and no password' },
      { id: 'WMCS-UNIT-SEND', file: 'apps/web/src/mail-connect-devices-client.test.ts', name: 'xMail connect devices workspace sends the instructions to one address and reports refusals without a false success' },
    ],
    checks: ['AUTOCONFIG-IMAP-993-SSL-SMTP-465-SSL-USERNAME', 'INSTRUCTIONS-TO-INVALID-ADDRESS-INVALID-EMAIL'],
    async run({ mailbox, fixture, check, refused }) {
      const address = fixture.mailbox.address
      const config = await mailbox.get(`${API}/connect-devices/autoconfig.xml`).catch(() => null)
      const text = config?.text ?? ''
      check('AUTOCONFIG-IMAP-993-SSL-SMTP-465-SSL-USERNAME', config?.status === 200 && /<incomingServer type="imap">[^]*?<port>993<\/port>[^]*?<socketType>SSL<\/socketType>/.test(text) && /<outgoingServer type="smtp">[^]*?<port>465<\/port>[^]*?<socketType>SSL<\/socketType>/.test(text) && text.includes(`<username>${address}</username>`), { status: config?.status ?? null })
      refused('INSTRUCTIONS-TO-INVALID-ADDRESS-INVALID-EMAIL', await mailbox.post(`${API}/connect-devices/send-instructions`, { email: 'not-an-address' }), 'VALIDATION')
    },
  }),

  tool('webmail-mailing-lists', {
    prefix: 'WMLS', as: 'mailbox', also: ['owner'], needs: ['account', 'mailbox'], probe: `${API}/inbox`,
    paths: /^\/api\/(?:webmail\/mailing-lists(?:\/[0-9a-f-]{36}\/subscription)?|mail\/mailing-lists(?:\/[0-9a-f-]{36})?)$/,
    page: { route: '/mail/tools/mailing-lists', read: `${API}/mailing-lists`, shows: () => ['Mailing lists'] },
    unit: [{ id: 'WMLS-UNIT-VIEW', file: 'apps/api/src/mail/mailbox-mailing-lists.test.ts', name: 'sealed mailbox mailing-list subscriptions shows only public or current bound memberships, with no member addresses or counts' }],
    checks: ['NO-ADMINISTERED-LIST-EMPTY-TABLE', 'PRIVATE-SELF-SUBSCRIBE-REFUSED', 'OPEN-SELF-SUBSCRIBE-SUBSCRIBED'],
    async run({ mailbox, owner, fixture, tag, check, undo }) {
      const empty = await mailbox.get(`${API}/mailing-lists`)
      check('NO-ADMINISTERED-LIST-EMPTY-TABLE', empty.status === 200 && Array.isArray(empty.data?.lists) && empty.data.lists.length === 0, { status: empty.status, rows: empty.data?.lists?.length ?? null })
      const closed = await owner.post('/api/mail/mailing-lists', { name: `xq-${tag}-c`, address: `xqc${tag}@${fixture.domain}`, moderation: 'members', selfSubscription: 'closed' })
      const closedId = closed.data?.mailingList?.id
      if (typeof closedId === 'string') undo('private mailing list', async () => [200, 204, 404].includes((await owner.delete(`/api/mail/mailing-lists/${closedId}`)).status))
      const closedJoin = typeof closedId === 'string' ? await mailbox.put(`${API}/mailing-lists/${closedId}/subscription`, { subscribed: true, expectedRevision: '0'.repeat(64) }) : { status: 0 }
      const closedView = typeof closedId === 'string' ? await mailbox.get(`${API}/mailing-lists`) : { status: 0 }
      check('PRIVATE-SELF-SUBSCRIBE-REFUSED', typeof closedId === 'string' && closedJoin.status === 404 && closedView.status === 200 && !(closedView.data?.lists ?? []).some(item => item.id === closedId), { join: closedJoin.status, listed: closedView.status })
      const open = await owner.post('/api/mail/mailing-lists', { name: `xq-${tag}-o`, address: `xqo${tag}@${fixture.domain}`, moderation: 'members', selfSubscription: 'open' })
      const openId = open.data?.mailingList?.id
      if (typeof openId === 'string') undo('open mailing list', async () => [200, 204, 404].includes((await owner.delete(`/api/mail/mailing-lists/${openId}`)).status))
      const beforeJoin = typeof openId === 'string' ? await mailbox.get(`${API}/mailing-lists`) : { status: 0 }
      const openRow = (beforeJoin.data?.lists ?? []).find(item => item.id === openId)
      const openJoin = openRow ? await mailbox.put(`${API}/mailing-lists/${openId}/subscription`, { subscribed: true, expectedRevision: openRow.revision }) : { status: 0 }
      check('OPEN-SELF-SUBSCRIBE-SUBSCRIBED', openJoin.status === 200 && openJoin.data?.lists?.find(item => item.id === openId)?.membership === 'subscribed', { join: openJoin.status, listed: beforeJoin.status })
    },
  }),

  tool('webmail-track-delivery', {
    prefix: 'WMTD', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 45, deadlineMs: 240000,
    paths: /^\/api\/webmail\/(?:send|track-delivery)$/,
    page: { route: '/mail/tools/track-delivery', read: `${API}/track-delivery`, shows: data => [data?.mailbox] },
    unit: [{ id: 'WMTD-UNIT-SCOPE', file: 'apps/api/src/mail-log-workspace.test.ts', name: 'xMail track delivery route derives the address only from the sealed mailbox session and re-checks it after the read' }],
    checks: ['FAILED-RECIPIENT-LISTED-STATUS-ERROR-WITH-REPLY', 'OTHER-MAILBOXES-EXCLUDED'],
    async run({ mailbox, fixture, tag, check, until }) {
      const address = fixture.mailbox.address, recipient = `nobody@xq-${tag}.example.org`
      const before = await mailbox.get(`${API}/track-delivery`)
      const priorIds = new Set((before.data?.messages ?? []).map(item => item.queueId).filter(Boolean))
      const sent = await sendTo(mailbox, recipient, `xq-${tag}-track`, 'delivery tracking test')
      const matchesFailure = item => !priorIds.has(item.queueId) && item.role === 'sender' && item.sender === address && item.otherRecipients >= 1 && ['bounced', 'deferred', 'rejected'].includes(item.status)
      const seen = sent.status === 201
        ? await until(() => mailbox.get(`${API}/track-delivery`), response => response.status === 200 && (response.data?.messages ?? []).some(matchesFailure), { attempts: 20, delayMs: 3000 })
        : { settled: false, last: before }
      const log = seen.last, mine = (log.data?.messages ?? []).find(matchesFailure)
      check('FAILED-RECIPIENT-LISTED-STATUS-ERROR-WITH-REPLY', sent.status === 201 && seen.settled && ['bounced', 'deferred', 'rejected'].includes(mine?.status) && typeof mine?.dsn === 'string' && mine.dsn.length > 0,
        { send: sent.status, listed: seen.settled, status: typeof mine?.status === 'string' && /^[a-z-]{1,16}$/.test(mine.status) ? mine.status : null })
      const everyone = log.data?.messages ?? []
      check('OTHER-MAILBOXES-EXCLUDED', log.status === 200 && log.data?.mailbox === address && everyone.length > 0 && everyone.every(item => (item.sender === address || (item.recipients ?? []).some(entry => entry.address === address)) && (item.recipients ?? []).every(entry => entry.address === address)), { status: log.status, rows: everyone.length })
    },
  }),

  tool('webmail-two-factor', {
    prefix: 'WMTF', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${API}/inbox`, requests: 25,
    paths: /^\/api\/webmail\/security(?:\/2fa\/(?:setup|enable|disable))?$/,
    unit: [{ id: 'WMTF-UNIT-RECOVERY', file: 'apps/api/src/entry-points-security.test.ts', name: 'interactive entry point isolation on real HTTP and WebSocket listeners retains root bootstrap, TOTP and single-use recovery inside the administrative audience' }],
    checks: ['WRONG-SETUP-CODE-INVALID-TOTP', 'TWO-FACTOR-STAYS-OFF-AFTER-WRONG-CODE', 'PASSWORD-ONLY-LOGIN-TOTP-REQUIRED'],
    async run({ mailbox, fixture, check, refused, signIn, undo }) {
      const password = fixture.mailbox.password, setup = await mailbox.post(`${API}/security/2fa/setup`, { password })
      const secret = setup.data?.secret, recoveryCode = setup.data?.recoveryCodes?.[0]
      if (setup.status !== 200 || typeof secret !== 'string') return failAll(check, ['WRONG-SETUP-CODE-INVALID-TOTP', 'TWO-FACTOR-STAYS-OFF-AFTER-WRONG-CODE', 'PASSWORD-ONLY-LOGIN-TOTP-REQUIRED'], statusOf(setup))
      undo('two-factor', async () => {
        const now = await mailbox.get(`${API}/security`)
        if (now.status !== 200) return false
        if (!now.data?.enrolled && !now.data?.totpEnabled) return true
        const off = await mailbox.post(`${API}/security/2fa/disable`, typeof recoveryCode === 'string' ? { password, recoveryCode } : { password, code: totp(secret, 1) })
        return off.status === 200 && (await mailbox.get(`${API}/security`)).data?.enrolled === false
      })
      refused('WRONG-SETUP-CODE-INVALID-TOTP', await mailbox.post(`${API}/security/2fa/enable`, { code: '000000' }), 'VALIDATION')
      const sec = await mailbox.get(`${API}/security`)
      check('TWO-FACTOR-STAYS-OFF-AFTER-WRONG-CODE', sec.status === 200 && sec.data?.totpEnabled === false && sec.data?.enrolled === false, statusOf(sec))
      const on = await mailbox.post(`${API}/security/2fa/enable`, { code: totp(secret) })
      const plain = on.status === 200 ? await signIn('mailbox', { username: fixture.mailbox.address, password }) : null
      if (plain) refused('PASSWORD-ONLY-LOGIN-TOTP-REQUIRED', plain.response, 'UNAUTHENTICATED')
      else check('PASSWORD-ONLY-LOGIN-TOTP-REQUIRED', false, { enable: on.status })
      if (on.status === 200 && typeof recoveryCode === 'string') await mailbox.post(`${API}/security/2fa/disable`, { password, recoveryCode })
    },
  }),
]
