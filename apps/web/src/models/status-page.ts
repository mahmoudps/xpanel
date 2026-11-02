import { translator, type Locale } from '../i18n.ts'

export type StatusCode = 400 | 403 | 404 | 421 | 500 | 503

export interface StatusPageCopy {
  title: string
  explanation: string
}

const STATUS_COPY: Readonly<Record<StatusCode, StatusPageCopy>> = {
  400: { title: msgid('Check the request details'), explanation: msgid('The request contains an invalid value. Correct the filters or date range and try again.') },
  404: { title: msgid('This page is not here'), explanation: msgid('That address does not match a page on this panel.') },
  403: { title: msgid('You cannot open this page'), explanation: msgid('This panel is for a different role, or this account cannot view the page.') },
  421: { title: msgid('Check the panel address'), explanation: msgid('This address does not belong to this panel. Check the address and try again.') },
  500: { title: msgid('Something went wrong'), explanation: msgid('The panel could not finish loading this page. Try again in a moment.') },
  503: { title: msgid('The panel is briefly unavailable'), explanation: msgid('Try again in a moment. Nothing was changed.') },
}

export const statusPageCopy = (status: StatusCode, locale: Locale): StatusPageCopy => {
  const t = translator(locale), copy = STATUS_COPY[status]
  return { title: t(copy.title), explanation: t(copy.explanation) }
}
