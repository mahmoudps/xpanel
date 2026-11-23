import { describe, expect, it } from 'vitest'
import { translator } from '../../i18n.ts'
import {
  buildCronExpression,
  describeCronSchedule,
  renderActionMenu,
  renderAppShell,
  renderButton,
  renderCard,
  renderCodeInput,
  renderCombobox,
  renderConfirmDialog,
  renderCronBuilder,
  renderDataTable,
  renderDrawer,
  renderEmptyState,
  renderErrorState,
  renderField,
  renderInput,
  renderKeyValue,
  renderLiveReadState,
  renderMetric,
  renderPageHeader,
  renderPagination,
  renderRadioCardGroup,
  renderSection,
  renderSelect,
  renderSkeleton,
  renderSparkline,
  renderSplitButton,
  renderStatStrip,
  renderStatusBadge,
  renderSwitch,
  renderTabs,
  renderToastRegion,
  renderWizard,
} from './index.ts'

describe('design-system 31 unified components', () => {
  it('renders all layout, data, action, and input primitives without style=, hex colors, or Not read', () => {
    const tableRows = Array.from({ length: 30 }, (_, idx) => ({
      id: `row-${idx + 1}`,
      cells: { name: `acct-${idx + 1}`, usage: '1.00 GiB' },
      actionsHtml: renderActionMenu({
        id: `row-menu-${idx + 1}`,
        items: [{ id: 'open', label: 'Open', href: `/whm/accounts/${idx + 1}` }],
      }),
    }))

    const tableHtml = renderDataTable({
      id: 'accounts-table',
      caption: 'Accounts',
      columns: [{ key: 'name', label: 'Account', sortable: true }, { key: 'usage', label: 'Usage' }],
      rows: tableRows,
      selectable: true,
      selectedCount: 0,
      bulkActionsHtml: renderButton({ label: 'Suspend', variant: 'danger' }),
      filterToolbarHtml: renderInput({ id: 'tbl-filter', name: 'q', type: 'search' }),
    })

    // Enforces <= 25 visible rows per page (retaining rows 26-30 hidden for pagination) and hidden contextual bulk bar at 0 selection
    expect(tableHtml.match(/data-ds-row="/g)?.length).toBe(30)
    expect(tableHtml.match(/data-ds-page-hidden="true"/g)?.length).toBe(5)
    expect(tableHtml).toContain('data-ds-bulk-bar hidden')
    expect(tableHtml).toContain('data-ds-select-all')

    const fragments = [
      renderAppShell({
        surface: 'xpanel',
        locale: 'ar',
        brandHtml: '<span>xPanel</span>',
        navGroups: [{ id: 'g1', title: 'الرئيسية', items: [{ id: 'home', label: 'الرئيسية', href: '/home', current: true }] }],
        topbarHtml: renderSplitButton({
          id: 'quick-cta',
          primaryLabel: 'إضافة موقع',
          primaryAction: 'open-site',
          menuLabel: 'المزيد',
          menuItems: [{ id: 'mail', label: 'بريد جديد', href: '/email/accounts' }],
        }),
        contentHtml: renderSection({
          id: 'sec-1',
          title: 'المواقع',
          bodyHtml: [
            renderPageHeader({
              title: 'المواقع',
              locale: 'ar',
              breadcrumbs: [{ label: 'الرئيسية', href: '/home' }, { label: 'المواقع' }],
              status: { label: 'نشط', tone: 'ok' },
              description: 'إدارة المواقع والنطاقات',
              primaryActionHtml: renderButton({ label: 'إضافة موقع', variant: 'primary' }),
            }),
            renderStatStrip({
              items: [
                { label: 'الذاكرة', value: '1.27 GiB', technical: true, sparklineHtml: renderSparkline({ values: [10, 20, 15, 25], label: 'Memory trend' }) },
              ],
            }),
            renderMetric({ label: 'المعالج', value: '0.12' }),
            renderCard({
              title: 'تفاصيل',
              bodyHtml: renderKeyValue({ items: [{ label: 'الخادم', value: 'xpanel.edgion.app', technical: true }] }),
              footerHtml: renderStatusBadge({ label: 'سليم', tone: 'ok' }),
            }),
            renderTabs({
              id: 'sample-tabs',
              ariaLabel: 'الأقسام',
              items: [
                { id: 't1', label: 'الأول', active: true, panelHtml: tableHtml },
                { id: 't2', label: 'الثاني', panelHtml: renderEmptyState({ locale: 'ar', message: 'لا توجد عناصر بعد' }) },
              ],
            }),
            renderLiveReadState({ status: 'loading', locale: 'ar' }),
            renderLiveReadState({ status: 'error', locale: 'ar', refreshAction: 'retry-read', errorMessage: 'تعذر الاتصال' }),
            renderLiveReadState({ status: 'disabled', locale: 'ar', enableHref: '/whm/services', errorMessage: 'الخدمة متوقفة' }),
            renderLiveReadState({ status: 'ready', locale: 'ar', lastReadAt: '2026-11-23T10:30:00Z', refreshAction: 'refresh-now', contentHtml: '<p class="ds-prose">OK</p>' }),
            renderErrorState({ title: 'خطأ', message: 'أعد المحاولة', retryAction: 'retry' }),
            renderSkeleton({ variant: 'line', count: 2 }),
            renderPagination({ id: 'pg', page: 1, totalPages: 3, totalItems: 75, locale: 'ar' }),
            renderField({
              id: 'domain-input',
              label: 'النطاق',
              availability: { tone: 'ok', message: 'متاح' },
              controlHtml: renderCombobox({ id: 'domain-input', name: 'domain', options: [{ value: 'example.com', label: 'example.com' }] }),
            }),
            renderSelect({ id: 'php-ver', name: 'php', options: [{ value: '8.4', label: 'PHP 8.4' }], value: '8.4' }),
            renderSwitch({ id: 'tls-sw', name: 'tls', label: 'فرض HTTPS', checked: true }),
            renderRadioCardGroup({ name: 'plan', ariaLabel: 'Plan', value: 'basic', options: [{ id: 'p1', value: 'basic', title: 'Basic' }] }),
            renderCodeInput({ id: 'zone-raw', name: 'zone', value: '@ IN A 192.0.2.1' }),
            renderCronBuilder({ id: 'bk-cron', namePrefix: 'cron', locale: 'ar', state: { frequency: 'daily', hour: 2, minute: 0 } }),
            renderWizard({
              id: 'acc-wiz',
              activeStepIndex: 1,
              steps: [
                { id: 's1', label: 'الهوية', bodyHtml: '<p>Step 1</p>' },
                { id: 's2', label: 'الخطة', bodyHtml: '<p>Step 2</p>' },
              ],
              preflightState: { tone: 'ok', message: 'جاهز للإنشاء' },
              changePlan: [{ label: 'الحصة', before: '0', after: '10.00 GiB' }],
              progressSteps: [{ id: 'p1', label: 'حجز الهوية', state: 'done' }],
              receiptHtml: '<p>Done</p>',
            }),
          ].join(''),
        }),
        overlaysHtml: [
          renderConfirmDialog({ id: 'dlg-confirm', title: 'تأكيد', message: 'متأكد؟', destructive: true }),
          renderDrawer({ id: 'drw-edit', title: 'تعديل', bodyHtml: '<p>Form</p>' }),
          renderToastRegion([{ id: 't-1', title: 'تم', undoAction: 'undo-action', tone: 'ok' }]),
        ].join(''),
      }),
    ].join('\n')

    expect(fragments).not.toContain('style=')
    expect(fragments).not.toMatch(/#[0-9a-fA-F]{6}/)
    expect(fragments).not.toContain('Not read')
    expect(fragments).not.toContain('Not observed')
    expect(fragments).toContain('<bdi dir="ltr">xpanel.edgion.app</bdi>')
    expect(fragments).toContain('data-surface="xpanel"')
    expect(fragments).toContain('ds-wizard-diff')
    expect(fragments).toContain('ds-wizard-preflight')
    expect(fragments).toContain('data-action="undo-action"')
  })

  it('builds cron expressions and plain-language schedules cleanly without surfacing raw syntax primarily', () => {
    const ar = translator('ar')
    const daily = { frequency: 'daily' as const, hour: 2, minute: 0 }
    expect(buildCronExpression(daily)).toBe('0 2 * * *')
    expect(describeCronSchedule(daily, 'en')).toBe('Every day at 02:00')
    expect(describeCronSchedule(daily, 'ar', ar)).toBe('يومياً عند الساعة 02:00')

    const weekly = { frequency: 'weekly' as const, hour: 3, minute: 30, dayOfWeek: 0 }
    expect(buildCronExpression(weekly)).toBe('30 3 * * 0')
    expect(describeCronSchedule(weekly, 'ar', ar)).toContain('الأحد')

    const html = renderCronBuilder({ id: 'b-cron', namePrefix: 'backup', state: daily, locale: 'en' })
    expect(html).toContain('Every day at 02:00')
    expect(html).toContain('data-ds-cron-expression')
    expect(html).toContain('data-cron-field="dow" hidden')
    expect(html).toContain('data-cron-field="dom" hidden')
    expect(html).toContain('data-cron-field="custom" hidden')
    expect(html).toContain('<details class="ds-caption"><summary>Technical cron expression</summary>')
    expect(html).not.toMatch(/id="b-cron-custom"[^>]*\brequired\b/)

    const emptyCustomCron = renderCronBuilder({
      id: 'c-custom',
      namePrefix: 'bk',
      state: { frequency: 'custom', hour: 2, minute: 0, customExpression: '' },
      locale: 'en',
    })
    expect(emptyCustomCron).toMatch(/id="c-custom-custom"[^>]*\brequired\b/)
    expect(emptyCustomCron).not.toMatch(/id="c-custom-custom"[^>]*\bdisabled\b/)
    expect(emptyCustomCron).toContain('name="bk[expression]" value="" data-ds-cron-expression')
    expect(emptyCustomCron).toContain('Custom schedule (—)')

    const disabledLink = renderButton({ label: 'Next', href: '/next', disabled: true })
    expect(disabledLink).not.toContain('href=')
    expect(disabledLink).toContain('role="link" aria-disabled="true" tabindex="-1"')

    const sw = renderSwitch({ id: 'sw1', name: 'tls', label: 'HTTPS', checked: true })
    expect(sw).not.toContain('aria-checked=')

    const menuHtml = renderActionMenu({
      id: 'm1',
      items: [
        { id: 'view', label: 'View', href: '/view' },
        { id: 'del', label: 'Delete', href: '/delete', disabled: true },
      ],
    })
    expect(menuHtml).toContain('data-ds-menu-item="view" href="/view"')
    expect(menuHtml).toContain('data-ds-menu-item="del" aria-disabled="true" tabindex="-1"')
    expect(menuHtml).not.toContain('href="/delete"')

    const splitHtml = renderSplitButton({
      id: 'sb1',
      primaryLabel: 'Run',
      menuLabel: 'More actions',
      disabled: true,
      menuItems: [
        { id: 'sub', label: 'Inspect', href: '/inspect', disabled: true },
      ],
    })
    expect(splitHtml).toContain('aria-label="More actions" disabled>')
    expect(splitHtml).toContain('aria-disabled="true" tabindex="-1"')
    expect(splitHtml).not.toContain('href="/inspect"')

    const comboHtml = renderCombobox({
      id: 'cb1',
      name: 'domain',
      options: [{ value: 'example.com', label: 'example.com' }],
    })
    expect(comboHtml).toContain('id="cb1-opt-0"')

    const shellHtml = renderAppShell({
      surface: 'xpanel',
      brandHtml: '<span>xPanel</span>',
      navGroups: [{ id: 'g1', title: 'Main', items: [{ id: 'home', label: 'Home', href: '/home', current: true }] }],
      topbarHtml: '',
      contentHtml: '',
      collapsed: true,
    })
    expect(shellHtml).toContain('data-action="toggle-sidebar-collapse"')
    expect(shellHtml).toContain('aria-expanded="false"')

    const pagedTable = renderDataTable({
      id: 'tbl2',
      caption: 'Accounts',
      columns: [{ key: 'name', label: 'Name' }],
      rows: Array.from({ length: 30 }, (_, i) => ({ id: `r-${i + 1}`, cells: { name: `row-${i + 1}` } })),
      page: 2,
      pageSize: 25,
      selectable: true,
    })
    expect(pagedTable).toContain('<tr data-ds-row="r-25" hidden data-ds-page-hidden="true">')
    expect(pagedTable).toContain('<tr data-ds-row="r-26">')
    expect(pagedTable).toContain('data-ds-col="name"')
    expect(pagedTable).toContain('<span data-ds-page-current>2</span>')
    expect(pagedTable).toContain('data-ds-selected-count')

    const linkedPager = renderPagination({
      id: 'pg-links',
      page: 1,
      totalPages: 3,
      pageHref: page => `?page=${page}`,
    })
    expect(linkedPager).toContain('data-ds-page-prev data-ds-page="1" role="link" aria-disabled="true" tabindex="-1"')
    expect(linkedPager).not.toContain('href="?page=1"')
    expect(linkedPager).toContain('href="?page=2" data-ds-page-next data-ds-page="2"')

    const initialWizard = renderWizard({
      id: 'wiz-start',
      activeStepIndex: 0,
      steps: [
        { id: 's1', label: 'One', bodyHtml: '<p>One</p>' },
        { id: 's2', label: 'Two', bodyHtml: '<p>Two</p>' },
      ],
    })
    expect(initialWizard).toContain('data-ds-wizard-next>')
    expect(initialWizard).toContain('data-ds-wizard-submit hidden disabled>')

    const steppedWizard = renderWizard({
      id: 'wiz2',
      activeStepIndex: 1,
      steps: [
        { id: 's1', label: 'One', bodyHtml: '<p>One</p>' },
        { id: 's2', label: 'Two', bodyHtml: '<p>Two</p>' },
      ],
    })
    expect(steppedWizard).toContain('data-ds-wizard-step="s1" hidden')
    expect(steppedWizard).toContain('data-ds-wizard-step="s2">')
    expect(steppedWizard).toContain('data-ds-wizard-next hidden disabled>')
    expect(steppedWizard).toContain('data-ds-wizard-submit>')

    const openDlg = renderConfirmDialog({ id: 'dlg-open', title: 'Confirm', message: 'Proceed?', open: true })
    expect(openDlg).toContain('data-ds-dialog-open="true"')
    expect(openDlg).not.toContain(' open>')

    const openDrawer = renderDrawer({ id: 'drw-open', title: 'Edit', bodyHtml: '<p>Body</p>', open: true })
    expect(openDrawer).toContain('<dialog class="ds-drawer" id="drw-open" aria-modal="true"')
    expect(openDrawer).toContain('data-ds-drawer-open="true"')
    expect(openDrawer).not.toContain(' open>')
    expect(openDrawer).not.toContain('ds-backdrop')

    const sortTable = renderDataTable({
      id: 'sort-tbl',
      caption: 'Counts',
      selectable: true,
      columns: [{ key: 'count', label: 'Count', sortable: true }],
      rows: [{ id: 'n1', cells: { count: '1,000' }, sortValues: { count: 1000 } }],
    })
    expect(sortTable).toContain('<label class="ds-table__check"><input type="checkbox" data-ds-select-all')
    expect(sortTable).toContain('<label class="ds-table__check"><input type="checkbox" data-ds-row-select="n1"')
    expect(sortTable).toContain('data-ds-col="count" data-ds-sort-value="1000">1,000</td>')

    const disabledCombo = renderCombobox({
      id: 'cb-dis',
      name: 'zone',
      disabled: true,
      options: [{ value: 'a.test', label: 'a.test' }],
    })
    expect(disabledCombo).toContain('data-ds-combobox-hidden disabled>')
    expect(disabledCombo).toContain('id="cb-dis" role="combobox"')
    expect(disabledCombo).toMatch(/id="cb-dis"[^>]*\bdisabled>/)
  })
})
