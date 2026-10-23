// Board sample data for tests and the local fidelity script only.
// Product code must not import this module.
import type { Locale } from '../i18n.ts'
import { type FolderLink, type MailCard, type InboxModel, renderInbox, block, xmailInboxFromProps } from './xmail-inbox.ts'

const FIXTURE_MESSAGES: MailCard[] = [
  { id: 'm1', fromName: 'xPanel on srv1', fromAddr: 'no-reply@srv1.xpanel.test', to: 'info@alice-shop.com', cc: '', subject: 'Cron job 2 failed: sync-stock.sh exited with status 2', snippet: 'xpanel-cron-alice-2.service exited with status 2 after 12.4 s. Last lines of output follow.', time: '14:00', datetime: '2026-10-22T14:00:12Z', unread: true, auth: 'Sent from this server', local: true, attachments: [], blocks: [block('Job 2 for alice exited with status 2 after 12.4 s, so its output is sent to you.'), block(undefined, 'Unit      xpanel-cron-alice-2.service\nSlice     xpanel-20014.slice\nSchedule  0 * * * *  (at minute 0 of every hour)\nCommand   /home/alice/bin/sync-stock.sh --supplier atlas\nStarted   2026-10-22T14:00:00Z'), block('Last lines of output:'), block(undefined, 'curl: (22) The requested URL returned error: 401\nsync-stock: supplier feed rejected the API key\nsync-stock: 0 of 318 products updated'), block('The next run is at 2026-10-22 15:00 UTC. You can change or pause the job in xPanel under Advanced, Cron jobs.')] },
  { id: 'm2', fromName: 'Layla Haddad', fromAddr: 'layla@nour.dev', to: 'info@alice-shop.com', cc: 'karim@alice-shop.com', subject: 'Checkout redesign — staging build ready', snippet: 'The new checkout is live on staging.alice-shop.com. I attached the test plan and two screenshots.', time: '13:48', datetime: '2026-10-22T13:48:31Z', unread: false, auth: 'DKIM and SPF pass · nour.dev', attachments: [{ name: 'checkout-test-plan.pdf', ext: 'PDF', size: '248 KB' }, { name: 'checkout-desktop.png', ext: 'PNG', size: '1.4 MB' }, { name: 'checkout-phone.png', ext: 'PNG', size: '612 KB' }], attachTotal: '2.3 MB', blocks: [block('Hi Alice,'), block('The new checkout is live on staging.alice-shop.com. It sits behind the Staging preview password you set up, so only the team can open it.'), block(undefined, undefined, ['Address and payment on one page instead of three', 'Shipping cost shown before the payment step', 'Order summary stays visible on phones']), block('I attached the test plan and two screenshots, desktop and phone. Could you and Karim go through the plan by Friday? If it passes, I will switch production on 2026-10-26 at 07:00 UTC, before the morning traffic.'), block('Thanks,\nLayla')] },
  { id: 'm3', fromName: 'Salma Youssef', fromAddr: 'salma.youssef@example.net', to: 'info@alice-shop.com', cc: '', subject: 'Order #10482 arrived in the wrong size', snippet: 'I ordered the linen shirt in M but the parcel has size XL. Photo of the label attached.', time: '11:05', datetime: '2026-10-22T11:05:09Z', unread: true, auth: 'DKIM and SPF pass · example.net', attachments: [{ name: 'IMG_2041.jpg', ext: 'JPG', size: '2.1 MB' }], attachTotal: '2.1 MB', blocks: [block('Hello,'), block('I ordered the linen shirt in size M (order #10482, placed on 2026-10-17), but the parcel has size XL. A photo of the label is attached.'), block('Can I swap it for an M? Should I send it back to the address on the invoice?'), block('Thank you,\nSalma Youssef')] },
  { id: 'm4', fromName: 'Karim Mansour', fromAddr: 'karim@alice-shop.com', to: 'info@alice-shop.com', cc: '', subject: 'Winter collection photos are on the server', snippet: 'I uploaded 64 product photos to public_html/media/winter-2026 over SFTP. Alt text is in the CSV.', time: '10:12', datetime: '2026-10-22T10:12:44Z', unread: true, auth: 'DKIM and SPF pass · alice-shop.com', attachments: [], blocks: [block('I uploaded 64 product photos for the winter collection over SFTP, into /home/alice/public_html/media/winter-2026.'), block('Alt text for every photo is in alt-text.csv in the same folder. The product pages can go live once Layla’s checkout is approved.'), block('Karim')] },
  { id: 'm5', fromName: 'AutoSSL on srv1', fromAddr: 'no-reply@srv1.xpanel.test', to: 'info@alice-shop.com', cc: '', subject: 'Certificate renewed for alice-shop.com and *.alice-shop.com', snippet: 'The wildcard certificate was renewed through ACME DNS-01 and is valid until 2027-01-20.', time: '09:12', datetime: '2026-10-22T09:12:03Z', unread: false, auth: 'Sent from this server', local: true, attachments: [], blocks: [block('AutoSSL renewed the certificate for alice-shop.com before it expired. Nothing needs to be done.'), block(undefined, 'Names     alice-shop.com, *.alice-shop.com\nIssued    2026-10-22T09:10:41Z\nExpires   2027-01-20T09:10:40Z\nChallenge ACME DNS-01 (RFC 8555)'), block('The TXT record for the challenge was added to the alice-shop.com zone and removed after validation. Nginx was reloaded in generation 141 after nginx -t passed.')] },
  { id: 'm6', fromName: 'Mail Delivery System', fromAddr: 'MAILER-DAEMON@srv1.xpanel.test', to: 'info@alice-shop.com', cc: '', subject: 'Undelivered: Your order #10479 has shipped', snippet: 'Your message to h.amin@example.org could not be delivered: 550 5.1.1 recipient address rejected.', time: '2026-10-21', datetime: '2026-10-21T16:20:55Z', unread: false, auth: 'Sent from this server', local: true, attachments: [], blocks: [block('Your message could not be delivered to one recipient. The receiving server gave this reason:'), block(undefined, '<h.amin@example.org>: host mx.example.org[192.0.2.40] said:\n550 5.1.1 <h.amin@example.org>: Recipient address rejected:\nUser unknown in virtual mailbox table'), block('Check the address with the customer, then send the message again.')] },
  { id: 'm7', fromName: 'Shop team', fromAddr: 'team@alice-shop.com', to: 'info@alice-shop.com', cc: '', subject: 'Weekly stock report: 3 items below reorder level', snippet: 'Linen shirt M, canvas tote natural and gift box small are below their reorder level.', time: '2026-10-20', datetime: '2026-10-20T07:00:00Z', unread: false, auth: 'DKIM and SPF pass · alice-shop.com', attachments: [{ name: 'stock-2026-w43.csv', ext: 'CSV', size: '18 KB' }], attachTotal: '18 KB', blocks: [block('Three items are below their reorder level this week:'), block(undefined, undefined, ['Linen shirt, size M: 4 left, reorder level 10', 'Canvas tote, natural: 7 left, reorder level 15', 'Gift box, small: 22 left, reorder level 50']), block('The full report is attached as CSV.')] },
  { id: 'm8', fromName: 'Rana Khalil', fromAddr: 'rana@example.com', to: 'info@alice-shop.com', cc: '', subject: 'Wholesale enquiry for 40 canvas totes', snippet: 'We run a small bookshop and would like 40 natural canvas totes with our logo printed on one side.', time: '2026-10-19', datetime: '2026-10-19T15:41:27Z', unread: false, auth: 'DKIM and SPF pass · example.com', remoteImages: true, attachments: [], blocks: [block('Hello Alice Shop,'), block('We run a small bookshop and would like 40 natural canvas totes with our logo printed on one side. Do you offer wholesale prices, and how long would printing take?'), block('Best regards,\nRana Khalil')] },
  { id: 'm9', fromName: 'Layla Haddad', fromAddr: 'layla@nour.dev', to: 'info@alice-shop.com', cc: '', subject: 'Staging login for the checkout preview', snippet: 'I set up staging.alice-shop.com behind directory privacy. I will share the password by phone.', time: '2026-10-18', datetime: '2026-10-18T12:03:15Z', unread: false, auth: 'DKIM and SPF pass · nour.dev', attachments: [], blocks: [block('Hi Alice,'), block('Staging is now behind directory privacy, with the prompt “Staging preview”. The usernames are designer and client-review. I will share the passwords by phone rather than by email.'), block('Layla')] },
  { id: 'm10', fromName: 'Karim Mansour', fromAddr: 'karim@alice-shop.com', to: 'info@alice-shop.com', cc: '', subject: 'Holiday opening hours for the shop page', snippet: 'Here are the opening hours for December. Could you add them to the contact page?', time: '2026-10-17', datetime: '2026-10-17T09:27:50Z', unread: false, auth: 'DKIM and SPF pass · alice-shop.com', attachments: [{ name: 'opening-hours-december.docx', ext: 'DOCX', size: '22 KB' }], attachTotal: '22 KB', blocks: [block('Here are the opening hours for December, attached as a document. Could you add them to the contact page before 2026-11-30?'), block('Karim')] },
]

