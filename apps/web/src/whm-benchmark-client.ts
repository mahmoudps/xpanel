import type { MessageValues } from './i18n.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
import type { BenchmarkView } from '../../api/src/benchmark-workspace.ts'
export function readWhmBenchmarkView(raw: unknown): BenchmarkView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const rate = (v: unknown): boolean => v === null || typeof v === 'number' && Number.isSafeInteger(v) && v > 0
  const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
  const bad = (): never => { throw new Error('invalid_benchmark_response') }
  if (!object(raw) || !object(raw.history) || !['read', 'unavailable'].includes(String(raw.history.state)) || !Array.isArray(raw.history.results) || raw.history.results.length > 20 || typeof raw.jobsAvailable !== 'boolean' || !object(raw.limits) || raw.limits.cpuSeconds !== 5 || raw.limits.diskBytes !== 67108864 || raw.limits.maxRuntimeSeconds !== 60 || raw.network !== 'not_measured') return bad()
  for (const v of raw.history.results) if (!object(v) || !instant(v.startedAt) || !instant(v.finishedAt) || Date.parse(v.finishedAt) < Date.parse(v.startedAt) || !['measured', 'partial', 'unavailable'].includes(String(v.state)) || !rate(v.cpuBytesPerSecond) || !rate(v.diskWriteBytesPerSecond) || !rate(v.diskReadBytesPerSecond) || !['verified', 'unknown'].includes(String(v.cleanup)) || v.network !== 'not_measured' || v.state === 'measured' && (v.cleanup !== 'verified' || v.cpuBytesPerSecond === null || v.diskWriteBytesPerSecond === null || v.diskReadBytesPerSecond === null)) return bad()
  if (raw.history.state === 'unavailable' && raw.history.results.length) return bad()
  return raw as unknown as BenchmarkView
}
function bindWhmBenchmark(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-whm-benchmark]').forEach(root => {
    if (root.dataset.canManage !== 'true' || root.closest('[data-readonly="true"],[data-wiring="unavailable"],fieldset:disabled')) return
    const form = root.querySelector<HTMLFormElement>('[data-benchmark-form]'), confirm = root.querySelector<HTMLInputElement>('[data-benchmark-confirm]'), start = root.querySelector<HTMLButtonElement>('[data-benchmark-start]'), refresh = root.querySelector<HTMLButtonElement>('[data-benchmark-refresh]'), status = root.querySelector<HTMLElement>('[data-benchmark-status]'), body = root.querySelector<HTMLTableSectionElement>('[data-benchmark-history]')
    if (!send || !form || !confirm || !start || !refresh || !status || !body) return
    let busy = false, available = false, locked = false
    const controls = (): void => { start.disabled = busy || !available || locked || confirm.value !== 'RUN'; confirm.disabled = busy || !available || locked; refresh.disabled = busy }
    const load = async (): Promise<void> => {
      if (busy) return; busy = true; controls(); status.textContent = t('Reading result history…')
      try {
        const view = readWhmBenchmarkView(await send('GET', '/api/server/monitoring/benchmark')); available = view.jobsAvailable
        body.replaceChildren()
        if (!view.history.results.length) { const row = body.insertRow(), cell = row.insertCell(); cell.colSpan = 6; cell.textContent = view.history.state === 'read' ? t('No benchmark has been recorded.') : t('History is unavailable.') }
        for (const value of view.history.results) {
          const row = body.insertRow()
          const values = [formatDisplayDateTime(value.startedAt), value.cpuBytesPerSecond, value.diskWriteBytesPerSecond, value.diskReadBytesPerSecond, value.state === 'measured' ? t('Measured') : value.state === 'partial' ? t('Partial') : t('Unavailable'), value.cleanup === 'verified' ? t('Verified') : t('Requires review')]
          for (const value of values) { const cell = row.insertCell(), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value === null ? t('Unavailable') : String(value); cell.append(bdi) }
        }
        status.textContent = locked ? t('Submission outcome needs review. Check host jobs before starting another run.') : available ? t('History updated. A benchmark starts only after you confirm RUN.') : t('Benchmark execution is unavailable on this host.')
      } catch { available = false; status.textContent = t('History could not be read. Refresh to retry.') }
      finally { busy = false; controls() }
    }
    form.addEventListener('submit', event => { event.preventDefault(); if (start.disabled || busy) return; busy = true; controls(); status.textContent = t('Submitting the benchmark…'); void (async () => {
      try {
        const raw = await send('POST', '/api/server/monitoring/benchmark/jobs', { confirm: 'RUN' }) as { job?: { id?: unknown; kind?: unknown; status?: unknown } }
        if (!raw?.job || typeof raw.job.id !== 'string' || !/^[0-9a-f-]{36}$/.test(raw.job.id) || raw.job.kind !== 'system.monitoring.benchmark' || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(raw.job.status))) throw new Error('invalid_job')
        locked = true; confirm.value = ''; status.textContent = t('Benchmark submitted. Follow it in host jobs, then refresh results.')
      } catch { locked = true; status.textContent = t('The submission outcome is unknown. Review host jobs before trying again.') }
      finally { busy = false; controls() }
    })() })
    confirm.addEventListener('input', controls); refresh.addEventListener('click', () => { void load() }); void load()
  })
}
export const WHM_BENCHMARK_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmBenchmarkView=${readWhmBenchmarkView.toString()};return ${bindWhmBenchmark.toString()};})()`
