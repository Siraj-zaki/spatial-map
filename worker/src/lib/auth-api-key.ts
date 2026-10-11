/**
 * Constant-time X-Api-Key validation against env.API_KEY.
 *
 * `crypto.subtle.verify` is overkill for a static shared secret; a manual
 * byte loop avoids the early-exit timing leak of a string `===` compare.
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export function checkApiKey(request: Request, env: { API_KEY?: string }): boolean {
  const presented = request.headers.get('X-Api-Key') ?? ''
  const expected = env.API_KEY ?? ''
  if (!presented || !expected) return false
  return constantTimeEqual(presented, expected)
}
