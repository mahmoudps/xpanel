import { loadThemeMessages } from '../../theme-messages.ts'

/** Own copy is isolated from core and other themes; common product copy still uses core's catalog. */
export const v2Messages = loadThemeMessages('v2', new URL('./locales/', import.meta.url))
