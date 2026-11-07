/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { DISPLAY_DATETIME_BINDING } from './display-format.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
// Local names, so the serialized controller calls the helpers the binding defines, never module bindings.
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

/** Localized refusal for the stable reasons the SSL storage routes return; never echoes key material. */
export function sslStoreRefusal(error: unknown, t: (message: string, values?: MessageValues) => string): string {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const details = object(error) && object(error.details) ? error.details : {}
  const reasons: Record<string, string> = {
    key_format: t('The private key must be one unencrypted PEM key.'),
    key_encrypted: t('The private key is protected by a passphrase. Remove the passphrase and try again.'),
    key_strength: t('Only RSA keys of 2048 bits or more and EC P-256 or P-384 keys are supported.'),
    certificate_format: t('The certificate field must hold one PEM site certificate.'),
    leaf_ca: t('Store the site certificate, not a certificate authority.'),
    too_large: t('The PEM text is too large.'),
    names: t('List one host name per line; the first is the common name.'),
    subject: t('Use letters, digits, spaces and . , \' & ( ) _ @ - in the subject fields, and a two-letter country code.'),
    days: t('A self-signed certificate is valid for 1 to 3650 days.'),
    key_missing: t('No stored private key matches this certificate.'),
    capacity: t('The SSL storage already holds the maximum number of items of this kind.'),
    directory_unmanageable: t('The ~/ssl folder is not a plain folder. Fix it in the file manager first.'),
    openssl_unavailable: t('Certificate requests need openssl on this server.'),
    host_unavailable: t('SSL storage is unavailable on this server.'),
    default_key_type_unreadable: t('The default key type could not be read. Choose a key type.'),
    label: t('Use letters, digits, spaces and . , \' & ( ) _ - in the name, up to 64 characters.'),
    passphrase: t('The challenge passphrase is 4 to 64 printable ASCII characters without leading or trailing spaces.'),
    labels_unreadable: t('The saved names could not be read. Nothing was changed.'),
    index_unreadable: t('The server SSL storage index could not be read. Nothing was changed.'),
    self_signed: t('Mail clients refuse self-signed certificates. Install one a certificate authority issued.'),
    hostname_unset: t('Set the server hostname first.'),
    chain_order: t('The CA bundle is out of order. List it from the certificate that signed yours up to the root.'),
    service_install_unavailable: t('This service does not take a certificate from SSL storage.'),
  }
  return typeof details.reason === 'string' && reasons[details.reason] ? reasons[details.reason]! : t('The request was refused. Nothing was changed.')
}

interface StoreItem { id: string; label: string | null; modifiedAt: string; valid: boolean; publicKeySha256: string | null; keyType?: string | null; bits?: number | null; commonName?: string | null; names?: string[]; issuer?: string | null; selfSigned?: boolean | null; notAfter?: string | null }
interface StoreView { keys: StoreItem[]; csrs: StoreItem[]; certificates: StoreItem[]; keyTypes: string[]; defaultKeyType: string | null; limits: { truncated: boolean } }