const fixtureFolders = (): FolderLink[] => [
  { id: 'inbox', label: 'Inbox', href: 'MailInbox.dc.html', icon: 'inbox', current: true, count: { text: '12', kind: 'pill' }, aria: 'Inbox, 12 unread' },
  { id: 'sent', label: 'Sent', href: 'MailInbox.dc.html', icon: 'sent', current: false },
  { id: 'drafts', label: 'Drafts', href: 'MailCompose.dc.html', icon: 'drafts', current: false, count: { text: '2', kind: 'muted' }, aria: 'Drafts, 2 messages' },
  { id: 'junk', label: 'Junk', href: 'MailInbox.dc.html', icon: 'junk', current: false, count: { text: '3', kind: 'strong' }, aria: 'Junk, 3 unread' },
  { id: 'trash', label: 'Trash', href: 'MailInbox.dc.html', icon: 'trash', current: false },
  { id: 'archive', label: 'Archive', href: 'MailInbox.dc.html', icon: 'archive', current: false },
]

const fixtureCustom = (): FolderLink[] => [
  { id: 'orders', label: 'Orders', href: 'MailInbox.dc.html', icon: 'folder', current: false, count: { text: '4', kind: 'strong' }, aria: 'Orders, 4 unread' },
  { id: 'suppliers', label: 'Suppliers', href: 'MailInbox.dc.html', icon: 'folder', current: false },
  { id: 'invoices', label: 'Invoices 2026', href: 'MailInbox.dc.html', icon: 'folder', current: false },
]

