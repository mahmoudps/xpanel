import { VIEW_RECORD_HELPERS, cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export interface SwDeploymentsClientView {
  filesAvailable: boolean; nativeAvailable: boolean; accounts: { username: string; gitAllowed: boolean }[]
  selected: null | { context: { username: string }; revision: string; repositories: string[]; selected: null | { path: string; branch: string; head: string | null; dirty: boolean; changedFiles: number; remote: string | null; commits: { hash: string; at: string; subject: string }[] } }
}
/** The API already pins every field; the browser re-checks the shape it paints. Self-contained for serialization. */
export function readSwDeploymentsView(value: unknown): SwDeploymentsClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_deployments_view') }
  const path = (item: unknown): item is string => typeof item === 'string' && item.length <= 240 && /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(item)
  if (!object(value) || value.scope !== 'account-git-deployments' || typeof value.filesAvailable !== 'boolean' || typeof value.nativeAvailable !== 'boolean' || !Array.isArray(value.accounts) || value.accounts.length > 500) return bad()
  const accounts = value.accounts.map((item: unknown) => object(item) && typeof item.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item.username) && typeof item.gitAllowed === 'boolean' ? { username: item.username, gitAllowed: item.gitAllowed } : bad())
  let selected: SwDeploymentsClientView['selected'] = null
  if (value.selected !== null) {
    const s = value.selected
    if (!object(s) || !object(s.context) || typeof s.context.username !== 'string' || typeof s.revision !== 'string' || !/^[0-9a-f]{64}$/.test(s.revision) || !Array.isArray(s.repositories) || s.repositories.length > 20 || !s.repositories.every(path)) return bad()
    let repository = null
    if (s.selected !== null) {
      const r = s.selected
      if (!object(r) || !path(r.path) || typeof r.branch !== 'string' || r.branch.length > 120 || !(r.head === null || hash(r.head)) || typeof r.dirty !== 'boolean' || !Number.isSafeInteger(r.changedFiles) || !(r.remote === null || typeof r.remote === 'string' && r.remote.startsWith('https://') && r.remote.length <= 500) || !Array.isArray(r.commits) || r.commits.length > 20) return bad()
      const commits = r.commits.map((c: unknown) => object(c) && hash(c.hash) && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at)) && typeof c.subject === 'string' && c.subject.length <= 500 ? { hash: c.hash, at: c.at, subject: c.subject } : bad())
      repository = { path: r.path, branch: r.branch, head: r.head, dirty: r.dirty, changedFiles: r.changedFiles, remote: r.remote, commits }
    }
    selected = { context: { username: s.context.username }, revision: s.revision, repositories: [...s.repositories], selected: repository }
  }
  return { filesAvailable: value.filesAvailable, nativeAvailable: value.nativeAvailable, accounts, selected }
}

