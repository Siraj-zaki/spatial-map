/**
 * Forgot password: email → emailed code → new password → done.
 *
 * Follows the OWASP Forgot Password cheat sheet (see the backend's
 * authPasswordReset* handlers): step 1 answers identically whether or not
 * the account exists, so every screen after it is worded "if an account
 * exists…"; the reset signs out every session; and the user is NOT signed
 * in automatically — the done screen hands off to /login with the email
 * prefilled.
 */

import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { AuthAlert } from '@/components/auth/auth-alert'
import { productName } from '@/lib/site'
import { AuthInput, AuthSubmitButton, FieldError, PasswordInput } from '@/components/auth/auth-fields'
import { AuthHeader, AuthLayout, rise } from '@/components/auth/auth-layout'
import { AuthOtpStep, OTP_LENGTH } from '@/components/auth/auth-otp-step'
import { StepProgress, StepTransition, SuccessCheck } from '@/components/auth/auth-steps'
import { PasswordRequirements } from '@/components/password-requirements'
import { useAuthAlert } from '@/hooks/useAuthAlert'
import { useCountdown } from '@/hooks/useCountdown'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { completePasswordReset, requestPasswordReset, verifyPasswordReset } from '@/lib/auth-client'
import { describeAuthError, formatCountdown, looksLikeEmail } from '@/lib/auth-errors'
import { isPasswordAcceptable } from '@/lib/password-policy'

type Step = 'email' | 'otp' | 'password' | 'done'
const STEPS: Step[] = ['email', 'otp', 'password', 'done']
const RESEND_COOLDOWN_SECONDS = 60

type PasswordField = 'password' | 'confirm'

function readInitialStep(params: URLSearchParams): Step {
  // Same rule as signup: only the code step survives a refresh — the reset
  // token lives in memory only.
  return params.get('step') === 'otp' && params.get('email') ? 'otp' : 'email'
}

