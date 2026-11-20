/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
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
  document.body.replaceChildren()
  window.sessionStorage.clear()
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

  it('skips externally managed tables while still paginating unmanaged large tables', () => {
    const manyRows = (attrs = '') =>
      Array.from({ length: 35 }, (_, idx) => `<tr${attrs}><td>Row ${idx + 1}</td></tr>`).join('')

    document.body.innerHTML = `
      <section data-accounts-workspace>
        <div data-account-list-controls></div>
        <table id="accounts-table"><tbody>${manyRows(' data-account-row')}</tbody></table>
      </section>
      <section data-list-filter>
        <table id="filtered-table"><tbody>${manyRows(' data-list-row')}</tbody></table>
      </section>
      <section data-whm-table-workspace>
        <div data-whm-filter-table>
          <table id="whm-table"><tbody>${manyRows()}</tbody></table>
        </div>
      </section>
      <section>
        <table id="plain-table"><tbody>${manyRows()}</tbody></table>
      </section>
    `
    bootRuntime()

    const pagers = document.querySelectorAll('.v2-pagination-bar')
    expect(pagers).toHaveLength(1)
    expect(document.getElementById('plain-table')!.nextElementSibling?.classList.contains('v2-pagination-bar')).toBe(true)
    expect(document.getElementById('accounts-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(0)
    expect(document.getElementById('filtered-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(0)
    expect(document.getElementById('whm-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(0)
    expect(document.getElementById('plain-table')!.querySelectorAll('tbody tr[hidden]')).toHaveLength(10)
  })
})
