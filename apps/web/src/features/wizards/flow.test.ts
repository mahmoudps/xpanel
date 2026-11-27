import { describe, expect, it } from 'vitest'
import { renderGuidedWizard, renderStepLinkList, renderWizardStepCounter } from './flow.ts'

describe('guided wizard helper', () => {
  it('renders single active step, preflight badge, change diff, and custom finish label', () => {
    const html = renderGuidedWizard({
      id: 'sample-wizard',
      activeStepIndex: 0,
      submitLabel: 'Apply now',
      preflightState: { tone: 'ok', message: 'Ready' },
      changePlan: [{ label: 'Plan', before: 'Basic', after: 'Pro' }],
      steps: [
        { id: 'one', label: 'First', bodyHtml: '<p>Step one</p>' },
        { id: 'two', label: 'Second', bodyHtml: '<p>Step two</p>' },
      ],
    })
    expect(html).toContain('data-ds-wizard')
    expect(html).toContain('data-ds-wizard-step="one" data-ds-wizard-panel-state="active">')
    expect(html).toContain('data-ds-wizard-step="two" data-ds-wizard-panel-state="inactive">')
    const collapsed = renderGuidedWizard({
      id: 'collapsed-wizard',
      activeStepIndex: 0,
      disabled: true,
      revealAllPanels: false,
      steps: [
        { id: 'one', label: 'First', bodyHtml: '<p>Step one</p>' },
        { id: 'two', label: 'Second', bodyHtml: '<p>Step two</p>' },
      ],
    })
    expect(collapsed).toContain('data-ds-wizard-step="two" hidden>')
    expect(collapsed).toContain('data-ds-wizard-next disabled>')
    expect(html).toContain('data-ds-wizard-preflight')
    expect(html).toContain('data-ds-wizard-diff')
    expect(html).toContain('data-ds-wizard-custom-submit="true">Apply now</button>')
    expect(renderWizardStepCounter(1, 3)).toContain('Step 1 of 3')
    expect(renderStepLinkList([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], 1)).toContain('data-step-state="done"')
  })
})
