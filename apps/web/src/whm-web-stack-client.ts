/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'

const frameRequest = canonicalFrameRequest

export interface WebStackProfileSummary {
  id: string
  name: string
  engine: 'apache' | 'openlitespeed'
  mpm: 'itk'
  modules: string[]
  phpVersions: string[]
  summary: string
}

export interface WebStackViewModel {
  observedAt: string
  engine: 'apache' | 'openlitespeed'
  apacheMpm: string
  isolationPolicy: 'mpm_itk'
  isolationEnforced: boolean
  activeProfile: {
    profileId: string
    engine: 'apache' | 'openlitespeed'
    mpm: 'itk'
    modules: string[]
    phpVersions: string[]
  }
  profiles: WebStackProfileSummary[]
  mpmConfigPath: string
  mpmConfigPreview: string | null
  revision: string
}

export interface WebStackPreviewModel {
  valid: boolean
  isolationPolicy: 'mpm_itk'
  diff: {
    addModules: string[]
    removeModules: string[]
    addPhpVersions: string[]
    removePhpVersions: string[]
    engineChanged: boolean
  }
  renderedFiles: { path: string; content: string }[]
}

export interface OpenLiteSpeedBackupModel {
  id: string
  createdAt: string
  checksum: string
}

export interface OpenLiteSpeedViewModel {
  observedAt: string
  installed: boolean
  state: 'active' | 'inactive' | 'failed' | 'not_installed'
  unit: string | null
  active: string | null
  enabled: string | null
  binaryPath: string
  configPath: string
  config: string | null
  revision: string | null
  backups: OpenLiteSpeedBackupModel[]
  logTail: string[]
  renderedReference: string
}

export function validateWebStackMpmChoice(
  mpms: readonly string[],
): { ok: true; mpm: 'itk' } | { ok: false; status: 409 | 422; reason: 'multiple_mpms_selected' | 'mpm_isolation_required' } {
  const normalized = [...new Set(mpms.map(item => item.trim().toLowerCase().replace(/^mpm[-_]/, '')))]
  if (normalized.length > 1 || mpms.length > 1) {
    return { ok: false, status: 409, reason: 'multiple_mpms_selected' }
  }
  if (normalized.length !== 1 || normalized[0] !== 'itk') {
    return { ok: false, status: 422, reason: 'mpm_isolation_required' }
  }
  return { ok: true, mpm: 'itk' }
}

export function readWebStackView(raw: unknown): WebStackViewModel {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const str = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
  const strArr = (v: unknown, max = 64): v is string[] => Array.isArray(v) && v.length <= max && v.every(item => str(item, 64))
  if (
    !obj(raw)
    || !str(raw.observedAt, 64)
    || (raw.engine !== 'apache' && raw.engine !== 'openlitespeed')
    || !str(raw.apacheMpm, 32)
    || raw.isolationPolicy !== 'mpm_itk'
    || typeof raw.isolationEnforced !== 'boolean'
    || !obj(raw.activeProfile)
    || !str(raw.activeProfile.profileId, 64)
    || (raw.activeProfile.engine !== 'apache' && raw.activeProfile.engine !== 'openlitespeed')
    || raw.activeProfile.mpm !== 'itk'
    || !strArr(raw.activeProfile.modules)
    || !strArr(raw.activeProfile.phpVersions)
    || !Array.isArray(raw.profiles)
    || !str(raw.mpmConfigPath, 256)
    || (raw.mpmConfigPreview !== null && typeof raw.mpmConfigPreview !== 'string')
    || typeof raw.revision !== 'string'
    || !/^[0-9a-f]{64}$/.test(raw.revision)
  ) {
    throw new Error('invalid_web_stack_view')
  }
  const profiles: WebStackProfileSummary[] = raw.profiles.map(item => {
    if (
      !obj(item)
      || !str(item.id, 64)
      || !str(item.name, 128)
      || (item.engine !== 'apache' && item.engine !== 'openlitespeed')
      || item.mpm !== 'itk'
      || !strArr(item.modules)
      || !strArr(item.phpVersions)
      || !str(item.summary, 256)
    ) {
      throw new Error('invalid_web_stack_profile')
    }
    return {
      id: item.id,
      name: item.name,
      engine: item.engine,
      mpm: 'itk',
      modules: [...item.modules],
      phpVersions: [...item.phpVersions],
      summary: item.summary,
    }
  })
  return {
    observedAt: raw.observedAt,
    engine: raw.engine,
    apacheMpm: raw.apacheMpm,
    isolationPolicy: 'mpm_itk',
    isolationEnforced: raw.isolationEnforced,
    activeProfile: {
      profileId: raw.activeProfile.profileId,
      engine: raw.activeProfile.engine,
      mpm: 'itk',
      modules: [...raw.activeProfile.modules],
      phpVersions: [...raw.activeProfile.phpVersions],
    },
    profiles,
    mpmConfigPath: raw.mpmConfigPath,
    mpmConfigPreview: raw.mpmConfigPreview as string | null,
    revision: raw.revision,
  }
}