export default function ForgotPasswordPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()

  const [step, setStep] = useState<Step>(() => readInitialStep(searchParams))
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '')
  const [code, setCode] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [pwErrors, setPwErrors] = useState<Partial<Record<PasswordField, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [resending, setResending] = useState(false)
  const { alert, show, clear } = useAuthAlert()
  const [lockedFor, startLock] = useCountdown()
  const [resendIn, startResend] = useCountdown()
  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (step === 'otp' || step === 'password') next.set('step', 'otp')
    else next.delete('step')
    const normalized = email.trim().toLowerCase()
    if (normalized) next.set('email', normalized)
    else next.delete('email')
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }, [step, email, searchParams, setSearchParams])

  const rateLimited = alert?.key === 'auth.errors.rateLimited'
  const visibleAlert = rateLimited && lockedFor === 0 ? null : alert
  const hasError =
    !!(emailError || codeError || Object.keys(pwErrors).length > 0) || visibleAlert?.tone === 'error'
  useDocumentTitle(`${t('auth.resetTitle')} · ${productName()}`, hasError ? t('auth.errorTitlePrefix') : null)

  const goTo = (next: Step) => {
    clear()
    setEmailError(null)
    setCodeError(null)
    setPwErrors({})
    setStep(next)
  }

  const handleError = (err: unknown) => {
    const info = describeAuthError(err)
    if (info.retryAfter) startLock(info.retryAfter)
    return info
  }

  // ---- Step 1 ----
  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting || lockedFor > 0) return
    const trimmed = email.trim()
    if (!trimmed || !looksLikeEmail(trimmed)) {
      setEmailError(trimmed ? 'auth.errors.invalidEmail' : 'auth.errors.emailRequired')
      emailRef.current?.focus()
      return
    }
    clear()
    setSubmitting(true)
    try {
      const res = await requestPasswordReset(trimmed.toLowerCase())
      setEmail(res.email)
      setCode('')
      startResend(RESEND_COOLDOWN_SECONDS)
      goTo('otp')
    } catch (err) {
      const info = handleError(err)
      if (info.field === 'email') {
        setEmailError(info.key)
        emailRef.current?.focus()
      } else {
        show('error', info.key)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleResend = async () => {
    if (resendIn > 0 || resending) return
    clear()
    setCodeError(null)
    setResending(true)
    try {
      await requestPasswordReset(email)
      setCode('')
      startResend(RESEND_COOLDOWN_SECONDS)
      show('success', 'auth.otpResent')
      codeRef.current?.focus()
    } catch (err) {
      const info = describeAuthError(err)
      if (info.retryAfter) {
        startResend(info.retryAfter)
        show('error', 'auth.errors.resendLimited')
      } else {
        show('error', info.key)
      }
    } finally {
      setResending(false)
    }
  }

  // ---- Step 2 ----
  const handleVerify = async (value: string) => {
    if (submitting || lockedFor > 0) return
    if (value.length < OTP_LENGTH) {
      setCodeError('auth.errors.codeIncomplete')
      codeRef.current?.focus()
      return
    }
    clear()
    setCodeError(null)
    setSubmitting(true)
    try {
      const res = await verifyPasswordReset(email, value)
      setResetToken(res.resetToken)
      goTo('password')
    } catch (err) {
      const info = handleError(err)
      if (info.field === 'code') {
        setCodeError(info.key)
        setCode('')
        window.setTimeout(() => codeRef.current?.focus(), 0)
      } else {
        show('error', info.key)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ---- Step 3 ----
  const clearPwError = (field: PasswordField) => {
    if (!pwErrors[field]) return
    setPwErrors((prev) => {
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting || lockedFor > 0) return
    const errors: Partial<Record<PasswordField, string>> = {}
    if (!isPasswordAcceptable(password)) {
      errors.password = password ? 'auth.passwordRequirementsNotMet' : 'auth.errors.passwordRequired'
    } else if (password !== confirm) {
      errors.confirm = 'auth.passwordsDontMatch'
    }
    setPwErrors(errors)
    if (errors.password) return passwordRef.current?.focus()
    if (errors.confirm) return confirmRef.current?.focus()

    clear()
    setSubmitting(true)
    try {
      await completePasswordReset({ email, password, resetToken })
      setResetToken('')
      setPassword('')
      setConfirm('')
      goTo('done')
    } catch (err) {
      const info = handleError(err)
      if (info.code === 'verification_expired') {
        setResetToken('')
        setPassword('')
        setConfirm('')
        setCode('')
        goTo('email')
        show('info', 'auth.resetExpired')
      } else if (info.field === 'password') {
        setPwErrors({ password: info.key })
        passwordRef.current?.focus()
      } else {
        show('error', info.key)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const alertNode = visibleAlert && (
    <AuthAlert key={visibleAlert.n} tone={visibleAlert.tone}>
      {t(visibleAlert.key, rateLimited ? { time: formatCountdown(lockedFor) } : visibleAlert.values)}
    </AuthAlert>
  )

  const submitLabel = (idle: string, busy: string) =>
    lockedFor > 0 ? t('auth.tryAgainIn', { time: formatCountdown(lockedFor) }) : submitting ? busy : idle

  const stepIndex = STEPS.indexOf(step)
  const loginHref = `/login${email.trim() ? `?email=${encodeURIComponent(email.trim().toLowerCase())}` : ''}`

  return (
    <AuthLayout>
      {step !== 'done' && (
        <div {...rise(0)}>
          <StepProgress
            labels={[t('auth.steps.email'), t('auth.steps.verify'), t('auth.steps.newPassword')]}
            current={stepIndex}
          />
        </div>
      )}

      <StepTransition step={step} index={stepIndex}>
        {step === 'email' && (
          <>
            <AuthHeader icon={<KeyRound />} title={t('auth.resetTitle')} subtitle={t('auth.resetSubtitle')} />
            <form noValidate onSubmit={handleRequest} className="space-y-5">
              <div>
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
                  autoFocus
                  placeholder={t('auth.emailPlaceholder')}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (emailError) setEmailError(null)
                  }}
                  aria-invalid={!!emailError || undefined}
                  aria-describedby={emailError ? 'email-error' : undefined}
                />
                <FieldError id="email-error">{emailError && t(emailError)}</FieldError>
              </div>

              {alertNode}

              <AuthSubmitButton loading={submitting} disabled={lockedFor > 0}>
                {submitLabel(t('auth.sendResetCode'), t('auth.sendingCode'))}
              </AuthSubmitButton>
            </form>
          </>
        )}

        {step === 'otp' && (
          <AuthOtpStep
            title={t('auth.checkEmailTitle')}
            subtitleKey="auth.resetCodeSentRich"
            email={email}
            code={code}
            onCodeChange={(v) => {
              setCode(v)
              if (codeError) setCodeError(null)
            }}
            onSubmit={handleVerify}
            submitting={submitting}
            submitLabel={submitLabel(t('auth.continue'), t('auth.verifying'))}
            codeError={codeError && t(codeError)}
            alert={alertNode}
            locked={lockedFor > 0}
            resendIn={resendIn}
            resending={resending}
            onResend={handleResend}
            onChangeEmail={() => {
              setCode('')
              goTo('email')
            }}
            inputRef={codeRef}
          />
        )}

        {step === 'password' && (
          <>
            <AuthHeader
              icon={<KeyRound />}
              title={t('auth.newPasswordTitle')}
              subtitle={
                <Trans
                  i18nKey="auth.newPasswordSubtitle"
                  values={{ email }}
                  components={{ strong: <strong className="inline-block max-w-full break-all align-bottom font-medium text-foreground" /> }}
                />
              }
            />
            <form noValidate onSubmit={handleReset} className="space-y-5">
              <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
              <div>
                <Label htmlFor="password" className="mb-2 block">
                  {t('auth.newPassword')}
                </Label>
                <PasswordInput
                  ref={passwordRef}
                  id="password"
                  name="new-password"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    clearPwError('password')
                  }}
                  aria-invalid={!!pwErrors.password || undefined}
                  aria-describedby={pwErrors.password ? 'password-error password-rules' : 'password-rules'}
                />
                <FieldError id="password-error">{pwErrors.password && t(pwErrors.password)}</FieldError>
                <div id="password-rules">
                  <PasswordRequirements password={password} confirmPassword={confirm} />
                </div>
              </div>
              <div>
                <Label htmlFor="confirm" className="mb-2 block">
                  {t('auth.confirmPassword')}
                </Label>
                <PasswordInput
                  ref={confirmRef}
                  id="confirm"
                  name="confirm-password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value)
                    clearPwError('confirm')
                  }}
                  aria-invalid={!!pwErrors.confirm || undefined}
                  aria-describedby={pwErrors.confirm ? 'confirm-error' : undefined}
                />
                <FieldError id="confirm-error">{pwErrors.confirm && t(pwErrors.confirm)}</FieldError>
              </div>

              {alertNode}

              <AuthSubmitButton loading={submitting} disabled={lockedFor > 0}>
                {submitLabel(t('auth.resetPasswordAction'), t('auth.resettingPassword'))}
              </AuthSubmitButton>
            </form>
          </>
        )}

        {step === 'done' && (
          <div role="status">
            <SuccessCheck />
            <AuthHeader title={t('auth.resetDoneTitle')} subtitle={t('auth.resetDoneSubtitle')} />
            <Button asChild className="h-10 w-full">
              <Link to={loginHref}>{t('auth.continueToSignIn')}</Link>
            </Button>
          </div>
        )}
      </StepTransition>

      {step !== 'done' && (
        <div {...rise(4)}>
          <p className="mt-8 text-center text-sm">
            <Link
              to={loginHref}
              className="inline-flex items-center gap-1.5 rounded-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
              {t('auth.backToSignIn')}
            </Link>
          </p>
        </div>
      )}
    </AuthLayout>
  )
}