/** Every request uses the session transport; key text appears only in the viewer after an explicit View. */
function bindSslStore(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, deps: { refusal: typeof sslStoreRefusal; displayDateTime: (value: string) => string }): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-ssl-store]').forEach(root => {
    if (root.dataset.sslStoreBound === 'true') return
    root.dataset.sslStoreBound = 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountSelect = root.querySelector<HTMLSelectElement>('select[data-ssl-store-account]')
    const status = root.querySelector<HTMLElement>('[data-ssl-store-status]')
    const tables: Record<'keys' | 'csrs' | 'certificates', HTMLElement | null> = { keys: root.querySelector('tbody[data-ssl-store-keys]'), csrs: root.querySelector('tbody[data-ssl-store-csrs]'), certificates: root.querySelector('tbody[data-ssl-store-certificates]') }
    const viewer = root.querySelector<HTMLElement>('[data-ssl-store-viewer]'), pemBox = root.querySelector<HTMLElement>('[data-ssl-store-pem]'), viewerTitle = root.querySelector<HTMLElement>('[data-ssl-store-viewer-title]')
    const installForm = root.querySelector<HTMLFormElement>('form[data-ssl-store-install-form]'), serviceForm = root.querySelector<HTMLFormElement>('form[data-ssl-store-service-form]')
    const username = (): string => accountSelect ? accountSelect.value : root.dataset.sslStoreUsername ?? ''
    // Root's own store: a server-scoped workspace, or the empty account choice where the page offers it.
    const server = (): boolean => root.dataset.sslStoreScope === 'server' || (!!accountSelect && accountSelect.value === '' && root.dataset.sslStoreServer === 'true')
    const admitted = (): boolean => root.isConnected && root.dataset.sslStoreCanManage === 'true' && (server() || /^[a-z][a-z0-9]{0,15}$/.test(username())) && typeof transport === 'function'
    const base = (): string => server() ? '/api/server/ssl' : '/api/accounts/' + encodeURIComponent(username()) + '/ssl'
    let view: StoreView | null = null, busy = false, uncertain = false, revision: number | null = null
    let actionTemplate: HTMLTemplateElement
    // Themes own the action button markup; without their template the workspace stays unavailable.
    try { actionTemplate = clientTemplate(root, 'ssl-store-action'); cloneClientTemplate(actionTemplate, 'button', ['label']) } catch { root.dataset.sslStoreState = 'unavailable'; return }
    if (!status) return
    const announce = (state: string, message: string): void => { status.hidden = false; status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const blocked = busy || uncertain || !admitted()
      root.setAttribute('aria-busy', String(busy))
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea').forEach(control => {
        if (control === accountSelect || control.closest('[data-ssl-store-viewer]')) control.disabled = busy || root.dataset.sslStoreCanManage !== 'true'
        else if (control.hasAttribute('data-ssl-store-refresh')) control.disabled = busy || !admitted()
        else control.disabled = blocked || !view
      })
    }
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => { if (!transport || !admitted()) throw { details: { stateChanged: false } }; return body === undefined ? transport(method, path) : transport(method, path, body) }
    const changedUnknown = (error: unknown): boolean => { const details = object(error) && object(error.details) ? error.details : {}; return details.stateChanged !== false || details.unknownOutcome === true || details.verificationRequired === true }
    const technical = (text: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = text; return node }
    const cell = (row: HTMLTableRowElement, content: string | Node): void => { const td = row.insertCell(); td.append(content) }
    const shortKey = (item: StoreItem): string => item.publicKeySha256 ? item.publicKeySha256.slice(0, 16) : t('Unreadable')
    const keyLabel = (item: StoreItem): string => !item.valid ? t('Unreadable file') : item.keyType === 'rsa' ? t('RSA, {bits}-bit', { bits: String(item.bits) }) : t('ECDSA, P-{bits}', { bits: String(item.bits) })
    const matchingKey = (item: StoreItem): boolean => !!item.publicKeySha256 && !!view?.keys.some(key => key.publicKeySha256 === item.publicKeySha256)
    const action = (label: string, run: () => void): HTMLElement => { const button = cloneClientTemplate(actionTemplate, 'button', ['label']); clientTemplateSlot(button, 'label').textContent = label; button.addEventListener('click', run); return button }
    const fillSelect = (select: HTMLSelectElement, options: [string, string][], keep = true): void => {
      const previous = select.value
      select.replaceChildren(...options.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option }))
      if (keep && options.some(([value]) => value === previous)) select.value = previous
    }
    const render = (): void => {
      for (const [kind, body] of Object.entries(tables) as ['keys' | 'csrs' | 'certificates', HTMLElement | null][]) {
        if (!body) continue
        const items = view?.[kind] ?? []
        const columns = body.closest('table')?.querySelectorAll('thead th').length ?? 1
        if (!items.length) { const row = document.createElement('tr'), td = row.insertCell(); td.colSpan = columns; td.textContent = view ? t('Nothing is stored yet.') : t('SSL storage has not been read.'); body.replaceChildren(row); continue }
        body.replaceChildren(...items.map(item => {
          const row = document.createElement('tr'), names = (item.names ?? []).join(', ')
          const identity = document.createElement('span')
          if (item.label) identity.append(item.label, ' ')
          identity.append(technical(item.id))
          cell(row, identity)
          if (kind === 'keys') cell(row, keyLabel(item))
          else cell(row, item.valid ? technical(names || item.commonName || '') : t('Unreadable file'))
          if (kind === 'certificates') {
            cell(row, !item.valid ? '' : item.selfSigned ? t('Self-signed') : technical(item.issuer ?? ''))
            cell(row, item.notAfter ? technical(deps.displayDateTime(item.notAfter)) : '')
            cell(row, matchingKey(item) ? t('Matching key stored') : t('No matching key stored'))
          }
          cell(row, technical(shortKey(item)))
          const actions = document.createElement('div'); actions.dataset.sslStoreActions = ''
          const kindName = kind === 'keys' ? 'key' : kind === 'csrs' ? 'csr' : 'certificate'
          if (item.valid) actions.append(action(t(msgctxt('ssl-store', 'View')), () => { void show(kind, item) }))
          if (kind === 'certificates' && installForm && item.valid && matchingKey(item)) actions.append(action(t(msgctxt('ssl-store', 'Install')), () => { const select = installForm.querySelector<HTMLSelectElement>('select[name="storeCertificateId"]'); if (select) { select.value = item.id; select.focus() } }))
          actions.append(action(t(msgctxt('ssl-store', 'Rename')), () => { void rename(kind, item) }))
          actions.append(action(t(msgctxt('ssl-store', 'Delete')), () => { void remove(kind, kindName, item) }))
          cell(row, actions)
          return row
        }))
      }
      const keyOptions: [string, string][] = (view?.keys ?? []).filter(item => item.valid).map(item => [item.id, item.id + ' (' + keyLabel(item) + ')'])
      root.querySelectorAll<HTMLSelectElement>('select[name="keyId"]').forEach(select => fillSelect(select, [['', t('Generate a new key')], ...keyOptions]))
      root.querySelectorAll<HTMLSelectElement>('select[name="keyType"]').forEach(select => {
        const fresh = !select.options.length
        fillSelect(select, (view?.keyTypes ?? []).map(type => [type, ({ 'rsa-2048': t('RSA, 2048-bit'), 'rsa-4096': t('RSA, 4096-bit'), 'ecdsa-prime256v1': t('ECDSA, P-256'), 'ecdsa-secp384r1': t('ECDSA, P-384') } as Record<string, string>)[type] ?? type]))
        if (fresh && view?.defaultKeyType) select.value = view.defaultKeyType
      })
      for (const form of [installForm, serviceForm]) {
        const select = form?.querySelector<HTMLSelectElement>('select[name="storeCertificateId"]')
        if (select) fillSelect(select, (view?.certificates ?? []).filter(item => item.valid && matchingKey(item)).map(item => [item.id, (item.label ? item.label + ' ' : '') + item.id + ' (' + (item.names ?? []).join(', ') + ')']))
      }
      lock()
    }
    const load = async (message?: string): Promise<void> => {
      if (busy || !admitted()) { lock(); return }
      busy = true; lock(); announce('pending', t('Reading SSL storage…'))
      try {
        const reply = await request('GET', base())
        if (!object(reply) || !Array.isArray(reply.keys) || !Array.isArray(reply.csrs) || !Array.isArray(reply.certificates) || !Array.isArray(reply.keyTypes)) throw new Error('invalid_ssl_store')
        view = reply as unknown as StoreView
        if (installForm && !server()) {
          const workspace = await request('GET', '/api/accounts/' + encodeURIComponent(username()) + '/certificates')
          if (!object(workspace) || typeof workspace.revision !== 'number' || !Array.isArray(workspace.domains)) throw new Error('invalid_certificate_workspace')
          revision = workspace.revision
          const domain = installForm.querySelector<HTMLSelectElement>('select[name="domain"]')
          if (domain) fillSelect(domain, (workspace.domains as Record<string, unknown>[]).filter(item => typeof item.name === 'string').map(item => [item.name as string, item.name as string]))
        }
        announce('read', message ?? (view.limits.truncated ? t('SSL storage read. Only the first items of each kind are listed.') : server() ? t('The server SSL storage was read.') : t('SSL storage read from ~/ssl of this account.')))
      } catch (error) { view = null; announce('failed', deps.refusal(error, t)) }
      finally { busy = false; render() }
    }
    const mutate = async (method: string, path: string, body: unknown, success: string | ((reply: Record<string, unknown>) => string)): Promise<boolean> => {
      if (busy || uncertain || !admitted()) return false
      busy = true; lock(); announce('pending', t('Saving…'))
      try {
        const reply = await request(method, path, body)
        if (path.endsWith('/install')) { if (!object(reply) || !object(reply.certificate)) throw new Error('invalid_install') }
        else if (!object(reply) || !Array.isArray(reply.keys)) throw new Error('invalid_ssl_store')
        else view = reply as unknown as StoreView
        busy = false
        const message = typeof success === 'string' ? success : success(reply as Record<string, unknown>)
        if (path.endsWith('/install')) await load(message); else { render(); announce('saved', message) }
        return true
      } catch (error) {
        if (changedUnknown(error)) { uncertain = true; announce('uncertain', t('The outcome could not be verified. Read the storage again before any other change.')) }
        else announce('failed', deps.refusal(error, t))
        return false
      } finally { busy = false; lock() }
    }
    const show = async (kind: string, item: StoreItem): Promise<void> => {
      if (busy || !viewer || !pemBox) return
      busy = true; lock()
      try {
        const reply = await request('GET', base() + '/' + kind + '/' + encodeURIComponent(item.id))
        if (!object(reply) || typeof reply.pem !== 'string') throw new Error('invalid_item')
        pemBox.textContent = reply.pem
        if (viewerTitle) viewerTitle.textContent = item.id
        viewer.hidden = false
        viewer.querySelector<HTMLElement>('[data-ssl-store-viewer-close]')?.focus()
      } catch (error) { announce('failed', deps.refusal(error, t)) }
      finally { busy = false; lock() }
    }
    const remove = async (kind: string, kindName: string, item: StoreItem): Promise<void> => {
      let confirmed = false
      try { confirmed = !!askDialog && await askDialog({ title: kindName === 'key' ? t('Delete this private key?') : kindName === 'csr' ? t('Delete this signing request?') : t('Delete this stored certificate?'), body: item.id, danger: true, confirm: t(msgctxt('ssl-store', 'Delete')) }) === true } catch { confirmed = false }
      if (confirmed) await mutate('DELETE', base() + '/' + kind + '/' + encodeURIComponent(item.id), { modifiedAt: item.modifiedAt }, t('Deleted from SSL storage.'))
    }
    const rename = async (kind: string, item: StoreItem): Promise<void> => {
      let value: unknown = null
      try { value = askDialog ? await askDialog({ title: t('Rename stored item'), input: true, preserveWhitespace: true, label: t('Name'), value: item.label ?? '', confirm: t(msgctxt('ssl-store', 'Rename')) }) : null } catch { value = null }
      if (typeof value === 'string') await mutate('PATCH', base() + '/' + kind + '/' + encodeURIComponent(item.id), { label: value.trim() || null }, value.trim() ? t('The name was saved.') : t('The name was removed.'))
    }
    const field = (form: HTMLFormElement, name: string): string => { const input = form.elements.namedItem(name); return input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement ? input.value.trim() : '' }
    const lines = (text: string): string[] => text.split(/[\s,]+/).map(name => name.trim()).filter(Boolean)
    const subject = (form: HTMLFormElement): Record<string, string> => Object.fromEntries(['organization', 'organizationalUnit', 'locality', 'state', 'country', 'email'].map(name => [name, field(form, name)]).filter(([, value]) => value))
    const keyChoice = (form: HTMLFormElement): Record<string, string> => field(form, 'keyId') ? { keyId: field(form, 'keyId') } : field(form, 'keyType') ? { keyType: field(form, 'keyType') } : {}
    const submit = (form: HTMLFormElement | null, run: (form: HTMLFormElement) => Promise<boolean>): void => {
      form?.addEventListener('submit', async event => { event.preventDefault(); if (!form.reportValidity()) return; if (await run(form)) form.reset() })
    }
    submit(root.querySelector<HTMLFormElement>('form[data-ssl-store-key-form]'), form => mutate('POST', base() + '/keys', { ...keyChoice(form), ...(field(form, 'label') ? { label: field(form, 'label') } : {}) }, t('The new private key was saved in ~/ssl/keys.')))
    // The challenge passphrase is sent once and never shown again; the field is cleared with the form.
    const secret = (form: HTMLFormElement): Record<string, string> => field(form, 'passphrase') ? { passphrase: field(form, 'passphrase') } : {}
    submit(root.querySelector<HTMLFormElement>('form[data-ssl-store-csr-form]'), form => mutate('POST', base() + '/csrs', { ...keyChoice(form), names: lines(field(form, 'names')), subject: subject(form), ...secret(form) }, t('The signing request was saved in ~/ssl/csrs.')))
    submit(root.querySelector<HTMLFormElement>('form[data-ssl-store-certificate-form]'), form => mutate('POST', base() + '/certificates', { ...keyChoice(form), names: lines(field(form, 'names')), subject: subject(form), days: Number(field(form, 'days') || '365'), csr: form.dataset.sslStoreWithCsr === 'true', ...(form.dataset.sslStoreWithCsr === 'true' ? secret(form) : {}) },
      form.dataset.sslStoreWithCsr === 'true' ? t('The key, self-signed certificate and signing request were saved in ~/ssl.') : t('The self-signed certificate was saved in ~/ssl/certs.')))
    submit(root.querySelector<HTMLFormElement>('form[data-ssl-store-import-form]'), async form => {
      const key = field(form, 'keyPem'), certificate = field(form, 'certificatePem')
      if (!key && !certificate) { announce('failed', t('Paste a private key, a certificate or both.')); return false }
      return (!key || await mutate('POST', base() + '/keys', { pem: key }, t('Saved to SSL storage.'))) && (!certificate || await mutate('POST', base() + '/certificates', { pem: certificate }, t('Saved to SSL storage.')))
    })
    submit(installForm, async form => {
      if (revision === null) return false
      const bundle = field(form, 'caBundlePem')
      return mutate('POST', '/api/accounts/' + encodeURIComponent(username()) + '/certificates/install', { domain: field(form, 'domain'), expectedRevision: revision, storeCertificateId: field(form, 'storeCertificateId'), ...(bundle ? { caBundlePem: bundle } : {}) },
        t('The stored certificate was saved for the domain. Served TLS is not verified here.'))
    })
    submit(serviceForm, form => {
      const bundle = field(form, 'caBundlePem')
      return mutate('POST', '/api/server/ssl/certificates/' + encodeURIComponent(field(form, 'storeCertificateId')) + '/install', { service: field(form, 'service'), ...(bundle ? { caBundlePem: bundle } : {}) },
        reply => reply.mailUses === true ? t('The certificate is saved for the mail services (SMTP, IMAP and POP3). Served TLS is not verified here.') : t('The certificate is saved, but the mail services keep a certificate for the hostname that expires later.'))
    })
    root.querySelector('[data-ssl-store-refresh]')?.addEventListener('click', () => { uncertain = false; void load() })
    accountSelect?.addEventListener('change', () => { view = null; uncertain = false; render(); void load() })
    viewer?.querySelector('[data-ssl-store-viewer-close]')?.addEventListener('click', () => { if (pemBox) pemBox.textContent = ''; viewer.hidden = true })
    render()
    if (admitted()) void load(); else announce('unavailable', t('SSL storage is not available for this view.'))
  })
}

export const SSL_STORE_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};const sslStoreRefusal=${sslStoreRefusal.toString()};const bind=${bindSslStore.toString()};return(askDialog)=>bind(askDialog,{refusal:sslStoreRefusal,displayDateTime});})()`
