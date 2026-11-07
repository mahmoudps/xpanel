/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
export interface SearchHitView { kind: string; entityId: string; accountId: string | null; title: string; subtitle: string }

/** Exact title first, then the index order; only accounts and domains have a page to open here. */
export function rankSearchHits(hits: readonly SearchHitView[], query: string): SearchHitView[] {
  const wanted = query.trim().toLowerCase()
  return hits.filter(hit => hit.kind === 'account' || hit.kind === 'domain').map((hit, index) => ({ hit, index, exact: hit.title.toLowerCase() === wanted }))
    .sort((left, right) => Number(right.exact) - Number(left.exact) || left.index - right.index).map(item => item.hit)
}

/** Favorites on Home and the side menu, the notification bell and its list, and record search in the quick bar. */
function bindWhmHome(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  if (typeof request !== 'function') return
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const note = (node: HTMLElement | null, state: string, message: string): void => { if (node) { node.hidden = false; node.dataset.state = state; node.textContent = message } }

  // Favorites are saved per administrator; the quick bar owns the star and tells this client through a document event.
  const home = document.querySelector<HTMLElement>('[data-whm-favorites]'), side = document.querySelector<HTMLElement>('[data-whm-favorites-nav]')
  const labels = new Map<string, { label: string; hint: string; href: string }>()
  document.querySelectorAll<HTMLAnchorElement>('a[data-cmdk-item][data-cmdk-persistable="true"]').forEach(link => {
    const route = link.dataset.cmdkItem ?? '', strong = link.querySelector('strong')
    labels.set(route, { label: strong?.textContent ?? link.textContent ?? route, hint: link.closest('[data-cmdk-group]')?.querySelector('span')?.textContent ?? '', href: link.getAttribute('href') ?? route })
  })
  let saved: { routes: string[]; descriptions: boolean } = { routes: [], descriptions: true }, listRead = false
  const favoritesStatus = home?.querySelector<HTMLElement>('[data-whm-favorites-status]') ?? null
  const links = (routes: string[], describe: boolean): HTMLElement[] => routes.filter(route => labels.has(route)).map(route => {
    const entry = labels.get(route)!, item = document.createElement('li'), link = document.createElement('a')
    link.href = entry.href; link.textContent = entry.label; item.dataset.favoriteRoute = route; item.append(link)
    if (describe && entry.hint) { const hint = document.createElement('small'); hint.textContent = ' ' + entry.hint; item.append(hint) }
    return item
  })
  const paint = (): void => {
    const shown = saved.routes.filter(route => labels.has(route))
    if (side) { side.querySelector('ul')?.replaceChildren(...links(shown, false)); side.hidden = !shown.length }
    if (!home) return
    const list = home.querySelector<HTMLElement>('[data-whm-favorites-list]'), empty = home.querySelector<HTMLElement>('[data-whm-favorites-empty]'), box = home.querySelector<HTMLInputElement>('[data-whm-favorites-descriptions]')
    if (box) box.checked = saved.descriptions
    if (empty) empty.hidden = shown.length > 0
    list?.replaceChildren(...links(shown, saved.descriptions).map((item, index) => {
      const move = (step: number, label: string): HTMLButtonElement => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = index + step < 0 || index + step >= shown.length; button.addEventListener('click', () => { const next = [...shown]; [next[index], next[index + step]] = [next[index + step]!, next[index]!]; void save({ ...saved, routes: next }) }); return button }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = t('Remove'); remove.addEventListener('click', () => void save({ ...saved, routes: shown.filter(route => route !== item.dataset.favoriteRoute) }))
      item.append(' ', move(-1, t('Up')), ' ', move(1, t('Down')), ' ', remove)
      return item
    }))
  }
  // An unreadable list must not read as an empty one, and a save replaces the whole list, so none goes out before a read.
  const favoritesUnavailable = (): void => {
    const empty = home?.querySelector<HTMLElement>('[data-whm-favorites-empty]'); if (empty) empty.hidden = true
    note(favoritesStatus, 'unavailable', t('Favorites could not be read.'))
  }
  const acceptFavorites = (value: unknown): void => {
    const view = object(value), routes = view.routes
    if (!Array.isArray(routes) || !routes.every(route => typeof route === 'string') || typeof view.descriptions !== 'boolean') return favoritesUnavailable()
    saved = { routes, descriptions: view.descriptions }; listRead = true
    if (favoritesStatus) favoritesStatus.hidden = true
    paint(); document.dispatchEvent(new CustomEvent('xpanel:favorites-loaded', { detail: saved.routes }))
  }
  const save = async (next: { routes: string[]; descriptions: boolean }): Promise<void> => {
    if (!listRead) return favoritesUnavailable()
    try { acceptFavorites(await request('PUT', '/api/admin/favorites', next)) }
    catch { note(favoritesStatus, 'failed', t('The favorites were not saved.')) }
  }
  if (home || side) {
    request('GET', '/api/admin/favorites').then(acceptFavorites).catch(favoritesUnavailable)
    document.addEventListener('xpanel:favorites-changed', event => void save({ ...saved, routes: (event as CustomEvent<string[]>).detail }))
    home?.querySelector<HTMLInputElement>('[data-whm-favorites-descriptions]')?.addEventListener('change', event => void save({ ...saved, descriptions: (event.target as HTMLInputElement).checked }))
  }

  const bell = document.querySelector<HTMLElement>('[data-whm-bell]'), inbox = document.querySelector<HTMLElement>('[data-whm-inbox]')
  const paintInbox = (view: Record<string, unknown>): void => {
    const unread = Number(view.unread), items = Array.isArray(view.items) ? view.items.map(object) : []
    if (bell) {
      bell.dataset.unread = String(unread > 0)
      bell.setAttribute('aria-label', t('{count, plural, =0 {Notifications, none unread} one {Notifications, # unread} other {Notifications, # unread}}', { count: unread }))
      const count = bell.querySelector<HTMLElement>('[data-whm-bell-count]'); if (count) { count.hidden = unread < 1; count.textContent = unread > 99 ? '99+' : String(unread) }
    }
    if (!inbox) return
    const list = inbox.querySelector<HTMLElement>('[data-whm-inbox-list]'), all = inbox.querySelector<HTMLButtonElement>('[data-whm-inbox-read]')
    list?.replaceChildren(...items.map(entry => {
      const row = document.createElement('li'), at = document.createElement('bdi'), title = document.createElement('strong')
      at.dir = 'ltr'; at.textContent = String(entry.at).slice(0, 16).replace('T', ' ') + ' UTC'; title.textContent = String(entry.title); row.dataset.read = String(entry.read === true); row.append(title, ' ', at)
      if (entry.target) { const target = document.createElement('bdi'); target.dir = 'ltr'; target.textContent = ' ' + String(entry.target); row.append(target) }
      if (entry.read !== true) {
        const read = document.createElement('button'); read.type = 'button'; read.textContent = t('Mark as read')
        read.addEventListener('click', () => void mark([String(entry.id)])); row.append(' ', read)
      }
      return row
    }))
    if (all) { all.disabled = unread < 1; all.onclick = () => void mark(items.filter(entry => entry.read !== true).map(entry => String(entry.id))) }
    note(inbox.querySelector<HTMLElement>('[data-whm-inbox-status]'), 'read', items.length ? t('{count, plural, =0 {Nothing unread.} one {# unread.} other {# unread.}}', { count: unread }) : t('No failed jobs, backups or operations were found.'))
  }
  const loadInbox = (): Promise<void> => request('GET', '/api/admin/notifications').then(value => {
    const view = object(value)
    if (!Array.isArray(view.items) || typeof view.unread !== 'number') throw new Error('unreadable_notifications')
    paintInbox(view)
  })
  const mark = async (ids: string[]): Promise<void> => {
    try { await request('POST', '/api/admin/notifications/read', { ids }); await loadInbox() }
    catch { note(inbox?.querySelector<HTMLElement>('[data-whm-inbox-status]') ?? null, 'failed', t('The items were not marked as read.')) }
  }
  if (bell || inbox) loadInbox().catch(() => note(inbox?.querySelector<HTMLElement>('[data-whm-inbox-status]') ?? null, 'unavailable', t('Notifications could not be read.')))

  const remote = document.querySelector<HTMLElement>('[data-cmdk-remote]'), input = document.querySelector<HTMLInputElement>('[data-cmdk-search]')
  if (remote && input && remote.closest('[data-cmdk-surface="xwhm"]')) {
    let timer: ReturnType<typeof setTimeout> | undefined, asked = ''
    input.addEventListener('input', () => {
      clearTimeout(timer)
      const query = input.value.replace(/^[>@#]\s*/, '').trim()
      if (query.length < 2) { remote.hidden = true; remote.replaceChildren(); asked = ''; return }
      timer = setTimeout(() => {
        asked = query
        request('GET', '/api/search?q=' + encodeURIComponent(query)).then(value => {
          if (asked !== query) return
          const hits = rankSearchHits(Array.isArray(object(value).hits) ? object(value).hits as SearchHitView[] : [], query).slice(0, 10)
          remote.replaceChildren(...hits.map(hit => {
            const item = document.createElement('li'), link = document.createElement('a'), detail = document.createElement('small')
            link.href = '/whm/accounts?' + new URLSearchParams({ accountId: hit.accountId ?? hit.entityId }).toString(); link.textContent = hit.title; detail.textContent = ' ' + hit.subtitle; link.append(detail); item.append(link)
            return item
          }))
          remote.hidden = !hits.length
        }).catch(() => { remote.hidden = true })
      }, 250)
    })
  }
}

export const WHM_HOME_CLIENT_BINDING = `(()=>{const rankSearchHits=${rankSearchHits.toString()};return ${bindWhmHome.toString()};})()`
