import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
const PGP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PGP_FP = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/
const PGP_REV = /^[a-f0-9]{64}$/
interface PgpClientKey { fingerprint: string; uids: string[]; algorithm: string; bits: number; created: string; expires: string | null; hasSecret: boolean; encryption: boolean }
export interface PgpClientView { revision: string; keys: PgpClientKey[]; mailboxes: string[]; application: { status: string; fingerprint: string | null }; capabilities: { generate: boolean; import: boolean; export: boolean; delete: boolean } }
const pgpObject = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const pgpExact = (raw: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(raw).length === fields.length && fields.every(field => Object.hasOwn(raw, field))
export function readPgpView(raw: unknown, accountId: string, status = 'read'): PgpClientView {
  if (!PGP_ID.test(accountId) || !pgpObject(raw) || !pgpExact(raw, ['context', 'revision', 'keys', 'mailboxes', 'application', 'capabilities', 'scope', 'messageEncryption']) || !pgpObject(raw.context) || !pgpExact(raw.context, ['accountId', 'username']) || raw.context.accountId !== accountId || typeof raw.context.username !== 'string' || !/^[a-z][a-z0-9]{1,15}$/.test(raw.context.username) || raw.scope !== 'account-keyring' || raw.messageEncryption !== false || typeof raw.revision !== 'string' || !PGP_REV.test(raw.revision) || !pgpObject(raw.application) || !pgpExact(raw.application, ['status', 'fingerprint']) || raw.application.status !== status || !(raw.application.fingerprint === null ? status === 'read' : typeof raw.application.fingerprint === 'string' && PGP_FP.test(raw.application.fingerprint)) || !pgpObject(raw.capabilities) || !pgpExact(raw.capabilities, ['generate', 'import', 'export', 'delete']) || Object.values(raw.capabilities).some(value => typeof value !== 'boolean')) throw new Error('invalid_pgp_reply')
  if (!Array.isArray(raw.keys) || raw.keys.length > 100 || !Array.isArray(raw.mailboxes) || raw.mailboxes.length > 10000 || raw.mailboxes.some(address => typeof address !== 'string' || address.length > 320 || !/^[^\s<>@]+@[^\s<>@]+$/.test(address)) || new Set(raw.mailboxes).size !== raw.mailboxes.length) throw new Error('invalid_pgp_reply')
  const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value) && Number.isFinite(Date.parse(value))
  for (const key of raw.keys) if (!pgpObject(key) || !pgpExact(key, ['fingerprint', 'uids', 'algorithm', 'bits', 'created', 'expires', 'hasSecret', 'encryption']) || typeof key.fingerprint !== 'string' || !PGP_FP.test(key.fingerprint) || !Array.isArray(key.uids) || key.uids.length < 1 || key.uids.length > 32 || key.uids.some(uid => typeof uid !== 'string' || uid.length > 512 || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(uid)) || !['RSA', 'DSA', 'ElGamal', 'ECDH', 'ECDSA', 'Ed25519', 'X25519'].includes(key.algorithm as string) || !Number.isInteger(key.bits) || Number(key.bits) < 1 || Number(key.bits) > 65536 || !date(key.created) || !(key.expires === null || date(key.expires)) || typeof key.hasSecret !== 'boolean' || typeof key.encryption !== 'boolean') throw new Error('invalid_pgp_reply')
  const keys = raw.keys as PgpClientKey[]
  if (new Set(keys.map(key => key.fingerprint)).size !== keys.length || status === 'read' && raw.application.fingerprint !== null) throw new Error('invalid_pgp_reply')
  return { revision: raw.revision, keys, mailboxes: raw.mailboxes as string[], application: raw.application as PgpClientView['application'], capabilities: raw.capabilities as PgpClientView['capabilities'] }
}
export function bindAccountPgp(askDialog: ((options: { title: string; body: string; danger: boolean; confirm: string }) => Promise<boolean>) | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-account-pgp]').forEach(root => {
    if (root.dataset.pgpBound) return; root.dataset.pgpBound = '1'
    const t = (message: string, values?: MessageValues) => xpT(message, values), accountId = root.dataset.account ?? ''
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
    const rows = query<HTMLTableSectionElement>('[data-pgp-rows]'), status = query<HTMLElement>('[data-pgp-status]'), refresh = query<HTMLButtonElement>('[data-pgp-refresh]'), generate = query<HTMLButtonElement>('[data-pgp-generate]'), importButton = query<HTMLButtonElement>('[data-pgp-import]'), deleteButton = query<HTMLButtonElement>('[data-pgp-delete]')
    const name = query<HTMLInputElement>('[data-pgp-name]'), address = query<HTMLSelectElement>('[data-pgp-address]'), algorithm = query<HTMLSelectElement>('[data-pgp-algorithm]'), days = query<HTMLInputElement>('[data-pgp-days]'), passphrase = query<HTMLInputElement>('[data-pgp-passphrase]'), file = query<HTMLInputElement>('[data-pgp-file]'), confirmation = query<HTMLInputElement>('[data-pgp-confirm]'), selectedLabel = query<HTMLElement>('[data-pgp-selected]')
    if (![rows, status, refresh, generate, importButton, deleteButton, name, address, algorithm, days, passphrase, file, confirmation, selectedLabel].every(Boolean)) return
    let view: PgpClientView | null = null, selected = '', busy = false, review = false
    const eligible = () => root.dataset.pgpManage === 'true' && PGP_ID.test(accountId) && !!send
    const note = (state: string, text: string) => { status.dataset.state = state; status.textContent = text; status.setAttribute('role', ['failed', 'uncertain', 'stale'].includes(state) ? 'alert' : 'status') }
    const lock = () => {
      const blocked = !eligible() || busy || review || !view
      for (const control of [name, address, algorithm, days, passphrase, file, confirmation]) control.disabled = blocked
      refresh.disabled = !eligible() || busy
      generate.disabled = blocked || !view?.capabilities.generate
      importButton.disabled = blocked || !view?.capabilities.import || !file.files?.length
      deleteButton.disabled = blocked || !view?.capabilities.delete || !selected || confirmation.value !== selected
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = blocked })
      rows.querySelectorAll<HTMLAnchorElement>('a').forEach(anchor => { if (blocked || !view?.capabilities.export) { anchor.removeAttribute('href'); anchor.setAttribute('aria-disabled', 'true') } else { anchor.href = anchor.dataset.pgpHref!; anchor.removeAttribute('aria-disabled') } })
      root.setAttribute('aria-busy', String(busy))
    }
    const text = (parent: HTMLElement, value: string, technical = false) => { const node = document.createElement(technical ? 'bdi' : 'span'); if (technical) node.dir = 'ltr'; node.textContent = value; parent.append(node); return node }
    const paint = () => {
      if (!view) return; rows.replaceChildren()
      if (!view.keys.length) { const row = rows.insertRow(); const cell = row.insertCell(); cell.colSpan = 5; cell.textContent = t('No keys have been saved.') }
      for (const key of view.keys) {
        const row = rows.insertRow(), identity = document.createElement('div'); row.insertCell().append(identity); identity.style.display = 'grid'; identity.style.gap = '8px'
        for (const uid of key.uids) text(identity, uid, true); text(identity, key.fingerprint, true)
        text(row.insertCell(), key.algorithm + ' / ' + String(key.bits), true)
        const dateCell = document.createElement('div'); row.insertCell().append(dateCell); dateCell.style.display = 'grid'; dateCell.style.gap = '8px'; text(dateCell, key.created.slice(0, 10), true); text(dateCell, key.expires?.slice(0, 10) ?? t('Does not expire'), !!key.expires)
        text(row.insertCell(), key.hasSecret ? t('Present') : t('Public only'))
        const actions = document.createElement('div'); row.insertCell().append(actions); actions.className = 'xp-acct-tool__actions'
        const download = document.createElement('a'); download.className = 'xp-btn'; download.textContent = t('Export public key'); download.dataset.pgpHref = '/api/account/pgp/' + key.fingerprint + '/public'; download.download = 'openpgp-' + key.fingerprint + '.asc'; actions.append(download)
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'xp-btn'; remove.textContent = t('Delete'); remove.addEventListener('click', () => { selected = key.fingerprint; selectedLabel.textContent = selected; confirmation.value = ''; confirmation.focus(); lock() }); actions.append(remove)
      }
      const previous = address.value; address.replaceChildren()
      for (const mailbox of view.mailboxes) { const option = document.createElement('option'); option.value = mailbox; option.textContent = mailbox; address.append(option) }
      if (view.mailboxes.includes(previous)) address.value = previous
      if (!view.keys.some(key => key.fingerprint === selected)) { selected = ''; selectedLabel.textContent = '—'; confirmation.value = '' }
    }
    const read = async (): Promise<void> => {
      if (!eligible() || busy) return; busy = true; lock(); note('reading', t('Reading keys…'))
      try { view = readPgpView(await send!('GET', '/api/account/pgp'), accountId); review = false; paint(); note('read', t('Keyring read. Message encryption is not enabled by this page.')) }
      catch { review = true; note('failed', t('The keyring is unavailable. No operation was requested.')) }
      finally { busy = false; lock() }
    }
    const mutate = async (op: 'generate' | 'import' | 'delete', body: Record<string, unknown>): Promise<void> => {
      if (!eligible() || busy || review || !view) return
      const old = view; busy = true; lock(); note('saving', t('Applying the key operation…'))
      try {
        const expected = op === 'generate' ? 'generated' : op === 'import' ? 'imported' : 'deleted'
        const ack = readPgpView(await send!(op === 'delete' ? 'DELETE' : 'POST', '/api/account/pgp', { op, expectedRevision: old.revision, ...body }), accountId, expected)
        const fingerprint = ack.application.fingerprint
        if (!fingerprint || op === 'delete' && fingerprint !== body.fingerprint || op !== 'delete' && !ack.keys.some(key => key.fingerprint === fingerprint) || op === 'delete' && ack.keys.some(key => key.fingerprint === fingerprint) || ack.revision === old.revision) throw new Error('uncertain_pgp_ack')
        if (op === 'generate' && !ack.keys.some(key => key.fingerprint === fingerprint && key.hasSecret && key.encryption && key.uids.includes(body.name + ' <' + body.address + '>'))) throw new Error('uncertain_pgp_ack')
        const after = readPgpView(await send!('GET', '/api/account/pgp'), accountId)
        if (after.revision !== ack.revision || JSON.stringify(after.keys) !== JSON.stringify(ack.keys)) throw new Error('uncertain_pgp_readback')
        view = after; paint(); note('saved', t('The key operation was verified.'))
      } catch (error) {
        const value = pgpObject(error) ? error : {}, details = pgpObject(value.details) ? value.details : pgpObject(value.detail) ? value.detail : {}
        const unchanged = details.stateChanged === false && value.code !== 'CONFLICT'
        review = !unchanged
        note(unchanged ? 'failed' : value.code === 'CONFLICT' ? 'stale' : 'uncertain', unchanged ? t('The request was refused. Check the fields and mailbox ownership.') : t('Read the keyring before retrying. The operation may have taken effect.'))
      } finally { busy = false; lock() }
    }
    generate.addEventListener('click', () => {
      const secret = passphrase.value; passphrase.value = ''
      if (!name.value.trim() || secret.length < 12 || /[\r\n\x00]/.test(secret) || !/^[0-9]{1,4}$/.test(days.value) || Number(days.value) < 1 || Number(days.value) > 3650 || !view?.mailboxes.includes(address.value)) { note('failed', t('Use a name, a current mailbox, 1–3650 days and a passphrase of at least 12 characters.')); return }
      void mutate('generate', { name: name.value.trim(), address: address.value, algorithm: algorithm.value, days: Number(days.value), passphrase: secret })
    })
    importButton.addEventListener('click', async () => {
      const selectedFile = file.files?.[0]; file.value = ''; lock()
      if (!selectedFile || selectedFile.size > 262144) { note('failed', t('Choose one armored key file of at most 256 KiB.')); return }
      try { const armor = await selectedFile.text(); await mutate('import', { armor }) } catch { note('failed', t('The key file could not be read.')) }
    })
    deleteButton.addEventListener('click', async () => {
      if (!view || busy || review || confirmation.value !== selected || !askDialog) return
      const fingerprint = selected; busy = true; lock()
      let confirmed = false
      try { confirmed = await askDialog({ title: t('Delete key pair'), body: t('Delete the public and private key with fingerprint {fingerprint}', { fingerprint }), danger: true, confirm: t('Delete key pair') }) === true } finally { busy = false; lock() }
      if (confirmed && selected === fingerprint && confirmation.value === fingerprint) await mutate('delete', { fingerprint, confirmation: fingerprint })
    })
    refresh.addEventListener('click', () => { void read() }); file.addEventListener('change', lock); confirmation.addEventListener('input', lock)
    window.addEventListener('pagehide', () => { passphrase.value = ''; file.value = '' })
    if (!eligible()) { lock(); note('unavailable', t('OpenPGP key management is unavailable here.')); return }
    void read()
  })
}
export const ACCOUNT_PGP_CLIENT_BINDING = `(()=>{const PGP_ID=${PGP_ID.toString()};const PGP_FP=${PGP_FP.toString()};const PGP_REV=${PGP_REV.toString()};const pgpObject=${pgpObject.toString()};const pgpExact=${pgpExact.toString()};const readPgpView=${readPgpView.toString()};return ${bindAccountPgp.toString()};})()`
