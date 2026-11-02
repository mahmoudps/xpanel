import { expect, it } from 'vitest'

// These tiny cases prove collection/selection/reporting, never product acceptance.
it('unfiltered selector fixture', () => { expect(2 + 2).toBe(4) })
it.each([1, 2])('expanded slow selector fixture %i', { tags: ['slow'] }, (value) => { expect(value).toBeGreaterThan(0) })
it('excluded visual selector fixture', { tags: ['slow', 'visual'] }, () => { expect('selector').toContain('select') })
