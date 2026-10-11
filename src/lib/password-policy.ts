/**
 * Client-side mirror of `backend/internal/auth/password_policy.go`.
 *
 * Rules are duplicated here (not fetched from the server) so the signup
 * form can render a live requirements checklist as the user types
 * WITHOUT a network round-trip per keystroke. The server always
 * re-validates on submit — this file is UX, not a security boundary.
 *
 * Any change to the server rules MUST be mirrored here or the checklist
 * will lie to the user ("all green!" while the server 400s on submit).
 */

export const MIN_PASSWORD_LENGTH = 12

// Exact-match common-password blocklist. Kept in sync with
// commonPasswords in password_policy.go.
const COMMON_PASSWORDS = new Set<string>([
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'qwerty12',
  'qwerty123',
  'qwerty1234',
  'qwertyui',
  'asdfghjkl',
  'letmein12',
  'letmein123',
  'welcome12',
  'welcome123',
  'admin1234',
  'admin12345',
  'administrator',
  'changeme',
  'changeme12',
  'changeme123',
  'iloveyou1',
  'iloveyou12',
  'trustno1234',
  'monkey1234',
  'sunshine1',
  'princess1',
  'dragon1234',
  'master1234',
  'football1',
  'baseball1',
  'superman1',
  'batman1234',
  'pokemon12',
  'starwars1',
  'minecraft',
  'iloveyou123',
])

// Substring blocklist (case-insensitive). Catches "MyPassword123!" and
// similar variants that beat the exact-match filter.
const SUBSTRING_BLOCKLIST = [
  'password',
  'qwerty',
  'letmein',
  'welcome',
  '12345678',
  'iloveyou',
  'admin123',
] as const

export interface PasswordRuleStatus {
  id: 'length' | 'diversity' | 'notCommon'
  met: boolean
}

/** How many of {lowercase, uppercase, digit, symbol} the string contains. */
export function characterClassCount(pw: string): number {
  let hasLower = false
  let hasUpper = false
  let hasDigit = false
  let hasSymbol = false
  for (const c of pw) {
    if (c >= 'a' && c <= 'z') hasLower = true
    else if (c >= 'A' && c <= 'Z') hasUpper = true
    else if (c >= '0' && c <= '9') hasDigit = true
    // Everything else — punctuation, symbols, whitespace — counts as
    // "symbol". Matches the Go implementation which treats
    // unicode.IsPunct/IsSymbol + space as the fourth class.
    else hasSymbol = true
  }
  let n = 0
  for (const flag of [hasLower, hasUpper, hasDigit, hasSymbol]) {
    if (flag) n++
  }
  return n
}

/** Returns true when the password is on the common-password blocklist. */
export function isCommonPassword(pw: string): boolean {
  const lower = pw.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) return true
  for (const needle of SUBSTRING_BLOCKLIST) {
    if (lower.includes(needle)) return true
  }
  return false
}

/**
 * Evaluate `pw` against every rule and return one status entry per rule.
 * Order is the order the checklist renders in — length first because
 * it's the fastest signal for "keep typing".
 */
export function evaluatePassword(pw: string): PasswordRuleStatus[] {
  return [
    { id: 'length', met: pw.length >= MIN_PASSWORD_LENGTH },
    { id: 'diversity', met: characterClassCount(pw) >= 3 },
    // "Not common" is only meaningful once length is satisfied — an
    // empty string is trivially "not on the blocklist" but showing it
    // as met would mislead. Gate on length so the tick only appears
    // when the answer means something.
    {
      id: 'notCommon',
      met: pw.length >= MIN_PASSWORD_LENGTH && !isCommonPassword(pw),
    },
  ]
}

/** True when EVERY rule passes. Used for enabling the submit button. */
export function isPasswordAcceptable(pw: string): boolean {
  return evaluatePassword(pw).every((r) => r.met)
}
