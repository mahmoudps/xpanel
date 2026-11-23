/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  renderActionMenu,
  renderAppShell,
  renderCombobox,
  renderConfirmDialog,
  renderCronBuilder,
  renderDataTable,
  renderDrawer,
  renderInput,
  renderTabs,
  renderToastRegion,
  renderWizard,
} from './design-system/components/index.ts'
import { WORKSPACE_RUNTIME_SCRIPT } from './workspace-runtime-client.ts'

function bootRuntime(): void {
  const win = window as unknown as Record<string, unknown>
  if (!win.__xpanelWorkspaceRuntime) {
    new Function(WORKSPACE_RUNTIME_SCRIPT)()
  } else if (typeof win.__xpanelMountWorkspace === 'function') {
    (win.__xpanelMountWorkspace as (root: Document) => void)(document)
  }
}

afterEach(() => {
  document.documentElement.dir = ''
  document.body.replaceChildren()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('workspace runtime client', () => {
  it('updates #xp-ops-dock from nested job.updated event.data payloads and updates generation chips', () => {
    document.body.innerHTML = `
      <div id="xp-ops-dock" hidden></div>
      <span data-generation-chip="4"><span class="v2-muted">gen 4</span></span>
    `
    bootRuntime()

    document.dispatchEvent(new CustomEvent('xpanel:ws-event', {
      detail: {
        id: 'evt-1',
        at: '2026-11-20T12:00:00.000Z',
        kind: 'job.updated',
        scope: { kind: 'global' },
        data: {
          jobId: 'job-42',
          kind: 'account.backup',
          status: 'running',
          progress: 60,
          logChunk: 'Packing archive',
        },
      },
    }))

    const dock = document.getElementById('xp-ops-dock')!
    expect(dock.hidden).toBe(false)
    const item = dock.querySelector('[data-ops-id="job-42"]')!
    expect(item.getAttribute('data-ops-state')).toBe('running')
    expect(item.textContent).toContain('account.backup')
    expect(item.textContent).toContain('60%')
    expect(item.textContent).toContain('Packing archive')

    document.dispatchEvent(new CustomEvent('xpanel:ws-event', {
      detail: {
        id: 'evt-2',
        at: '2026-11-20T12:00:05.000Z',
        kind: 'job.updated',
        scope: { kind: 'global' },
        data: {
          jobId: 'job-42',
          kind: 'account.backup',
          status: 'failed',
          progress: 60,
          error: 'Quota exceeded',
        },
      },
    }))
    const updated = dock.querySelector('[data-ops-id="job-42"]')!
    expect(updated.getAttribute('data-ops-state')).toBe('failed')
    expect(updated.textContent).toContain('Quota exceeded')

    document.dispatchEvent(new CustomEvent('xpanel:ws-event', {
      detail: {
        id: 'evt-3',
        at: '2026-11-20T12:00:10.000Z',
        kind: 'reconcile.applied',
        scope: { kind: 'global' },
        data: { generationId: 9 },
      },
    }))
    const chip = document.querySelector('[data-generation-chip]')!
    expect(chip.getAttribute('data-generation-chip')).toBe('9')
    expect(chip.querySelector('.v2-muted')?.textContent).toBe('gen 9')
  })

  it('keeps the dirty-state baseline until xpanel:workspace-stored confirms a save', async () => {
    document.body.innerHTML = `
      <form data-server-settings-form>
        <input name="hostname" value="srv1.example.test" />
        <button type="submit">Save</button>
      </form>
    `
    bootRuntime()

    const form = document.querySelector('form')!
    const input = form.querySelector<HTMLInputElement>('input[name="hostname"]')!
    const bar = form.querySelector<HTMLElement>('.v2-save-bar')!
    const discard = bar.querySelector<HTMLButtonElement>('[data-dirty-discard]')!
    expect(bar.hidden).toBe(true)

    input.value = 'srv2.example.test'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(bar.hidden).toBe(false)

    form.addEventListener('submit', event => event.preventDefault())
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 200))

    // Failed or pending submit must NOT clear the dirty indicator or overwrite the Discard baseline.
    expect(bar.hidden).toBe(false)
    discard.click()
    expect(input.value).toBe('srv1.example.test')
    expect(bar.hidden).toBe(true)

    // After a new edit, only a matching xpanel:workspace-stored event commits the new baseline.
    input.value = 'srv3.example.test'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(bar.hidden).toBe(false)

    window.dispatchEvent(new CustomEvent('xpanel:workspace-stored', { detail: { form: 'firewall-port-rule' } }))
    expect(bar.hidden).toBe(false)

    window.dispatchEvent(new CustomEvent('xpanel:workspace-stored', { detail: { form: 'server-settings' } }))
    expect(bar.hidden).toBe(true)
  })

  it('paginates only tables explicitly opting in via data-table-paginate and skips managed tables', () => {
    const manyRows = (attrs = '') =>
      Array.from({ length: 35 }, (_, idx) => `<tr${attrs}><td>Row ${idx + 1}</td></tr>`).join('')

    document.body.innerHTML = `
      <section data-accounts-workspace>
        <div data-account-list-controls></div>
        <table id="accounts-table" data-table-paginate><tbody>${manyRows(' data-account-row')}</tbody></table>
      </section>
      <section data-list-filter>
        <table id="filtered-table" data-table-paginate><tbody>${manyRows(' data-list-row')}</tbody></table>
      </section>
      <section>
        <table id="database-table"><tbody>${manyRows()}</tbody></table>
      </section>
      <section>
        <table id="optin-table" data-table-paginate><tbody>${manyRows()}</tbody></table>
      </section>
    `
    bootRuntime()

    const pagers = document.querySelectorAll('.v2-pagination-bar')
    expect(pagers).toHaveLength(1)
    expect(document.getElementById('optin-table')!.nextElementSibling?.classList.contains('v2-pagination-bar')).toBe(true)
    expect(document.getElementById('accounts-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(0)
    expect(document.getElementById('filtered-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(0)
    expect(document.getElementById('database-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(0)
    expect(document.getElementById('optin-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(10)
  })

  it('switches guided wizards to step-by-step mode, formats timezones in ASCII digits, and toggles sidebar collapse', () => {
    document.body.innerHTML = `
      <div class="v2-shell">
        <aside class="v2-side"><button type="button" data-action="toggle-sidebar-collapse" aria-expanded="true"></button></aside>
        <div data-wizard="guided">
          <button type="button" data-wizard-toggle aria-pressed="false">Step-by-step mode</button>
          <a href="#s1" data-wizard-go="1">1</a>
          <a href="#s2" data-wizard-go="2">2</a>
          <section id="s1" data-wizard-step="1"><input name="a" value="ok" /></section>
          <section id="s2" data-wizard-step="2"><input name="b" value="ok" /></section>
        </div>
        <time id="ts" datetime="2026-11-20T12:00:00Z">2026-11-20 12:00 UTC</time>
      </div>
    `
    bootRuntime()

    const toggle = document.querySelector<HTMLButtonElement>('[data-wizard-toggle]')!
    toggle.click()
    expect(document.getElementById('s1')!.getAttribute('data-wizard-hidden')).toBe('false')
    expect(document.getElementById('s2')!.getAttribute('data-wizard-hidden')).toBe('true')
    document.querySelector<HTMLAnchorElement>('[data-wizard-go="2"]')!.click()
    expect(document.getElementById('s1')!.getAttribute('data-wizard-hidden')).toBe('true')
    expect(document.getElementById('s2')!.getAttribute('data-wizard-hidden')).toBe('false')

    const win = window as unknown as { __xpanelApplyTimeZone: (tz: string) => void; __xpanelToggleSidebar: () => void }
    win.__xpanelApplyTimeZone('Asia/Dubai')
    expect(document.getElementById('ts')!.textContent).toBe('2026-11-20 16:00 Asia/Dubai')
    expect(document.getElementById('ts')!.title).toBe('UTC: 2026-11-20T12:00:00.000Z')
    win.__xpanelApplyTimeZone('UTC')
    expect(document.getElementById('ts')!.textContent).toBe('2026-11-20 12:00 UTC')

    win.__xpanelToggleSidebar()
    expect(document.querySelector('.v2-shell')!.getAttribute('data-sidebar-collapsed')).toBe('true')
    win.__xpanelToggleSidebar()
    expect(document.querySelector('.v2-shell')!.hasAttribute('data-sidebar-collapsed')).toBe(false)
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-user-timezone')
  })

  it('scopes operations dock storage per authenticated principal, scrubs foreign entries, and clears on logout', () => {
    document.body.innerHTML = `
      <div class="v2-shell" data-session-actor="xpanel:alice:20001">
        <button type="button" data-action="logout">Sign out</button>
        <div id="xp-ops-dock" hidden></div>
      </div>
    `
    bootRuntime()

    document.dispatchEvent(new CustomEvent('xpanel:ws-event', {
      detail: {
        id: 'evt-alice',
        at: '2026-11-20T12:00:00.000Z',
        kind: 'job.updated',
        scope: { kind: 'account' },
        data: { jobId: 'job-alice', kind: 'backup.create', status: 'running', progress: 40, logChunk: 'Alice private log' },
      },
    }))
    expect(window.sessionStorage.getItem('xpanel_operations_dock:xpanel:alice:20001')).toContain('Alice private log')
    expect(document.getElementById('xp-ops-dock')!.hidden).toBe(false)

    // A different principal signing in through the same tab must never see Alice's stored logs and must scrub them.
    document.body.innerHTML = `
      <div class="v2-shell" data-session-actor="xpanel:bob:20002">
        <button type="button" data-action="logout">Sign out</button>
        <div id="xp-ops-dock" hidden></div>
      </div>
    `
    bootRuntime()
    expect(document.getElementById('xp-ops-dock')!.hidden).toBe(true)
    expect(document.getElementById('xp-ops-dock')!.textContent).toBe('')
    expect(window.sessionStorage.getItem('xpanel_operations_dock:xpanel:alice:20001')).toBeNull()

    // Bob's operations are cleared immediately upon clicking logout.
    document.dispatchEvent(new CustomEvent('xpanel:ws-event', {
      detail: {
        id: 'evt-bob',
        at: '2026-11-20T12:01:00.000Z',
        kind: 'job.updated',
        scope: { kind: 'account' },
        data: { jobId: 'job-bob', kind: 'ssl.issue', status: 'running', progress: 50 },
      },
    }))
    expect(window.sessionStorage.getItem('xpanel_operations_dock:xpanel:bob:20002')).toContain('job-bob')
    document.querySelector<HTMLButtonElement>('[data-action="logout"]')!.click()
    expect(window.sessionStorage.getItem('xpanel_operations_dock:xpanel:bob:20002')).toBeNull()
    expect(document.getElementById('xp-ops-dock')!.hidden).toBe(true)
  })

  it('blocks keyboard sorting when a sortable list sets data-sort-locked="true"', () => {
    document.body.innerHTML = `
      <ul data-sortable-list data-sort-locked="true">
        <li data-sort-id="a" tabindex="0">A</li>
        <li data-sort-id="b" tabindex="0">B</li>
      </ul>
    `
    bootRuntime()
    const list = document.querySelector<HTMLElement>('[data-sortable-list]')!
    let reordered = false
    list.addEventListener('xpanel:reorder', () => { reordered = true })
    const second = list.querySelector<HTMLElement>('[data-sort-id="b"]')!
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    expect(reordered).toBe(false)
    expect([...list.children].map(el => el.getAttribute('data-sort-id'))).toEqual(['a', 'b'])
  })

  it('tracks radio groups separately in dirty-form snapshots and restores the saved radio option on Discard', () => {
    document.body.innerHTML = `
      <form data-dirty-track="web-server">
        <input id="eng-apache" type="radio" name="engine" value="apache" checked />
        <input id="eng-nginx" type="radio" name="engine" value="nginx" />
        <input id="mpm-itk" type="radio" name="apacheMpm" value="itk" checked />
        <input id="mpm-event" type="radio" name="apacheMpm" value="event" />
        <input name="keepalive" value="65" />
      </form>
    `
    bootRuntime()

    const form = document.querySelector('form')!
    const bar = form.querySelector<HTMLElement>('.v2-save-bar')!
    const count = bar.querySelector<HTMLElement>('[data-dirty-count]')!
    const apache = document.getElementById('eng-apache') as HTMLInputElement
    const nginx = document.getElementById('eng-nginx') as HTMLInputElement
    const itk = document.getElementById('mpm-itk') as HTMLInputElement
    const keepalive = form.querySelector<HTMLInputElement>('input[name="keepalive"]')!

    expect(bar.hidden).toBe(true)

    // Editing another field must NOT falsely flag the initially checked radios as dirty.
    keepalive.value = '120'
    keepalive.dispatchEvent(new Event('input', { bubbles: true }))
    expect(bar.hidden).toBe(false)
    expect(count.textContent).toBe('1 unsaved change')

    // Switching a radio group counts as one additional change, and Discard restores both radios cleanly.
    nginx.checked = true
    nginx.dispatchEvent(new Event('change', { bubbles: true }))
    expect(count.textContent).toBe('2 unsaved changes')

    bar.querySelector<HTMLButtonElement>('[data-dirty-discard]')!.click()
    expect(apache.checked).toBe(true)
    expect(nginx.checked).toBe(false)
    expect(itk.checked).toBe(true)
    expect(keepalive.value).toBe('65')
    expect(bar.hidden).toBe(true)
  })

  it('routes file-manager dropzone clicks through [data-action="upload-file"] and delegates drops via xpanel:files-dropped', () => {
    document.body.innerHTML = `
      <div data-file-manager="browse">
        <button type="button" data-action="upload-file">Upload File</button>
        <input type="file" data-file-upload hidden />
        <div data-file-dropzone role="button" tabindex="0">Drop files</div>
      </div>
    `
    bootRuntime()

    const root = document.querySelector<HTMLElement>('[data-file-manager]')!
    const uploadBtn = root.querySelector<HTMLButtonElement>('[data-action="upload-file"]')!
    const dropzone = root.querySelector<HTMLElement>('[data-file-dropzone]')!
    let uploadBtnClicks = 0
    uploadBtn.addEventListener('click', () => { uploadBtnClicks++ })
    dropzone.click()
    expect(uploadBtnClicks).toBe(1)

    const droppedNames: string[] = []
    root.addEventListener('xpanel:files-dropped', event => {
      event.preventDefault()
      const detail = (event as CustomEvent<{ files: File[] }>).detail
      droppedNames.push(...detail.files.map(file => file.name))
    })
    const fakeFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: { files: File[] } }
    dropEvent.dataTransfer = { files: [fakeFile] }
    dropzone.dispatchEvent(dropEvent)
    expect(droppedNames).toEqual(['notes.txt'])
    expect(dropzone.querySelector('[data-dropzone-queue]')!.textContent).toBe('')
  })

  it('synchronizes cron builder expression, summary, and frequency fields on user input and binds menus, tabs, comboboxes, and toasts', () => {
    document.body.innerHTML = [
      renderCronBuilder({ id: 'cron-1', namePrefix: 'schedule', state: { frequency: 'daily', hour: 2, minute: 0 } }),
      renderActionMenu({ id: 'menu-1', items: [{ id: 'edit', label: 'Edit', action: 'edit' }] }),
      renderTabs({
        id: 'tabs-1',
        ariaLabel: 'Sections',
        items: [
          { id: 'one', label: 'First', active: true, panelHtml: '<p>One</p>' },
          { id: 'two', label: 'Second', panelHtml: '<p>Two</p>' },
        ],
      }),
      renderCombobox({
        id: 'combo-1',
        name: 'domain',
        options: [
          { value: 'alpha.test', label: 'alpha.test' },
          { value: 'beta.test', label: 'beta.test' },
        ],
      }),
      renderToastRegion([{ id: 'toast-1', title: 'Saved', tone: 'ok' }]),
    ].join('\n')

    bootRuntime()

    const hiddenExpr = document.querySelector<HTMLInputElement>('[data-ds-cron-expression]')!
    const summaryText = document.querySelector<HTMLElement>('[data-ds-cron-summary-text]')!
    const codeText = document.querySelector<HTMLElement>('[data-ds-cron-code]')!
    const freqSelect = document.querySelector<HTMLSelectElement>('[name="schedule[frequency]"]')!
    const hourInput = document.querySelector<HTMLInputElement>('[name="schedule[hour]"]')!
    const dowWrap = document.querySelector<HTMLElement>('[data-cron-field="dow"]')!
    const domWrap = document.querySelector<HTMLElement>('[data-cron-field="dom"]')!
    const customWrap = document.querySelector<HTMLElement>('[data-cron-field="custom"]')!
    const dowSelect = document.querySelector<HTMLSelectElement>('[name="schedule[dayOfWeek]"]')!
    const domInput = document.querySelector<HTMLInputElement>('[name="schedule[dayOfMonth]"]')!
    const customInput = document.querySelector<HTMLInputElement>('[name="schedule[customExpression]"]')!

    expect(hiddenExpr.value).toBe('0 2 * * *')
    expect(dowWrap.hidden).toBe(true)
    expect(dowSelect.disabled).toBe(true)

    hourInput.value = '3'
    hourInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('0 3 * * *')
    expect(summaryText.textContent).toBe('Every day at 03:00')
    expect(codeText.textContent).toBe('0 3 * * *')

    freqSelect.value = 'weekly'
    freqSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(dowWrap.hidden).toBe(false)
    expect(dowSelect.disabled).toBe(false)
    dowSelect.value = '5'
    dowSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(hiddenExpr.value).toBe('0 3 * * 5')
    expect(summaryText.textContent).toBe('Every Friday at 03:00')

    freqSelect.value = 'monthly'
    freqSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(dowWrap.hidden).toBe(true)
    expect(domWrap.hidden).toBe(false)
    domInput.value = '15'
    domInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('0 3 15 * *')

    freqSelect.value = 'custom'
    freqSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(customWrap.hidden).toBe(false)
    expect(customInput.required).toBe(true)
    customInput.value = '*/15 * * * *'
    customInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('*/15 * * * *')
    expect(customInput.checkValidity()).toBe(true)

    customInput.value = '@daily'
    customInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('@daily')
    expect(customInput.checkValidity()).toBe(true)

    customInput.value = ''
    customInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('')
    expect(codeText.textContent).toBe('')
    expect(summaryText.textContent).toBe('Custom schedule (—)')
    expect(customInput.checkValidity()).toBe(false)

    customInput.value = '   '
    customInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('')
    expect(customInput.checkValidity()).toBe(false)

    customInput.value = 'not-a-cron'
    customInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hiddenExpr.value).toBe('not-a-cron')
    expect(customInput.checkValidity()).toBe(false)

    freqSelect.value = 'daily'
    freqSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(customWrap.hidden).toBe(true)
    expect(customInput.disabled).toBe(true)
    expect(customInput.required).toBe(false)
    expect(customInput.validationMessage).toBe('')
    expect(hiddenExpr.value).toBe('0 3 * * *')

    // Action menu toggle, item click close, & Escape close
    const menuTrigger = document.querySelector<HTMLButtonElement>('#menu-1 [aria-haspopup="menu"]')!
    const menuPanel = document.querySelector<HTMLElement>('#menu-1-panel')!
    const menuItem = document.querySelector<HTMLButtonElement>('#menu-1 [role="menuitem"]')!
    expect(menuPanel.hidden).toBe(true)
    menuTrigger.click()
    expect(menuPanel.hidden).toBe(false)
    expect(menuTrigger.getAttribute('aria-expanded')).toBe('true')
    menuItem.click()
    expect(menuPanel.hidden).toBe(true)
    expect(menuTrigger.getAttribute('aria-expanded')).toBe('false')
    menuTrigger.click()
    expect(menuPanel.hidden).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menuPanel.hidden).toBe(true)

    // Tabs switching + keyboard RTL + Home/End
    const tabOne = document.querySelector<HTMLButtonElement>('[data-ds-tab="one"]')!
    const tabTwo = document.querySelector<HTMLButtonElement>('[data-ds-tab="two"]')!
    const panelOne = document.querySelector<HTMLElement>('[data-ds-tabpanel="one"]')!
    const panelTwo = document.querySelector<HTMLElement>('[data-ds-tabpanel="two"]')!
    tabTwo.click()
    expect(panelOne.hidden).toBe(true)
    expect(panelTwo.hidden).toBe(false)
    expect(tabTwo.getAttribute('aria-selected')).toBe('true')
    tabTwo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(tabOne.getAttribute('aria-selected')).toBe('true')
    document.documentElement.dir = 'rtl'
    tabOne.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(tabTwo.getAttribute('aria-selected')).toBe('true')
    tabOne.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(tabTwo.getAttribute('aria-selected')).toBe('true')
    document.documentElement.dir = ''

    // Combobox filter, outside click close, & select
    const comboInput = document.querySelector<HTMLInputElement>('#combo-1')!
    const comboList = document.querySelector<HTMLElement>('#combo-1-listbox')!
    const comboHidden = document.querySelector<HTMLInputElement>('[data-ds-combobox-hidden]')!
    comboInput.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    expect(comboList.hidden).toBe(false)
    document.body.click()
    expect(comboList.hidden).toBe(true)
    expect(comboInput.getAttribute('aria-expanded')).toBe('false')
    comboInput.value = 'beta'
    comboInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector<HTMLElement>('[data-ds-combobox-value="alpha.test"]')!.hidden).toBe(true)
    document.querySelector<HTMLElement>('[data-ds-combobox-value="beta.test"]')!.click()
    expect(comboHidden.value).toBe('beta.test')

    // Drawer Escape close
    document.body.insertAdjacentHTML('beforeend', renderDrawer({ id: 'drw-1', title: 'Edit', bodyHtml: '<p>Body</p>', open: true }))
    const drawer = document.querySelector<HTMLElement>('#drw-1')!
    const backdrop = document.querySelector<HTMLElement>('#drw-1-backdrop')!
    expect(drawer.hidden).toBe(false)
    expect(backdrop.hidden).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(drawer.hidden).toBe(true)
    expect(backdrop.hidden).toBe(true)

    // Toast dismissal
    expect(document.querySelector('[data-ds-toast="toast-1"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-ds-toast-dismiss="toast-1"]')!.click()
    expect(document.querySelector('[data-ds-toast="toast-1"]')).toBeNull()
  })

  it('handles combobox keyboard selection, .ds-shell collapse, wizard navigation, table bulk selection, and dialog Escape', () => {
    window.localStorage.setItem('xpanel.sidebar.collapsed', '0')
    document.body.innerHTML = renderAppShell({
      surface: 'xpanel',
      collapsed: true,
      brandHtml: '<span>xPanel</span>',
      navGroups: [{ id: 'g1', title: 'Main', items: [{ id: 'home', label: 'Home', href: '/home', current: true }] }],
      topbarHtml: '',
      contentHtml: [
        renderCombobox({
          id: 'kb-combo',
          name: 'zone',
          options: [
            { value: 'one.test', label: 'one.test' },
            { value: 'two.test', label: 'two.test' },
            { value: 'three.test', label: 'three.test' },
          ],
        }),
        renderWizard({
          id: 'kb-wiz',
          activeStepIndex: 0,
          steps: [
            { id: 's1', label: 'Step 1', bodyHtml: '<p>Step one</p>' },
            { id: 's2', label: 'Step 2', bodyHtml: '<p>Step two</p>' },
          ],
        }),
        renderDataTable({
          id: 'kb-tbl',
          caption: 'Domains',
          selectable: true,
          columns: [{ key: 'domain', label: 'Domain' }],
          rows: [
            { id: 'd1', cells: { domain: 'one.test' } },
            { id: 'd2', cells: { domain: 'two.test' } },
          ],
        }),
      ].join('\n'),
      overlaysHtml: renderConfirmDialog({ id: 'kb-dlg', title: 'Confirm', message: 'Proceed?', open: true }),
    })

    const origShowModal = HTMLDialogElement.prototype.showModal
    const origClose = HTMLDialogElement.prototype.close
    let showModalCalls = 0
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      showModalCalls++
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
    try {
      bootRuntime()

      expect(showModalCalls).toBe(1)

      // 1. .ds-shell initially collapsed was expanded by stored '0', then toggles on button & Ctrl+B
      const shell = document.querySelector<HTMLElement>('.ds-shell')!
      const collapseBtn = document.querySelector<HTMLButtonElement>('[data-action="toggle-sidebar-collapse"]')!
      expect(shell.getAttribute('data-sidebar-collapsed')).toBeNull()
      expect(collapseBtn.getAttribute('aria-expanded')).toBe('true')
      collapseBtn.click()
      expect(shell.getAttribute('data-sidebar-collapsed')).toBe('true')
      expect(collapseBtn.getAttribute('aria-expanded')).toBe('false')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
      expect(shell.getAttribute('data-sidebar-collapsed')).toBeNull()

      // 2. Combobox keyboard selection
      const input = document.querySelector<HTMLInputElement>('#kb-combo')!
      const hidden = document.querySelector<HTMLInputElement>('#kb-combo ~ [data-ds-combobox-hidden], .ds-combobox [data-ds-combobox-hidden]')!
      const list = document.querySelector<HTMLElement>('#kb-combo-listbox')!
      let changes = 0
      hidden.addEventListener('change', () => { changes++ })
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
      expect(list.hidden).toBe(false)
      expect(input.getAttribute('aria-activedescendant')).toBe('kb-combo-opt-0')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(input.getAttribute('aria-activedescendant')).toBe('kb-combo-opt-1')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      expect(input.getAttribute('aria-activedescendant')).toBe('kb-combo-opt-2')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(input.getAttribute('aria-activedescendant')).toBe('kb-combo-opt-1')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(hidden.value).toBe('two.test')
      expect(input.value).toBe('two.test')
      expect(changes).toBe(1)
      expect(list.hidden).toBe(true)
      expect(input.getAttribute('aria-activedescendant')).toBeNull()

      // Editing or clearing the visible input invalidates the stale hidden selection
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      expect(hidden.value).toBe('')
      expect(changes).toBe(2)
      expect(document.querySelector('#kb-combo-opt-1')!.getAttribute('aria-selected')).toBe('false')
      document.body.click()
      expect(list.hidden).toBe(true)
      expect(hidden.value).toBe('')

      // 3. Wizard Next & Prev navigation
      const wiz = document.querySelector<HTMLElement>('#kb-wiz')!
      const s1 = wiz.querySelector<HTMLElement>('[data-ds-wizard-step="s1"]')!
      const s2 = wiz.querySelector<HTMLElement>('[data-ds-wizard-step="s2"]')!
      const prevBtn = wiz.querySelector<HTMLButtonElement>('[data-ds-wizard-prev]')!
      const nextBtn = wiz.querySelector<HTMLButtonElement>('[data-ds-wizard-next]')!
      const submitBtn = wiz.querySelector<HTMLButtonElement>('[data-ds-wizard-submit]')!
      expect(s1.hidden).toBe(false)
      expect(s2.hidden).toBe(true)
      expect(prevBtn.disabled).toBe(true)
      nextBtn.click()
      expect(s1.hidden).toBe(true)
      expect(s2.hidden).toBe(false)
      expect(prevBtn.disabled).toBe(false)
      expect(nextBtn.hidden).toBe(true)
      expect(submitBtn.hidden).toBe(false)
      prevBtn.click()
      expect(s1.hidden).toBe(false)
      expect(s2.hidden).toBe(true)

      // 4. Table select-all & row selection
      const selectAll = document.querySelector<HTMLInputElement>('#kb-tbl [data-ds-select-all]')!
      const rowChecks = document.querySelectorAll<HTMLInputElement>('#kb-tbl [data-ds-row-select]')
      const bulkBar = document.querySelector<HTMLElement>('#kb-tbl [data-ds-bulk-bar]')!
      const selectedCount = document.querySelector<HTMLElement>('#kb-tbl [data-ds-selected-count]')!
      expect(bulkBar.hidden).toBe(true)
      selectAll.checked = true
      selectAll.dispatchEvent(new Event('change', { bubbles: true }))
      expect(bulkBar.hidden).toBe(false)
      expect(selectedCount.textContent).toBe('2')
      rowChecks[0]!.checked = false
      rowChecks[0]!.dispatchEvent(new Event('change', { bubbles: true }))
      expect(selectAll.indeterminate).toBe(true)
      expect(selectedCount.textContent).toBe('1')

      // 5. Escape closes modal dialog mounted via showModal()
      const dlg = document.querySelector<HTMLDialogElement>('#kb-dlg')!
      expect(dlg.hasAttribute('open')).toBe(true)
      expect(dlg.hasAttribute('data-ds-dialog-open')).toBe(false)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(dlg.hasAttribute('open')).toBe(false)

      // 6. DataTable client pagination (30 rows), visible-page select-all, and column sorting
      const pageWrap = document.createElement('div')
      pageWrap.innerHTML = renderDataTable({
        id: 'pg-tbl',
        caption: 'Paged accounts',
        selectable: true,
        pageSize: 25,
        columns: [{ key: 'domain', label: 'Domain', sortable: true }],
        rows: Array.from({ length: 30 }, (_, i) => ({
          id: `r-${i + 1}`,
          cells: { domain: `site-${String(30 - i).padStart(2, '0')}.test` },
        })),
      })
      document.body.appendChild(pageWrap)
      bootRuntime()

      const pgTbl = document.querySelector<HTMLElement>('#pg-tbl')!
      const pgCur = pgTbl.querySelector<HTMLElement>('[data-ds-page-current]')!
      const pgPrev = pgTbl.querySelector<HTMLButtonElement>('[data-ds-page-prev]')!
      const pgNext = pgTbl.querySelector<HTMLButtonElement>('[data-ds-page-next]')!
      const pgSelectAll = pgTbl.querySelector<HTMLInputElement>('[data-ds-select-all]')!
      const pgCount = pgTbl.querySelector<HTMLElement>('[data-ds-selected-count]')!
      const row1 = pgTbl.querySelector<HTMLTableRowElement>('[data-ds-row="r-1"]')!
      const row26 = pgTbl.querySelector<HTMLTableRowElement>('[data-ds-row="r-26"]')!

      expect(pgCur.textContent).toBe('1')
      expect(row1.hidden).toBe(false)
      expect(row26.hidden).toBe(true)
      expect(pgPrev.disabled).toBe(true)
      expect(pgNext.disabled).toBe(false)

      pgNext.click()
      expect(pgCur.textContent).toBe('2')
      expect(row1.hidden).toBe(true)
      expect(row26.hidden).toBe(false)
      expect(pgPrev.disabled).toBe(false)
      expect(pgNext.disabled).toBe(true)

      pgSelectAll.checked = true
      pgSelectAll.dispatchEvent(new Event('change', { bubbles: true }))
      expect(pgCount.textContent).toBe('5')
      expect(row1.querySelector<HTMLInputElement>('[data-ds-row-select]')!.checked).toBe(false)
      expect(row26.querySelector<HTMLInputElement>('[data-ds-row-select]')!.checked).toBe(true)

      pgPrev.click()
      expect(pgCur.textContent).toBe('1')
      expect(row1.hidden).toBe(false)
      expect(row26.hidden).toBe(true)
      expect(pgCount.textContent).toBe('5')

      const sortBtn = pgTbl.querySelector<HTMLButtonElement>('[data-ds-sort="domain"]')!
      sortBtn.click()
      const firstSortedRow = pgTbl.querySelector<HTMLTableRowElement>('tbody tr[data-ds-row]')!
      expect(firstSortedRow.getAttribute('data-ds-row')).toBe('r-30')
      expect(firstSortedRow.hidden).toBe(false)
      expect(sortBtn.closest('th')!.getAttribute('aria-sort')).toBe('ascending')

      // 7. Nested tab groups isolate activation to their owning group & disabled combobox stays closed
      const extraWrap = document.createElement('div')
      extraWrap.innerHTML = [
        renderTabs({
          id: 'outer-tabs',
          ariaLabel: 'Outer',
          items: [
            {
              id: 'o1',
              label: 'Outer 1',
              active: true,
              panelHtml: renderTabs({
                id: 'inner-tabs',
                ariaLabel: 'Inner',
                items: [
                  { id: 'i1', label: 'Inner 1', active: true, panelHtml: '<p>Inner 1 body</p>' },
                  { id: 'i2', label: 'Inner 2', panelHtml: '<p>Inner 2 body</p>' },
                ],
              }),
            },
            { id: 'o2', label: 'Outer 2', panelHtml: '<p>Outer 2 body</p>' },
          ],
        }),
        renderCombobox({
          id: 'dis-combo',
          name: 'disabledZone',
          disabled: true,
          options: [{ value: 'a.test', label: 'a.test' }],
        }),
      ].join('\n')
      document.body.appendChild(extraWrap)
      bootRuntime()

      const outerBtn1 = document.querySelector<HTMLButtonElement>('[data-ds-tab="o1"]')!
      const outerBtn2 = document.querySelector<HTMLButtonElement>('[data-ds-tab="o2"]')!
      const outerPanel1 = document.querySelector<HTMLElement>('[data-ds-tabpanel="o1"]')!
      const innerBtn1 = document.querySelector<HTMLButtonElement>('[data-ds-tab="i1"]')!
      const innerBtn2 = document.querySelector<HTMLButtonElement>('[data-ds-tab="i2"]')!
      const innerPanel1 = document.querySelector<HTMLElement>('[data-ds-tabpanel="i1"]')!
      const innerPanel2 = document.querySelector<HTMLElement>('[data-ds-tabpanel="i2"]')!

      outerBtn2.click()
      expect(outerPanel1.hidden).toBe(true)
      expect(innerBtn1.getAttribute('aria-selected')).toBe('true')
      expect(innerPanel1.hidden).toBe(false)

      outerBtn1.click()
      innerBtn2.click()
      expect(outerBtn1.getAttribute('aria-selected')).toBe('true')
      expect(outerPanel1.hidden).toBe(false)
      expect(innerPanel1.hidden).toBe(true)
      expect(innerPanel2.hidden).toBe(false)

      const disInput = document.querySelector<HTMLInputElement>('#dis-combo')!
      const disList = document.querySelector<HTMLElement>('#dis-combo-listbox')!
      disInput.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
      disInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(disList.hidden).toBe(true)

      // 8. Wizard guards implicit submission and Enter before the final step
      const wizWrap = document.createElement('div')
      wizWrap.innerHTML = `<form id="wiz-form">${renderWizard({
        id: 'form-wiz',
        activeStepIndex: 0,
        steps: [
          { id: 'ws1', label: 'Step 1', bodyHtml: renderInput({ id: 'wiz-domain', name: 'domain', required: true }) },
          { id: 'ws2', label: 'Step 2', bodyHtml: renderInput({ id: 'wiz-plan', name: 'plan', value: 'basic' }) },
        ],
      })}</form>`
      document.body.appendChild(wizWrap)
      bootRuntime()

      const wizForm = document.querySelector<HTMLFormElement>('#wiz-form')!
      const formWiz = document.querySelector<HTMLElement>('#form-wiz')!
      const ws1 = formWiz.querySelector<HTMLElement>('[data-ds-wizard-step="ws1"]')!
      const ws2 = formWiz.querySelector<HTMLElement>('[data-ds-wizard-step="ws2"]')!
      const wPrev = formWiz.querySelector<HTMLButtonElement>('[data-ds-wizard-prev]')!
      const wNext = formWiz.querySelector<HTMLButtonElement>('[data-ds-wizard-next]')!
      const wSubmit = formWiz.querySelector<HTMLButtonElement>('[data-ds-wizard-submit]')!
      const domainInput = formWiz.querySelector<HTMLInputElement>('#wiz-domain')!
      let allowedSubmits = 0
      wizForm.addEventListener('submit', e => {
        if (!e.defaultPrevented) allowedSubmits++
      })

      expect(wSubmit.hidden).toBe(true)
      expect(wSubmit.disabled).toBe(true)
      expect(wNext.hidden).toBe(false)
      expect(wNext.disabled).toBe(false)

      const invalidSubmit = new Event('submit', { bubbles: true, cancelable: true })
      wizForm.dispatchEvent(invalidSubmit)
      expect(invalidSubmit.defaultPrevented).toBe(true)
      expect(allowedSubmits).toBe(0)
      expect(ws1.hidden).toBe(false)

      domainInput.value = 'example.com'
      const enterEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      domainInput.dispatchEvent(enterEv)
      expect(enterEv.defaultPrevented).toBe(true)
      expect(allowedSubmits).toBe(0)
      expect(ws1.hidden).toBe(true)
      expect(ws2.hidden).toBe(false)
      expect(wNext.hidden).toBe(true)
      expect(wNext.disabled).toBe(true)
      expect(wSubmit.hidden).toBe(false)
      expect(wSubmit.disabled).toBe(false)

      wPrev.click()
      expect(wSubmit.disabled).toBe(true)
      const earlySubmit = new Event('submit', { bubbles: true, cancelable: true })
      wizForm.dispatchEvent(earlySubmit)
      expect(earlySubmit.defaultPrevented).toBe(true)
      expect(allowedSubmits).toBe(0)
      expect(ws2.hidden).toBe(false)
      expect(wSubmit.disabled).toBe(false)

      domainInput.value = ''
      const brokenFinalSubmit = new Event('submit', { bubbles: true, cancelable: true })
      wizForm.dispatchEvent(brokenFinalSubmit)
      expect(brokenFinalSubmit.defaultPrevented).toBe(true)
      expect(allowedSubmits).toBe(0)
      expect(ws1.hidden).toBe(false)

      domainInput.value = 'example.com'
      wNext.click()
      const validSubmit = new Event('submit', { bubbles: true, cancelable: true })
      wizForm.dispatchEvent(validSubmit)
      expect(validSubmit.defaultPrevented).toBe(false)
      expect(allowedSubmits).toBe(1)
    } finally {
      HTMLDialogElement.prototype.showModal = origShowModal
      HTMLDialogElement.prototype.close = origClose
    }
  })
})
