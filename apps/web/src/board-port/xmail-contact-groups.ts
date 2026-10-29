import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Mailbox-owned group definitions and membership; every operation is controller-bound. */
export function renderMailContactGroups(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const field = (id: string, label: string, content: string): string => `<div class="xp-field"><label for="${id}">${label}</label>${content}</div>`
  const select = (id: string, hook: string, multiple = false): string => `<select id="${id}" class="xp-select" ${hook}${multiple ? ' multiple size="6"' : ''} disabled></select>`
  return `<section class="xp-card xp-contact-groups" data-mail-contact-groups data-groups-mailbox="${escapeHtml(input.mailbox)}" data-groups-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-contact-groups-heading">
    <style>.xp-contact-groups{display:grid;gap:24px;min-inline-size:0;padding:16px}.xp-contact-groups :is(h2,h3,p,dl,dd){margin:0}.xp-contact-groups__group{display:grid;gap:24px;min-inline-size:0}.xp-contact-groups__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;min-inline-size:0}.xp-contact-groups .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;margin:0}.xp-contact-groups :is(input,select){inline-size:100%;min-inline-size:0;min-block-size:44px;box-sizing:border-box}.xp-contact-groups select[multiple]{min-block-size:160px}.xp-contact-groups__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-contact-groups button{min-block-size:44px}.xp-contact-groups__capacity{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.xp-contact-groups__capacity dt{text-box-trim:trim-end;text-box-edge:text}.xp-contact-groups__capacity dd{text-box-trim:trim-start;text-box-edge:text}.xp-contact-groups__capacity>div{display:grid;gap:8px;min-inline-size:0}.xp-contact-groups[dir=rtl] .xp-field :is(input,select){text-align:right}.xp-contact-groups[dir=rtl] [dir=ltr]{text-align:right}.xp-contact-groups [data-groups-status]{overflow-wrap:anywhere}@media(min-width:601px){.xp-contact-groups{padding:24px}}@media(max-width:640px){.xp-contact-groups__fields,.xp-contact-groups__capacity{grid-template-columns:minmax(0,1fr)}}
    </style>
    <h2 id="mail-contact-groups-heading">${t('Groups and membership')}</h2>
    <p>${t('Manage groups for contacts owned by this mailbox. Shared contacts stay read-only. These changes do not send mail or synchronize CardDAV.')}</p>
    <p data-groups-metadata-review>${t('Older mailbox metadata may require verified ownership review before it can be shown. Records are preserved.')}</p>
    <dl class="xp-contact-groups__capacity"><div><dt>${t('Owned contacts')}</dt><dd data-groups-contact-capacity>${t(msgctxt('xmail-contact-groups', 'Not read'))}</dd></div><div><dt>${t('Groups')}</dt><dd data-groups-capacity>${t(msgctxt('xmail-contact-groups', 'Not read'))}</dd></div><div><dt>${t('Groups per contact')}</dt><dd data-groups-membership-capacity>${t(msgctxt('xmail-contact-groups', 'Not read'))}</dd></div></dl>
    <div class="xp-contact-groups__actions"><button type="button" class="xp-btn" data-groups-reload disabled>${t('Read groups and contacts')}</button><button type="button" class="xp-btn" data-groups-new disabled>${t('New group')}</button></div>
    <p data-groups-status data-state="unread" role="status" aria-live="polite">${t('Groups and capacity have not been read.')}</p>
    <section class="xp-contact-groups__group" aria-labelledby="contact-group-editor-heading"><h3 id="contact-group-editor-heading">${t('Group editor')}</h3>
      <div class="xp-contact-groups__fields">${field('contact-group-selection', t('Saved group'), select('contact-group-selection', 'data-groups-select'))}${field('contact-group-name', t('Group name'), '<input id="contact-group-name" class="xp-input" data-groups-name dir="auto" maxlength="128" disabled>')}</div>
      ${field('contact-group-members', t('Group members'), select('contact-group-members', 'data-groups-members', true))}
      <p class="xp-help">${t('Select the owned contacts that belong to this group. Saving applies this exact membership.')}</p>
      <div class="xp-contact-groups__actions"><button type="button" class="xp-btn xp-btn--primary" data-groups-save disabled>${t('Save group')}</button><button type="button" class="xp-btn" data-groups-delete disabled>${t('Delete group')}</button></div>
    </section>
    <section class="xp-contact-groups__group" aria-labelledby="contact-membership-heading"><h3 id="contact-membership-heading">${t('Contact membership')}</h3>
      <div class="xp-contact-groups__fields">${field('contact-membership-contact', t('Owned contact'), select('contact-membership-contact', 'data-groups-contact'))}${field('contact-membership-groups', t('Assigned groups'), select('contact-membership-groups', 'data-groups-membership', true))}</div>
      <div class="xp-contact-groups__actions"><button type="button" class="xp-btn xp-btn--primary" data-groups-membership-save disabled>${t('Save contact membership')}</button></div>
    </section>
  </section>`
}
