import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { AuthAlert } from '@/components/auth/auth-alert'
import { PRODUCT_NAME } from '@/components/auth/auth-brand-mark'
import { AuthInput, AuthSubmitButton, FieldError, PasswordInput } from '@/components/auth/auth-fields'
import { AuthHeader, AuthLayout, AuthSwitchLine, rise } from '@/components/auth/auth-layout'
import { useAuthAlert } from '@/hooks/useAuthAlert'
import { useCountdown } from '@/hooks/useCountdown'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { AUTH_NOTICE_KEY } from '@/lib/api-client'
import { login } from '@/lib/auth-client'
import { describeAuthError, formatCountdown, looksLikeEmail } from '@/lib/auth-errors'

interface LocationState {
  /** Where AuthGuard bounced the user from; login returns them there. */
  from?: string
}

type Field = 'email' | 'password'

/** Why the user landed here (if not just "not signed in yet") + the email to prefill. */
function readNotice(): { key: string; email: string } | null {
  try {
    const raw = sessionStorage.getItem(AUTH_NOTICE_KEY)
    const notice = raw ? (JSON.parse(raw) as { reason?: string; email?: string }) : null
    if (notice?.reason !== 'session_revoked') return null
    return { key: 'auth.notices.sessionRevoked', email: notice.email ?? '' }
  } catch {
    return null
  }
}

export default function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  // ?email= prefill: set by the signup page, the reset flow's "continue to
  // sign in", and the links in our auth emails.
  const [notice] = useState(readNotice)
  const prefilledEmail = new URLSearchParams(location.search).get('email') ?? notice?.email ?? ''

  const [email, setEmail] = useState(prefilledEmail)
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const { alert, show, clear } = useAuthAlert()
  const [lockedFor, startLock] = useCountdown()
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // The notice is one-shot; clear it after reading (in an effect, not the
  // state initializer, so StrictMode's double-invoke can't lose it).
  useEffect(() => {
    try {
      sessionStorage.removeItem(AUTH_NOTICE_KEY)
    } catch {
      // storage unavailable — nothing to clear
    }
  }, [])

  const rateLimited = alert?.key === 'auth.errors.rateLimited'
  const visibleAlert = rateLimited && lockedFor === 0 ? null : alert
  const hasError = Object.keys(fieldErrors).length > 0 || visibleAlert?.tone === 'error'
  useDocumentTitle(`${t('auth.signIn')} · ${PRODUCT_NAME}`, hasError ? t('auth.errorTitlePrefix') : null)

  const setField = (field: Field, value: string) => {
    if (field === 'email') setEmail(value)
    else setPassword(value)
    // Clear the error as soon as the user starts fixing it (Baymard).
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const next = { ...prev }
        delete next[field]
        return next
      })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting || lockedFor > 0) return

    const trimmed = email.trim()
    const errors: Partial<Record<Field, string>> = {}
    if (!trimmed) errors.email = 'auth.errors.emailRequired'
    else if (!looksLikeEmail(trimmed)) errors.email = 'auth.errors.invalidEmail'
    if (!password) errors.password = 'auth.errors.passwordRequired'
    setFieldErrors(errors)
    if (errors.email) return emailRef.current?.focus()
    if (errors.password) return passwordRef.current?.focus()

    clear()
    setSubmitting(true)
    try {
      await login(trimmed, password)
      const dest = (location.state as LocationState | null)?.from ?? '/dashboard'
      navigate(dest, { replace: true })
    } catch (err) {
      const info = describeAuthError(err)
      if (info.retryAfter) startLock(info.retryAfter)
      if (info.field === 'email') {
        setFieldErrors({ email: info.key })
        emailRef.current?.focus()
      } else {
        show('error', info.key)
        if (info.code === 'invalid_credentials') {
          // Keep what they typed (never clear fields on error), but select
          // it so retyping the password replaces it in one go.
          passwordRef.current?.focus()
          passwordRef.current?.select()
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  const forgotHref = `/forgot-password${email.trim() ? `?email=${encodeURIComponent(email.trim().toLowerCase())}` : ''}`

  return (
    <AuthLayout>
      <div {...rise(0)}>
        <AuthHeader title={t('auth.signInTitle')} subtitle={t('auth.signInSubtitle')} />
      </div>

      {notice && (
        <div {...rise(1)}>
          <AuthAlert tone="info" className="mb-5">
            {t(notice.key)}
          </AuthAlert>
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="space-y-5">
        <div {...rise(2)}>
          <Label htmlFor="email" className="mb-2 block">
            {t('auth.email')}
          </Label>
          <AuthInput
            ref={emailRef}
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={!prefilledEmail}
            placeholder={t('auth.emailPlaceholder')}
            value={email}
            onChange={(e) => setField('email', e.target.value)}
            aria-invalid={!!fieldErrors.email || undefined}
            aria-describedby={fieldErrors.email ? 'email-error' : undefined}
          />
          <FieldError id="email-error">{fieldErrors.email && t(fieldErrors.email)}</FieldError>
        </div>

        <div {...rise(3)}>
          <Label htmlFor="password" className="mb-2 block">
            {t('auth.password')}
          </Label>
          <PasswordInput
            ref={passwordRef}
            id="password"
            name="password"
            autoComplete="current-password"
            autoFocus={!!prefilledEmail}
            value={password}
            onChange={(e) => setField('password', e.target.value)}
            aria-invalid={!!fieldErrors.password || undefined}
            aria-describedby={fieldErrors.password ? 'password-error' : undefined}
          />
          <FieldError id="password-error">{fieldErrors.password && t(fieldErrors.password)}</FieldError>
          <div className="mt-2 flex justify-end">
            <Link
              to={forgotHref}
              className="rounded-sm text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('auth.forgotPassword')}
            </Link>
          </div>
        </div>

        {visibleAlert && (
          <AuthAlert key={visibleAlert.n} tone={visibleAlert.tone}>
            {t(visibleAlert.key, rateLimited ? { time: formatCountdown(lockedFor) } : visibleAlert.values)}
          </AuthAlert>
        )}

        <div {...rise(4)}>
          <AuthSubmitButton loading={submitting} disabled={lockedFor > 0}>
            {lockedFor > 0
              ? t('auth.tryAgainIn', { time: formatCountdown(lockedFor) })
              : submitting
                ? t('auth.signingIn')
                : t('auth.signIn')}
          </AuthSubmitButton>
        </div>
      </form>

      <div {...rise(5)}>
        <AuthSwitchLine prompt={t('auth.noAccountYet')} to="/signup" action={t('auth.createAccount')} />
      </div>
    </AuthLayout>
  )
}
