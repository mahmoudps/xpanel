import { whmStoredFacts, type WhmStoredFactAuthority } from '../stored-facts.ts'
import { canOpenRegisteredRoute } from '@xpanel/catalog'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { dataTable } from '../../../components/data-table.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml } from '../../../html.ts'
import type { WhmResellerAuthority } from './index.ts'

/** These two registered documents expose saved records; they do not mutate delegation or nameservers. */
export function renderV2WhmResellerRecords(t: Translate, props: WhmSurfaceProps, authority: WhmResellerAuthority): string | undefined {
  const route = props.activeRoute
  if (route !== '/whm/resellers/more' && route !== '/whm/resellers/ips-nameservers') return undefined
  const principal = props.visibility?.principal ?? props.principal
  const readable = ((authority.presentation !== 'read-only' && authority.canRead && props.capabilityUnavailable !== true) || whmStoredFacts(props, authority, ['reseller-center'], route)) && !!principal
    && canOpenRegisteredRoute(route, { ...props.visibility, principal, reseller: props.visibility?.reseller ?? props.activeReseller ?? undefined })
  const resellers = readable ? props.resellers?.filter(reseller => principal.kind === 'root' || reseller.id === principal.id) : undefined
  const title = route === '/whm/resellers/more' ? t('More reseller tools') : t('IPs & nameservers')
  const rows = (resellers ?? []).map(reseller => ({ cellsHtml: [`<bdi dir="ltr">${escapeHtml(reseller.username)}</bdi>`, reseller.maxAccounts === 'unlimited' ? escapeHtml(t('Unlimited')) : `<bdi dir="ltr">${reseller.maxAccounts}</bdi>`, reseller.nameservers.map(name => `<bdi dir="ltr">${escapeHtml(name)}</bdi>`).join('<br>')] }))
  return `<section class="v2-resellers" data-whm-detail-route="${route}" data-capability-state="${readable ? 'authorized' : 'unavailable'}">${pageHeader(t, { title, route, description: t(route === '/whm/resellers/more' ? msgid('Only loaded, stored reseller account limits and nameserver records are shown. Usage and bulk ownership changes are unavailable.') : msgid('Only loaded reseller nameserver and account-limit records are shown. IP delegation changes are unavailable.')), breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t('Resellers'), href: '/whm/resellers' }, { label: title }] })}${card({ title, titleId: 'v2-reseller-records-heading', bodyHtml: dataTable(t, { id: 'v2-reseller-records', caption: title, columns: [t('Reseller'), t('Account limit'), t('Nameservers')].map(label => ({ label })), rows, emptyText: t(resellers === undefined ? msgid('Not read') : msgctxt('theme:v2', 'No resellers were returned.')) }) })}<p role="status" data-wiring="unavailable">${escapeHtml(t(msgctxt('theme:v2', 'This document shows stored records only. Use the qualified reseller workspace for individual changes.')))}</p></section>`
}