export function readWebStackPreview(raw: unknown): WebStackPreviewModel {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every(item => typeof item === 'string')
  if (
    !obj(raw)
    || raw.valid !== true
    || raw.isolationPolicy !== 'mpm_itk'
    || !obj(raw.diff)
    || !strArr(raw.diff.addModules)
    || !strArr(raw.diff.removeModules)
    || !strArr(raw.diff.addPhpVersions)
    || !strArr(raw.diff.removePhpVersions)
    || typeof raw.diff.engineChanged !== 'boolean'
    || !Array.isArray(raw.renderedFiles)
  ) {
    throw new Error('invalid_web_stack_preview')
  }
  const renderedFiles = raw.renderedFiles.map(file => {
    if (!obj(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('invalid_web_stack_preview_file')
    }
    return { path: file.path, content: file.content }
  })
  return {
    valid: true,
    isolationPolicy: 'mpm_itk',
    diff: {
      addModules: [...raw.diff.addModules],
      removeModules: [...raw.diff.removeModules],
      addPhpVersions: [...raw.diff.addPhpVersions],
      removePhpVersions: [...raw.diff.removePhpVersions],
      engineChanged: raw.diff.engineChanged,
    },
    renderedFiles,
  }
}

export function readOpenLiteSpeedView(raw: unknown): OpenLiteSpeedViewModel {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const str = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max
  const optStr = (v: unknown, max = 256): v is string | null => v === null || str(v, max)
  if (
    !obj(raw)
    || !str(raw.observedAt, 64)
    || typeof raw.installed !== 'boolean'
    || !['active', 'inactive', 'failed', 'not_installed'].includes(String(raw.state))
    || !optStr(raw.unit, 128)
    || !optStr(raw.active, 64)
    || !optStr(raw.enabled, 64)
    || !str(raw.binaryPath, 256)
    || !str(raw.configPath, 256)
    || (raw.config !== null && typeof raw.config !== 'string')
    || (raw.revision !== null && (typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)))
    || !Array.isArray(raw.backups)
    || !Array.isArray(raw.logTail)
    || typeof raw.renderedReference !== 'string'
  ) {
    throw new Error('invalid_ols_view')
  }
  const backups: OpenLiteSpeedBackupModel[] = raw.backups.map(item => {
    if (!obj(item) || !str(item.id, 64) || !str(item.createdAt, 64) || !str(item.checksum, 64)) {
      throw new Error('invalid_ols_backup')
    }
    return { id: item.id, createdAt: item.createdAt, checksum: item.checksum }
  })
  return {
    observedAt: raw.observedAt,
    installed: raw.installed,
    state: raw.state as OpenLiteSpeedViewModel['state'],
    unit: raw.unit,
    active: raw.active,
    enabled: raw.enabled,
    binaryPath: raw.binaryPath,
    configPath: raw.configPath,
    config: raw.config as string | null,
    revision: raw.revision,
    backups,
    logTail: raw.logTail.filter((line): line is string => typeof line === 'string').slice(0, 200),
    renderedReference: raw.renderedReference,
  }
}

