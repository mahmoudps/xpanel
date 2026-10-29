import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'

/** Root server terminal for /whm/server/terminal. A session requires fresh re-authentication; execution is read from the host. */
export function renderOpsTerminalWorkspace(input: { locale: Locale; canUse: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  return `<div class="xp-ops-terminal" data-ops-terminal-workspace data-terminal-can-use="${input.canUse}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-ops-terminal{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-ops-terminal :is(h2,p){margin:0}.xp-ops-terminal__reauth{display:flex;flex-direction:column;gap:16px;max-inline-size:360px}.xp-ops-terminal__screen{margin:0;min-block-size:200px;padding:16px;border-radius:8px;background:var(--xp-bg-elevated,#0b1020);color:var(--xp-terminal-fg,#e6edf3);white-space:pre-wrap;overflow:auto;font-size:13px;line-height:1.6}.xp-ops-terminal :is(button,input):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="terminal-session" aria-labelledby="ops-terminal-session">
      <h2 id="ops-terminal-session">${t('Root terminal')}</h2>
      <p class="xp-help">${t('Opening a root terminal session requires re-entering your password, and every session is recorded in the audit log.')}</p>
      <p class="xp-whm-detail-status" data-ops-terminal-status data-state="${input.canUse ? 'closed' : 'unavailable'}" role="status">${input.canUse ? t('No terminal session is open.') : t('The server terminal requires an authorized root administrator in an interactive session. Nothing was opened.')}</p>
      ${input.canUse
        ? `<form class="xp-ops-terminal__reauth" data-ops-terminal-reauth>
        <div class="xp-field"><label for="ops-terminal-password">${t('Confirm your password')}</label>
        <input id="ops-terminal-password" class="xp-input" data-ops-terminal-password type="password" autocomplete="current-password" dir="ltr"></div>
        <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-ops-terminal-open>${t('Open terminal session')}</button></div>
      </form>`
        // Unavailable: the approved layout stays visible as disabled controls, never a submittable form.
        : `<div class="xp-ops-terminal__reauth" data-ops-terminal-reauth-unavailable>
        <div class="xp-field"><label for="ops-terminal-password">${t('Confirm your password')}</label>
        <input id="ops-terminal-password" class="xp-input" type="password" dir="ltr" disabled></div>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" disabled>${t('Open terminal session')}</button></div>
      </div>`}
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="terminal-screen" data-ops-terminal-screen-card aria-labelledby="ops-terminal-screen" hidden>
      <h2 id="ops-terminal-screen">${t('Session')}</h2>
      <pre class="xp-ops-terminal__screen" dir="ltr" tabindex="0" data-ops-terminal-screen role="log" aria-label="${t('Terminal output')}"></pre>
      <div class="xp-reconcile-banner" role="status" data-ops-terminal-execution="unavailable">
        <p class="xp-prose" data-ops-terminal-execution-note>${t('No qualified command-execution path exists on this server, so no command can be run from this page and no output is fabricated.')}</p>
      </div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ops-terminal-close>${t('Close session')}</button></div>
    </section>
  </div>`
}
