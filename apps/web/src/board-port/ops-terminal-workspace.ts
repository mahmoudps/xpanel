import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Shared by the root (/whm/server/terminal) and account (/advanced/terminal) terminals; the client binding drives both. */
const TERMINAL_CSS = `<style>
.xp-term-page{display:flex;flex-direction:column;gap:var(--xp-space-group,24px)}.xp-term{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-term :is(h2,p,dl,dd,ul){margin:0}.xp-term [hidden]{display:none!important}
.xp-term__pills{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.xp-term__pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--xp-bg-subtle);color:var(--xp-text-secondary)}
.xp-term__pill::before{content:"";inline-size:6px;block-size:6px;border-radius:50%;background:currentColor}
.xp-term__pill[data-tone="ok"]{background:var(--xp-status-ok-bg);color:var(--xp-status-ok-fg)}.xp-term__pill[data-tone="warn"]{background:var(--xp-status-warn-bg);color:var(--xp-status-warn-fg)}.xp-term__pill[data-tone="info"]{background:var(--xp-accent-soft);color:var(--xp-accent)}
.xp-term__grid{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}.xp-term__main{flex:1.618 1 0;min-inline-size:min(100%,420px);display:flex;flex-direction:column;gap:24px}.xp-term__aside{flex:1 1 0;min-inline-size:min(100%,300px);display:flex;flex-direction:column;gap:24px}
.xp-term__card{display:flex;flex-direction:column;gap:24px;padding:24px;border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface);border:1px solid var(--xp-border)}.xp-term__card h2{font-size:16px;font-weight:600}.xp-term__card p{font-size:13px;line-height:1.6;color:var(--xp-text-secondary)}
.xp-term__session{display:flex;flex-direction:column;border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface);border:1px solid var(--xp-border);overflow:hidden}
.xp-term__head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 24px}.xp-term__head h2{font-size:16px;font-weight:600}.xp-term__head p{font-size:13px;line-height:1.6;color:var(--xp-text-secondary);max-inline-size:72ch}
.xp-term__note{display:flex;gap:10px;padding:12px 14px;border-radius:10px;border:1px solid var(--xp-border);background:var(--xp-bg-subtle);font-size:13px;line-height:1.6}
.xp-term__note[data-state="opening"],.xp-term__note[data-state="connecting"]{border-color:var(--xp-accent-border);background:var(--xp-accent-soft)}.xp-term__note[data-state="open"]{border-color:var(--xp-status-ok-border);background:var(--xp-status-ok-bg)}
.xp-term__note:is([data-state="empty"],[data-state="wrong"],[data-state="locked"],[data-state="failed"],[data-state="code"],[data-state="busy"]){border-color:var(--xp-status-critical-border);background:var(--xp-status-critical-bg)}
.xp-term__banner{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:10px;border:1px solid var(--xp-status-warn-border);background:var(--xp-status-warn-bg);font-size:13px;line-height:1.6}.xp-term__banner strong{font-size:14px;font-weight:600}.xp-term__session .xp-term__banner{margin:0 24px 24px}
.xp-term__form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px}.xp-term__field{flex:0 1 360px;min-inline-size:0;display:flex;flex-direction:column;gap:8px}.xp-term__field label{font-size:13px;font-weight:600}
.xp-term__field input{min-block-size:44px;padding:0 12px;font-family:var(--xp-font-mono);font-size:14px}
.xp-term__screen{block-size:clamp(280px,50vh,560px);padding:12px 16px;background:#0E1726;color:#E6EDF7;font-family:var(--xp-font-mono);font-size:13px;overflow:hidden;box-sizing:border-box}.xp-term__screen .xterm{block-size:100%}
.xp-term__screen:focus-visible{outline:2px solid var(--xp-accent);outline-offset:-2px}
.xp-term__bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px;padding:16px 24px;border-block-start:1px solid var(--xp-border);background:var(--xp-bg-subtle)}.xp-term__bar .xp-term__field{flex:1 1 320px}.xp-term__command{flex:1 1 420px}
.xp-term__empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px 24px;border-radius:var(--xp-radius-lg,12px);border:1px dashed var(--xp-border-strong);text-align:center}.xp-term__empty h2{font-size:16px;font-weight:600}.xp-term__empty p{font-size:13px;color:var(--xp-text-muted);max-inline-size:420px;line-height:1.6}
.xp-term__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:16px;font-size:14px;line-height:1.4}.xp-term__facts div{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-inline-size:0;text-align:start}.xp-term__facts dt{color:var(--xp-text-secondary)}.xp-term__facts dd{font-weight:600;overflow-wrap:anywhere}
.xp-term__ids{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px;padding:0 24px 24px}.xp-term__ids div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-term__ids dt{font-size:12px;font-weight:600;color:var(--xp-text-secondary)}.xp-term__ids dd{font-size:13px}
.xp-term__pad{padding:0 24px 24px}
.xp-term__list{list-style:none;padding:0;display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.6}
.xp-term__mono{font-family:var(--xp-font-mono);font-size:12.5px}
</style>`

