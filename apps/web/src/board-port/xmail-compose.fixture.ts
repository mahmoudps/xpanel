// Board sample data for tests and the local fidelity script only.
// Product code must not import this module.
import type { Locale } from '../i18n.ts'
import { MONO, type FolderLink, type ComposeModel, renderCompose, xmailComposeFromProps } from './xmail-compose.ts'

const FIXTURE_BODY = `<p style="margin: 0; max-width: 68ch">Hi Layla,</p><p style="margin: 0; max-width: 68ch">Thanks, the staging checkout looks good. Karim and I went through the test plan this morning and everything passed except two points:</p><ol style="margin: 0; padding-inline-start: 22px; max-width: 68ch; display: flex; flex-direction: column; gap: 4px"><li>On phones, the coupon field hides the <strong>Pay</strong> button while the keyboard is open.</li><li>The shipping estimate shows the price without VAT; it should include it.</li></ol><p style="margin: 0; max-width: 68ch">Once both are fixed, go ahead with the switch on 2026-10-26 at 07:00 UTC. Karim's annotated screenshot is attached.</p><p style="margin: 0; max-width: 68ch">Best,<br>Alice</p><p style="margin: 0; color: #475467; font-size: 13px">--<br>Alice Shop · alice-shop.com</p><blockquote style="margin: 4px 0 0; padding-inline-start: 14px; border-inline-start: 3px solid #D0D5DD; color: #475467; font-size: 13px; max-width: 68ch"><p style="margin: 0 0 6px">On 2026-10-22 13:48 UTC, Layla Haddad &lt;layla@nour.dev&gt; wrote:</p><p style="margin: 0">The new checkout is live on staging.alice-shop.com. It sits behind the Staging preview password you set up, so only the team can open it.</p></blockquote>`

const FIXTURE_RULES = `<li style="display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid #E2E6EC; font-size: 13px; line-height: 1.4"><span aria-hidden="true" style="flex: none; width: 22px; height: 22px; border-radius: 50%; background: #EEF0F3; color: #344054; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600">1</span><span>From ends with <code style="font-family: ${MONO}">@atlas-pack.example</code>, move to <strong style="font-weight: 600">Suppliers</strong></span></li><li style="display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid #E2E6EC; font-size: 13px; line-height: 1.4"><span aria-hidden="true" style="flex: none; width: 22px; height: 22px; border-radius: 50%; background: #EEF0F3; color: #344054; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600">2</span><span>Subject contains <code style="font-family: ${MONO}">Invoice</code>, move to <strong style="font-weight: 600">Invoices 2026</strong></span></li><li style="display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid #E2E6EC; font-size: 13px; line-height: 1.4"><span aria-hidden="true" style="flex: none; width: 22px; height: 22px; border-radius: 50%; background: #EEF0F3; color: #344054; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600">3</span><span>To is <code style="font-family: ${MONO}">orders@alice-shop.com</code>, move to <strong style="font-weight: 600">Orders</strong></span></li>`


const fixtureFolders = (): FolderLink[] => [
  { label: 'Inbox', href: 'MailInbox.dc.html', icon: 'inbox', current: false, count: { text: '12', kind: 'pill' }, aria: 'Inbox, 12 unread' },
  { label: 'Sent', href: 'MailInbox.dc.html', icon: 'sent', current: false },
  { label: 'Drafts', href: 'MailCompose.dc.html', icon: 'drafts', current: false, count: { text: '2', kind: 'muted' }, aria: 'Drafts, 2 messages' },
  { label: 'Junk', href: 'MailInbox.dc.html', icon: 'junk', current: false, count: { text: '3', kind: 'strong' }, aria: 'Junk, 3 unread' },
  { label: 'Trash', href: 'MailInbox.dc.html', icon: 'trash', current: false },
  { label: 'Archive', href: 'MailInbox.dc.html', icon: 'archive', current: false },
]

