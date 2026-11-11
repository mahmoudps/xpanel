import { whmStoredFacts, type WhmStoredFactAuthority } from '../stored-facts.ts'
import { canOpenRegisteredRoute } from '@xpanel/catalog'
import { formatDisplayDateTime } from '../../../../../display-format.ts'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { dataTable } from '../../../components/data-table.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml } from '../../../html.ts'
import type { WhmResellerAuthority } from './index.ts'
import { phoneCell, renderV2ResellerEmail, renderV2ResellerIpsNameservers, renderV2ResellerUsage } from './tools.ts'

/** These two registered documents expose saved records; they do not mutate delegation or nameservers. */
export function renderV2WhmResellerRecords(t: Translate, props: WhmSurfaceProps, authority: WhmResellerAuthority): string | undefined {
  const route = props.activeRoute
  if (route !== '/whm/resellers/more' && route !== '/whm/resellers/ips-nameservers') return undefined
  const principal = props.visibility?.principal ?? props.principal
  const readable = ((authority.presentation !== 'read-only' && authority.canRead && props.capabilityUnavailable !== true) || whmStoredFacts(props, authority, ['reseller-center'], route)) && !!principal
    && canOpenRegisteredRoute(route, { ...props.visibility, principal, reseller: props.visibility?.reseller ?? props.activeReseller ?? undefined })
  const resellers = readable ? props.resellers?.filter(reseller => principal.kind === 'root' || reseller.id === principal.id) : undefined
  const title = route === '/whm/resellers/more' ? t('More reseller tools') : t('IPs & nameservers')
  const rows = (resellers ?? []).map(reseller => {
    const created = reseller.createdAt ? formatDisplayDateTime(reseller.createdAt) : '—'
    const lastSignIn = reseller.lastSignInAt === undefined ? escapeHtml(t('Not read'))
      : reseller.lastSignInAt === null ? escapeHtml(t(msgid('Never')))
        : `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(formatDisplayDateTime(reseller.lastSignInAt))}</bdi>`
    return {
      cellsHtml: [
        `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(reseller.username)}</bdi>`,
        reseller.maxAccounts === 'unlimited' ? escapeHtml(t('Unlimited')) : `<bdi class="v2-mono v2-num" dir="ltr">${reseller.maxAccounts}</bdi>`,
        phoneCell(t('Created'), created === '—' ? escapeHtml(t(msgid('Not recorded'))) : `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(created)}</bdi>`),
        phoneCell(t('Last sign-in'), lastSignIn),
        phoneCell(t('Nameservers'), reseller.nameservers.map(name => `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(name)}</bdi>`).join('<br>')),
      ],
    }
  })
  const root = readable && principal.kind === 'root' && authority.canManage
  const records = card({ title, titleId: 'v2-reseller-records-heading', bodyHtml: dataTable(t, { id: 'v2-reseller-records', caption: title, columns: [t('Reseller'), t('Account limit'), t('Created'), t('Last sign-in'), t('Nameservers')].map(label => ({ label })), rows, emptyText: t(resellers === undefined ? msgid('Not read') : msgctxt('theme:v2', 'No resellers were returned.')) }) })
  const scoped = { ...props, resellers }
  const tools = !readable ? `<p role="status" data-wiring="unavailable">${escapeHtml(t(msgctxt('theme:v2', 'This document shows stored records only. Use the qualified reseller workspace for individual changes.')))}</p>`
    : route === '/whm/resellers/more' ? (principal.kind === 'root' ? renderV2ResellerUsage(t, scoped) + renderV2ResellerEmail(t, scoped, root) : '')
    : renderV2ResellerIpsNameservers(t, scoped, root)
  return `<section class="v2-resellers" data-whm-detail-route="${route}" data-capability-state="${readable ? 'authorized' : 'unavailable'}">${pageHeader(t, { title, route, description: t(route === '/whm/resellers/more' ? msgid('Measured reseller usage, Email All Resellers and stored reseller account limits and nameservers.') : msgid('IPs each reseller may assign, the shared IP of its new accounts and its nameservers.')), breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t('Resellers'), href: '/whm/resellers' }, { label: title }] })}${route === '/whm/resellers/more' ? records + tools : tools + records}</section>`
}