type Text = (message: string, values?: MessageValues) => string

// A real form only when the page can open a shell; otherwise the same hooks on a div with disabled controls.
const sessionBar = (t: Text, placeholder: string, withOpen: boolean, live: boolean): string => `<div class="xp-term__bar">
        <${live ? 'form' : 'div'} class="xp-term__form xp-term__command" data-terminal-command-form>
          <div class="xp-term__field"><label for="terminal-command">${t('Command')}</label>
          <input id="terminal-command" class="xp-input" data-terminal-command dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" disabled></div>
          <button type="${live ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-terminal-run disabled>${t('Run command')}</button>
        </${live ? 'form' : 'div'}>
        ${withOpen ? `<button type="button" class="xp-btn xp-btn--primary" data-terminal-open disabled>${t('Open terminal session')}</button>` : ''}
        <button type="button" class="xp-btn" data-terminal-close hidden>${t('Close session')}</button>
      </div>`

// The vendored emulator mounts here when a session opens; it brings its own focusable input and screen reader support.
const screen = (t: Text): string => `<div class="xp-term__screen" dir="ltr" role="region" aria-label="${t('Terminal output')}" data-terminal-screen></div>`

const unavailableBanner = (t: Text): string => `<div class="xp-term__banner" role="status" data-terminal-unavailable hidden>
        <strong>${t('Command execution unavailable')}</strong>
        <span>${t('This server has no verified terminal helper, so no command can be run from this page.')} <span class="xp-term__mono" dir="ltr" data-terminal-reason></span></span>
      </div>`

