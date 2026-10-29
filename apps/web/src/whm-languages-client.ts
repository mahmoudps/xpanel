/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { LOCALES, MAX_CATALOG_BYTES, SOURCE_LOCALE, type MessageValues } from './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
/** Registry tags in registry order; the client binding receives the same list. */
const LANGUAGE_TAGS: readonly string[] = LOCALES.map(info => info.tag)
const SOURCE_TAG: string = SOURCE_LOCALE
const CATALOG_LIMIT = MAX_CATALOG_BYTES

export interface LanguageRowView {
  tag: string; name: string; nativeName: string; dir: 'ltr' | 'rtl'; source: boolean; offered: boolean; messages: number
  override: { uploadedAt: string; uploadedBy: string; sha256: string; entries: number } | null
  overrideState: 'none' | 'saved' | 'invalid'; runtime: 'applied' | 'restart_required' | 'rejected'
}
export interface PanelLanguagesView { locales: LanguageRowView[]; defaultLocale: string; policyState: 'default' | 'saved' | 'invalid'; updatedAt: string | null; revision: string }

export function readPanelLanguagesView(value: unknown): PanelLanguagesView {
  const bad = (): never => { throw new Error('invalid_languages') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const exact = (item: Record<string, unknown>, keys: string): boolean => Object.keys(item).sort().join() === keys
  const iso = (item: unknown): string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) ? item : bad()
  const count = (item: unknown): number => Number.isSafeInteger(item) && (item as number) >= 0 ? item as number : bad()
  if (!object(value) || !exact(value, 'defaultLocale,locales,policyState,revision,updatedAt') || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !['default', 'saved', 'invalid'].includes(value.policyState as string) || !Array.isArray(value.locales) || value.locales.length !== LANGUAGE_TAGS.length
    || !LANGUAGE_TAGS.includes(value.defaultLocale as string) || (value.policyState === 'saved') !== (value.updatedAt !== null)) return bad()
  const locales = value.locales.map((row, index): LanguageRowView => {
    if (!object(row) || !exact(row, 'dir,messages,name,nativeName,offered,override,overrideState,runtime,source,tag') || row.tag !== LANGUAGE_TAGS[index] || row.source !== (row.tag === SOURCE_TAG)
      || typeof row.name !== 'string' || typeof row.nativeName !== 'string' || (row.dir !== 'ltr' && row.dir !== 'rtl') || typeof row.offered !== 'boolean'
      || !['none', 'saved', 'invalid'].includes(row.overrideState as string) || !['applied', 'restart_required', 'rejected'].includes(row.runtime as string)
      || (row.overrideState === 'saved') !== (row.override !== null)) return bad()
    const raw = row.override
    const override = raw === null ? null : object(raw) && exact(raw, 'entries,sha256,uploadedAt,uploadedBy') && typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256)
      && typeof raw.uploadedBy === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(raw.uploadedBy) ? { uploadedAt: iso(raw.uploadedAt), uploadedBy: raw.uploadedBy, sha256: raw.sha256, entries: count(raw.entries) } : bad()
    return { tag: row.tag as string, name: row.name, nativeName: row.nativeName, dir: row.dir, source: row.source as boolean, offered: row.offered, messages: count(row.messages),
      override, overrideState: row.overrideState as LanguageRowView['overrideState'], runtime: row.runtime as LanguageRowView['runtime'] }
  })
  if (!locales.some(row => row.offered) || !locales.find(row => row.tag === value.defaultLocale)!.offered) return bad()
  return { locales, defaultLocale: value.defaultLocale as string, policyState: value.policyState as PanelLanguagesView['policyState'], updatedAt: value.updatedAt === null ? null : iso(value.updatedAt), revision: value.revision }
}