function bindWhmWebStack(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const isReadOnlyFrame = (el: HTMLElement): boolean => el.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') !== null
  const setStatus = (el: HTMLElement | null, state: string, message: string): void => {
    if (!el) return
    el.dataset.state = state
    el.textContent = message
    el.setAttribute('role', ['failed', 'uncertain'].includes(state) ? 'alert' : 'status')
  }
  const errorDetail = (error: unknown): { code: string; reason: string; message: string } => {
    const obj = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const details = obj.details && typeof obj.details === 'object' ? obj.details as Record<string, unknown> : {}
    return {
      code: typeof obj.code === 'string' ? obj.code : '',
      reason: typeof details.reason === 'string' ? details.reason : '',
      message: typeof obj.detail === 'string' ? obj.detail : typeof obj.message === 'string' ? obj.message : '',
    }
  }

  document.querySelectorAll<HTMLElement>('[data-web-stack-builder]').forEach(root => {
    if (root.dataset.webStackBound === 'true') return
    root.dataset.webStackBound = 'true'
    const request = frameRequest(root)
    const statusEl = root.querySelector<HTMLElement>('[data-web-stack-status]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-web-stack-refresh]')
    const profileSelect = root.querySelector<HTMLSelectElement>('[data-web-stack-profile]')
    const mpmSelect = root.querySelector<HTMLSelectElement>('[data-web-stack-mpm]')
    const moduleBoxes = [...root.querySelectorAll<HTMLInputElement>('[data-web-stack-module]')]
    const phpBoxes = [...root.querySelectorAll<HTMLInputElement>('[data-web-stack-php]')]
    const previewBtn = root.querySelector<HTMLButtonElement>('[data-web-stack-preview]')
    const applyBtn = root.querySelector<HTMLButtonElement>('[data-web-stack-apply]')
    const previewOut = root.querySelector<HTMLElement>('[data-web-stack-preview-output]')
    const activeEngineEl = root.querySelector<HTMLElement>('[data-web-stack-active-engine]')
    const activeMpmEl = root.querySelector<HTMLElement>('[data-web-stack-active-mpm]')
    const isolationEl = root.querySelector<HTMLElement>('[data-web-stack-isolation]')
    const revisionEl = root.querySelector<HTMLElement>('[data-web-stack-revision]')

    const readable = () => root.isConnected && root.dataset.webStackCanRead === 'true'
    const writable = () => readable() && root.dataset.webStackCanManage === 'true' && !isReadOnlyFrame(root)
    let busy = false
    let currentView: WebStackViewModel | null = null

    const syncControls = (): void => {
      const canRead = readable() && Boolean(request)
      const canWrite = writable() && Boolean(request) && currentView !== null
      if (refreshBtn) refreshBtn.disabled = busy || !canRead
      if (profileSelect) profileSelect.disabled = busy || !canWrite
      if (mpmSelect) mpmSelect.disabled = busy || !canWrite
      for (const box of moduleBoxes) box.disabled = busy || !canWrite
      for (const box of phpBoxes) box.disabled = busy || !canWrite
      if (previewBtn) previewBtn.disabled = busy || !canWrite
      if (applyBtn) applyBtn.disabled = busy || !canWrite
      root.setAttribute('aria-busy', String(busy))
    }

    const collectPayload = (): Record<string, unknown> => {
      const profileId = profileSelect?.value || 'apache-itk-fpm'
      const matched = currentView?.profiles.find(item => item.id === profileId)
      const engine = matched?.engine ?? (profileId === 'openlitespeed-lsphp' ? 'openlitespeed' : 'apache')
      return {
        profileId,
        engine,
        mpm: mpmSelect?.value || 'itk',
        modules: moduleBoxes.filter(box => box.checked).map(box => box.value),
        phpVersions: phpBoxes.filter(box => box.checked).map(box => box.value),
        ...(currentView ? { expectedRevision: currentView.revision } : {}),
      }
    }

    const paintView = (view: WebStackViewModel): void => {
      currentView = view
      if (activeEngineEl) activeEngineEl.textContent = view.engine
      if (activeMpmEl) activeMpmEl.textContent = view.apacheMpm === 'itk' ? 'mpm_itk' : view.apacheMpm
      if (isolationEl) isolationEl.textContent = view.isolationEnforced ? t('Enforced (mpm_itk)') : t('Unverified')
      if (revisionEl) revisionEl.textContent = view.revision.slice(0, 12)
      if (profileSelect) {
        profileSelect.textContent = ''
        for (const profile of view.profiles) {
          const opt = document.createElement('option')
          opt.value = profile.id
          opt.textContent = profile.name
          profileSelect.append(opt)
        }
        if ([...profileSelect.options].some(opt => opt.value === view.activeProfile.profileId)) {
          profileSelect.value = view.activeProfile.profileId
        }
      }
      if (mpmSelect) mpmSelect.value = 'itk'
      for (const box of moduleBoxes) box.checked = view.activeProfile.modules.includes(box.value)
      for (const box of phpBoxes) box.checked = view.activeProfile.phpVersions.includes(box.value)
      if (previewOut && view.mpmConfigPreview) {
        previewOut.textContent = view.mpmConfigPreview
      }
    }

    const loadStack = async (): Promise<void> => {
      if (busy || !readable() || !request) return
      busy = true
      syncControls()
      setStatus(statusEl, 'reading', t('Reading web stack profile and MPM policy…'))
      try {
        const view = readWebStackView(await request('GET', '/api/server/web-stack'))
        if (!readable()) return
        paintView(view)
        setStatus(statusEl, 'read', t('Web stack profile read. Per-account mpm_itk isolation is enforced.'))
      } catch {
        setStatus(statusEl, 'failed', t('Could not read the web stack profile. Nothing was changed.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    const runPreview = async (): Promise<void> => {
      if (busy || !writable() || !request) return
      busy = true
      syncControls()
      setStatus(statusEl, 'reading', t('Validating stack selection and rendering configuration preview…'))
      try {
        const preview = readWebStackPreview(await request('POST', '/api/server/web-stack/preview', collectPayload()))
        if (previewOut) {
          const fileBlocks = preview.renderedFiles.map(file => `# ${file.path}\n${file.content}`).join('\n')
          previewOut.textContent = fileBlocks || t('No generated files in preview.')
        }
        setStatus(statusEl, 'read', t('Web stack selection validated with mpm_itk isolation.'))
      } catch (error) {
        const info = errorDetail(error)
        if (info.reason === 'multiple_mpms_selected') {
          setStatus(statusEl, 'failed', t('Multiple Apache MPMs cannot be selected at the same time.'))
        } else if (info.reason === 'mpm_isolation_required') {
          setStatus(statusEl, 'failed', t('Apache requires mpm_itk per-account process isolation. Non-isolated MPMs are refused.'))
        } else {
          setStatus(statusEl, 'failed', t('Web stack preview failed. Nothing was changed.'))
        }
      } finally {
        busy = false
        syncControls()
      }
    }

    const runApply = async (): Promise<void> => {
      if (busy || !writable() || !request) return
      if (askDialog) {
        const ok = await askDialog({
          title: t('Apply web stack profile?'),
          body: t('The server will validate mpm_itk isolation, run configuration tests and reload affected web services.'),
          confirm: t('Apply stack'),
        }).catch(() => false)
        if (ok !== true) return
      }
      busy = true
      syncControls()
      setStatus(statusEl, 'saving', t('Testing configuration and applying web stack profile…'))
      try {
        await request('POST', '/api/server/web-stack/apply', collectPayload())
        const fresh = readWebStackView(await request('GET', '/api/server/web-stack'))
        paintView(fresh)
        setStatus(statusEl, 'saved', t('Web stack profile applied and configuration tests passed.'))
      } catch (error) {
        const info = errorDetail(error)
        if (info.reason === 'multiple_mpms_selected') {
          setStatus(statusEl, 'failed', t('Multiple Apache MPMs cannot be selected at the same time.'))
        } else if (info.reason === 'mpm_isolation_required') {
          setStatus(statusEl, 'failed', t('Apache requires mpm_itk per-account process isolation. Non-isolated MPMs are refused.'))
        } else if (info.reason === 'web_stack_config_test_failed') {
          setStatus(statusEl, 'failed', t('Configuration test failed; previous web stack configuration was restored.'))
        } else {
          setStatus(statusEl, 'failed', t('Web stack apply was refused or failed. Read state before retrying.'))
        }
      } finally {
        busy = false
        syncControls()
      }
    }

    if (!request || !readable()) {
      syncControls()
      setStatus(statusEl, 'unavailable', t('Web stack controls are unavailable here.'))
      return
    }
    syncControls()
    refreshBtn?.addEventListener('click', () => { void loadStack() })
    previewBtn?.addEventListener('click', () => { void runPreview() })
    applyBtn?.addEventListener('click', () => { void runApply() })
    profileSelect?.addEventListener('change', () => {
      const matched = currentView?.profiles.find(item => item.id === profileSelect.value)
      if (!matched) return
      for (const box of moduleBoxes) box.checked = matched.modules.includes(box.value)
      for (const box of phpBoxes) box.checked = matched.phpVersions.includes(box.value)
    })
    void loadStack()
  })

  document.querySelectorAll<HTMLElement>('[data-ols-manager]').forEach(root => {
    if (root.dataset.olsBound === 'true') return
    root.dataset.olsBound = 'true'
    const request = frameRequest(root)
    const statusEl = root.querySelector<HTMLElement>('[data-ols-status]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-ols-refresh]')
    const stateEl = root.querySelector<HTMLElement>('[data-ols-state]')
    const unitEl = root.querySelector<HTMLElement>('[data-ols-unit]')
    const configPathEl = root.querySelector<HTMLElement>('[data-ols-config-path]')
    const revisionEl = root.querySelector<HTMLElement>('[data-ols-revision]')
    const actionButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-ols-action]')]
    const toggleEditorBtn = root.querySelector<HTMLButtonElement>('[data-ols-config-toggle]')
    const editorContainer = root.querySelector<HTMLElement>('[data-ols-config-editor]')
    const configText = root.querySelector<HTMLTextAreaElement>('[data-ols-config-text]')
    const previewConfigBtn = root.querySelector<HTMLButtonElement>('[data-ols-config-preview]')
    const applyConfigBtn = root.querySelector<HTMLButtonElement>('[data-ols-config-apply]')
    const backupSelect = root.querySelector<HTMLSelectElement>('[data-ols-backup-select]')
    const rollbackBtn = root.querySelector<HTMLButtonElement>('[data-ols-config-rollback]')
    const previewOutputEl = root.querySelector<HTMLElement>('[data-ols-preview-output]')
    const logTailEl = root.querySelector<HTMLElement>('[data-ols-log-tail]')

    const readable = () => root.isConnected && root.dataset.olsCanRead === 'true'
    const writable = () => readable() && root.dataset.olsCanManage === 'true' && !isReadOnlyFrame(root)
    let busy = false
    let currentView: OpenLiteSpeedViewModel | null = null

    const stateLabels: Record<string, string> = {
      active: t('Active'),
      inactive: t('Inactive'),
      failed: t('Failed'),
      not_installed: t('Not installed'),
    }

    const syncControls = (): void => {
      const canRead = readable() && Boolean(request)
      const canWrite = writable() && Boolean(request)
      const installed = currentView?.installed === true
      if (refreshBtn) refreshBtn.disabled = busy || !canRead
      for (const btn of actionButtons) btn.disabled = busy || !canWrite || !installed
      if (toggleEditorBtn) toggleEditorBtn.disabled = busy || !canRead
      if (configText) configText.disabled = busy || !canWrite
      if (previewConfigBtn) previewConfigBtn.disabled = busy || !canWrite
      if (applyConfigBtn) applyConfigBtn.disabled = busy || !canWrite || !installed
      if (backupSelect) backupSelect.disabled = busy || !canWrite || !installed || (currentView?.backups.length ?? 0) === 0
      if (rollbackBtn) rollbackBtn.disabled = busy || !canWrite || !installed || (currentView?.backups.length ?? 0) === 0
      root.setAttribute('aria-busy', String(busy))
    }

    const paintView = (view: OpenLiteSpeedViewModel): void => {
      currentView = view
      if (stateEl) stateEl.textContent = stateLabels[view.state] ?? view.state
      if (unitEl) unitEl.textContent = view.unit ?? t('Not installed')
      if (configPathEl) configPathEl.textContent = view.configPath
      if (revisionEl) revisionEl.textContent = view.revision ? view.revision.slice(0, 12) : '—'
      if (configText) configText.value = view.config ?? view.renderedReference
      if (editorContainer) editorContainer.hidden = !view.installed
      if (backupSelect) {
        backupSelect.textContent = ''
        if (view.backups.length === 0) {
          const opt = document.createElement('option')
          opt.value = ''
          opt.textContent = t('No saved backups')
          backupSelect.append(opt)
        } else {
          for (const entry of view.backups) {
            const opt = document.createElement('option')
            opt.value = entry.id
            opt.textContent = `${entry.id} (${entry.createdAt.slice(0, 19).replace('T', ' ')})`
            backupSelect.append(opt)
          }
        }
      }
      if (logTailEl) {
        logTailEl.textContent = view.logTail.length > 0 ? view.logTail.join('\n') : t('No OpenLiteSpeed log lines observed.')
      }
    }

    const loadOls = async (): Promise<void> => {
      if (busy || !readable() || !request) return
      busy = true
      syncControls()
      setStatus(statusEl, 'reading', t('Reading OpenLiteSpeed service and configuration state…'))
      try {
        const view = readOpenLiteSpeedView(await request('GET', '/api/server/services/openlitespeed'))
        if (!readable()) return
        paintView(view)
        setStatus(
          statusEl,
          'read',
          view.installed
            ? t('OpenLiteSpeed status and configuration read.')
            : t('OpenLiteSpeed (lshttpd) is not installed on this host.'),
        )
      } catch {
        setStatus(statusEl, 'failed', t('Could not read OpenLiteSpeed status.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    const runAction = async (action: string): Promise<void> => {
      if (busy || !writable() || !request || !currentView?.installed) return
      if ((action === 'stop' || action === 'restart' || action === 'disable') && askDialog) {
        const ok = await askDialog({
          title: t('Confirm OpenLiteSpeed service action'),
          body: t('Run {action} on the OpenLiteSpeed service?', { action }),
          confirm: t('Confirm'),
          danger: action === 'stop' || action === 'disable',
        }).catch(() => false)
        if (ok !== true) return
      }
      busy = true
      syncControls()
      setStatus(statusEl, 'saving', t('Running OpenLiteSpeed service action…'))
      try {
        await request('POST', '/api/server/services/openlitespeed/action', { action })
        const fresh = readOpenLiteSpeedView(await request('GET', '/api/server/services/openlitespeed'))
        paintView(fresh)
        setStatus(statusEl, 'saved', t('OpenLiteSpeed service action completed.'))
      } catch {
        setStatus(statusEl, 'failed', t('OpenLiteSpeed service action failed.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    const previewConfig = async (): Promise<void> => {
      if (busy || !writable() || !request || !configText) return
      busy = true
      syncControls()
      setStatus(statusEl, 'reading', t('Validating OpenLiteSpeed directives…'))
      try {
        const reply = await request('POST', '/api/server/services/openlitespeed/config/preview', { text: configText.value }) as {
          linesCount?: number
          directivesCount?: number
          renderedText?: string
        }
        if (previewOutputEl && typeof reply.renderedText === 'string') {
          previewOutputEl.textContent = reply.renderedText
        }
        setStatus(statusEl, 'read', t('OpenLiteSpeed configuration validated ({count} directives).', { count: String(reply.directivesCount ?? 0) }))
      } catch (error) {
        const info = errorDetail(error)
        if (info.reason === 'unsafe_ols_include') {
          setStatus(statusEl, 'failed', t('Unsafe include path rejected in OpenLiteSpeed configuration.'))
        } else if (info.reason === 'unsafe_ols_directive') {
          setStatus(statusEl, 'failed', t('Disallowed shell metacharacter rejected in OpenLiteSpeed configuration.'))
        } else {
          setStatus(statusEl, 'failed', t('OpenLiteSpeed configuration validation failed.'))
        }
      } finally {
        busy = false
        syncControls()
      }
    }

    const applyConfig = async (): Promise<void> => {
      if (busy || !writable() || !request || !configText || !currentView?.installed) return
      if (askDialog) {
        const ok = await askDialog({
          title: t('Apply OpenLiteSpeed configuration?'),
          body: t('A backup will be saved first. If reload fails, the previous httpd_config.conf is restored automatically.'),
          confirm: t('Apply configuration'),
        }).catch(() => false)
        if (ok !== true) return
      }
      busy = true
      syncControls()
      setStatus(statusEl, 'saving', t('Backing up, applying and verifying OpenLiteSpeed configuration…'))
      try {
        await request('POST', '/api/server/services/openlitespeed/config/apply', {
          text: configText.value,
          ...(currentView.revision ? { expectedRevision: currentView.revision } : {}),
        })
        const fresh = readOpenLiteSpeedView(await request('GET', '/api/server/services/openlitespeed'))
        paintView(fresh)
        setStatus(statusEl, 'saved', t('OpenLiteSpeed configuration applied and verified.'))
      } catch (error) {
        const info = errorDetail(error)
        if (info.reason === 'openlitespeed_config_rejected') {
          setStatus(statusEl, 'failed', t('OpenLiteSpeed rejected the configuration; previous file was restored.'))
        } else {
          setStatus(statusEl, 'failed', t('Failed to apply OpenLiteSpeed configuration.'))
        }
      } finally {
        busy = false
        syncControls()
      }
    }

    const rollbackConfig = async (): Promise<void> => {
      if (busy || !writable() || !request || !currentView?.installed) return
      const backupId = backupSelect?.value || undefined
      if (askDialog) {
        const ok = await askDialog({
          title: t('Rollback OpenLiteSpeed configuration?'),
          body: t('Restore the selected httpd_config.conf backup and restart OpenLiteSpeed if active?'),
          confirm: t('Rollback configuration'),
          danger: true,
        }).catch(() => false)
        if (ok !== true) return
      }
      busy = true
      syncControls()
      setStatus(statusEl, 'saving', t('Restoring OpenLiteSpeed configuration backup…'))
      try {
        await request('POST', '/api/server/services/openlitespeed/config/rollback', {
          ...(backupId ? { backupId } : {}),
          ...(currentView.revision ? { expectedRevision: currentView.revision } : {}),
        })
        const fresh = readOpenLiteSpeedView(await request('GET', '/api/server/services/openlitespeed'))
        paintView(fresh)
        setStatus(statusEl, 'saved', t('OpenLiteSpeed configuration restored from backup.'))
      } catch {
        setStatus(statusEl, 'failed', t('OpenLiteSpeed configuration rollback failed.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    if (!request || !readable()) {
      syncControls()
      setStatus(statusEl, 'unavailable', t('OpenLiteSpeed controls are unavailable here.'))
      return
    }
    syncControls()
    refreshBtn?.addEventListener('click', () => { void loadOls() })
    toggleEditorBtn?.addEventListener('click', () => { if (editorContainer) editorContainer.hidden = !editorContainer.hidden })
    for (const btn of actionButtons) {
      btn.addEventListener('click', () => { void runAction(btn.dataset.olsAction ?? '') })
    }
    previewConfigBtn?.addEventListener('click', () => { void previewConfig() })
    applyConfigBtn?.addEventListener('click', () => { void applyConfig() })
    rollbackBtn?.addEventListener('click', () => { void rollbackConfig() })
    void loadOls()
  })
}

export const WHM_WEB_STACK_CLIENT_BINDING = withFrameRequest(
  `(()=>{const validateWebStackMpmChoice=${validateWebStackMpmChoice.toString()};const readWebStackView=${readWebStackView.toString()};const readWebStackPreview=${readWebStackPreview.toString()};const readOpenLiteSpeedView=${readOpenLiteSpeedView.toString()};return ${bindWhmWebStack.toString()};})()`,
)
