/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

/** The body of an HTML file with its scripts swapped for markers, so the visual editor can never run or rewrite them. */
export function protectHtmlScripts(source: string): { head: string; body: string; tail: string; scripts: string[] } {
  const open = /<body\b[^>]*>/i.exec(source), close = source.toLowerCase().lastIndexOf('</body>')
  const start = open && close >= open.index ? open.index + open[0].length : 0, end = open && close >= open.index ? close : source.length
  const scripts: string[] = []
  const body = source.slice(start, end).replace(/<script\b[\s\S]*?<\/script\s*>/gi, match => `<!--xpanel-script-${scripts.push(match) - 1}-->`)
  return { head: source.slice(0, start), body, tail: source.slice(end), scripts }
}
export function restoreHtmlScripts(head: string, body: string, tail: string, scripts: readonly string[]): string {
  return head + body.replace(/<!--xpanel-script-(\d+)-->/g, (match, index: string) => scripts[Number(index)] ?? match) + tail
}
/** What the sandboxed frame shows: no script tag at all, in the page's own styles. */
export function htmlPreviewDocument(head: string, body: string): string {
  const safeHead = head.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<body\b[^>]*>\s*$/i, '')
  return `${safeHead.includes('<html') ? safeHead : '<!doctype html><html><head><meta charset="utf-8"></head>'}<body>${body}</body></html>`
}

