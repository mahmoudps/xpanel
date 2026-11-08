import { XP_PATHS } from './paths.ts'
import { apacheQuote } from './quote.ts'

/** Root-only log of signed-in requests: time, site, visitor address, status, user, path. Leech protection reads it. */
export const APACHE_AUTH_LOG = `${XP_PATHS.apacheLogDir}/auth.log`

/** Server-level lines of the Apache base file; no vhost has its own CustomLog, so every site inherits them. */
export const renderApacheAuthLog = (): string[] => [
  'LogFormat "%{sec}t\\t%v\\t%a\\t%>s\\t%u\\t%U" xpanel_auth',
  `CustomLog ${apacheQuote(APACHE_AUTH_LOG)} xpanel_auth "expr=-n %{REMOTE_USER}"`,
]
