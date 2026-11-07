/**
 * Entropy estimate in bits capped at 100: length times log2 of the character classes used; a repeat of the previous
 * character adds nothing. Self-contained: the identity client serializes it for the browser meter.
 */
export function passwordStrength(password: string): number {
  const pools: [RegExp, number][] = [[/[a-z]/, 26], [/[A-Z]/, 26], [/[0-9]/, 10], [/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/, 33], [/[^\x00-\x7f]/, 100]]
  const chars = [...password], pool = pools.reduce((sum, [pattern, size]) => sum + (pattern.test(password) ? size : 0), 0)
  const length = chars.filter((char, index) => index === 0 || char !== chars[index - 1]).length
  return pool ? Math.min(100, Math.floor(length * Math.log2(pool))) : 0
}