/** A bordered table with empty cells for a size such as 3x4, or null outside what the editor offers. */
export function htmlTableMarkup(size: string): string | null {
  const match = /^\s*(\d{1,2})\s*[xX*\u00d7]\s*(\d{1,2})\s*$/.exec(size), rows = Number(match?.[1]), columns = Number(match?.[2])
  if (!match || rows < 1 || rows > 50 || columns < 1 || columns > 20) return null
  return `<table border="1" style="border-collapse:collapse;width:100%"><tbody>${`<tr>${'<td>&nbsp;</td>'.repeat(columns)}</tr>`.repeat(rows)}</tbody></table>`
}
/** A YouTube or Vimeo address becomes its embed, anything else a video file; only http, https and paths reach the page. */
export function htmlVideoMarkup(address: string): string | null {
  const value = address.trim()
  if (!value || value.length > 2000 || /[\s"'<>\\]/.test(value) || value.startsWith('//')) return null
  const youtube = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/)([\w-]{6,20})(?:[?&#]|$)/.exec(value), vimeo = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{1,12})(?:[/?#]|$)/.exec(value)
  if (youtube || vimeo) return `<iframe src="${youtube ? 'https://www.youtube-nocookie.com/embed/' + youtube[1] : 'https://player.vimeo.com/video/' + vimeo![1]}" width="560" height="315" title="Video" allowfullscreen></iframe>`
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return null
  return `<video src="${value.replaceAll('&', '&amp;')}" controls preload="metadata" style="max-width:100%"></video>`
}

function bindAccountOwnerTools(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (!request) return
  const text = (node: HTMLElement | null, value: string): void => { if (node) node.textContent = value }
  const note = (node: HTMLElement | null, state: string, value: string): void => { if (node) { node.dataset.state = state; node.textContent = value } }
  const once = (root: HTMLElement): boolean => { if (root.dataset.bound === 'true') return false; root.dataset.bound = 'true'; return true }

  for (const root of document.querySelectorAll<HTMLElement>('[data-server-information]')) {
    if (!once(root)) continue
    const read = (): void => {
      note(root.querySelector<HTMLElement>('[data-server-info-status]'), 'reading', t('Reading…'))
      request('GET', '/api/account/server-information').then(raw => {
        const v = raw as { plan: string; hostname: string; panelVersion: string | null; primaryDomain: string; os: { id: string; version: string; arch: string; kernel: string }; versions: Record<string, string | null>; paths: { sendmail: string; perl: string }; services: { label: string; state: string }[] | null }
        const unread = t('Not read')
        const facts: Record<string, string> = { plan: v.plan, hostname: v.hostname, panel: v.panelVersion ?? unread, os: v.os.id + ' ' + v.os.version, arch: v.os.arch, kernel: v.os.kernel, sendmail: v.paths.sendmail, perl: v.paths.perl }
        for (const [name, version] of Object.entries(v.versions)) facts[name] = version ?? t('Not installed')
        for (const node of root.querySelectorAll<HTMLElement>('[data-server-info]')) { const value = facts[node.dataset.serverInfo ?? '']; if (value !== undefined) node.textContent = value }
        const body = root.querySelector<HTMLElement>('[data-server-services]')
        body?.replaceChildren(...(v.services ?? []).map(service => { const row = document.createElement('tr'), name = document.createElement('td'), state = document.createElement('td'); name.textContent = service.label; state.textContent = service.state === 'active' ? t('Up') : service.state === 'unchecked' ? t('Not read') : t('Down'); row.append(name, state); return row }))
        note(root.querySelector<HTMLElement>('[data-server-info-status]'), 'read', v.services ? t('Read from the server just now.') : t('Service state could not be read.'))
      }).catch(() => note(root.querySelector<HTMLElement>('[data-server-info-status]'), 'failed', t('Server information could not be read.')))
    }
    root.querySelector('[data-server-info-read]')?.addEventListener('click', read)
    read()
  }

  for (const root of document.querySelectorAll<HTMLElement>('[data-perl-modules]')) {
    if (!once(root)) continue
    const install = root.querySelector<HTMLButtonElement>('[data-perl-install]'), input = root.querySelector<HTMLInputElement>('[data-perl-module]'), rows = root.querySelector<HTMLElement>('[data-perl-rows]')
    const search = root.querySelector<HTMLButtonElement>('[data-perl-search-run]'), terms = root.querySelector<HTMLInputElement>('[data-perl-search]'), found = root.querySelector<HTMLElement>('[data-perl-search-rows]')
    if (!install || !input || !rows || !search || !terms || !found) continue
    let timer: ReturnType<typeof setTimeout> | null = null
    const action = (kind: string, module: string): void => {
      install.disabled = true; note(root.querySelector<HTMLElement>('[data-perl-status]'), 'saving', t('Starting…'))
      request('POST', '/api/account/perl-modules', { action: kind, module }).then(() => { note(root.querySelector<HTMLElement>('[data-perl-status]'), 'read', t('Running as your account. The list updates when it finishes.')); schedule() }).catch((error: { details?: { reason?: string } }) => { install.disabled = false; note(root.querySelector<HTMLElement>('[data-perl-status]'), 'failed', error?.details?.reason === 'invalid_module' ? t('Enter an exact module name, such as JSON::Tiny.') : error?.details?.reason === 'cpan_unavailable' ? t('The CPAN client is not installed on this server.') : t('The operation could not be started.')) })
    }
    const paint = (raw: unknown): void => {
      const v = raw as { library: string; useLine: string; engine: boolean; job: string; modules: { name: string; version: string }[] | null }
      text(root.querySelector<HTMLElement>('[data-perl-library]'), v.library); text(root.querySelector<HTMLElement>('[data-perl-useline]'), v.useLine)
      install.disabled = !v.engine || v.job === 'running'; input.disabled = !v.engine
      rows.replaceChildren(...(v.modules ?? []).map(item => {
        const row = document.createElement('tr'), name = document.createElement('td'), version = document.createElement('td'), actions = document.createElement('td')
        name.textContent = item.name; version.textContent = item.version
        for (const [label, kind] of [[t('Update'), 'install'], [t('Reinstall'), 'reinstall'], [t('Uninstall'), 'uninstall']] as const) { const template = root.querySelector<HTMLTemplateElement>('template[data-perl-button]'), button = template?.content.firstElementChild?.cloneNode(true) as HTMLButtonElement | undefined; if (!button) continue; button.textContent = label; button.addEventListener('click', () => action(kind, item.name)); actions.append(button) }
        row.append(name, version, actions); return row
      }))
      note(root.querySelector<HTMLElement>('[data-perl-status]'), v.job === 'failed' ? 'failed' : 'read', v.job === 'running' ? t('Running as your account. The list updates when it finishes.') : v.job === 'failed' ? t('The last operation failed. Read its log.') : !v.engine ? t('The CPAN client is not installed on this server.') : t('Modules read.'))
      if (v.job === 'running') schedule()
    }
    const say = (state: string, value: string): void => note(root.querySelector<HTMLElement>('[data-perl-search-status]'), state, value)
    const findings = (list: { name: string; version: string | null; description: string }[]): void => found.replaceChildren(...list.map(item => {
      const row = document.createElement('tr'), module = document.createElement('td'), actions = document.createElement('td'), name = document.createElement('bdi'), about = document.createElement('p')
      name.dir = 'ltr'; name.textContent = item.version ? item.name + ' ' + item.version : item.name; about.dir = 'auto'; about.textContent = item.description
      module.append(name, about)
      const button = root.querySelector<HTMLTemplateElement>('template[data-perl-button]')?.content.firstElementChild?.cloneNode(true) as HTMLButtonElement | undefined, link = root.querySelector<HTMLTemplateElement>('template[data-perl-link]')?.content.firstElementChild?.cloneNode(true) as HTMLAnchorElement | undefined
      if (button) { button.textContent = t('Install'); button.setAttribute('aria-label', t('Install') + ': ' + item.name); button.addEventListener('click', () => action('install', item.name)); actions.append(button) }
      if (link) { link.textContent = t('Documentation'); link.setAttribute('aria-label', t('Documentation') + ': ' + item.name); link.href = 'https://metacpan.org/pod/' + encodeURIComponent(item.name).replaceAll('%3A', ':'); actions.append(link) }
      row.append(module, actions); return row
    }))
    const find = (): void => {
      search.disabled = true; say('reading', t('Searching CPAN…'))
      request('GET', '/api/account/perl-modules/search?q=' + encodeURIComponent(terms.value.trim())).then(raw => { const list = (raw as { modules: Parameters<typeof findings>[0] }).modules; findings(list); say('read', list.length ? t('{count} results from CPAN.', { count: list.length }) : t('Nothing on CPAN matches this search.')) })
        .catch((error: { details?: { reason?: string } }) => { findings([]); say('failed', error?.details?.reason === 'invalid_search' ? t('Use at least two letters, digits or module name characters.') : error?.details?.reason === 'cpan_search_unavailable' ? t('CPAN search is unavailable right now. You can still install a module by its exact name.') : t('The search could not be run.')) })
        .finally(() => { search.disabled = false })
    }
    search.addEventListener('click', find)
    terms.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find() } })
    const load = (): void => { request('GET', '/api/account/perl-modules').then(paint).catch(() => note(root.querySelector<HTMLElement>('[data-perl-status]'), 'failed', t('Modules could not be read.'))) }
    const schedule = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (root.isConnected) load() }, 5000) }
    install.addEventListener('click', () => action('install', input.value.trim()))
    root.querySelector('[data-perl-log-read]')?.addEventListener('click', () => { request('GET', '/api/account/perl-modules/log').then(raw => text(root.querySelector<HTMLElement>('[data-perl-log]'), ((raw as { lines?: string[] }).lines ?? []).join('\n') || t('The log is empty.'))).catch(() => text(root.querySelector<HTMLElement>('[data-perl-log]'), t('The log could not be read.'))) })
    load()
  }

  for (const root of document.querySelectorAll<HTMLElement>('[data-image-tools]')) {
    if (!once(root)) continue
    const run = root.querySelector<HTMLButtonElement>('[data-image-run]'), op = root.querySelector<HTMLSelectElement>('[data-image-op]'), results = root.querySelector<HTMLElement>('[data-image-results]')
    if (!run || !op || !results) continue
    const field = (key: string): string => [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-image-field]')].find(node => node.dataset.imageField === key)?.value.trim() ?? ''
    const number = (key: string): number => Number(field(key))
    request('GET', '/api/account/images').then(raw => { const engine = (raw as { engine?: unknown }).engine === true; run.disabled = !engine; note(root.querySelector<HTMLElement>('[data-image-status]'), engine ? 'read' : 'failed', engine ? t('Ready. Files are changed as your account.') : t('Image processing is not installed on this server.')) }).catch(() => note(root.querySelector<HTMLElement>('[data-image-status]'), 'failed', t('Image processing could not be read.')))
    run.addEventListener('click', () => {
      const kind = op.value, path = field('path').replace(/^\/+|\/+$/g, '')
      const body = kind === 'thumbnail' ? { op: kind, path, widthPercent: number('width'), heightPercent: number('height') } : kind === 'scale' ? { op: kind, path, width: number('width'), height: number('height'), keepAs: field('keep') || null } : kind === 'convert' ? { op: kind, path, format: field('format') } : { op: kind, path }
      run.disabled = true; note(root.querySelector<HTMLElement>('[data-image-status]'), 'saving', t('Working…'))
      request('POST', '/api/account/images', body).then(raw => {
        const list = (raw as { results?: { path: string; width: number; height: number }[] }).results ?? []
        results.replaceChildren(...list.map(item => { const line = document.createElement('li'), name = document.createElement('bdi'); name.dir = 'ltr'; name.textContent = `${item.path} ${item.width}x${item.height}`; line.append(name); return line }))
        note(root.querySelector<HTMLElement>('[data-image-status]'), 'saved', t('{count} images done.', { count: list.length }))
      }).catch(() => note(root.querySelector<HTMLElement>('[data-image-status]'), 'failed', t('The image operation failed. Check the path and sizes. Originals you did not replace are unchanged.'))).finally(() => { run.disabled = false })
    })
  }

  for (const root of document.querySelectorAll<HTMLElement>('[data-site-compression]')) {
    if (!once(root)) continue
    const mode = root.querySelector<HTMLSelectElement>('[data-compression-mode]'), types = root.querySelector<HTMLInputElement>('[data-compression-types]'), save = root.querySelector<HTMLButtonElement>('[data-compression-save]')
    if (!mode || !types || !save) continue
    let revision = ''
    const load = (): Promise<void> => (request('GET', '/api/account/runtime') as Promise<{ revision: string; compression?: { mode: string; types: string[] } | null }>).then(view => { revision = view.revision; mode.value = view.compression?.mode ?? 'default'; types.value = (view.compression?.types ?? []).join(' '); mode.disabled = types.disabled = save.disabled = false; note(root.querySelector<HTMLElement>('[data-compression-status]'), 'read', t('Compression settings read.')) })
    load().catch(() => note(root.querySelector<HTMLElement>('[data-compression-status]'), 'failed', t('Compression settings could not be read.')))
    save.addEventListener('click', () => {
      save.disabled = true; note(root.querySelector<HTMLElement>('[data-compression-status]'), 'saving', t('Applying the change…'))
      request('POST', '/api/account/runtime', { op: 'compression.save', mode: mode.value, types: types.value.split(/\s+/).filter(Boolean), expectedRevision: revision }).then(load).then(() => note(root.querySelector<HTMLElement>('[data-compression-status]'), 'saved', t('Applied to your sites after the server configuration test passed.')))
        .catch((error: { status?: number }) => { save.disabled = false; note(root.querySelector<HTMLElement>('[data-compression-status]'), 'failed', error?.status === 400 ? t('Enter MIME types such as text/css, separated by spaces.') : t('The change was refused. Nothing was changed.')) })
    })
  }

  for (const root of document.querySelectorAll<HTMLElement>('[data-html-editor]')) {
    if (!once(root)) continue
    const account = root.dataset.htmlEditor ?? '', frame = root.querySelector<HTMLIFrameElement>('iframe[data-html-frame]'), source = root.querySelector<HTMLTextAreaElement>('[data-html-source]'), path = root.querySelector<HTMLInputElement>('[data-html-path]')
    const save = root.querySelector<HTMLButtonElement>('[data-html-save]'), mode = root.querySelector<HTMLButtonElement>('[data-html-mode]')
    if (!frame || !source || !path || !save || !mode) continue
    const files = (body: unknown): Promise<unknown> => request('POST', '/api/accounts/' + encodeURIComponent(account) + '/files', body)
    let parts: ReturnType<typeof protectHtmlScripts> | null = null, visual = true
    const current = (): string => !visual ? source.value : restoreHtmlScripts(parts!.head, frame.contentDocument?.body.innerHTML ?? parts!.body, parts!.tail, parts!.scripts)
    const show = (content: string): void => {
      parts = protectHtmlScripts(content); source.value = content
      frame.onload = () => { if (frame.contentDocument) frame.contentDocument.designMode = 'on' }
      frame.srcdoc = htmlPreviewDocument(parts.head, parts.body)
    }
    root.querySelector('[data-html-load]')?.addEventListener('click', () => {
      note(root.querySelector<HTMLElement>('[data-html-status]'), 'reading', t('Reading…'))
      files({ op: 'read', path: path.value.trim().replace(/^\/+/, '') }).then(raw => { show((raw as { content: string }).content); save.disabled = mode.disabled = false; note(root.querySelector<HTMLElement>('[data-html-status]'), 'read', t('File opened. Page scripts do not run here, so scripted parts may look different.')) })
        .catch(() => note(root.querySelector<HTMLElement>('[data-html-status]'), 'failed', t('The file could not be opened.')))
    })
    mode.addEventListener('click', () => { if (!parts) return; const content = current(); visual = !visual; frame.hidden = !visual; source.hidden = visual; show(content); source.value = content; mode.textContent = visual ? t('HTML source') : t('Visual editor') })
    save.addEventListener('click', () => {
      if (!parts) return
      save.disabled = true; note(root.querySelector<HTMLElement>('[data-html-status]'), 'saving', t('Saving…'))
      files({ op: 'write', path: path.value.trim().replace(/^\/+/, ''), content: current(), overwrite: true }).then(() => note(root.querySelector<HTMLElement>('[data-html-status]'), 'saved', t('Saved.'))).catch(() => note(root.querySelector<HTMLElement>('[data-html-status]'), 'failed', t('The file could not be saved. The file on the server is unchanged.'))).finally(() => { save.disabled = false })
    })
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-html-command]')) button.addEventListener('click', async () => {
      const command = button.dataset.htmlCommand ?? '', doc = frame.contentDocument
      if (!doc || !visual) return
      const answer = command === 'createLink' ? await askDialog?.({ title: t('Link'), input: true, label: t('Link address'), confirm: t('Link') }) : undefined
      const value = typeof answer === 'string' ? answer : undefined
      if (command !== 'createLink' || value) doc.execCommand(command, false, value)
      frame.contentWindow?.focus()
    })
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-html-insert]')) button.addEventListener('click', async () => {
      const doc = frame.contentDocument, table = button.dataset.htmlInsert === 'table', status = root.querySelector<HTMLElement>('[data-html-status]')
      if (!doc || !visual || !parts) return
      const answer = await askDialog?.({ title: table ? t('Table') : t('Video'), input: true, label: table ? t('Rows x columns, for example 3x4') : t('Video file path, or a web, YouTube or Vimeo address'), confirm: t('Insert') })
      if (typeof answer !== 'string') return
      const html = table ? htmlTableMarkup(answer) : htmlVideoMarkup(answer)
      if (!html) { note(status, 'failed', table ? t('Enter rows and columns such as 3x4, up to 50x20.') : t('Enter a web address, or a path on your site, with no spaces.')); return }
      frame.contentWindow?.focus()
      // A page never clicked has no caret for the command, so the new block goes at the end of the page.
      if (!doc.execCommand('insertHTML', false, html)) doc.body.insertAdjacentHTML('beforeend', html)
      note(status, 'read', table ? t('Table added. Save to keep it.') : t('Video added. It plays on the published page and may not play here. Save to keep it.'))
    })
  }
}

export const ACCOUNT_OWNER_TOOLS_CLIENT_BINDING = `(askDialog=>{const protectHtmlScripts=${protectHtmlScripts.toString()};const restoreHtmlScripts=${restoreHtmlScripts.toString()};const htmlPreviewDocument=${htmlPreviewDocument.toString()};const htmlTableMarkup=${htmlTableMarkup.toString()};const htmlVideoMarkup=${htmlVideoMarkup.toString()};(${bindAccountOwnerTools.toString()})(askDialog)})`