/** Root server terminal for /whm/server/terminal. A session needs fresh re-authentication; execution is read from the host. */
export function renderOpsTerminalWorkspace(input: { locale: Locale; canUse: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  return `<div class="xp-term" data-terminal-workspace data-terminal-kind="root" data-terminal-can-use="${input.canUse}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    ${TERMINAL_CSS}
    <div class="xp-term__pills">
      <span class="xp-term__pill" data-terminal-pill>${input.canUse ? t('No session') : t('Unavailable')}</span>
      <span class="xp-term__pill" data-terminal-exec-pill>${t('Not read')}</span>
    </div>
    <div class="xp-term__grid">
      <div class="xp-term__main">
        <section class="xp-term__card" aria-labelledby="terminal-root-heading">
          <div style="display:flex;flex-direction:column;gap:4px">
            <h2 id="terminal-root-heading">${t('Root terminal')}</h2>
            <p>${t('Opening a root terminal session requires re-entering your password, and every session is recorded in the audit log.')}</p>
          </div>
          <div class="xp-term__note" data-terminal-status data-state="${input.canUse ? 'closed' : 'unavailable'}" role="status">${input.canUse ? t('No terminal session is open.') : t('The server terminal requires an authorized root administrator in an interactive session. Nothing was opened.')}</div>
          ${input.canUse
            ? `<form class="xp-term__form" data-terminal-reauth aria-label="${t('Re-authenticate to open a session')}">
            <div class="xp-term__field"><label for="terminal-password">${t('Confirm your password')}</label>
            <input id="terminal-password" class="xp-input" data-terminal-password type="password" autocomplete="current-password" dir="ltr"></div>
            <div class="xp-term__field" data-terminal-totp-field hidden><label for="terminal-totp">${t('Two-factor code')}</label>
            <input id="terminal-totp" class="xp-input" data-terminal-totp inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" dir="ltr"></div>
            <button type="submit" class="xp-btn xp-btn--primary" data-terminal-open disabled>${t('Open terminal session')}</button>
          </form>`
            // Unavailable: the approved layout stays visible as disabled controls, never a submittable form.
            : `<div class="xp-term__form">
            <div class="xp-term__field"><label for="terminal-password">${t('Confirm your password')}</label>
            <input id="terminal-password" class="xp-input" type="password" dir="ltr" disabled></div>
            <button type="button" class="xp-btn xp-btn--primary" disabled>${t('Open terminal session')}</button>
          </div>`}
        </section>
        <section class="xp-term__session" aria-labelledby="terminal-session-heading" data-terminal-session hidden>
          <div class="xp-term__head">
            <div style="display:flex;flex-direction:column;gap:4px;min-inline-size:0">
              <h2 id="terminal-session-heading">${t('Session')}</h2>
              <p>${t('Recorded in the audit log as {action}. Commands and output are not recorded.', { action: 'server.terminal.session_opened' })}</p>
            </div>
            <span class="xp-term__pill" data-tone="ok">${t('Open · root')}</span>
          </div>
          ${screen(t)}
          ${sessionBar(t, 'uptime', false, input.canUse)}
        </section>
        <section class="xp-term__empty" aria-labelledby="terminal-empty-heading" data-terminal-empty>
          <h2 id="terminal-empty-heading">${t('Session')}</h2>
          <p>${input.canUse ? t('The terminal appears here after you re-authenticate.') : t('Nothing was opened.')}</p>
        </section>
      </div>
      <aside class="xp-term__aside">
        <section class="xp-term__card" aria-labelledby="terminal-how-heading" style="gap:16px">
          <h2 id="terminal-how-heading">${t('How it works')}</h2>
          ${unavailableBanner(t)}
          <dl class="xp-term__facts">
            <div><dt>${t('Re-authentication')}</dt><dd>${t('Required')}</dd></div>
            <div><dt>${t('Two-factor code')}</dt><dd data-terminal-fact="second-factor">${t('Not read')}</dd></div>
            <div><dt>${t('Audit')}</dt><dd>${t('Enabled')}</dd></div>
            <div><dt>${t('Command execution')}</dt><dd data-terminal-fact="execution">${t('Not read')}</dd></div>
            <div><dt>${t('Idle timeout')}</dt><dd data-terminal-fact="idle">${t('Not read')}</dd></div>
            <div><dt>${t('Session limit')}</dt><dd data-terminal-fact="absolute">${t('Not read')}</dd></div>
          </dl>
          <ul class="xp-term__list">
            <li>${t('Only root, in the signed-in interactive session. API tokens cannot open a terminal.')}</li>
            <li>${t('Failed passwords count toward the sign-in lockout and are recorded in the audit log.')}</li>
            <li>${t('If the session cannot be audited, it is not opened.')}</li>
            <li>${t('One session at a time. It closes when idle, at its time limit, or when you close it.')}</li>
          </ul>
        </section>
      </aside>
    </div>
  </div>`
}

/** Account owner terminal for /advanced/terminal: the account's jailed shell, as its own user, in its own slice. */
export function renderAccountTerminalWorkspace(input: { locale: Locale; account: { username: string; uid: number; home: string }; shellEnabled: boolean; canUse: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const slice = `xpanel-${input.account.uid}.slice`, live = input.canUse && input.shellEnabled
  return `<div class="xp-term" data-terminal-workspace data-terminal-kind="account" data-terminal-can-use="${live}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    ${TERMINAL_CSS}
    ${unavailableBanner(t)}
    <section class="xp-term__session" aria-labelledby="terminal-account-heading" data-terminal-session>
      <div class="xp-term__head">
        <div style="display:flex;flex-direction:column;gap:4px;min-inline-size:0">
          <h2 id="terminal-account-heading">${t('Terminal session')}</h2>
          <p>${t('Running as UID {uid} inside systemd cgroup v2 unit {slice} with private /tmp and only your home directory visible.', { uid: input.account.uid, slice })}</p>
        </div>
        <span class="xp-term__pill" data-tone="${input.shellEnabled ? 'ok' : 'warn'}">${input.shellEnabled ? escapeHtml(t('Jailed ({slice})', { slice })) : t('Shell access disabled')}</span>
      </div>
      <dl class="xp-term__ids">
        <div><dt>${t('Account')}</dt><dd class="xp-term__mono"><bdi dir="ltr">${escapeHtml(input.account.username)}</bdi></dd></div>
        <div><dt>${t('Home')}</dt><dd class="xp-term__mono"><bdi dir="ltr">${escapeHtml(input.account.home)}</bdi></dd></div>
        <div><dt>${t('Shell')}</dt><dd>${input.shellEnabled ? t('Jailed, from your plan') : t('Disabled on your plan')}</dd></div>
      </dl>
      <div class="xp-term__pad">
        <div class="xp-term__note" data-terminal-status data-state="${live ? 'closed' : 'unavailable'}" role="status">${live ? t('No terminal session has started.') : input.shellEnabled ? t('The account terminal is unavailable here. Nothing was opened.') : t('Terminal access is disabled on your current plan.')}</div>
      </div>
      ${screen(t)}
      ${sessionBar(t, 'php -v', true, live)}
    </section>
  </div>`
}

/** The whole /advanced/terminal section of the account surface: page title and workspace, styled by page-scoped classes. */
export function renderAccountTerminalPage(input: Parameters<typeof renderAccountTerminalWorkspace>[0] & { title: string }): string {
  return `<section class="xp-card xp-term-page" id="xpanel-terminal" data-section="jailed-shell-terminal" aria-labelledby="xpanel-terminal-heading">
    <h1 id="xpanel-terminal-heading" class="xp-page-title">${escapeHtml(input.title)}</h1>
    ${renderAccountTerminalWorkspace(input)}
  </section>`
}
