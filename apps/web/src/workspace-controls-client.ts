/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'

const frameRequest = canonicalFrameRequest

type JsonTransport = (method: string, path: string, body?: unknown) => Promise<unknown>

/**
 * Self-contained browser binder for extended workspace controls across panel and host workspaces.
 * Uses only literal DOM selectors, DOM element creation with textContent, and frameRequest for writes.
 */
export function bindWorkspaceControls(): void {
  const txt = (message: string, values?: MessageValues): string =>
    typeof (globalThis as { xpT?: (msg: string, vals?: MessageValues) => string }).xpT === 'function'
      ? (globalThis as { xpT: (msg: string, vals?: MessageValues) => string }).xpT(message, values)
      : message

  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const isBlockedFrame = (el: Element): boolean =>
    el.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') !== null

  const errorMessage = (error: unknown, fallback: string): string => {
    if (isObj(error) && typeof error.message === 'string' && error.message.trim()) return error.message
    if (error instanceof Error && error.message.trim()) return error.message
    return fallback
  }

  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    if (bytes < 1024) return `${Math.round(bytes)} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MiB`
    return `${(bytes / 1073741824).toFixed(2)} GiB`
  }

  const makeCell = (value: string, ltr = false): HTMLTableCellElement => {
    const td = document.createElement('td')
    if (ltr) {
      const bdi = document.createElement('bdi')
      bdi.dir = 'ltr'
      bdi.textContent = value
      td.appendChild(bdi)
    } else {
      td.textContent = value
    }
    return td
  }

  const setStatus = (el: Element | null, msg: string, state = 'read'): void => {
    if (!el) return
    el.textContent = msg
    el.setAttribute('data-state', state)
  }

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // 1a. WHM Host PHP INI preview / apply / copy
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-wc-whm-php-preview-region]').forEach(region => {
    const hostRoot = region.closest<HTMLElement>('.v2-host') ?? document.body
    if (hostRoot.dataset.wcWhmPhpBound === 'true') return
    hostRoot.dataset.wcWhmPhpBound = 'true'

    const send = frameRequest(hostRoot)
    const workspace = hostRoot.querySelector<HTMLElement>('[data-whm-php-workspace]')
    const canRead = workspace?.getAttribute('data-php-can-read') === 'true' && !isBlockedFrame(hostRoot)
    const previewBtn = hostRoot.querySelector<HTMLButtonElement>('[data-wc-whm-php-preview-btn]')
    const applyBtn = hostRoot.querySelector<HTMLButtonElement>('[data-wc-whm-php-apply-btn]')
    const copyBtn = hostRoot.querySelector<HTMLButtonElement>('[data-php-ini-copy]')
    const statusEl = hostRoot.querySelector<HTMLElement>('[data-wc-whm-php-preview-status]')
    const versionSelect = hostRoot.querySelector<HTMLSelectElement>('[name="php-version"]')

    const fMemory = hostRoot.querySelector<HTMLInputElement>('[name="memory_limit"]')
    const fUpload = hostRoot.querySelector<HTMLInputElement>('[name="upload_max_filesize"]')
    const fPost = hostRoot.querySelector<HTMLInputElement>('[name="post_max_size"]')
    const fExec = hostRoot.querySelector<HTMLInputElement>('[name="max_execution_time"]')
    const fVars = hostRoot.querySelector<HTMLInputElement>('[name="max_input_vars"]')
    const fDisp = hostRoot.querySelector<HTMLInputElement>('[data-wc-whm-php-ini]')

    let currentRevision = ''
    let lastPreviewText = ''

    const collectIni = (): Record<string, string> => {
      const out: Record<string, string> = {}
      const add = (key: string, el: HTMLInputElement | null): void => {
        const val = el?.value.trim() ?? ''
        if (val) out[key] = val
      }
      add('memory_limit', fMemory)
      add('upload_max_filesize', fUpload)
      add('post_max_size', fPost)
      add('max_execution_time', fExec)
      add('max_input_vars', fVars)
      add('display_errors', fDisp)
      return out
    }

    const paintPreview = (data: Record<string, unknown>): void => {
      if (typeof data.revision === 'string') currentRevision = data.revision
      if (isObj(data.ini)) {
        if (fMemory && typeof data.ini.memory_limit === 'string' && !fMemory.value) fMemory.value = data.ini.memory_limit
        if (fUpload && typeof data.ini.upload_max_filesize === 'string' && !fUpload.value) fUpload.value = data.ini.upload_max_filesize
        if (fPost && typeof data.ini.post_max_size === 'string' && !fPost.value) fPost.value = data.ini.post_max_size
        if (fExec && typeof data.ini.max_execution_time === 'string' && !fExec.value) fExec.value = data.ini.max_execution_time
        if (fVars && typeof data.ini.max_input_vars === 'string' && !fVars.value) fVars.value = data.ini.max_input_vars
        if (fDisp && typeof data.ini.display_errors === 'string') fDisp.value = data.ini.display_errors
      }
      if (typeof data.previewText === 'string' && data.previewText.trim()) {
        lastPreviewText = data.previewText
        const pre = document.createElement('pre')
        pre.dir = 'ltr'
        pre.textContent = data.previewText
        region.replaceChildren(pre)
        if (copyBtn && !isBlockedFrame(hostRoot)) copyBtn.disabled = false
      }
    }

    if (canRead && send) {
      void send('GET', '/api/server/php/ini')
        .then(res => {
          if (isObj(res)) paintPreview(res)
        })
        .catch(() => {
          // Leave initial unread status intact if host endpoint is unavailable
        })
    }

    previewBtn?.addEventListener('click', async () => {
      if (!send || isBlockedFrame(hostRoot)) return
      setStatus(statusEl, txt('Generating php.ini preview...'), 'loading')
      try {
        const version = versionSelect?.value || '8.3'
        const res = await send('POST', '/api/server/php/ini/preview', { version, ini: collectIni() })
        if (isObj(res)) paintPreview(res)
        setStatus(statusEl, txt('php.ini preview updated.'), 'read')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('Preview failed.')), 'failed')
      }
    })

    applyBtn?.addEventListener('click', async () => {
      if (!send || isBlockedFrame(hostRoot)) return
      setStatus(statusEl, txt('Saving global php.ini overrides...'), 'saving')
      try {
        if (!currentRevision) {
          const readRes = await send('GET', '/api/server/php/ini')
          if (isObj(readRes) && typeof readRes.revision === 'string') currentRevision = readRes.revision
        }
        const version = versionSelect?.value || '8.3'
        const res = await send('POST', '/api/server/php/ini/apply', {
          version,
          ini: collectIni(),
          expectedRevision: currentRevision,
        })
        if (isObj(res)) paintPreview(res)
        setStatus(statusEl, txt('Global php.ini overrides saved.'), 'saved')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('Failed to save php.ini overrides.')), 'failed')
      }
    })

    copyBtn?.addEventListener('click', async () => {
      const content = lastPreviewText || region.textContent?.trim() || ''
      if (!content) return
      const copied = await copyToClipboard(content)
      setStatus(
        statusEl,
        copied ? txt('Copied php.ini preview to clipboard.') : txt('Clipboard permission unavailable; select preview text manually.'),
        copied ? 'saved' : 'unread',
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 1b. Account Software PHP INI extended preview / apply / copy
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-wc-panel-php-preview-region]').forEach(region => {
    const scope = region.closest<HTMLElement>('[data-domain-php-form]') ?? document.body
    if (scope.dataset.wcPanelPhpBound === 'true') return
    scope.dataset.wcPanelPhpBound = 'true'

    const send = frameRequest(scope)
    const previewBtn = scope.querySelector<HTMLButtonElement>('[data-wc-panel-php-preview-btn]')
    const applyBtn = scope.querySelector<HTMLButtonElement>('[data-wc-panel-php-apply-btn]')
    const copyBtn = scope.querySelector<HTMLButtonElement>('[data-wc-panel-php-copy]')
    const statusEl = scope.querySelector<HTMLElement>('[data-wc-panel-php-status]')
    const domainSelect = scope.querySelector<HTMLSelectElement>('[data-domain-php-select]')

    const fMem = scope.querySelector<HTMLInputElement>('[name="ini.memory_limit"]')
    const fUp = scope.querySelector<HTMLInputElement>('[name="ini.upload_max_filesize"]')
    const fPost = scope.querySelector<HTMLInputElement>('[name="ini.post_max_size"]')
    const fExec = scope.querySelector<HTMLInputElement>('[name="ini.max_execution_time"]')
    const fVars = scope.querySelector<HTMLInputElement>('#v2-php-max-input')
    const fErr = scope.querySelector<HTMLInputElement>('#v2-php-display-errors')
    const fTz = scope.querySelector<HTMLInputElement>('#v2-php-timezone')

    let lastPreviewText = ''

    const collectAccountIni = (): Record<string, string> => {
      const out: Record<string, string> = {}
      const add = (key: string, el: HTMLInputElement | null): void => {
        if (!el) return
        out[key] = el.value.trim()
      }
      add('memory_limit', fMem)
      add('upload_max_filesize', fUp)
      add('post_max_size', fPost)
      add('max_execution_time', fExec)
      add('max_input_vars', fVars)
      add('display_errors', fErr)
      add('date.timezone', fTz)
      return out
    }

    const paint = (res: Record<string, unknown>, message: string, state: string): void => {
      if (typeof res.previewText === 'string') {
        lastPreviewText = res.previewText
        region.textContent = res.previewText
        if (copyBtn && !isBlockedFrame(scope)) copyBtn.disabled = false
      }
      setStatus(statusEl, message, state)
    }

    previewBtn?.addEventListener('click', async () => {
      if (!send || isBlockedFrame(scope)) return
      setStatus(statusEl, txt('Validating INI directives...'), 'loading')
      try {
        const res = await send('POST', '/api/account/php/ini/preview', {
          ...(domainSelect?.value ? { domainId: domainSelect.value } : {}),
          ini: collectAccountIni(),
        })
        if (isObj(res)) paint(res, txt('INI configuration preview updated.'), 'read')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('INI preview validation failed.')), 'failed')
      }
    })

    applyBtn?.addEventListener('click', async () => {
      if (!send || isBlockedFrame(scope)) return
      setStatus(statusEl, txt('Applying INI overrides...'), 'saving')
      try {
        const res = await send('POST', '/api/account/php/ini/apply', {
          ...(domainSelect?.value ? { domainId: domainSelect.value } : {}),
          ini: collectAccountIni(),
        })
        if (isObj(res)) paint(res, txt('Extended PHP INI overrides saved.'), 'saved')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('Failed to save PHP INI overrides.')), 'failed')
      }
    })

    copyBtn?.addEventListener('click', async () => {
      const content = lastPreviewText || region.textContent?.trim() || ''
      if (!content) return
      const copied = await copyToClipboard(content)
      setStatus(
        statusEl,
        copied ? txt('Copied INI preview to clipboard.') : txt('Clipboard permission unavailable; select preview text manually.'),
        copied ? 'saved' : 'unread',
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Account Resources live folders & IO direction toggle
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('.v2-panel-resources[data-panel-resources-live="true"]').forEach(root => {
    if (root.dataset.wcResourcesBound === 'true') return
    root.dataset.wcResourcesBound = 'true'

    const send = frameRequest(root)
    const foldersBtn = root.querySelector<HTMLButtonElement>('[data-wc-resource-folders-refresh]')
    const foldersRows = root.querySelector<HTMLElement>('[data-wc-resource-folders-rows]')
    const foldersStatus = root.querySelector<HTMLElement>('[data-wc-resource-folders-status]')
    const ioReadBtn = root.querySelector<HTMLButtonElement>('[data-wc-resource-io-dir="read"]')
    const ioWriteBtn = root.querySelector<HTMLButtonElement>('[data-wc-resource-io-dir="write"]')
    const ioStatus = root.querySelector<HTMLElement>('[data-wc-resource-io-status]')

    const loadFolders = async (): Promise<void> => {
      if (!send || isBlockedFrame(root) || !foldersRows) return
      setStatus(foldersStatus, txt('Scanning account home directory...'), 'loading')
      try {
        const res = await send('GET', '/api/account/resources/folders')
        if (!isObj(res) || !Array.isArray(res.folders)) throw new Error('Invalid folder breakdown reply')
        if (res.folders.length === 0) {
          const tr = document.createElement('tr')
          const td = document.createElement('td')
          td.colSpan = 3
          td.textContent = res.state === 'unavailable'
            ? txt('Account home directory is unavailable for breakdown.')
            : txt('No files or folders found in account home.')
          tr.appendChild(td)
          foldersRows.replaceChildren(tr)
        } else {
          const rows = res.folders.map(entry => {
            const item = isObj(entry) ? entry : {}
            const tr = document.createElement('tr')
            tr.appendChild(makeCell(String(item.path ?? ''), true))
            tr.appendChild(makeCell(formatBytes(Number(item.sizeBytes ?? 0)), true))
            tr.appendChild(makeCell(`${Number(item.sharePercent ?? 0)}%`, true))
            return tr
          })
          foldersRows.replaceChildren(...rows)
        }
        const total = typeof res.totalBytes === 'number' ? formatBytes(res.totalBytes) : '-'
        setStatus(
          foldersStatus,
          txt('Total scanned: ') + total + (res.truncated === true ? ' (' + txt('truncated') + ')' : ''),
          'read',
        )
      } catch (err) {
        setStatus(foldersStatus, errorMessage(err, txt('Folder scan failed.')), 'failed')
      }
    }

    foldersBtn?.addEventListener('click', () => {
      void loadFolders()
    })

    const selectIoDir = (dir: 'read' | 'write'): void => {
      if (ioReadBtn) ioReadBtn.setAttribute('aria-pressed', dir === 'read' ? 'true' : 'false')
      if (ioWriteBtn) ioWriteBtn.setAttribute('aria-pressed', dir === 'write' ? 'true' : 'false')
      setStatus(
        ioStatus,
        dir === 'read'
          ? txt('Showing disk read IO cap context. Host history sampling is required for historical rate curves.')
          : txt('Showing disk write IO cap context. Host history sampling is required for historical rate curves.'),
        'read',
      )
    }

    ioReadBtn?.addEventListener('click', () => selectIoDir('read'))
    ioWriteBtn?.addEventListener('click', () => selectIoDir('write'))
  })

  // ---------------------------------------------------------------------------
  // 3. Cron next-runs preview & MAILTO save/clear
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-account-cron]').forEach(root => {
    if (root.dataset.wcCronBound === 'true') return
    root.dataset.wcCronBound = 'true'

    const send = frameRequest(root)
    const canManage = root.dataset.cronManage === 'true' && !isBlockedFrame(root)
    const previewBtn = root.querySelector<HTMLButtonElement>('[data-wc-cron-preview-btn]')
    const previewStatus = root.querySelector<HTMLElement>('[data-wc-cron-preview-status]')
    const nextRunsBody = root.querySelector<HTMLElement>('[data-wc-cron-next-runs]')

    const mailtoInput = root.querySelector<HTMLInputElement>('[data-wc-cron-mailto-input]')
    const mailtoSaveBtn = root.querySelector<HTMLButtonElement>('[data-wc-cron-mailto-save]')
    const mailtoClearBtn = root.querySelector<HTMLButtonElement>('[data-wc-cron-mailto-clear]')
    const mailtoStatus = root.querySelector<HTMLElement>('[data-wc-cron-mailto-status]')
    const modeFailures = root.querySelector<HTMLInputElement>('[data-wc-cron-email-mode="failures"]')
    const modeAlways = root.querySelector<HTMLInputElement>('[data-wc-cron-email-mode="always"]')
    const modeNever = root.querySelector<HTMLInputElement>('[data-wc-cron-email-mode="never"]')

    const fMinute = root.querySelector<HTMLInputElement>('[data-cron-field="minute"]')
    const fHour = root.querySelector<HTMLInputElement>('[data-cron-field="hour"]')
    const fDay = root.querySelector<HTMLInputElement>('[data-cron-field="day"]')
    const fMonth = root.querySelector<HTMLInputElement>('[data-cron-field="month"]')
    const fWeekday = root.querySelector<HTMLInputElement>('[data-cron-field="weekday"]')

    let mailtoRevision = ''

    const currentMode = (): 'failures' | 'always' | 'never' => {
      if (modeAlways?.checked) return 'always'
      if (modeFailures?.checked) return 'failures'
      return 'never'
    }

    const paintMailto = (res: Record<string, unknown>): void => {
      if (typeof res.revision === 'string') mailtoRevision = res.revision
      if (mailtoInput) mailtoInput.value = typeof res.mailto === 'string' ? res.mailto : ''
      const mode = String(res.mode ?? 'never')
      if (modeFailures) modeFailures.checked = mode === 'failures'
      if (modeAlways) modeAlways.checked = mode === 'always'
      if (modeNever) modeNever.checked = mode === 'never'
    }

    if (canManage && send && mailtoInput) {
      void send('GET', '/api/account/cron/mailto')
        .then(res => {
          if (isObj(res)) paintMailto(res)
        })
        .catch(() => undefined)
    }

    previewBtn?.addEventListener('click', async () => {
      if (!send || !canManage || !nextRunsBody) return
      const schedule = [
        fMinute?.value.trim() || '*',
        fHour?.value.trim() || '*',
        fDay?.value.trim() || '*',
        fMonth?.value.trim() || '*',
        fWeekday?.value.trim() || '*',
      ].join(' ')
      setStatus(previewStatus, txt('Calculating next UTC runs...'), 'loading')
      try {
        const res = await send('POST', '/api/account/cron/preview', { schedule, count: 5 })
        if (!isObj(res) || !Array.isArray(res.nextRuns)) throw new Error('Invalid preview response')
        if (res.nextRuns.length === 0) {
          const tr = document.createElement('tr')
          const td = document.createElement('td')
          td.colSpan = 2
          td.textContent = txt('No matching UTC run within the next 366 days.')
          tr.appendChild(td)
          nextRunsBody.replaceChildren(tr)
        } else {
          const rows = res.nextRuns.map((iso, index) => {
            const tr = document.createElement('tr')
            tr.appendChild(makeCell(String(index + 1), true))
            tr.appendChild(makeCell(String(iso), true))
            return tr
          })
          nextRunsBody.replaceChildren(...rows)
        }
        setStatus(previewStatus, txt('Preview calculated for schedule: ') + schedule, 'read')
      } catch (err) {
        setStatus(previewStatus, errorMessage(err, txt('Schedule preview failed.')), 'failed')
      }
    })

    mailtoSaveBtn?.addEventListener('click', async () => {
      if (!send || !canManage || !mailtoInput) return
      setStatus(mailtoStatus, txt('Saving MAILTO address...'), 'saving')
      try {
        const res = await send('PUT', '/api/account/cron/mailto', {
          mailto: mailtoInput.value.trim(),
          mode: currentMode() === 'never' && mailtoInput.value.trim() ? 'failures' : currentMode(),
          ...(mailtoRevision ? { expectedRevision: mailtoRevision } : {}),
        })
        if (isObj(res)) paintMailto(res)
        setStatus(mailtoStatus, txt('MAILTO configuration saved.'), 'saved')
      } catch (err) {
        setStatus(mailtoStatus, errorMessage(err, txt('Failed to save MAILTO address.')), 'failed')
      }
    })

    mailtoClearBtn?.addEventListener('click', async () => {
      if (!send || !canManage || !mailtoInput) return
      setStatus(mailtoStatus, txt('Clearing MAILTO address...'), 'saving')
      try {
        const res = await send('PUT', '/api/account/cron/mailto', {
          mailto: null,
          mode: 'never',
          ...(mailtoRevision ? { expectedRevision: mailtoRevision } : {}),
        })
        if (isObj(res)) paintMailto(res)
        setStatus(mailtoStatus, txt('MAILTO notifications cleared.'), 'saved')
      } catch (err) {
        setStatus(mailtoStatus, errorMessage(err, txt('Failed to clear MAILTO address.')), 'failed')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Domain TLS certificate inspect, Force-HTTPS, redirect, & primary rename
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-domain-workspace]').forEach(root => {
    if (root.dataset.wcDomainsBound === 'true') return
    root.dataset.wcDomainsBound = 'true'

    const send = frameRequest(root)
    const canManage = root.dataset.domainManage === 'true' && !isBlockedFrame(root)
    const rowsBody = root.querySelector<HTMLElement>('[data-domain-rows]')
    const settingsPanel = root.querySelector<HTMLElement>('[data-domain-settings-panel]')
    const selectedNameEl = root.querySelector<HTMLElement>('[data-domain-selected-name]')
    const certInspectBtn = root.querySelector<HTMLButtonElement>('[data-wc-domain-cert-inspect]')
    const certStatus = root.querySelector<HTMLElement>('[data-wc-domain-cert-status]')
    const settingsHttpsToggle = root.querySelector<HTMLInputElement>('[data-wc-domain-settings-https]')
    const redirectToInput = root.querySelector<HTMLInputElement>('[data-wc-domain-redirect-to]')
    const redirectCodeSelect = root.querySelector<HTMLSelectElement>('[data-wc-domain-redirect-code]')
    const redirectSaveBtn = root.querySelector<HTMLButtonElement>('[data-wc-domain-redirect-save]')
    const redirectClearBtn = root.querySelector<HTMLButtonElement>('[data-wc-domain-redirect-clear]')
    const settingsStatus = root.querySelector<HTMLElement>('[data-wc-domain-settings-status]')

    const renameCurrent = root.querySelector<HTMLInputElement>('#v2-domain-primary-current')
    const renameNew = root.querySelector<HTMLInputElement>('[data-wc-domain-rename-new]')
    const renameAlias = root.querySelector<HTMLInputElement>('[data-wc-domain-rename-alias]')
    const renameConfirm = root.querySelector<HTMLInputElement>('[data-wc-domain-rename-confirm]')
    const renameBtn = root.querySelector<HTMLButtonElement>('[data-wc-domain-rename-submit]')
    const renameStatus = root.querySelector<HTMLElement>('[data-wc-domain-rename-status]')

    const resolveSelectedDomainId = (): string | null => {
      const name = selectedNameEl?.textContent?.trim() ?? ''
      if (!name || !rowsBody) return null
      for (const row of rowsBody.querySelectorAll<HTMLTableRowElement>('tr[data-domain-id]')) {
        const strong = row.querySelector('strong')
        if (strong?.textContent?.trim() === name) return row.getAttribute('data-domain-id')
      }
      return null
    }

    const syncRowSwitchLabel = (input: HTMLInputElement, enabled: boolean): void => {
      input.checked = enabled
      const label = input.parentElement?.querySelector('span')
      if (label) label.textContent = enabled ? txt('On') : txt('Off')
    }

    rowsBody?.addEventListener('change', async event => {
      const target = event.target as HTMLElement | null
      if (!target || !target.matches('[data-wc-domain-row-https]')) return
      const toggle = target as HTMLInputElement
      const domainId = toggle.getAttribute('data-wc-domain-row-https') ?? ''
      if (!send || !canManage || !domainId) {
        toggle.checked = !toggle.checked
        return
      }
      const nextEnabled = toggle.checked
      try {
        await send('POST', `/api/account/domains/${encodeURIComponent(domainId)}/force-https`, { enabled: nextEnabled })
        syncRowSwitchLabel(toggle, nextEnabled)
      } catch (err) {
        syncRowSwitchLabel(toggle, !nextEnabled)
        setStatus(settingsStatus, errorMessage(err, txt('Force HTTPS update failed.')), 'failed')
      }
    })

    certInspectBtn?.addEventListener('click', async () => {
      if (!send || isBlockedFrame(root)) return
      const id = resolveSelectedDomainId()
      if (!id) {
        setStatus(certStatus, txt('Select a domain row first to inspect its TLS certificate.'), 'unread')
        return
      }
      setStatus(certStatus, txt('Inspecting stored TLS certificate...'), 'loading')
      try {
        const res = await send('GET', `/api/account/domains/${encodeURIComponent(id)}/certificate`)
        if (!isObj(res)) throw new Error('Invalid certificate response')
        if (settingsHttpsToggle) settingsHttpsToggle.checked = res.forceHttps === true
        if (res.covered && isObj(res.certificate)) {
          const issuer = typeof res.certificate.issuer === 'string' ? res.certificate.issuer : txt('Issued certificate')
          const notAfter = typeof res.certificate.notAfter === 'string' ? res.certificate.notAfter : ''
          setStatus(certStatus, `${issuer} · ${txt('Valid until')} ${notAfter}`, 'read')
        } else {
          setStatus(certStatus, txt('No valid TLS certificate covers this domain yet.'), 'unread')
        }
      } catch (err) {
        setStatus(certStatus, errorMessage(err, txt('TLS certificate inspection failed.')), 'failed')
      }
    })

    settingsHttpsToggle?.addEventListener('change', async () => {
      if (!send || !canManage) {
        settingsHttpsToggle.checked = !settingsHttpsToggle.checked
        return
      }
      const id = resolveSelectedDomainId()
      if (!id) {
        settingsHttpsToggle.checked = !settingsHttpsToggle.checked
        setStatus(settingsStatus, txt('Select a domain row first.'), 'unread')
        return
      }
      const nextEnabled = settingsHttpsToggle.checked
      setStatus(settingsStatus, txt('Updating Force HTTPS...'), 'saving')
      try {
        await send('POST', `/api/account/domains/${encodeURIComponent(id)}/force-https`, { enabled: nextEnabled })
        setStatus(settingsStatus, nextEnabled ? txt('Force HTTPS enabled.') : txt('Force HTTPS disabled.'), 'saved')
      } catch (err) {
        settingsHttpsToggle.checked = !nextEnabled
        setStatus(settingsStatus, errorMessage(err, txt('Force HTTPS update failed.')), 'failed')
      }
    })

    const updateRedirect = async (clear: boolean): Promise<void> => {
      if (!send || !canManage || !settingsPanel) return
      const id = resolveSelectedDomainId()
      if (!id) {
        setStatus(settingsStatus, txt('Select a domain row first.'), 'unread')
        return
      }
      const to = clear ? null : (redirectToInput?.value.trim() ?? '')
      const code = redirectCodeSelect?.value === '302' ? 302 : 301
      setStatus(settingsStatus, clear ? txt('Clearing redirect...') : txt('Saving redirect...'), 'saving')
      try {
        await send('PUT', `/api/account/domains/${encodeURIComponent(id)}/redirect`, clear ? { to: null } : { to, code })
        if (clear && redirectToInput) redirectToInput.value = ''
        setStatus(settingsStatus, clear ? txt('Redirect cleared.') : txt('Redirect saved.'), 'saved')
      } catch (err) {
        setStatus(settingsStatus, errorMessage(err, txt('Redirect update failed.')), 'failed')
      }
    }

    redirectSaveBtn?.addEventListener('click', () => {
      void updateRedirect(false)
    })
    redirectClearBtn?.addEventListener('click', () => {
      void updateRedirect(true)
    })

    renameBtn?.addEventListener('click', async () => {
      if (!send || !canManage || !renameNew || !renameConfirm) return
      setStatus(renameStatus, txt('Renaming primary domain...'), 'saving')
      try {
        const res = await send('POST', '/api/account/domains/rename-primary', {
          newDomain: renameNew.value.trim(),
          confirmCurrentDomain: renameConfirm.value.trim(),
          keepOldAsAlias: renameAlias?.checked === true,
        })
        if (isObj(res) && typeof res.primaryDomain === 'string') {
          if (renameCurrent) renameCurrent.value = res.primaryDomain
          renameNew.value = ''
          renameConfirm.value = ''
          setStatus(renameStatus, txt('Primary domain renamed to ') + res.primaryDomain, 'saved')
        }
      } catch (err) {
        setStatus(renameStatus, errorMessage(err, txt('Primary domain rename failed.')), 'failed')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 5. MariaDB inspect, SQL preview, charset update, & connection copy
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-database-workspace]').forEach(root => {
    if (root.dataset.wcDbBound === 'true') return
    root.dataset.wcDbBound = 'true'

    const send = frameRequest(root)
    const canRead = root.getAttribute('data-capability-unavailable') !== 'true' && !isBlockedFrame(root)
    const canManage = root.dataset.dbManage === 'true' && canRead
    const prefix = (root.dataset.dbUsername ?? '') + '_'

    const dbNameInput = root.querySelector<HTMLInputElement>('#v2-db-create-name')
    const createCharset = root.querySelector<HTMLSelectElement>('[data-wc-db-charset]')
    const createCollation = root.querySelector<HTMLSelectElement>('[data-wc-db-collation]')
    const createSqlBtn = root.querySelector<HTMLButtonElement>('[data-wc-db-create-sql-btn]')
    const createSqlPre = root.querySelector<HTMLElement>('[data-wc-db-create-sql-preview]')

    const userNameInput = root.querySelector<HTMLInputElement>('#v2-dbu-create-name')
    const userInitialDb = root.querySelector<HTMLSelectElement>('#v2-dbu-initial-database')
    const userSqlBtn = root.querySelector<HTMLButtonElement>('[data-wc-dbu-sql-preview-btn]')
    const userSqlPre = root.querySelector<HTMLElement>('[data-v2-db-sql-preview="create-user"]')
    const userSqlStatus = root.querySelector<HTMLElement>('[data-wc-dbu-sql-status]')

    const copyBtn = root.querySelector<HTMLButtonElement>('[data-db-copy-details]')
    const connPre = root.querySelector<HTMLElement>('[data-wc-db-conn-snippet]')
    const copyStatus = root.querySelector<HTMLElement>('[data-wc-db-copy-status]')

    const inspectSelect = root.querySelector<HTMLSelectElement>('[data-wc-db-inspect-select]')
    const alterCharset = root.querySelector<HTMLSelectElement>('[data-wc-db-alter-charset]')
    const alterCollation = root.querySelector<HTMLSelectElement>('[data-wc-db-alter-collation]')
    const inspectBtn = root.querySelector<HTMLButtonElement>('[data-wc-db-inspect-btn]')
    const alterPreviewBtn = root.querySelector<HTMLButtonElement>('[data-wc-db-alter-preview-btn]')
    const alterApplyBtn = root.querySelector<HTMLButtonElement>('[data-wc-db-alter-apply-btn]')
    const inspectStatus = root.querySelector<HTMLElement>('[data-wc-db-inspect-status]')
    const alterPre = root.querySelector<HTMLElement>('[data-wc-db-alter-sql-preview]')

    const setPreCode = (pre: HTMLElement | null, codeText: string): void => {
      if (!pre) return
      const code = document.createElement('code')
      code.textContent = codeText
      pre.replaceChildren(code)
    }

    const withPrefix = (raw: string): string => {
      const clean = raw.trim().toLowerCase()
      if (!clean) return prefix + 'app'
      return clean.startsWith(prefix) ? clean : prefix + clean
    }

    inspectBtn?.addEventListener('click', async () => {
      if (!send || !canRead) return
      setStatus(inspectStatus, txt('Inspecting databases...'), 'loading')
      try {
        const res = await send('GET', '/api/account/databases/inspect')
        if (!isObj(res) || !Array.isArray(res.databases)) throw new Error('Invalid inspect response')
        if (inspectSelect) {
          const prev = inspectSelect.value
          const blankOpt = document.createElement('option')
          blankOpt.value = ''
          blankOpt.textContent = txt('Choose a database')
          const opts = res.databases.map(item => {
            const db = isObj(item) ? item : {}
            const opt = document.createElement('option')
            opt.value = String(db.id ?? '')
            const tables = typeof db.tableCount === 'number' ? `, ${db.tableCount} tables` : ''
            const size = typeof db.sizeBytes === 'number' ? `, ${formatBytes(db.sizeBytes)}` : ''
            opt.textContent = `${String(db.name ?? '')} (${String(db.charset ?? 'utf8mb4')}/${String(db.collation ?? 'utf8mb4_unicode_ci')}${tables}${size})`
            return opt
          })
          inspectSelect.replaceChildren(blankOpt, ...opts)
          if (prev) inspectSelect.value = prev
        }
        setStatus(inspectStatus, txt('Inspected databases: ') + String(res.databases.length), 'read')
      } catch (err) {
        setStatus(inspectStatus, errorMessage(err, txt('Database inspection failed.')), 'failed')
      }
    })

    createSqlBtn?.addEventListener('click', async () => {
      if (!send || !canRead) return
      try {
        const res = await send('POST', '/api/account/databases/sql-preview', {
          kind: 'create-database',
          databaseName: withPrefix(dbNameInput?.value ?? ''),
          charset: createCharset?.value || 'utf8mb4',
          collation: createCollation?.value || 'utf8mb4_unicode_ci',
        })
        if (isObj(res) && typeof res.sqlPreview === 'string') setPreCode(createSqlPre, res.sqlPreview)
      } catch (err) {
        setPreCode(createSqlPre, errorMessage(err, txt('SQL preview failed.')))
      }
    })

    userSqlBtn?.addEventListener('click', async () => {
      if (!send || !canRead) return
      try {
        const selectedDbText = userInitialDb?.selectedOptions[0]?.textContent?.trim() ?? ''
        const res = await send('POST', '/api/account/databases/sql-preview', {
          kind: 'create-user',
          username: withPrefix(userNameInput?.value ?? 'user'),
          ...(selectedDbText && selectedDbText.startsWith(prefix) ? { databaseName: selectedDbText } : {}),
        })
        if (isObj(res) && typeof res.sqlPreview === 'string') {
          setPreCode(userSqlPre, res.sqlPreview)
          if (typeof res.connectionSnippet === 'string') setPreCode(connPre, res.connectionSnippet)
          setStatus(userSqlStatus, txt('Generated read-only SQL preview.'), 'read')
        }
      } catch (err) {
        setStatus(userSqlStatus, errorMessage(err, txt('User SQL preview failed.')), 'failed')
      }
    })

    const selectedAlterDbName = (): string => {
      const text = inspectSelect?.selectedOptions[0]?.textContent?.trim() ?? ''
      const spaceIdx = text.indexOf(' ')
      const candidate = spaceIdx > 0 ? text.slice(0, spaceIdx) : text
      return candidate.startsWith(prefix) ? candidate : withPrefix(dbNameInput?.value ?? 'app')
    }

    alterPreviewBtn?.addEventListener('click', async () => {
      if (!send || !canRead) return
      try {
        const res = await send('POST', '/api/account/databases/sql-preview', {
          kind: 'alter-charset',
          databaseName: selectedAlterDbName(),
          charset: alterCharset?.value || 'utf8mb4',
          collation: alterCollation?.value || 'utf8mb4_unicode_ci',
        })
        if (isObj(res) && typeof res.sqlPreview === 'string') {
          setPreCode(alterPre, res.sqlPreview)
          setStatus(inspectStatus, txt('ALTER DATABASE SQL preview ready.'), 'read')
        }
      } catch (err) {
        setStatus(inspectStatus, errorMessage(err, txt('SQL preview failed.')), 'failed')
      }
    })

    alterApplyBtn?.addEventListener('click', async () => {
      if (!send || !canManage) return
      const dbId = inspectSelect?.value ?? ''
      if (!dbId) {
        setStatus(inspectStatus, txt('Choose a database first.'), 'unread')
        return
      }
      setStatus(inspectStatus, txt('Updating database charset...'), 'saving')
      try {
        const res = await send('PUT', `/api/account/databases/${encodeURIComponent(dbId)}/charset`, {
          charset: alterCharset?.value || 'utf8mb4',
          collation: alterCollation?.value || 'utf8mb4_unicode_ci',
        })
        if (isObj(res) && typeof res.sqlPreview === 'string') setPreCode(alterPre, res.sqlPreview)
        setStatus(inspectStatus, txt('Database charset and collation updated.'), 'saved')
      } catch (err) {
        setStatus(inspectStatus, errorMessage(err, txt('Failed to update database charset.')), 'failed')
      }
    })

    copyBtn?.addEventListener('click', async () => {
      const content = connPre?.textContent?.trim() || 'localhost:3306'
      const copied = await copyToClipboard(content)
      setStatus(
        copyStatus,
        copied ? txt('Copied connection snippet to clipboard.') : txt('Clipboard permission unavailable; copy host and snippet manually.'),
        copied ? 'saved' : 'unread',
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 6. WHM Monitoring Traffic & IO ring-buffer history refresh
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-wc-history-refresh]').forEach(btn => {
    if (btn.dataset.wcHistoryBound === 'true') return
    btn.dataset.wcHistoryBound = 'true'

    const kind = btn.getAttribute('data-wc-history-refresh') === 'io' ? 'io' : 'traffic'
    const pageRoot = btn.closest<HTMLElement>('[data-whm-traffic],[data-whm-metering]') ?? document.body
    const send = frameRequest(pageRoot)
    const rowsEl = kind === 'io'
      ? pageRoot.querySelector<HTMLElement>('[data-wc-history-rows="io"]')
      : pageRoot.querySelector<HTMLElement>('[data-wc-history-rows="traffic"]')
    const statusEl = kind === 'io'
      ? pageRoot.querySelector<HTMLElement>('[data-wc-history-status="io"]')
      : pageRoot.querySelector<HTMLElement>('[data-wc-history-status="traffic"]')

    btn.addEventListener('click', async () => {
      if (!send || isBlockedFrame(pageRoot) || !rowsEl) return
      setStatus(statusEl, txt('Loading ring-buffer history...'), 'loading')
      try {
        const res = await send('GET', `/api/server/monitoring/history?kind=${kind}`)
        if (!isObj(res) || !Array.isArray(res.samples)) throw new Error('Invalid history reply')
        if (res.samples.length === 0) {
          const tr = document.createElement('tr')
          const td = document.createElement('td')
          td.colSpan = kind === 'io' ? 5 : 4
          td.textContent = txt('No ring-buffer samples recorded yet.')
          tr.appendChild(td)
          rowsEl.replaceChildren(tr)
        } else {
          const rows = res.samples.map(raw => {
            const sample = isObj(raw) ? raw : {}
            const tr = document.createElement('tr')
            tr.appendChild(makeCell(String(sample.observedAt ?? ''), true))
            if (kind === 'io') {
              tr.appendChild(makeCell(sample.readBps === null || sample.readBps === undefined ? '-' : String(sample.readBps), true))
              tr.appendChild(makeCell(sample.writeBps === null || sample.writeBps === undefined ? '-' : String(sample.writeBps), true))
              tr.appendChild(makeCell(sample.iops === null || sample.iops === undefined ? '-' : String(sample.iops), true))
            } else {
              tr.appendChild(makeCell(sample.rxBps === null || sample.rxBps === undefined ? '-' : String(sample.rxBps), true))
              tr.appendChild(makeCell(sample.txBps === null || sample.txBps === undefined ? '-' : String(sample.txBps), true))
            }
            tr.appendChild(makeCell(String(sample.summary ?? '')))
            return tr
          })
          rowsEl.replaceChildren(...rows)
        }
        setStatus(statusEl, txt('Samples loaded: ') + String(res.samples.length), 'read')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('History refresh failed.')), 'failed')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 7. WHM Add-on Services reviewed drop-in config preview & apply
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-wc-addon-config]').forEach(panel => {
    if (panel.dataset.wcAddonBound === 'true') return
    panel.dataset.wcAddonBound = 'true'

    const pageRoot = panel.closest<HTMLElement>('[data-sw-addons]') ?? panel
    const send = frameRequest(pageRoot)
    const canRead = pageRoot.getAttribute('data-sw-can-read') === 'true' && !isBlockedFrame(pageRoot)
    const canManage = pageRoot.getAttribute('data-sw-can-manage') === 'true' && canRead

    const serviceSel = panel.querySelector<HTMLSelectElement>('[data-wc-addon-service]')
    const memoryIn = panel.querySelector<HTMLInputElement>('[data-wc-addon-memory]')
    const bindSel = panel.querySelector<HTMLSelectElement>('[data-wc-addon-bind]')
    const maxConnIn = panel.querySelector<HTMLInputElement>('[data-wc-addon-maxconn]')
    const readBtn = panel.querySelector<HTMLButtonElement>('[data-wc-addon-config-read]')
    const previewBtn = panel.querySelector<HTMLButtonElement>('[data-wc-addon-config-preview]')
    const applyBtn = panel.querySelector<HTMLButtonElement>('[data-wc-addon-config-apply]')
    const statusEl = panel.querySelector<HTMLElement>('[data-wc-addon-config-status]')
    const outputPre = panel.querySelector<HTMLElement>('[data-wc-addon-config-output]')

    let configRevision = ''
    let loadedConfigs: Array<Record<string, unknown>> = []

    const populateSelected = (): void => {
      const id = serviceSel?.value || 'memcached'
      const match = loadedConfigs.find(entry => entry.serviceId === id)
      if (!match) return
      if (memoryIn && typeof match.memoryLimitMb === 'number') memoryIn.value = String(match.memoryLimitMb)
      if (bindSel && typeof match.bindAddress === 'string') bindSel.value = match.bindAddress
      if (maxConnIn) maxConnIn.value = typeof match.maxConnections === 'number' ? String(match.maxConnections) : ''
      if (outputPre && typeof match.previewText === 'string') outputPre.textContent = match.previewText
    }

    const loadAddonConfig = async (): Promise<void> => {
      if (!send || !canRead) return
      setStatus(statusEl, txt('Reading add-on drop-in configuration...'), 'loading')
      try {
        const res = await send('GET', '/api/server/software/addon-services/config')
        if (!isObj(res) || !Array.isArray(res.services)) throw new Error('Invalid add-on config reply')
        if (typeof res.revision === 'string') configRevision = res.revision
        loadedConfigs = res.services.filter(isObj)
        populateSelected()
        setStatus(statusEl, txt('Add-on service configuration loaded.'), 'read')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('Failed to read add-on service configuration.')), 'failed')
      }
    }

    serviceSel?.addEventListener('change', populateSelected)
    readBtn?.addEventListener('click', () => {
      void loadAddonConfig()
    })

    const submitAddon = async (mode: 'preview' | 'apply'): Promise<void> => {
      if (!send || !canManage) return
      const memoryLimitMb = Number(memoryIn?.value ?? '256')
      const maxConnRaw = maxConnIn?.value.trim() ?? ''
      const maxConnections = maxConnRaw === '' ? null : Number(maxConnRaw)
      setStatus(statusEl, mode === 'preview' ? txt('Rendering drop-in preview...') : txt('Applying add-on drop-in...'), 'saving')
      try {
        if (mode === 'apply' && !configRevision) {
          const readRes = await send('GET', '/api/server/software/addon-services/config')
          if (isObj(readRes) && typeof readRes.revision === 'string') configRevision = readRes.revision
        }
        const res = await send('POST', '/api/server/software/addon-services/config', {
          mode,
          serviceId: serviceSel?.value || 'memcached',
          memoryLimitMb,
          bindAddress: bindSel?.value || '127.0.0.1',
          maxConnections,
          ...(mode === 'apply' ? { expectedRevision: configRevision } : {}),
        })
        if (isObj(res)) {
          if (typeof res.revision === 'string') configRevision = res.revision
          if (outputPre && typeof res.previewText === 'string') outputPre.textContent = res.previewText
        }
        setStatus(statusEl, mode === 'preview' ? txt('Drop-in preview updated.') : txt('Drop-in configuration applied.'), mode === 'preview' ? 'read' : 'saved')
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('Add-on drop-in operation failed.')), 'failed')
      }
    }

    previewBtn?.addEventListener('click', () => {
      void submitAddon('preview')
    })
    applyBtn?.addEventListener('click', () => {
      void submitAddon('apply')
    })
  })

  // ---------------------------------------------------------------------------
  // 8. WHM Security Tools Antivirus finding quarantine & delete
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('[data-wc-av-remediation]').forEach(panel => {
    if (panel.dataset.wcAvBound === 'true') return
    panel.dataset.wcAvBound = 'true'

    const pageRoot = panel.closest<HTMLElement>('[data-whm-security-tools-workspace]') ?? panel
    const send = frameRequest(pageRoot)
    const canManage = pageRoot.getAttribute('data-security-tools-can-manage') === 'true' && !isBlockedFrame(pageRoot)

    const findingsBody = pageRoot.querySelector<HTMLElement>('[data-whm-security-tools-rows="findings"]')
    const accountIn = panel.querySelector<HTMLInputElement>('[data-wc-av-account]')
    const pathIn = panel.querySelector<HTMLInputElement>('[data-wc-av-path]')
    const quarantineBtn = panel.querySelector<HTMLButtonElement>('[data-wc-av-quarantine]')
    const deleteBtn = panel.querySelector<HTMLButtonElement>('[data-wc-av-delete]')
    const statusEl = panel.querySelector<HTMLElement>('[data-wc-av-status]')

    findingsBody?.addEventListener('click', event => {
      const target = event.target as HTMLElement | null
      const row = target?.closest('tr')
      if (!row) return
      const cells = row.querySelectorAll('td')
      if (cells.length >= 2 && accountIn && pathIn) {
        const acct = cells[0]?.textContent?.trim() ?? ''
        const filePath = cells[1]?.textContent?.trim() ?? ''
        if (acct && filePath) {
          accountIn.value = acct
          pathIn.value = filePath
        }
      }
    })

    const runRemediation = async (action: 'quarantine' | 'delete'): Promise<void> => {
      if (!send || !canManage || !accountIn || !pathIn) return
      const account = accountIn.value.trim()
      const path = pathIn.value.trim()
      setStatus(statusEl, action === 'quarantine' ? txt('Moving file to quarantine...') : txt('Deleting infected file...'), 'saving')
      try {
        const res = await send('POST', `/api/server/security-tools/antivirus/${action}`, { account, path })
        if (!isObj(res)) throw new Error('Invalid remediation reply')
        setStatus(
          statusEl,
          action === 'quarantine'
            ? txt('Quarantined file: ') + String(res.path ?? path)
            : txt('Deleted file: ') + String(res.path ?? path),
          'saved',
        )
      } catch (err) {
        setStatus(statusEl, errorMessage(err, txt('Antivirus remediation failed.')), 'failed')
      }
    }

    quarantineBtn?.addEventListener('click', () => {
      void runRemediation('quarantine')
    })
    deleteBtn?.addEventListener('click', () => {
      void runRemediation('delete')
    })
  })
}

export const WORKSPACE_CONTROLS_CLIENT_BINDING = withFrameRequest(bindWorkspaceControls.toString())
