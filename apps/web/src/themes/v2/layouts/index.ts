// v2 page layouts: one pure function per template family, from a theme-owned input type to an HTML string,
// composed from the component kit. Slots core fills are typed inputs or `<template data-xp-template>` elements.

import { COMMON_LAYOUT_CSS } from './common.ts'
import { DASHBOARD_LAYOUT_CSS } from './dashboard-page.ts'
import { EDITOR_LAYOUT_CSS } from './editor-page.ts'
import { LOG_LAYOUT_CSS } from './log-page.ts'
import { MATRIX_LAYOUT_CSS } from './matrix-page.ts'
import { WIZARD_LAYOUT_CSS } from './wizard-page.ts'

export { factList, kpiStrip, revisionSaveBar, xpTemplate, type Fact, type KpiStripProps, type LayoutState, type PageBaseProps, type RevisionSaveProps, type StateSlots } from './common.ts'
export { customPage, sectionGrid, type CustomPageProps, type GridSection } from './custom-page.ts'
export { dashboardPage, meterCard, statusItem, statusItemTemplate, statusList, type ChartCard, type MeterCard, type DashboardPageProps, type StatusItem, type StatusList } from './dashboard-page.ts'
export { codeDiff, codeEditor, editorPage, type CodeDiffProps, type DiffLine, type EditorPageProps, type EditorSnippet } from './editor-page.ts'
export { listPage, type ListFooter, type ListPageProps, type ListState } from './list-page.ts'
export { logEntryTemplate, logPage, type LogPageProps, type LogQuery } from './log-page.ts'
export { matrixPage, matrixTable, type MatrixChannel, type MatrixEvent, type MatrixGroup, type MatrixPageProps, type MatrixSwitch } from './matrix-page.ts'
export { settingsPage, settingsSection, type SettingsCommit, type SettingsField, type SettingsPageProps, type SettingsSection } from './settings-page.ts'
export { wizardPage, type WizardPageProps, type WizardStep } from './wizard-page.ts'

export const LAYOUTS_CSS = [COMMON_LAYOUT_CSS, DASHBOARD_LAYOUT_CSS, WIZARD_LAYOUT_CSS, LOG_LAYOUT_CSS, EDITOR_LAYOUT_CSS, MATRIX_LAYOUT_CSS].map(source => source.trim()).join('\n')