type Ask = (options: Record<string, unknown>) => Promise<unknown>
function bindSwDeployments(askDialog: Ask | undefined, parse: typeof readSwDeploymentsView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  document.querySelectorAll<HTMLElement>('[data-sw-deployments]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const q = <T extends HTMLElement>(key: string): T | null => root.querySelector<T>('[data-sw-dep-' + key + ']')
    const status = q<HTMLElement>('status'), refresh = q<HTMLButtonElement>('refresh'), account = q<HTMLSelectElement>('account'), repos = q<HTMLElement>('repositories'), commits = q<HTMLElement>('commits'), pull = q<HTMLButtonElement>('pull')
    if (!status || !refresh || !account || !repos || !commits || !pull) return
    try { viewAction(cloneViewRecord(root, 'software-deployment-repository-row', 'tr', { path: '', 'inspect-label': '' }), 'inspect'); cloneViewRecord(root, 'software-deployment-repository-empty', 'tr', { message: '' }); cloneViewRecord(root, 'software-deployment-commit-row', 'tr', { hash: '', date: '', subject: '' }); cloneViewRecord(root, 'software-deployment-commit-empty', 'tr', { message: '' }) } catch { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }); status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return }
    const admitted = (): boolean => root.isConnected && root.dataset.swCanRead === 'true' && !root.closest(blocked) && typeof transport === 'function'
    let busy = false, locked = false, view: SwDeploymentsClientView | null = null
    const repository = (): NonNullable<NonNullable<SwDeploymentsClientView['selected']>['selected']> | null => view?.selected?.selected ?? null
    const deployable = (): boolean => { const r = repository(); return admitted() && root.dataset.swCanManage === 'true' && !busy && !locked && !!view?.nativeAvailable && !!r && !r.dirty && r.head !== null && r.remote !== null && typeof askDialog === 'function' }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const fact = (key: string, text: string, human: boolean): void => { const node = q<HTMLElement>(key); if (node) { node.textContent = text; node.toggleAttribute('data-human', human) } }
    const empty = (body: HTMLElement, columns: number, message: string): void => { body.replaceChildren(cloneViewRecord(root, columns === 2 ? 'software-deployment-repository-empty' : 'software-deployment-commit-empty', 'tr', { message })) }
    const lock = (): void => { refresh.disabled = busy || !admitted(); account.disabled = busy || !admitted() || !view; pull.disabled = !deployable(); for (const button of repos.querySelectorAll('button')) button.disabled = busy || !admitted() || !view?.nativeAvailable }
    const paint = (): void => {
      fact('native', view ? (view.nativeAvailable ? t('Available') : t('Unavailable')) : t('Not read'), true)
      fact('files', view ? (view.filesAvailable ? t('Available') : t('Unavailable')) : t('Not read'), true)
      const chosen = view?.selected?.context.username ?? account.value
      account.textContent = ''
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = view?.accounts.length ? t('Choose an account') : t('No active accounts'); account.append(placeholder)
      for (const item of view?.accounts ?? []) { const option = document.createElement('option'); option.value = item.username; option.textContent = item.gitAllowed ? item.username : t('{account} (Git not allowed by plan)', { account: item.username }); option.disabled = !item.gitAllowed; account.append(option) }
      account.value = view?.accounts.some(item => item.username === chosen && item.gitAllowed) ? chosen : ''
      repos.textContent = ''
      for (const path of view?.selected?.repositories ?? []) {
        const row = cloneViewRecord(root, 'software-deployment-repository-row', 'tr', { path, 'inspect-label': t('Inspect') }), button = viewAction<HTMLButtonElement>(row, 'inspect')
        button.setAttribute('aria-label', t('Inspect repository {path}', { path }))
        button.addEventListener('click', () => { void send('inspect', { account: view!.selected!.context.username, path }) }); repos.append(row)
      }
      if (!repos.childElementCount) empty(repos, 2, view?.selected ? t('This account has no registered repositories.') : t('No account has been selected.'))
      const r = repository()
      fact('path', r?.path ?? t('Not read'), !r); fact('branch', r?.branch ?? t('Not read'), !r); fact('head', r?.head ?? (r ? t('No commits') : t('Not read')), !r?.head); fact('remote', r?.remote ?? (r ? t('No HTTPS origin') : t('Not read')), !r?.remote)
      fact('tree', r ? (r.dirty ? t('{count, plural, one {# uncommitted change} other {# uncommitted changes}}', { count: r.changedFiles }) : t('Clean')) : t('Not read'), true)
      commits.textContent = ''
      for (const commit of r?.commits ?? []) commits.append(cloneViewRecord(root, 'software-deployment-commit-row', 'tr', { hash: commit.hash.slice(0, 12), date: formatDisplayDateTime(commit.at), subject: commit.subject }))
      if (!commits.childElementCount) empty(commits, 3, r ? t('This repository has no commits.') : t('No repository has been inspected.'))
      lock()
    }
    const failure = (error: unknown, change: boolean): void => {
      const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
      const code = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
      if (change && !(detail && detail.stateChanged === false)) { locked = true; note('uncertain', t('The deployment outcome is unknown; files may have changed. Read the repository again before retrying.')); return }
      note('failed', code === 409 ? t('The repository or its list changed. Inspect it again before deploying.') : code === 412 ? t('This operation is unavailable for this account or host. Nothing was changed.') : code === 403 ? t('This account is not active or its plan does not allow Git.') : t('The request failed. Nothing was changed.'))
    }
    const send = async (operation: 'read' | 'inspect' | 'pull', body?: Record<string, string>): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', operation === 'pull' ? t('Deploying through the isolated Git runner…') : t('Reading deployments…'))
      try {
        const selectedAccount = operation === 'read' ? account.value : body!.account
        const next = parse(await transport!(operation === 'read' ? 'GET' : 'POST', operation === 'read' ? '/api/server/software/deployments' + (selectedAccount ? '?account=' + encodeURIComponent(selectedAccount) : '') : '/api/server/software/deployments/' + operation, body))
        if ((next.selected?.context.username ?? '') !== selectedAccount || operation !== 'read' && next.selected?.selected?.path !== body!.path) throw new Error('wrong_target')
        if (!admitted()) return
        view = next; if (operation === 'read') locked = false
        const r = next.selected?.selected
        note(operation === 'pull' ? 'submitted' : 'read', operation === 'pull' ? t('Deployed. Git confirms {path} is now at commit {head}.', { path: r!.path, head: (r!.head ?? '').slice(0, 12) })
          : !next.nativeAvailable ? t('Repositories read. Deployments are unavailable: the isolated Git runner is not connected on this host.') : r ? (r.dirty ? t('This repository has uncommitted changes, so deploying is refused.') : t('Repository read. Review the commit before deploying.')) : t('Deployments read. Choose an account and inspect a repository.'))
      } catch (error) { if (admitted()) failure(error, operation === 'pull') }
      finally { busy = false; paint() }
    }
    const deploy = async (): Promise<void> => {
      const r = repository(), user = view?.selected?.context.username, revision = view?.selected?.revision
      if (!deployable() || !r || !user || !revision || !r.head) return
      busy = true; lock()
      let approved = false
      try { approved = await askDialog!({ title: t('Deploy {path} for {account}?', { path: r.path, account: user }), body: t('Git fast-forwards the repository from its HTTPS origin as the account user. Files in the working tree change to the new commit.'), danger: true, confirm: t('Deploy') }) === true } catch { approved = false }
      busy = false
      if (!approved || repository() !== r) { lock(); return }
      await send('pull', { account: user, path: r.path, expectedHead: r.head, expectedRevision: revision })
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Deployments are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void send('read') }); account.addEventListener('change', () => { void send('read') }); pull.addEventListener('click', () => { void deploy() })
    void send('read')
  })
}
export const SW_DEPLOYMENTS_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parse=${readSwDeploymentsView.toString()};const bind=${bindSwDeployments.toString()};return (ask)=>bind(ask,parse);})()`
