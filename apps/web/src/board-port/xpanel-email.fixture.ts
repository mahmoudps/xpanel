import { readFileSync } from 'node:fs'

/** Resolved English artboard. Sample values stay in this fixture and never in the product module. */
const art = readFileSync(new URL('./xpanel-email.art.html', import.meta.url), 'utf8')

export const renderFidelityDocument = (): string => `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>Email &amp; users — xPanel</title>
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
${art}
</body>
</html>`
