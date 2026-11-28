/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatDisplayDateTime = canonicalFormatDisplayDateTime
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
const frameAccess = canonicalFrameAccess

export interface GitReleaseView { commit: string; at: string; op?: 'deploy' | 'rollback' }
export interface GitWebhookClientView { configured: boolean; url: string | null; updatedAt: string | null }
export interface GitClientView { revision: string; repositories: string[]; nativeAvailable: boolean; deployed: { commit: string; at: string; op?: 'deploy' | 'rollback' } | null; releases?: GitReleaseView[]; webhook?: GitWebhookClientView | null; selected: { path: string; branch: string; head: string | null; dirty: boolean; changedFiles: number; remote: string | null; branches: { name: string; hash: string; current: boolean }[]; commits: { hash: string; at: string; subject: string }[] } | null }
const GIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GIT_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/
function gitObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function gitBranch(value: unknown): value is string { return typeof value === 'string' && value.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//') && !value.includes('@{') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) && value !== 'HEAD' }
function gitUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512 || !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').slice(3).some(part => part === '..' || part === '.')) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.hostname.includes('.') && !/^(?:[0-9.]+|localhost|.*\.(?:localhost|local|internal))$/i.test(url.hostname) && !url.pathname.split('/').some(part => part === '..' || part === '.') } catch { return false }
}
function gitAscii(value: string): string { return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, char => String(char.charCodeAt(0) - (char.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660))) }
/** Browser checks are independent of server projection and bind the result to the action just sent. */
export function readGitClientView(raw: unknown, accountId: string, sent: Record<string, unknown>): GitClientView {
  const bad = (): never => { throw new Error('invalid_git_reply') }, path = (value: unknown): value is string => typeof value === 'string' && value.length <= 240 && GIT_PATH.test(value) && !value.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()))
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
  const webhookPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^\/api\/account\/git\/webhook\/[0-9a-f]{16,64}(?:\?token=[A-Za-z0-9_-]{32,128})?$/.test(value)
  if (gitObject(raw) && [raw, gitObject(raw.details) ? raw.details : {}, gitObject(raw.detail) ? raw.detail : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return bad()
  if (!gitObject(raw) || !gitObject(raw.context) || raw.context.accountId !== accountId || !gitObject(raw.application) || raw.application.op !== sent.op || raw.application.verificationRequired !== false || raw.application.state !== (['list', 'inspect'].includes(String(sent.op)) ? 'read' : 'verified') || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || !Array.isArray(raw.repositories) || raw.repositories.length > 20 || raw.repositories.some(value => !path(value)) || new Set(raw.repositories).size !== raw.repositories.length || typeof raw.nativeAvailable !== 'boolean') return bad()
  const selected = raw.selected
  if (sent.op === 'list' || sent.op === 'remove') { if (selected !== null || sent.op === 'remove' && raw.repositories.includes(sent.path)) return bad() }
  else {
    if (!gitObject(selected) || selected.path !== sent.path || !raw.repositories.includes(selected.path) || !gitBranch(selected.branch) || !(selected.head === null || hash(selected.head)) || typeof selected.dirty !== 'boolean' || typeof selected.changedFiles !== 'number' || !Number.isSafeInteger(selected.changedFiles) || selected.changedFiles < 0 || selected.changedFiles > 10000 || selected.dirty !== (selected.changedFiles > 0) || !(selected.remote === null || gitUrl(selected.remote)) || !Array.isArray(selected.branches) || selected.branches.length > 100 || !Array.isArray(selected.commits) || selected.commits.length > 20 || raw.nativeAvailable !== true) return bad()
    if (selected.branches.some(b => !gitObject(b) || !gitBranch(b.name) || !hash(b.hash) || typeof b.current !== 'boolean') || selected.commits.some(c => !gitObject(c) || !hash(c.hash) || typeof c.at !== 'string' || c.at.length > 40 || !Number.isFinite(Date.parse(c.at)) || typeof c.subject !== 'string' || c.subject.length > 500 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(c.subject))) return bad()
    const branches = selected.branches as { name: string; hash: string; current: boolean }[], commits = selected.commits as { hash: string }[], current = branches.filter(item => item.current)
    if (new Set(branches.map(item => item.name)).size !== branches.length || (selected.head === null ? branches.length !== 0 || commits.length !== 0 : current.length !== 1 || current[0]!.name !== selected.branch || current[0]!.hash !== selected.head || commits[0]?.hash !== selected.head)) return bad()
    if ((sent.op === 'checkout' || sent.op === 'init') && selected.branch !== sent.branch || !['inspect', 'webhook-rotate'].includes(String(sent.op)) && selected.dirty) return bad()
  }
  if (['remove', 'init', 'clone'].includes(String(sent.op)) && raw.revision === sent.expectedRevision) return bad()
  const deployed = raw.deployed ?? null
  if (deployed !== null && (!gitObject(deployed) || !hash(deployed.commit) || typeof deployed.at !== 'string' || !Number.isFinite(Date.parse(deployed.at)) || (deployed.op !== undefined && deployed.op !== 'deploy' && deployed.op !== 'rollback'))
    || sent.op === 'deploy' && (deployed as { commit?: unknown } | null)?.commit !== (selected as { head?: unknown } | null)?.head
    || sent.op === 'rollback' && (deployed as { commit?: unknown } | null)?.commit !== sent.targetCommit) return bad()
  let releases: GitReleaseView[] = []
  if (raw.releases !== undefined) {
    if (!Array.isArray(raw.releases) || raw.releases.length > 20 || sent.op === 'list') return bad()
    releases = raw.releases.map(item => {
      if (!gitObject(item) || !hash(item.commit) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || (item.op !== undefined && item.op !== 'deploy' && item.op !== 'rollback')) return bad()
      return item.op ? { commit: item.commit, at: item.at, op: item.op } : { commit: item.commit, at: item.at }
    })
  }
  let webhook: GitWebhookClientView | null = null
  if (raw.webhook !== undefined && raw.webhook !== null) {
    const w = raw.webhook
    if (!gitObject(w) || typeof w.configured !== 'boolean' || !(w.url === null || webhookPath(w.url)) || !(w.updatedAt === null || typeof w.updatedAt === 'string' && Number.isFinite(Date.parse(w.updatedAt)))) return bad()
    webhook = { configured: w.configured, url: w.url as string | null, updatedAt: w.updatedAt as string | null }
  }
  if (sent.op === 'webhook-rotate' && (!webhook || !webhook.configured || typeof webhook.url !== 'string')) return bad()
  return { revision: raw.revision, repositories: raw.repositories as string[], nativeAvailable: raw.nativeAvailable, deployed: deployed as GitClientView['deployed'], releases, webhook, selected: selected as GitClientView['selected'] }
}
function bindAccountGit(askDialog: ((input: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-git]').forEach(root => {
    if (root.dataset.gitBound === 'true') return
    root.dataset.gitBound = 'true'
    // Reads run in a read-only frame too; repository actions need the manage flag outside one.
    const access = frameAccess(root, 'data-git-can-read', 'data-git-manage'), send = access.request
    const accountId = root.dataset.account ?? '', readable = access.readable, eligible = access.writable
    const repository = root.querySelector<HTMLSelectElement>('[data-git-repository]')!
    const branch = root.querySelector<HTMLSelectElement>('[data-git-branch]')!
    const status = root.querySelector<HTMLElement>('[data-git-status]')!
    const history = root.querySelector<HTMLElement>('[data-git-history]')!
    const selectedEl = root.querySelector<HTMLElement>('[data-git-selected]')!
    const currentEl = root.querySelector<HTMLElement>('[data-git-current]')!
    const originEl = root.querySelector<HTMLElement>('[data-git-origin]')!
    const treeEl = root.querySelector<HTMLElement>('[data-git-tree]')!
    const deployedFact = root.querySelector<HTMLElement>('[data-git-deployed]')
    const pathInput = root.querySelector<HTMLInputElement>('[data-git-path]')!
    const initialBranchInput = root.querySelector<HTMLInputElement>('[data-git-initial-branch]')!
    const urlInput = root.querySelector<HTMLInputElement>('[data-git-url]')!
    const releaseSelect = root.querySelector<HTMLSelectElement>('[data-git-release-select]')
    const releasesBody = root.querySelector<HTMLElement>('[data-git-releases]')
    const webhookUrlEl = root.querySelector<HTMLElement>('[data-git-webhook-url]')
    const buttons: Record<string, HTMLButtonElement | null> = {
      refresh: root.querySelector<HTMLButtonElement>('[data-git-refresh]'),
      inspect: root.querySelector<HTMLButtonElement>('[data-git-inspect]'),
      remove: root.querySelector<HTMLButtonElement>('[data-git-remove]'),
      init: root.querySelector<HTMLButtonElement>('[data-git-init]'),
      clone: root.querySelector<HTMLButtonElement>('[data-git-clone]'),
      checkout: root.querySelector<HTMLButtonElement>('[data-git-checkout]'),
      pull: root.querySelector<HTMLButtonElement>('[data-git-pull]'),
      deploy: root.querySelector<HTMLButtonElement>('[data-git-deploy]'),
      rollback: root.querySelector<HTMLButtonElement>('[data-git-rollback]'),
      'webhook-rotate': root.querySelector<HTMLButtonElement>('[data-git-webhook-rotate]'),
    }
    if (!repository || !branch || !status || !history) return
    let view: GitClientView | null = null, busy = false, uncertain = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (): void => {
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) control.disabled = !eligible() || busy
      const deployButton = buttons.deploy
      if (deployButton) deployButton.disabled = !eligible() || busy || uncertain || view?.nativeAvailable !== true || !view.selected || !view.selected.head || view.selected.dirty || view.selected.path !== repository.value
      const rollbackButton = buttons.rollback
      if (rollbackButton) rollbackButton.disabled = !eligible() || busy || uncertain || view?.nativeAvailable !== true || !view.selected || view.selected.dirty || view.selected.path !== repository.value || !releaseSelect?.value
      if (releaseSelect) releaseSelect.disabled = !eligible() || busy || uncertain || view?.nativeAvailable !== true || !view.selected || view.selected.path !== repository.value || !(view.releases?.length)
      const rotateButton = buttons['webhook-rotate']
      if (rotateButton) rotateButton.disabled = !eligible() || busy || uncertain || view?.nativeAvailable !== true || !view.selected || view.selected.path !== repository.value
      for (const name of ['refresh', 'inspect', 'remove', 'init', 'clone', 'checkout', 'pull']) {
        const button = buttons[name]; if (!button) continue
        button.disabled = !eligible() || busy || name !== 'refresh' && (!view || uncertain) || ['inspect', 'remove'].includes(name) && !repository.value || ['init', 'clone', 'inspect', 'checkout', 'pull'].includes(name) && view?.nativeAvailable !== true || ['checkout', 'pull'].includes(name) && (!view?.selected?.head || view.selected.path !== repository.value || view.selected.dirty) || name === 'pull' && !view?.selected?.remote || name === 'checkout' && !branch.value
      }
      root.setAttribute('aria-busy', String(busy))
    }
    let templates: { row: HTMLTemplateElement; empty: HTMLTemplateElement }
    try {
      templates = { row: clientTemplate(root, 'git-history-row'), empty: clientTemplate(root, 'git-history-empty') }
      cloneClientTemplate(templates.row, 'tr', ['hash', 'at', 'subject'])
      cloneClientTemplate(templates.empty, 'tr', ['message'])
    } catch {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) control.disabled = true
      note('unavailable', t('Git is unavailable here. Nothing was read or changed.')); return
    }
    const paint = (next: GitClientView): void => {
      view = next
      const previous = next.selected?.path ?? repository.value; repository.textContent = ''
      if (!next.repositories.length) repository.add(new Option(t('No repositories registered'), ''))
      for (const path of next.repositories) repository.add(new Option(path, path))
      if (next.repositories.includes(previous)) repository.value = previous
      const selected = next.selected
      selectedEl.textContent = selected?.path ?? '-'; currentEl.textContent = selected?.branch ?? '-'; originEl.textContent = selected?.remote ?? '-'
      if (deployedFact) { deployedFact.textContent = !selected ? t(msgctxt('account-git-client', 'Not read')) : next.deployed ? gitAscii(next.deployed.commit.slice(0, 12)) + ' ' + formatDisplayDateTime(next.deployed.at) : t('Not deployed') }
      treeEl.textContent = !selected ? t(msgctxt('account-git-client', 'Not read')) : selected.dirty ? t('{count} changed files', { count: selected.changedFiles }) : t('Clean')
      branch.textContent = ''; for (const item of selected?.branches ?? []) branch.add(new Option(item.name, item.name)); if (selected) branch.value = selected.branch
      history.textContent = ''
      for (const commit of selected?.commits ?? []) {
        const row = cloneClientTemplate(templates.row, 'tr', ['hash', 'at', 'subject'])
        clientTemplateSlot(row, 'hash').textContent = gitAscii(commit.hash)
        const time = clientTemplateSlot(row, 'at', 'time'); time.setAttribute('datetime', commit.at); time.textContent = formatDisplayDateTime(commit.at)
        clientTemplateSlot(row, 'subject').textContent = gitAscii(commit.subject); history.append(row)
      }
      if (!selected?.commits.length) { const row = cloneClientTemplate(templates.empty, 'tr', ['message']); clientTemplateSlot(row, 'message', 'td').textContent = selected ? t('No commits yet.') : t('Select a repository and read its details.'); history.append(row) }
      const releases = selected ? (next.releases ?? []) : []
      if (releaseSelect) {
        const previousRelease = releaseSelect.value
        releaseSelect.textContent = ''
        const seenCommits = new Set<string>()
        for (const release of releases) {
          if (seenCommits.has(release.commit)) continue
          seenCommits.add(release.commit)
          releaseSelect.add(new Option(gitAscii(release.commit.slice(0, 12)) + ' · ' + formatDisplayDateTime(release.at), release.commit))
        }
        if (!releaseSelect.options.length) releaseSelect.add(new Option('—', ''))
        else if (seenCommits.has(previousRelease)) releaseSelect.value = previousRelease
      }
      if (releasesBody) {
        releasesBody.textContent = ''
        for (const release of releases) {
          const row = cloneClientTemplate(templates.row, 'tr', ['hash', 'at', 'subject'])
          clientTemplateSlot(row, 'hash').textContent = gitAscii(release.commit)
          const time = clientTemplateSlot(row, 'at', 'time'); time.setAttribute('datetime', release.at); time.textContent = formatDisplayDateTime(release.at)
          clientTemplateSlot(row, 'subject').textContent = release.op === 'rollback' ? t('Rollback') : t('Deploy')
          releasesBody.append(row)
        }
        if (!releases.length) { const row = cloneClientTemplate(templates.empty, 'tr', ['message']); clientTemplateSlot(row, 'message', 'td').textContent = selected ? t('No deployments recorded yet.') : t('Select a repository and read its details.'); releasesBody.append(row) }
      }
      if (webhookUrlEl) {
        webhookUrlEl.textContent = !selected ? '—' : next.webhook?.url ?? (next.webhook?.configured ? t('Configured') : t('Not configured'))
      }
    }
    async function perform(sent: Record<string, unknown>): Promise<void> {
      if (!(sent.op === 'list' ? readable() : eligible()) || busy || !send) return
      const mutation = !['list', 'inspect'].includes(String(sent.op))
      if (mutation && (!view || uncertain)) return
      if (mutation) {
        if (!askDialog) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
        busy = true; lock()
        let confirmed = false
        try {
          const promptBody = sent.op === 'remove' ? t('Remove this entry only. Files will remain.')
            : sent.op === 'deploy' ? t('Run the tasks in .cpanel.yml at the current commit? They run as your account and can change your website.')
            : sent.op === 'rollback' ? t('Redeploy recorded commit {commit} using .cpanel.yml? They run as your account and can change your website.', { commit: gitAscii(String(sent.targetCommit ?? '').slice(0, 12)) })
            : sent.op === 'webhook-rotate' ? t('Rotate the deploy webhook token? Any previous webhook URL stops working immediately.')
            : t('Apply the selected Git action to this repository?')
          confirmed = await askDialog({ title: t('Confirm repository action'), body: String(sent.path) + '\n' + promptBody, confirm: t('Confirm'), danger: sent.op === 'remove' }) === true
        } catch { confirmed = false }
        busy = false
        if (!confirmed || !eligible()) { lock(); return }
      }
      busy = true; lock(); note('reading', t('Reading or applying the repository action…'))
      try { const raw = await send(sent.op === 'list' ? 'GET' : 'POST', '/api/account/git', sent.op === 'list' ? undefined : sent); paint(readGitClientView(raw, accountId, sent)); if (sent.op === 'list') uncertain = false; note('read', sent.op === 'list' && !view!.nativeAvailable ? t('List read. Native Git operations are unavailable.') : sent.op === 'webhook-rotate' ? t('Webhook token rotated. Copy the new URL now; the secret token is shown once.') : t('Repository action verified.')) }
      catch (error) {
        const record = gitObject(error) ? error : {}, detail = gitObject(record.details) ? record.details : gitObject(record.detail) ? record.detail : {}
        if (mutation && !(detail.stateChanged === false && detail.unknownOutcome !== true && detail.verificationRequired !== true)) uncertain = true
        note('failed', uncertain ? t('The result needs review. Inspect the repository through your own Git access before retrying; read the list to unlock.') : record.code === 'CONFLICT' ? t('The repository changed or has uncommitted files. Read it again.') : (sent.op === 'deploy' || sent.op === 'rollback') && record.code === 'FORBIDDEN' ? t('Deployment tasks need shell access on this account. Nothing was run.') : (sent.op === 'deploy' || sent.op === 'rollback') && record.code === 'PRECONDITION_FAILED' ? t('This repository has no usable .cpanel.yml deployment file, or no commit yet. Nothing was run.') : t('The repository could not be read or changed. Check its path, configuration and permissions.'))
      } finally { busy = false; lock() }
    }
    const action = (op: string): void => {
      if (op === 'list') { void perform({ op }); return }
      if (!view) return
      const path = ['init', 'clone'].includes(op) ? pathInput.value.trim() : repository.value
      const sent: Record<string, unknown> = { op, path }
      if (op !== 'inspect') sent.expectedRevision = view.revision
      if (op === 'init') sent.branch = initialBranchInput.value.trim()
      if (op === 'clone') sent.url = urlInput.value.trim()
      if (op === 'checkout') sent.branch = branch.value
      if (op === 'checkout' || op === 'pull') sent.expectedHead = view.selected?.head
      if (op === 'rollback') sent.targetCommit = releaseSelect?.value ?? ''
      void perform(sent)
    }
    for (const [name, button] of Object.entries(buttons)) button?.addEventListener('click', () => action(name === 'refresh' ? 'list' : name))
    repository.addEventListener('change', () => { if (view) paint({ ...view, selected: null, deployed: null, releases: [], webhook: null }); lock() }); branch.addEventListener('change', lock); releaseSelect?.addEventListener('change', lock)
    if (!readable() || !GIT_ID.test(accountId)) { for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) control.disabled = true; note('unavailable', t('Git is unavailable here. Nothing was read or changed.')); return }
    lock(); void perform({ op: 'list' })
  })
}
export const ACCOUNT_GIT_CLIENT_BINDING = withFrameRequest(`(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const GIT_ID=${GIT_ID.toString()};const GIT_PATH=${GIT_PATH.toString()};const gitObject=${gitObject.toString()};const gitBranch=${gitBranch.toString()};const gitUrl=${gitUrl.toString()};const gitAscii=${gitAscii.toString()};const readGitClientView=${readGitClientView.toString()};return ${bindAccountGit.toString()};})()`)
