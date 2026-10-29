// The v2 HTML document frame. Core supplies the <html> attributes (lang, dir, data-theme, data-surface,
// data-realtime-enabled, ...), its head assets and the body; v2 adds its stylesheet and data-ui-theme="v2".

import { brandingHeadStyle, brandingRootAttributes } from '../../branding.ts'
import type { DocumentProps } from '../contract.ts'
import { v2FontsHref, v2Stylesheet } from './assets.ts'
import { escapeHtml } from './html.ts'

export type V2DocumentProps = DocumentProps

/** Core owns document identity, admission and status attributes; preserve their escaped order exactly. */
export const renderV2Document = (props: V2DocumentProps): string => `<!doctype html>
<html ${props.htmlAttributes}${brandingRootAttributes(props.branding)}${props.htmlAttributeSuffix}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(props.title)}</title>
<link rel="icon"${props.faviconContentType ? ` type="${escapeHtml(props.faviconContentType)}"` : ''} href="${escapeHtml(props.faviconHref)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${escapeHtml(v2FontsHref)}">
<link rel="stylesheet" href="${escapeHtml(v2Stylesheet.href)}">
${brandingHeadStyle(props.branding)}
${props.headHtml}
</head>
<body>${props.bodyHtml}</body>
</html>`
