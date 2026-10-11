import { useCallback, useState } from 'react'

export type AuthAlertTone = 'error' | 'info' | 'success'

export interface AuthAlertState {
  tone: AuthAlertTone
  /** i18n key; resolved at render so a language switch re-translates it. */
  key: string
  values?: Record<string, string | number>
  /** Bumped per show — use as the <AuthAlert> React key so a repeated
   *  message replays its entry animation and is announced again. */
  n: number
}

/** Form-level message state for the auth screens. */
export function useAuthAlert() {
  const [alert, setAlert] = useState<AuthAlertState | null>(null)
  const show = useCallback(
    (tone: AuthAlertTone, key: string, values?: Record<string, string | number>) =>
      setAlert((prev) => ({ tone, key, values, n: (prev?.n ?? 0) + 1 })),
    [],
  )
  const clear = useCallback(() => setAlert(null), [])
  return { alert, show, clear }
}
