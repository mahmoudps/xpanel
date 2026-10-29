import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/calendar: month, week and day views over the mailbox's stored calendars; settings and sharing stay on /mail/settings/calendars. */
export function renderMailCalendarView(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const disabled = input.canManage ? '' : ' disabled'
  const button = (attribute: string, label: string, primary = false, extra = ''): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-calview-${attribute}${extra}${disabled}>${label}</button>`
  const field = (key: string, label: string, options: string, wide = false): string => `<div class="xp-field${wide ? ' xp-mail-calview__wide' : ''}"><label for="mail-calview-${key}">${label}</label><input id="mail-calview-${key}" class="xp-input" data-calview-field="${key}" autocomplete="off"${options}${disabled}></div>`
  const date = ' maxlength="10" dir="ltr" inputmode="numeric" placeholder="YYYY-MM-DD" spellcheck="false"', time = ' maxlength="8" dir="ltr" inputmode="numeric" placeholder="HH:MM" spellcheck="false"'
  const unsupported = t('Recurrence, attendees and alarms are not supported here; the calendar service refuses them.')
  return `<section class="xp-card xp-mail-calview" data-mail-calendar-view data-calendar-view-mailbox="${escapeHtml(input.mailbox)}" data-calendar-view-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-calview-range">
    <style>
    .xp-mail-calview{display:grid;gap:24px;min-inline-size:0;padding:16px}.xp-mail-calview :is(h2,h3,p,dl,dd,ul){margin:0}.xp-mail-calview [hidden]{display:none}.xp-mail-calview__legend:empty{display:none}
    .xp-mail-calview__group{display:grid;gap:16px;min-inline-size:0}.xp-mail-calview__toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-mail-calview__actions{display:flex;flex-wrap:wrap;gap:16px;min-inline-size:0}
    .xp-mail-calview button{min-block-size:44px;max-inline-size:100%}.xp-mail-calview [aria-pressed="true"]{background:var(--xp-accent-soft);border-color:var(--xp-accent)}
    .xp-mail-calview__legend{display:flex;flex-wrap:wrap;gap:16px;list-style:none;padding:0}.xp-mail-calview__legend li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-inline-size:0;overflow-wrap:anywhere}.xp-mail-calview__swatch{inline-size:12px;block-size:12px;border-radius:3px;background:var(--calview-chip,var(--xp-accent))}
    .xp-mail-calview__body{display:grid;gap:24px;min-inline-size:0}.xp-mail-calview__scroll{overflow:auto;max-block-size:760px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:var(--xp-radius-md,8px)}
    .xp-mail-calview__row{display:grid;grid-template-columns:48px repeat(7,minmax(44px,1fr))}.xp-mail-calview__grid:is([data-mode=week],[data-mode=day]) .xp-mail-calview__row{grid-template-columns:56px repeat(var(--calview-days,7),minmax(96px,1fr))}
    .xp-mail-calview__row:first-child{position:sticky;inset-block-start:0;z-index:2;background:var(--xp-bg-surface)}
    .xp-mail-calview__head,.xp-mail-calview__week{display:flex;flex-direction:column;gap:8px;min-inline-size:0;padding:8px;border-block-end:1px solid var(--xp-border);font-weight:var(--xp-weight-semibold,600);text-align:start;overflow:hidden}.xp-mail-calview__week{color:var(--xp-text-muted);font-size:var(--xp-type-caption,12px);font-weight:inherit}
    .xp-mail-calview__short{display:none}.xp-mail-calview__day{display:flex;flex-direction:column;gap:8px;min-inline-size:0;min-block-size:112px;padding:8px;border-block-start:1px solid var(--xp-border);border-inline-start:1px solid var(--xp-border);cursor:pointer}
    .xp-mail-calview__day[data-outside=true]{background:var(--xp-bg-subtle);color:var(--xp-text-muted)}.xp-mail-calview__day:focus-visible{outline:var(--xp-focus-width,2px) solid var(--xp-border-focus,var(--xp-accent));outline-offset:-2px}
    .xp-mail-calview__date{align-self:flex-start;padding:2px 8px;border-radius:999px;font-variant-numeric:tabular-nums}.xp-mail-calview [aria-current=date] .xp-mail-calview__date{box-shadow:inset 0 0 0 2px var(--xp-accent);font-weight:var(--xp-weight-semibold,600)}
    .xp-mail-calview .xp-mail-calview__chip{display:flex;align-items:center;gap:8px;inline-size:100%;min-block-size:28px;box-sizing:border-box;padding:2px 8px;border:0;border-inline-start:3px solid var(--calview-chip,var(--xp-accent));border-radius:var(--xp-radius-sm,4px);background:var(--xp-bg-subtle);color:var(--xp-text-primary);font:inherit;font-size:var(--xp-type-caption,12px);text-align:start;white-space:nowrap;overflow:hidden;cursor:pointer}.xp-mail-calview__chip>span{overflow:hidden;text-overflow:ellipsis}
    .xp-mail-calview__more{color:var(--xp-text-muted);font-size:var(--xp-type-caption,12px)}.xp-mail-calview__grid:is([data-mode=week],[data-mode=day]) .xp-mail-calview__day{min-block-size:0;padding:0;cursor:default}
    .xp-mail-calview__timeline{position:relative;block-size:1152px;background:repeating-linear-gradient(to bottom,var(--xp-border) 0 1px,transparent 1px 48px)}.xp-mail-calview__timeline .xp-mail-calview__chip{position:absolute;inset-block-start:var(--calview-top);inset-inline-start:var(--calview-start);inline-size:var(--calview-width);block-size:var(--calview-height);min-block-size:20px;align-items:flex-start;white-space:normal}
    .xp-mail-calview__gutter{display:flex;flex-direction:column;color:var(--xp-text-muted);font-size:var(--xp-type-caption,12px)}.xp-mail-calview__gutter>bdi{display:block;block-size:48px;padding-inline:8px;box-sizing:border-box}
    .xp-mail-calview__detail{display:grid;gap:24px;align-content:start;min-inline-size:0;padding:16px;border:1px solid var(--xp-border);border-radius:var(--xp-radius-md,8px)}.xp-mail-calview__detail-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
    .xp-mail-calview__pane{display:grid;gap:24px;min-inline-size:0}.xp-mail-calview__list{display:grid;gap:16px;list-style:none;padding:0}.xp-mail-calview__list .xp-mail-calview__chip{min-block-size:44px;white-space:normal;flex-wrap:wrap}
    .xp-mail-calview__facts{display:grid;gap:16px}.xp-mail-calview__facts>div{display:grid;gap:8px;min-inline-size:0}.xp-mail-calview__facts dd{overflow-wrap:anywhere;text-align:start}.xp-mail-calview__notes{white-space:pre-wrap}
    .xp-mail-calview__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:16px;min-inline-size:0}.xp-mail-calview .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;margin:0}.xp-mail-calview__wide{grid-column:1/-1}
    .xp-mail-calview :is(input:not([type=checkbox]),select,textarea){inline-size:100%;min-inline-size:0;min-block-size:44px;box-sizing:border-box;margin:0}.xp-mail-calview textarea{min-block-size:120px;resize:vertical}.xp-mail-calview__check{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-mail-calview[dir=rtl] input[dir=ltr],.xp-mail-calview[dir=rtl] :is(input,textarea)[dir=auto]{text-align:right}
    @media(min-width:601px){.xp-mail-calview,.xp-mail-calview__detail{padding:24px}}@media(min-width:1100px){.xp-mail-calview__body:has(>[data-calview-detail]:not([hidden])){grid-template-columns:minmax(0,1fr) minmax(280px,360px);align-items:start}}
    @media(max-width:639px){.xp-mail-calview__grid[data-mode=month] .xp-mail-calview__row{grid-template-columns:repeat(7,minmax(40px,1fr))}.xp-mail-calview__grid[data-mode=month] .xp-mail-calview__week{display:none}.xp-mail-calview__long{display:none}.xp-mail-calview__short{display:inline}.xp-mail-calview__day{min-block-size:72px;padding:4px}.xp-mail-calview__actions>*{flex:1 1 auto}}
    </style>
    <div class="xp-mail-calview__group"><h2 id="mail-calview-range" data-calview-range>${t('Calendar view')}</h2><p class="xp-help">${t('Weeks start on Monday (ISO 8601) in every language. Times are shown in your browser timezone')} <bdi dir="ltr" data-calview-zone>${t('not detected')}</bdi>${t('; an event saved in another timezone also shows its own time.')}</p><p data-calview-status data-state="unread" role="status">${input.canManage ? t('Calendar records have not been read.') : t('Calendar records are unavailable here. Nothing was read or changed.')}</p></div>
    <div class="xp-mail-calview__toolbar"><div class="xp-mail-calview__actions" role="group" aria-label="${t('Move through dates')}">${button('nav="prev"', t('Previous'))}${button('nav="today"', t('Today'))}${button('nav="next"', t('Next'))}</div><div class="xp-mail-calview__actions" role="group" aria-label="${t(msgctxt('xmail-calendar-view', 'View'))}">${button('mode="month"', t(msgctxt('xmail-calendar-view', 'Month')), false, ' aria-pressed="true"')}${button('mode="week"', t('Week'), false, ' aria-pressed="false"')}${button('mode="day"', t(msgctxt('xmail-calendar-view', 'Day')), false, ' aria-pressed="false"')}</div><div class="xp-mail-calview__actions">${button('new', t('New event'), true)}${button('refresh', t('Reload calendars'))}</div></div>
    <ul class="xp-mail-calview__legend" data-calview-legend aria-label="${t('Calendars')}"></ul>
    <p class="xp-help" data-calview-unplaced role="note" hidden></p>
    <div class="xp-mail-calview__body">
      <div class="xp-mail-calview__scroll" data-calview-scroll><div class="xp-mail-calview__grid" role="grid" data-calview-grid data-mode="month" aria-labelledby="mail-calview-range"></div></div>
      <aside class="xp-mail-calview__detail" data-calview-detail tabindex="-1" aria-labelledby="mail-calview-detail-heading" hidden>
        <div class="xp-mail-calview__detail-head"><h3 id="mail-calview-detail-heading" data-calview-detail-heading></h3>${button('close', t('Close'))}</div>
        <div class="xp-mail-calview__pane" data-calview-agenda hidden><ul class="xp-mail-calview__list" data-calview-agenda-list></ul><div class="xp-mail-calview__actions">${button('agenda-new', t('New event on this day'), true)}</div></div>
        <div class="xp-mail-calview__pane" data-calview-event hidden><dl class="xp-mail-calview__facts" data-calview-event-facts></dl><p class="xp-help">${unsupported}</p><div class="xp-mail-calview__actions">${button('edit', t('Edit event'), true)}${button('delete', t('Delete event'))}</div></div>
        <div class="xp-mail-calview__pane" data-calview-editor role="group" aria-labelledby="mail-calview-detail-heading" hidden>
          <div class="xp-mail-calview__fields">
            <div class="xp-field xp-mail-calview__wide"><label for="mail-calview-calendar">${t('Calendar')}</label><select id="mail-calview-calendar" class="xp-select" data-calview-field="calendar"${disabled}></select></div>
            ${field('summary', t(msgctxt('xmail-calendar-view', 'Summary')), ' maxlength="300" dir="auto" required', true)}
            <label class="xp-mail-calview__check xp-mail-calview__wide"><input type="checkbox" data-calview-field="all-day"${disabled}>${t('All-day event')}</label>
            ${field('start-date', t('Start date'), date)}${field('start-time', t('Start time'), time)}${field('end-date', t('End date (inclusive)'), date)}${field('end-time', t('End time'), time)}
            ${field('timezone', t('Event timezone (IANA)'), ' maxlength="100" dir="ltr" spellcheck="false"', true)}${field('location', t('Location'), ' maxlength="500" dir="auto"', true)}
            <div class="xp-field xp-mail-calview__wide"><label for="mail-calview-notes">${t('Notes')}</label><textarea id="mail-calview-notes" class="xp-textarea" data-calview-field="notes" maxlength="5000" dir="auto"${disabled}></textarea></div>
          </div>
          <p class="xp-help">${t('Use ASCII digits: dates as YYYY-MM-DD and 24-hour times as HH:MM. Times are ignored for all-day events. Saving checks the calendar version that was read; a newer version is never overwritten.')}</p><p class="xp-help">${unsupported}</p>
          <div class="xp-mail-calview__actions">${button('save', t('Save event'), true)}${button('cancel', t('Cancel'))}</div>
        </div>
      </aside>
    </div>
  </section>`
}
