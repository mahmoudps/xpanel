import { translator, type Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

/**
 * Server branding as every theme receives it. Core turns it into data only: CSS custom properties
 * (`--xp-brand-primary`, `--xp-brand-accent`, `--xp-brand-logo`), `data-brand-*` flags on <html>,
 * the favicon link and a semantic footer. Each theme decides how its own tokens and marks use them.
 */
export interface WebBranding {
  companyName: string
  productName: string
  footerText: string
  hidePoweredBy: boolean
  primaryColor: string
  accentColor: string
  supportUrl: string
  supportEmail: string
  logoUrl: string | null
  faviconUrl: string | null
}

const COLOR = /^#[0-9a-f]{6}$/
const ASSET = /^\/branding\/(?:logo|favicon)\?v=[0-9a-f]{16}$/

/** Root attributes; an empty string when nothing is branded keeps unbranded output byte-identical. */
export const brandingRootAttributes = (branding?: WebBranding): string => !branding ? ''
  : `${branding.logoUrl && ASSET.test(branding.logoUrl) ? ' data-brand-logo' : ''}${COLOR.test(branding.primaryColor) || COLOR.test(branding.accentColor) ? ' data-brand-colors' : ''}`

export function brandingHeadStyle(branding?: WebBranding): string {
  if (!branding) return ''
  const vars = [
    COLOR.test(branding.primaryColor) ? `--xp-brand-primary:${branding.primaryColor}` : '',
    COLOR.test(branding.accentColor) ? `--xp-brand-accent:${branding.accentColor}` : '',
    branding.logoUrl && ASSET.test(branding.logoUrl) ? `--xp-brand-logo:url("${branding.logoUrl}")` : '',
  ].filter(Boolean)
  return vars.length ? `<style id="xpanel-branding">:root{${vars.join(';')}}</style>` : ''
}

export const brandingFaviconHref = (branding: WebBranding | undefined, fallback: string): string =>
  branding?.faviconUrl && ASSET.test(branding.faviconUrl) ? branding.faviconUrl : fallback

/** The product name replaces the built-in panel name in the document title. */
export const brandingProductName = (branding: WebBranding | undefined, fallback: string): string => branding?.productName || fallback

export function renderBrandingFooter(branding: WebBranding | undefined, locale: Locale): string {
  if (!branding) return ''
  const t = translator(locale)
  const parts = [
    branding.footerText ? `<span data-brand-footer-text>${escapeHtml(branding.footerText)}</span>` : '',
    branding.supportUrl ? `<a data-brand-support-url href="${escapeHtml(branding.supportUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtml(t('Help'))}</a>` : '',
    branding.supportEmail ? `<a data-brand-support-email href="mailto:${escapeHtml(branding.supportEmail)}"><bdi dir="ltr">${escapeHtml(branding.supportEmail)}</bdi></a>` : '',
    branding.hidePoweredBy ? '' : `<span data-brand-powered-by>${escapeHtml(t('Powered by {product}', { product: 'xPanel' }))}</span>`,
  ].filter(Boolean)
  return parts.length ? `<footer data-brand-footer role="contentinfo"${branding.companyName ? ` aria-label="${escapeHtml(branding.companyName)}"` : ''}>${parts.join('')}</footer>` : ''
}