const fixtureModel = (): ComposeModel => ({
  feedback: { sendOk: 'Sent to 3 recipients at 14:06 UTC and signed with DKIM for alice-shop.com. A copy is in Sent.', saved: 'Draft saved 14:06 UTC', savedNote: 'Draft saved to Drafts at 14:06 UTC.' },
  locale: 'en',
  product: false,
  mailbox: 'info@alice-shop.com',
  quotaText: '1.2 / 5 GB',
  quotaPct: 24,
  quotaMeasured: true,
  composeHref: 'MailCompose.dc.html',
  inboxHref: 'MailInbox.dc.html',
  folders: fixtureFolders(),
  custom: [
    { label: 'Orders', href: 'MailInbox.dc.html', icon: 'folder', current: false, count: { text: '4', kind: 'strong' }, aria: 'Orders, 4 unread' },
    { label: 'Suppliers', href: 'MailInbox.dc.html', icon: 'folder', current: false },
    { label: 'Invoices 2026', href: 'MailInbox.dc.html', icon: 'folder', current: false },
  ],
  vacationHref: '#vacation',
  vacationShort: 'Off',
  filtersHref: '#filters',
  filtersShort: '3 active',
  savedText: 'Draft saved 14:03 UTC',
  fromOptions: [
    { value: 'info@alice-shop.com', label: 'Alice Shop <info@alice-shop.com>' },
    { value: 'orders@alice-shop.com', label: 'Alice Shop Orders <orders@alice-shop.com>' },
    { value: 'alice@alice-shop.com', label: 'Alice <alice@alice-shop.com>' },
  ],
  fromValue: 'info@alice-shop.com',
  fromAddr: 'info@alice-shop.com',
  chips: [
    { field: 'to', name: 'Layla Haddad', addr: 'layla@nour.dev', invalid: false },
    { field: 'cc', name: 'Karim Mansour', addr: 'karim@alice-shop.com', invalid: false },
    { field: 'bcc', name: '', addr: 'accounts@alice-shop.com', invalid: false },
  ],
  subject: 'Re: Checkout redesign \u2014 staging build ready',
  bodyHtml: FIXTURE_BODY,
  numbersOn: true,
  attachments: [
    { name: 'checkout-phone-annotated.png', ext: 'PNG', state: '1.6 MB', stateColor: '#5D6B7E', uploading: false, pct: '0%', removeLabel: 'Remove checkout-phone-annotated.png' },
    { name: 'copy-changes.txt', ext: 'TXT', state: '4 KB', stateColor: '#5D6B7E', uploading: false, pct: '0%', removeLabel: 'Remove copy-changes.txt' },
    { name: 'shipping-banner.pdf', ext: 'PDF', state: 'Uploading 68% of 290 KB', stateColor: '#1D5BD6', uploading: true, pct: '68%', removeLabel: 'Cancel upload of shipping-banner.pdf' },
  ],
  attachSummary: '3 files, 1.9 MB',
  attachHelp: 'Sent size is about 2.6 MB of the 10 MB limit, because attachments grow by about a third in transit.',
  identityDkim: `Signed for <span style="font-family: ${MONO}">alice-shop.com</span>, selector <span style="font-family: ${MONO}">xp2026</span>`,
  identitySpf: `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; background: #E7F5EE; color: #0E7A4E; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: #0E7A4E"></span>Published</span>`,
  identitySize: '10 MB per message on this server',
  vacationStatus: 'Off',
  vacationOn: false,
  vacationOpenLabel: 'Set up responder',
  filterCount: '3 Sieve rules · run in order',
  filterRules: FIXTURE_RULES,
  wsHtml: '',
  actionHtml: '',
  logoutAttr: '',
  routeAttr: '',
})

const documentShell = (body: string): string => `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>Compose — xMail</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans',sans-serif}
*{box-sizing:border-box}
a{color:#1D5BD6}a:hover{color:#1546A8}
:focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
</style>
</head>
<body>
${body}
</body>
</html>`


export const renderFidelityDocument = (): string => documentShell(renderCompose(fixtureModel()))
export const renderLiveDocument = (locale: Locale = 'en'): string => documentShell(renderCompose(xmailComposeFromProps({ locale, mailbox: 'owner@example.test' })))
