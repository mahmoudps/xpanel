/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord

type Preview = { revision: string; records: unknown[]; differences: { name: string; type: string; current: string | null; imported: string | null; action: string }[]; skipped: { line: number; type: string; reason: string }[] }

export function readZoneFilePreview(value: unknown): Preview {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !Array.isArray(value.records) || !Array.isArray(value.differences) || !Array.isArray(value.skipped)
    || !value.differences.every(item => object(item) && typeof item.name === 'string' && typeof item.type === 'string' && typeof item.action === 'string' && [item.current, item.imported].every(text => text === null || typeof text === 'string'))
    || !value.skipped.every(item => object(item) && typeof item.line === 'number' && typeof item.type === 'string' && typeof item.reason === 'string')) throw new Error('invalid_zone_preview')
  return value as unknown as Preview
}

function bindWhmDnsFile(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-dns-file]').forEach(root => {
    if (root.dataset.dnsFileBound === 'true') return
    root.dataset.dnsFileBound = 'true'
    const zoneSelect = root.closest('[data-whm-dns-workspace]')?.querySelector<HTMLSelectElement>('[data-dns-zone]') ?? null
    const file = root.querySelector<HTMLInputElement>('[data-dns-file-input]'), text = root.querySelector<HTMLTextAreaElement>('[data-dns-file-text]')
    const rows = root.querySelector<HTMLElement>('[data-dns-file-rows]'), status = root.querySelector<HTMLElement>('[data-dns-file-status]')
    const exportButton = root.querySelector<HTMLButtonElement>('[data-dns-file-export]'), previewButton = root.querySelector<HTMLButtonElement>('[data-dns-file-preview]')
    const importButton = root.querySelector<HTMLButtonElement>('[data-dns-file-import]'), cancelButton = root.querySelector<HTMLButtonElement>('[data-dns-file-cancel]')
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!zoneSelect || !file || !text || !rows || !status || !exportButton || !previewButton || !importButton || !cancelButton) return
    let preview: { zone: string; value: Preview } | null = null, busy = false
    const zone = (): string => zoneSelect.value
    const route = (): string => '/api/dns/zones/' + encodeURIComponent(zone()) + '/zone-file'
    const say = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message }
    const failure = (error: unknown): string => (error as { message?: string }).message || t('The request was refused. Nothing was changed.')
    const lock = (): void => {
      exportButton.disabled = busy || !zone(); previewButton.disabled = busy || !zone() || !text.value.trim(); file.disabled = busy; text.disabled = busy
      importButton.disabled = busy || !preview || preview.zone !== zone(); cancelButton.disabled = busy
    }
    const clear = (): void => { preview = null; rows.replaceChildren(); lock() }
    if (typeof send !== 'function' || typeof askDialog !== 'function' || root.closest('[data-capability-unavailable="true"],[data-readonly="true"],fieldset:disabled')) { say('unavailable', t('Zone files are unavailable here. Nothing was read or changed.')); return }
    exportButton.addEventListener('click', () => { void (async () => {
      busy = true; lock(); say('reading', t('Reading the zone…'))
      try {
        const result = await send('GET', route()) as { fileName: string; text: string }
        const link = document.createElement('a'), address = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' }))
        link.href = address; link.download = result.fileName; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(address)
        say('read', t('The zone file was downloaded.'))
      } catch (error) { say('failed', failure(error)) } finally { busy = false; lock() }
    })() })
    previewButton.addEventListener('click', () => { void (async () => {
      const target = zone()
      busy = true; lock(); say('reading', t('Reading the zone file…'))
      try {
        const value = readZoneFilePreview(await send('POST', route(), { text: text.value }))
        preview = { zone: target, value }
        rows.replaceChildren(...value.differences.map(item => cloneViewRecord(root, 'dns-file-row', 'tr', { name: item.name, type: item.type, current: item.current ?? '', imported: item.imported ?? '', action: item.action === 'add' ? t('Add') : item.action === 'remove' ? t('Remove') : t('Change') })))
        const counts = { changes: value.differences.length, skipped: value.skipped.length }
        say('read', value.skipped.length ? t('{changes} changes. {skipped} lines were skipped. First: line {line}, {reason}', { ...counts, line: value.skipped[0]!.line, reason: value.skipped[0]!.reason }) : t('{changes} changes. The saved SOA record is kept.', counts))
      } catch (error) { clear(); say('failed', failure(error)) } finally { busy = false; lock() }
    })() })
    importButton.addEventListener('click', () => { void (async () => {
      if (!preview || preview.zone !== zone()) return
      const target = preview
      if (!await askDialog({ title: t('Replace the records of this zone?'), body: t('The saved records of {zone} are replaced by the records in this file.', { zone: target.zone }), confirm: t('Import BIND zone'), danger: true })) return
      busy = true; lock(); say('saving', t('Saving the zone…'))
      try {
        await send('PUT', '/api/dns/zones/' + encodeURIComponent(target.zone), { records: target.value.records, expectedZoneRevision: target.value.revision })
        text.value = ''; file.value = ''; clear()
        say('saved', t('Zone saved. DNS serving and propagation remain unverified.'))
        document.querySelector<HTMLButtonElement>('[data-dns-refresh]')?.click()
      } catch (error) { say('failed', failure(error)) } finally { busy = false; lock() }
    })() })
    cancelButton.addEventListener('click', () => { text.value = ''; file.value = ''; clear(); say('unread', t('Nothing has been imported.')) })
    file.addEventListener('change', () => { void (async () => { const chosen = file.files?.[0]; if (chosen) { text.value = await chosen.text(); clear() } })() })
    text.addEventListener('input', clear)
    zoneSelect.addEventListener('change', clear)
    new MutationObserver(lock).observe(zoneSelect, { childList: true, attributes: true })
    lock()
  })
}

export const WHM_DNS_FILE_CLIENT_BINDING = `((askDialog)=>{${VIEW_RECORD_HELPERS}const readZoneFilePreview=${readZoneFilePreview.toString()};(${bindWhmDnsFile.toString()})(askDialog)})`
