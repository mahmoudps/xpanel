import { expect, it } from 'vitest'

// Deliberate .only lives outside normal test discovery and must fail in the child.
it.only('focused modifier is forbidden in explicit lanes', () => { expect(true).toBe(true) })