function bindWhmLanguages(askDialog?: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-languages-workspace]').forEach(root => {
    if (root.dataset.languagesBound === 'true') return
    root.dataset.languagesBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const all = <T extends Element>(selector: string): T[] => [...root.querySelectorAll<T>(selector)]
    const status = one<HTMLElement>('[data-whm-languages-status]'), loading = one<HTMLElement>('[data-whm-languages-loading]'), catalogStatus = one<HTMLElement>('[data-whm-languages-catalog-status]')
    const errors = one<HTMLElement>('[data-whm-languages-errors]'), form = one<HTMLFormElement>('[data-whm-languages-form]'), defaultSelect = one<HTMLSelectElement>('[data-whm-languages-default]')
    const save = one<HTMLButtonElement>('[data-whm-languages-save]'), reload = one<HTMLButtonElement>('[data-whm-languages-reload]'), saveStatus = one<HTMLElement>('[data-whm-languages-save-status]')
    const fieldset = form?.querySelector<HTMLFieldSetElement>('fieldset') ?? null, offered = all<HTMLInputElement>('[data-whm-languages-offered]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !catalogStatus || !errors || !form || !defaultSelect || !save || !reload || !saveStatus || !fieldset) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.languagesCanManage === 'true' && form.tagName === 'FORM' && !root.closest(denied) && typeof request === 'function'
    let view: PanelLanguagesView | null = null, busy = false, stale = false
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' || state === 'stale' ? 'alert' : 'status') }
    const ready = (): boolean => !busy && !stale && view !== null && admitted()
    const lock = (): void => {
      const open = ready()
      defaultSelect.disabled = !open; fieldset.disabled = !open; save.disabled = !open; offered.forEach(input => { input.disabled = !open })
      reload.disabled = busy || !admitted()
      for (const button of all<HTMLButtonElement>('[data-whm-languages-download]')) button.disabled = !open
      for (const button of all<HTMLButtonElement>('[data-whm-languages-upload]')) button.disabled = !open
      for (const button of all<HTMLButtonElement>('[data-whm-languages-remove]')) button.disabled = !open || view?.locales.find(row => row.tag === button.dataset.whmLanguagesRemove)?.overrideState === 'none'
      root.setAttribute('aria-busy', String(busy))
    }
    const runtimeText: Record<string, string> = {
      applied: t('Uploaded catalog in use.'), restart_required: t('Uploaded catalog applies when the panel next starts.'),
      rejected: t('The uploaded catalog no longer matches this release and is not in use. Download, correct and upload it again, or remove it.'),
    }
    const paint = (next: PanelLanguagesView): void => {
      view = next; stale = false
      for (const row of next.locales) {
        const messages = one<HTMLElement>('[data-whm-languages-messages="' + row.tag + '"]'), setting = one<HTMLElement>('[data-whm-languages-setting="' + row.tag + '"]')
        if (messages) messages.textContent = row.source ? t('{count} source messages', { count: row.messages }) : t('{count} translated', { count: row.messages })
        if (!setting) continue
        const lines = [row.offered ? (row.tag === next.defaultLocale ? t('Offered, default') : t('Offered')) : t('Not offered')]
        if (row.source) lines.push(t('Source language'))
        else if (row.overrideState === 'invalid') lines.push(t('The uploaded catalog file is invalid and is not used. Remove it, then upload again.'))
        else if (row.override) lines.push(runtimeText[row.runtime]!, t('Uploaded {date} by {user}, {count} messages', { date: formatDisplayDateTime(row.override.uploadedAt), user: row.override.uploadedBy, count: row.override.entries }))
        else lines.push(row.runtime === 'applied' ? t('Release catalog') : t('Release catalog applies when the panel next starts.'))
        setting.replaceChildren(...lines.map(text => { const line = document.createElement('span'); line.textContent = text; return line }))
      }
      defaultSelect.value = next.defaultLocale
      offered.forEach(input => { input.checked = next.locales.some(row => row.tag === input.value && row.offered) })
      note(status, next.policyState === 'invalid' ? 'failed' : 'read', next.policyState === 'invalid'
        ? t('The saved language settings could not be verified. The release defaults are in use; saving replaces them.')
        : next.policyState === 'saved' ? t('Language settings read. Last saved {date}.', { date: formatDisplayDateTime(next.updatedAt!) }) : t('Language settings read. No settings have been saved; every language is offered and {language} is the default.', { language: languageOf(next.defaultLocale) }))
    }
    const problemText: Record<string, string> = {
      source_locale: t('The source language has no catalog to upload.'), too_large: t('The catalog is larger than 4 MiB.'), encoding: t('The catalog must be UTF-8 text.'),
      syntax: t('The file is not a valid PO catalog.'), language_mismatch: t('The catalog Language header does not name this language.'), empty: t('The catalog has no messages.'),
      unknown_message: t('This message is not in this release.'), invalid_message: t('The translation is not a valid ICU message.'),
      placeholder_mismatch: t('The translation does not use the same placeholders as the source.'), non_ascii_digits: t('The translation uses digits other than ASCII 0-9.'),
    }
    const showProblems = (fields: unknown, total: unknown): void => {
      errors.replaceChildren(); errors.hidden = true
      if (!Array.isArray(fields) || !fields.length) return
      for (const field of fields.slice(0, 20)) {
        const item = document.createElement('li'), code = (field as { code?: unknown })?.code, line = (field as { line?: unknown })?.line, id = (field as { msgid?: unknown })?.msgid
        const problem = problemText[typeof code === 'string' ? code : ''] ?? t('This value was refused.')
        item.textContent = Number.isSafeInteger(line) ? t('Line {line}: {problem}', { line: line as number, problem }) : problem
        if (typeof id === 'string') { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = ' ' + id; item.append(bdi) }
        errors.append(item)
      }
      if (Number.isSafeInteger(total) && (total as number) > fields.length) { const more = document.createElement('li'); more.textContent = t('{count} more problems are not shown.', { count: (total as number) - fields.length }); errors.append(more) }
      errors.hidden = false
    }
    const failure = (error: unknown, fallback: string): string => {
      const item = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean; unknownOutcome?: boolean } }
      if (item?.details?.verificationRequired || item?.details?.stateChanged || item?.details?.unknownOutcome) return t('The change could not be verified. Reload the language settings before trying again.')
      if (item?.status === 409) { stale = true; return t('Language settings changed since they were read. Reload before trying again.') }
      if (item?.status === 401 || item?.status === 403) return t('Administrator access is unavailable. Sign in again as root to manage languages.')
      if (item?.status === 400) return Array.isArray((item.details as { fields?: unknown } | undefined)?.fields) ? t('The server refused this change. Nothing was saved. Correct the listed problems and try again.') : t('The server refused this change. Nothing was saved.')
      return fallback
    }
    const verify = async (ack: PanelLanguagesView, check: (read: PanelLanguagesView) => boolean): Promise<PanelLanguagesView> => {
      if (!check(ack)) throw new Error('unverified_change')
      const read = readPanelLanguagesView(await request!('GET', '/api/server/panel/languages'))
      if (read.revision !== ack.revision || !check(read)) throw new Error('unverified_change')
      return read
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; view = null; lock(); if (loading) loading.hidden = false
      note(status, 'reading', t('Reading language settings…'))
      try { paint(readPanelLanguagesView(await request('GET', '/api/server/panel/languages'))) }
      catch (error) { note(status, 'failed', failure(error, t('Language settings could not be read. Nothing was changed.'))) }
      finally { busy = false; lock(); if (loading) loading.hidden = true }
    }
    const confirm = async (title: string, body: string, danger: boolean): Promise<boolean> => {
      if (!askDialog) { note(catalogStatus, 'failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false }
    }
    const languageOf = (tag: string): string => view?.locales.find(row => row.tag === tag)?.nativeName ?? tag
    const mutate = async (target: HTMLElement, pending: string, done: string, fallback: string, send: () => Promise<unknown>, check: (read: PanelLanguagesView) => boolean): Promise<void> => {
      busy = true; lock(); note(target, 'reading', pending)
      try { paint(await verify(readPanelLanguagesView(await send()), check)); note(target, 'read', done) }
      catch (error) {
        const details = (error as { details?: { fields?: unknown; problemCount?: unknown } })?.details
        showProblems(details?.fields, details?.problemCount)
        note(target, (error as { status?: number })?.status === 409 ? 'stale' : 'failed', failure(error, fallback))
      } finally { busy = false; lock() }
    }
    if (!admitted()) { lock(); note(status, 'unavailable', t('Language settings are unavailable here. Nothing was read or changed.')); return }

    reload.addEventListener('click', () => { saveStatus.hidden = true; catalogStatus.hidden = true; errors.hidden = true; void load() })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!ready() || !view) return
      const chosen = offered.filter(input => input.checked).map(input => input.value), defaultLocale = defaultSelect.value
      if (!chosen.length) { note(saveStatus, 'failed', t('Offer at least one language.')); return }
      if (!chosen.includes(defaultLocale)) { note(saveStatus, 'failed', t('The default language must be offered.')); return }
      void mutate(saveStatus, t('Saving application locales…'), t('Application locales saved and read back. They apply to the next page that opens.'), t('The save could not be verified. Reload the language settings before trying again.'),
        () => request!('PUT', '/api/server/panel/languages', { offered: chosen, defaultLocale, expectedRevision: view!.revision }),
        read => read.policyState === 'saved' && read.defaultLocale === defaultLocale && read.locales.every(row => row.offered === chosen.includes(row.tag)))
    })
    for (const button of all<HTMLButtonElement>('[data-whm-languages-download]')) button.addEventListener('click', async () => {
      const tag = button.dataset.whmLanguagesDownload ?? ''
      if (!ready() || !LANGUAGE_TAGS.includes(tag)) return
      busy = true; lock(); errors.hidden = true; note(catalogStatus, 'reading', t('Preparing the {language} catalog…', { language: languageOf(tag) }))
      try {
        const file = await request!('GET', '/api/server/panel/languages/' + tag + '/catalog') as { locale?: unknown; filename?: unknown; catalog?: unknown }
        if (!file || file.locale !== tag || file.filename !== tag + (tag === SOURCE_TAG ? '.pot' : '.po') || typeof file.catalog !== 'string') throw new Error('invalid_catalog_download')
        const url = URL.createObjectURL(new Blob([file.catalog], { type: 'text/x-gettext-translation;charset=utf-8' }))
        try { const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click() } finally { URL.revokeObjectURL(url) }
        note(catalogStatus, 'read', t('Catalog {file} downloaded.', { file: file.filename }))
      } catch (error) { note(catalogStatus, 'failed', failure(error, t('The catalog could not be downloaded.'))) }
      finally { busy = false; lock() }
    })
    for (const button of all<HTMLButtonElement>('[data-whm-languages-upload]')) {
      const tag = button.dataset.whmLanguagesUpload ?? '', input = one<HTMLInputElement>('[data-whm-languages-file="' + tag + '"]')
      if (!input) continue
      button.addEventListener('click', () => { if (ready()) { input.disabled = false; input.value = ''; input.click() } })
      input.addEventListener('change', async () => {
        const file = input.files?.[0]; input.disabled = true
        if (!file || !ready() || !view) return
        errors.hidden = true
        if (!/\.po$/i.test(file.name)) { note(catalogStatus, 'failed', t('Choose a .po catalog file.')); return }
        if (file.size > CATALOG_LIMIT) { note(catalogStatus, 'failed', t('The catalog is larger than 4 MiB.')); return }
        // The transport sends a Blob as raw bytes with its type; the server checks UTF-8 and the PO content.
        const catalog = new Blob([file], { type: 'text/x-gettext-translation' })
        const replacing = view.locales.find(row => row.tag === tag)?.overrideState !== 'none'
        if (!await confirm(t('Upload the {language} catalog?', { language: languageOf(tag) }), (replacing ? t('It replaces the catalog uploaded before.') + '\n' : '') + t('It is checked against this release and applies when the panel next starts.'), false)) return
        if (!ready() || !view) return
        await mutate(catalogStatus, t('Uploading and checking the catalog…'), t('Catalog checked and saved. It applies when the panel next starts.'), t('The upload could not be verified. Reload the language settings before trying again.'),
          () => request!('PUT', '/api/server/panel/languages/' + tag + '/catalog?expectedRevision=' + encodeURIComponent(view!.revision), catalog),
          read => read.locales.find(row => row.tag === tag)?.overrideState === 'saved')
      })
    }
    for (const button of all<HTMLButtonElement>('[data-whm-languages-remove]')) button.addEventListener('click', async () => {
      const tag = button.dataset.whmLanguagesRemove ?? ''
      if (!ready() || !view || !LANGUAGE_TAGS.includes(tag)) return
      errors.hidden = true
      if (!await confirm(t('Remove the uploaded {language} catalog?', { language: languageOf(tag) }), t('The release catalog is used again when the panel next starts. Download the catalog first to keep a copy.'), true)) return
      if (!ready() || !view) return
      await mutate(catalogStatus, t('Removing the uploaded catalog…'), t('Uploaded catalog removed. The release catalog applies when the panel next starts.'), t('The removal could not be verified. Reload the language settings before trying again.'),
        () => request!('DELETE', '/api/server/panel/languages/' + tag + '/catalog', { expectedRevision: view!.revision }),
        read => read.locales.find(row => row.tag === tag)?.overrideState === 'none')
    })
    void load()
  })
}
export const WHM_LANGUAGES_CLIENT_BINDING = `(()=>{const LANGUAGE_TAGS=${JSON.stringify(LANGUAGE_TAGS)};const SOURCE_TAG=${JSON.stringify(SOURCE_TAG)};const CATALOG_LIMIT=${CATALOG_LIMIT};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPanelLanguagesView=${readPanelLanguagesView.toString()};return ${bindWhmLanguages.toString()};})()`
