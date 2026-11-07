/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import type { GitViewResult } from '../../agent/src/account-git-view.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatDisplayDateTime = sharedFormatDisplayDateTime

export function readGitViewResult(raw: unknown, view: string): GitViewResult {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const list = (key: string): boolean => object(raw) && Array.isArray(raw[key]) && (raw[key] as unknown[]).every(object)
  const valid = object(raw) && raw.view === view && (view === 'log' ? list('commits') && typeof raw.hasMore === 'boolean' : view === 'refs' ? list('refs') : view === 'tree' ? list('entries') : view === 'grep' ? list('matches')
    : view === 'commit' ? typeof raw.hash === 'string' && typeof raw.subject === 'string' && list('changes') && (raw.patch === null || typeof raw.patch === 'string')
      : ['text', 'binary', 'too-large'].includes(String(raw.state)) && (raw.text === null || typeof raw.text === 'string'))
  if (!valid) throw new Error('invalid_git_view')
  return raw as unknown as GitViewResult
}

function bindAccountGitweb(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-account-gitweb]').forEach(root => {
    if (root.dataset.gitwebBound === 'true') return
    root.dataset.gitwebBound = 'true'
    const part = <T extends HTMLElement>(key: string): T | null => root.querySelector<T>('[data-gitweb-' + key + ']')
    const status = part('status'), rev = part<HTMLSelectElement>('rev'), kind = part<HTMLSelectElement>('search-kind'), text = part<HTMLInputElement>('search-text'), more = part<HTMLButtonElement>('more'), up = part<HTMLButtonElement>('up'), location = part('location')
    const repository = root.closest('[data-account-git]')?.querySelector<HTMLSelectElement>('[data-git-repository]') ?? null
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')]
    const say = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    if (!send || root.dataset.gitwebCanRead !== 'true' || !repository || !rev || !kind || !text || !more || !up || !location || root.closest('[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      say('unavailable', t('The history browser is unavailable here. Nothing was read.')); return
    }
    let skip = 0, dir = '', busy = false, logQuery: Record<string, string> = {}, patchText = '', blob: { name: string; text: string } | null = null
    const lock = (): void => { for (const control of controls) control.disabled = busy || !repository.value; more.disabled = more.disabled || more.dataset.more !== 'true'; up.disabled = up.disabled || !dir }
    const show = (name: string): void => { for (const panel of root.querySelectorAll<HTMLElement>('[data-gitweb-panel]')) panel.hidden = panel.dataset.gitwebPanel !== name }
    const cell = (value: string, technical = false): HTMLTableCellElement => { const td = document.createElement('td'); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi) } else td.textContent = value; return td }
    const action = (label: string, run: () => void): HTMLTableCellElement => { const td = document.createElement('td'), button = cloneClientTemplate(clientTemplate(root, 'gitweb-action'), 'button', ['label']); clientTemplateSlot(button, 'label').textContent = label; button.addEventListener('click', run); td.append(button); return td }
    const fill = (name: string, rows: readonly HTMLElement[][], empty: string, append = false): void => {
      const body = part(name + '-rows')
      if (!body) return
      if (!append) body.replaceChildren()
      if (!rows.length && !append) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = body.closest('table')?.querySelectorAll('thead th').length ?? 1; td.textContent = empty; row.append(td); body.append(row) }
      for (const cells of rows) { const row = document.createElement('tr'); row.append(...cells); body.append(row) }
    }
    const fact = (key: string, value: string): void => { const node = root.querySelector<HTMLElement>(`[data-gitweb-fact="${key}"]`); if (node) node.textContent = value }
    const read = async (query: Record<string, string>): Promise<GitViewResult | null> => {
      busy = true; lock(); say('reading', t('Reading the repository…'))
      try {
        const result = readGitViewResult(await send('GET', '/api/account/git/view?' + new URLSearchParams({ ...query, path: repository.value }).toString()), query.view!)
        say('read', t('Read from the repository.')); return result
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        say('failed', code === 'NOT_FOUND' ? t('That repository or file was not found.') : t('The repository could not be read. Nothing was changed.')); return null
      } finally { busy = false; lock() }
    }
    const loadLog = async (query: Record<string, string>, next: boolean): Promise<void> => {
      skip = next ? skip : 0; logQuery = query
      const result = await read({ view: 'log', rev: rev.value || 'HEAD', ...(skip ? { skip: String(skip) } : {}), ...query })
      if (result?.view !== 'log') return
      show('log'); skip += result.commits.length; more.dataset.more = String(result.hasMore); lock()
      fill('log', result.commits.map(commit => [action(commit.hash.slice(0, 12), () => { void loadCommit(commit.hash) }), cell(formatDisplayDateTime(commit.at), true), cell(commit.author), cell((commit.refs.length ? '[' + commit.refs.join(', ') + '] ' : '') + commit.subject)]), t('No commits match.'), next)
    }
    const loadCommit = async (hash: string): Promise<void> => {
      const result = await read({ view: 'commit', hash })
      if (result?.view !== 'commit') return
      show('commit'); fact('hash', result.hash); fact('author', result.author + ' <' + result.email + '>'); fact('date', formatDisplayDateTime(result.at)); fact('parents', result.parents.map(parent => parent.slice(0, 12)).join(' ') || t('None')); fact('subject', result.subject); fact('body', result.body)
      fill('changes', result.changes.map(change => [cell(change.file, true), cell(change.added === null ? t('Binary') : '+' + change.added + ' -' + change.removed, true)]), t('This commit changes no files.'))
      patchText = result.patch ?? ''
      const patch = part('patch'), download = part<HTMLButtonElement>('patch-download')
      if (patch) patch.textContent = result.patch ?? t('This diff is too large to show here. The changed files are listed above.')
      if (download) download.hidden = result.patch === null
    }
    const loadTree = async (path: string): Promise<void> => {
      const result = await read({ view: 'tree', rev: rev.value || 'HEAD', ...(path ? { dir: path } : {}) })
      if (result?.view !== 'tree') return
      dir = path; show('tree'); location.textContent = '/' + path; lock()
      fill('tree', result.entries.map(entry => { const full = path ? path + '/' + entry.name : entry.name; return [entry.kind === 'blob' ? action(entry.name, () => { void loadBlob(full) }) : entry.kind === 'tree' ? action(entry.name + '/', () => { void loadTree(full) }) : cell(entry.name, true), cell(entry.sizeBytes === null ? '' : String(entry.sizeBytes), true), cell(entry.mode, true)] }), t('This directory is empty.'))
    }
    const loadBlob = async (file: string): Promise<void> => {
      const result = await read({ view: 'blob', rev: rev.value || 'HEAD', file })
      if (result?.view !== 'blob') return
      show('blob'); fact('file', file); blob = result.text === null ? null : { name: file.slice(file.lastIndexOf('/') + 1), text: result.text }
      const body = part('blob'), raw = part<HTMLButtonElement>('blob-raw')
      if (raw) raw.hidden = blob === null
      if (body) { const lines = (result.text ?? '').split('\n'); body.textContent = result.state === 'binary' ? t('This is a binary file, so it is not shown.') : result.state === 'too-large' ? t('This file is too large to show here.') : lines.map((line, index) => String(index + 1).padStart(String(lines.length).length) + '  ' + line).join('\n') }
      root.dataset.gitwebFile = file
    }
    const save = (name: string, content: string, type: string): void => { const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = name; root.append(link); link.click(); link.remove(); URL.revokeObjectURL(url) }
    part('log')?.addEventListener('click', () => { void loadLog({}, false) })
    part('tree')?.addEventListener('click', () => { void loadTree('') })
    part('refs')?.addEventListener('click', () => {
      void read({ view: 'refs' }).then(result => {
        if (result?.view !== 'refs') return
        show('refs')
        const current = rev.value, keep = rev.options[0]!
        rev.replaceChildren(keep); for (const ref of result.refs) rev.append(new Option(ref.name, ref.name)); rev.value = result.refs.some(ref => ref.name === current) ? current : keep.value
        fill('refs', result.refs.map(ref => [cell(ref.name, true), cell(ref.kind === 'branch' ? t('Branch') : ref.kind === 'tag' ? t('Tag') : t('Remote branch')), cell(ref.hash.slice(0, 12), true), cell(ref.at ? formatDisplayDateTime(ref.at) : t('Unknown'), true)]), t('This repository has no branches or tags.'))
      })
    })
    more.addEventListener('click', () => { void loadLog(logQuery, true) })
    up.addEventListener('click', () => { void loadTree(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') })
    part('search')?.addEventListener('click', () => {
      const value = text.value.trim()
      if (!value) { say('failed', t('Enter what to search for.')); return }
      if (kind.value !== 'content') { void loadLog({ search: kind.value, text: value }, false); return }
      void read({ view: 'grep', rev: rev.value || 'HEAD', text: value }).then(result => {
        if (result?.view !== 'grep') return
        show('grep'); fill('grep', result.matches.map(match => [cell(match.file, true), cell(String(match.line), true), cell(match.text, true)]), t('No files match.'))
      })
    })
    part('file-history')?.addEventListener('click', () => { void loadLog({ file: root.dataset.gitwebFile ?? '' }, false) })
    part('patch-download')?.addEventListener('click', () => { save('commit.patch', patchText, 'text/plain') })
    part('blob-raw')?.addEventListener('click', () => { if (blob) save(blob.name, blob.text, 'application/octet-stream') })
    repository.addEventListener('change', () => { dir = ''; more.dataset.more = 'false'; show(''); lock() })
    new MutationObserver(lock).observe(repository, { childList: true, attributes: true, attributeFilter: ['disabled'] })
    lock()
  })
}

export const ACCOUNT_GITWEB_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readGitViewResult=${readGitViewResult.toString()};return ${bindAccountGitweb.toString()}})()`