const fixtureModel = (): InboxModel => ({
  locale: 'en',
  product: false,
  mailbox: 'info@alice-shop.com',
  quotaText: '1.2 / 5 GB',
  quotaPct: 24,
  quotaMeasured: true,
  listState: 'messages',
  title: 'Inbox',
  countText: '412 messages · 12 unread',
  pager: '1\u201310 of 412',
  loaded: 10,
  total: 412,
  composeHref: 'MailCompose.dc.html',
  inboxHref: 'MailInbox.dc.html',
  folders: fixtureFolders(),
  custom: fixtureCustom(),
  vacationHref: 'MailCompose.dc.html#vacation',
  vacation: 'Off',
  filtersHref: 'MailCompose.dc.html#filters',
  filters: '3 active',
  messages: FIXTURE_MESSAGES,
  selectedId: 'm2',
  folderEmpty: false,
  wsHtml: '',
  actionHtml: '',
  logoutAttr: '',
  moveTargets: ['Archive', 'Orders', 'Suppliers', 'Invoices 2026', 'Junk'],
  copy: {
    emptyTitle: 'No messages match',
    emptyBody: 'Nothing in Inbox fits this filter or search.',
    emptyClear: 'Show all messages',
    undo: 'Undo',
    moved: 'Moved to ',
    moveLabel: 'Move to folder',
  },
})


const documentShell = (body: string): string => `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>Inbox — xMail</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif}
*{box-sizing:border-box}
a{color:#1D5BD6}a:hover{color:#1546A8}
:focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
</style>
</head>
<body>
${body}
</body>
</html>`

export const renderFidelityDocument = (): string => documentShell(renderInbox(fixtureModel()))

export const renderLiveDocument = (locale: Locale = 'en'): string => documentShell(renderInbox(xmailInboxFromProps({ locale, mailbox: 'owner@example.test' })))
