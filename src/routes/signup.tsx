import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { AuthAlert } from '@/components/auth/auth-alert'
import { PRODUCT_NAME } from '@/components/auth/auth-brand-mark'
import { PRIVACY_URL, TERMS_URL } from '@/config/legal'
import { AuthInput, AuthSubmitButton, FieldError, PasswordInput } from '@/components/auth/auth-fields'
import { AuthHeader, AuthLayout, AuthSwitchLine, rise } from '@/components/auth/auth-layout'
import { AuthOtpStep, OTP_LENGTH } from '@/components/auth/auth-otp-step'
import { StepProgress, StepTransition } from '@/components/auth/auth-steps'
import { PasswordRequirements } from '@/components/password-requirements'
import { useAuthAlert } from '@/hooks/useAuthAlert'
import { useCountdown } from '@/hooks/useCountdown'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { completeSignup, requestSignupOtp, verifySignupOtp } from '@/lib/auth-client'
import { describeAuthError, formatCountdown, looksLikeEmail } from '@/lib/auth-errors'
import { isPasswordAcceptable } from '@/lib/password-policy'

type Step = 'email' | 'otp' | 'password'
const STEPS: Step[] = ['email', 'otp', 'password']

/** Client-side cooldown between code requests. The server's per-email
 *  limiter is the real cap; this just stops accidental double-sends. */
const RESEND_COOLDOWN_SECONDS = 60

function readInitialStep(params: URLSearchParams): Step {
  // Never restore to 'password' from the URL: the verification token
  // lives only in React memory and can't be recovered from a refresh,
  // so the password step would immediately dead-end. 'otp' is the only
  // mid-flow step worth restoring — and only with an email to go with it.
  return params.get('step') === 'otp' && params.get('email') ? 'otp' : 'email'
}

export default function SignupPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [step, setStep] = useState<Step>(() => readInitialStep(searchParams))
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '')
  const [code, setCode] = useState('')
  const [verificationToken, setVerificationToken] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [resending, setResending] = useState(false)
  // Set when the account turns out to exist (race at step 3) so the alert
  // can offer "Sign in instead".
  const [emailTaken, setEmailTaken] = useState(false)
  const { alert, show, clear } = useAuthAlert()
  const [lockedFor, startLock] = useCountdown()
  const [resendIn, startResend] = useCountdown()
  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Mirror step + email into the URL so a refresh at the code step keeps
  // progress. The verification token is NOT persisted — a refresh at step
  // 3 downgrades to step 2 (readInitialStep) and the user re-verifies.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (step === 'email') next.delete('step')
    else next.set('step', 'otp')
    const normalized = email.trim().toLowerCase()
    if (normalized) next.set('email', normalized)
    else next.delete('email')
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }, [step, email, searchParams, setSearchParams])

  const rateLimited = alert?.key === 'auth.errors.rateLimited'
  const visibleAlert = rateLimited && lockedFor === 0 ? null : alert
  const hasError = !!(emailError || codeError || passwordError) || visibleAlert?.tone === 'error'
  useDocumentTitle(`${t('auth.signUpTitle')} · ${PRODUCT_NAME}`, hasError ? t('auth.errorTitlePrefix') : null)

  const goTo = (next: Step) => {
    clear()
    setEmailError(null)
    setCodeError(null)
    setPasswordError(null)
    setEmailTaken(false)
    setStep(next)
  }

  /** Shared failure handling; returns the parsed info for step-specific branches. */
  const handleError = (err: unknown) => {
    const info = describeAuthError(err)
    if (info.retryAfter) startLock(info.retryAfter)
    return info
  }

  // ---- Step 1: email → code ----
  const handleRequestCode = async (e: React.FormEvent) => {
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
      const res = await requestSignupOtp(trimmed.toLowerCase())
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
      await requestSignupOtp(email)
      setCode('')
      startResend(RESEND_COOLDOWN_SECONDS)
      show('success', 'auth.otpResent')
      codeRef.current?.focus()
    } catch (err) {
      const info = describeAuthError(err)
      if (info.retryAfter) {
        // Too many codes for this address: the resend link counts down
        // instead of locking the form — verifying the last code still works.
        startResend(info.retryAfter)
        show('error', 'auth.errors.resendLimited')
      } else {
        show('error', info.key)
      }
    } finally {
      setResending(false)
    }
  }

  // ---- Step 2: code → verification token ----
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
      const res = await verifySignupOtp(email, value)
      setVerificationToken(res.verificationToken)
      goTo('password')
    } catch (err) {
      const info = handleError(err)
      if (info.field === 'code') {
        setCodeError(info.key)
        setCode('')
        // Focus after the input re-enables (it's disabled while submitting).
        window.setTimeout(() => codeRef.current?.focus(), 0)
      } else {
        show('error', info.key)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ---- Step 3: password → account ----
  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting || lockedFor > 0) return
    if (!isPasswordAcceptable(password)) {
      setPasswordError(password ? 'auth.passwordRequirementsNotMet' : 'auth.errors.passwordRequired')
      passwordRef.current?.focus()
      return
    }
    clear()
    setSubmitting(true)
    try {
      await completeSignup({ email, password, verificationToken })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      const info = handleError(err)
      if (info.code === 'verification_expired') {
        // 15-minute window between verifying and choosing a password ran
        // out. Restart at step 1 with the email kept, so it's one click to
        // get a fresh code instead of a dead end.
        setVerificationToken('')
        setPassword('')
        setCode('')
        goTo('email')
        show('info', 'auth.verificationExpired')
      } else if (info.code === 'email_taken') {
        setEmailTaken(true)
        show('error', info.key)
      } else if (info.field === 'password') {
        setPasswordError(info.key)
        passwordRef.current?.focus()
      } else {
        show('error', info.key)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const alertNode = visibleAlert && (
    <AuthAlert
      key={visibleAlert.n}
      tone={visibleAlert.tone}
      action={
        emailTaken ? (
          <Link
            to={`/login?email=${encodeURIComponent(email)}`}
            className="underline underline-offset-4"
          >
            {t('auth.signInInstead')}
          </Link>
        ) : undefined
      }
    >
      {t(visibleAlert.key, rateLimited ? { time: formatCountdown(lockedFor) } : visibleAlert.values)}
    </AuthAlert>
  )

  const submitLabel = (idle: string, busy: string) =>
    lockedFor > 0 ? t('auth.tryAgainIn', { time: formatCountdown(lockedFor) }) : submitting ? busy : idle

  const stepIndex = STEPS.indexOf(step)

  return (
    <AuthLayout>
      <div {...rise(0)}>
        <StepProgress
          labels={[t('auth.steps.email'), t('auth.steps.verify'), t('auth.steps.password')]}
          current={stepIndex}
        />
      </div>

      <StepTransition step={step} index={stepIndex}>
        {step === 'email' && (
          <>
            <AuthHeader title={t('auth.signUpTitle')} subtitle={t('auth.signUpSubtitle')} />
            <form noValidate onSubmit={handleRequestCode} className="space-y-5">
              <div>
                <Label htmlFor="email" className="mb-2 block">
                  {t('auth.workEmail')}
                </Label>
                <AuthInput
                  ref={emailRef}
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
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
                  aria-describedby={emailError ? 'email-error' : 'email-hint'}
                />
                <FieldError id="email-error">{emailError && t(emailError)}</FieldError>
                {!emailError && (
                  <p id="email-hint" className="mt-1.5 text-xs text-muted-foreground">
                    {t('auth.emailOtpHint')}
                  </p>
                )}
              </div>

              {alertNode}

              <AuthSubmitButton loading={submitting} disabled={lockedFor > 0}>
                {submitLabel(t('auth.continue'), t('auth.sendingCode'))}
              </AuthSubmitButton>

              {TERMS_URL && PRIVACY_URL && (
                <p className="text-center text-xs leading-relaxed text-muted-foreground">
                  <Trans
                    i18nKey="auth.agreeToTerms"
                    components={{
                      terms: (
                        <a
                          href={TERMS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        />
                      ),
                      privacy: (
                        <a
                          href={PRIVACY_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        />
                      ),
                    }}
                  />
                </p>
              )}
            </form>
          </>
        )}

        {step === 'otp' && (
          <AuthOtpStep
            title={t('auth.checkEmailTitle')}
            subtitleKey="auth.codeSentToRich"
            email={email}
            code={code}
            onCodeChange={(v) => {
              setCode(v)
              if (codeError) setCodeError(null)
            }}
            onSubmit={handleVerify}
            submitting={submitting}
            submitLabel={submitLabel(t('auth.verify'), t('auth.verifying'))}
            codeError={codeError && t(codeError)}
            alert={alertNode}
            locked={lockedFor > 0}
            resendIn={resendIn}
            resending={resending}
            onResend={handleResend}
            onChangeEmail={() => {
              setCode('')
              setVerificationToken('')
              goTo('email')
            }}
            inputRef={codeRef}
            footnote={
              // Neutral hint: signup-request answers the same for an existing
              // account (no enumeration), so an already-registered user gets a
              // "you already have an account" email instead of a code.
              <p>
                {t('auth.otpAlreadyRegisteredHint')}{' '}
                <Link
                  to={`/login?email=${encodeURIComponent(email)}`}
                  className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('auth.signIn')}
                </Link>
              </p>
            }
          />
        )}

        {step === 'password' && (
          <>
            <AuthHeader
              title={t('auth.setPasswordTitle')}
              subtitle={
                <Trans
                  i18nKey="auth.setPasswordSubtitle"
                  values={{ email }}
                  components={{ strong: <strong className="inline-block max-w-full break-all align-bottom font-medium text-foreground" /> }}
                />
              }
            />
            <form noValidate onSubmit={handleCreateAccount} className="space-y-5">
              {/* Lets password managers save the new password against the
                  verified email — this step has no visible username field. */}
              <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
              <div>
                <Label htmlFor="password" className="mb-2 block">
                  {t('auth.password')}
                </Label>
                <PasswordInput
                  ref={passwordRef}
                  id="password"
                  name="password"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (passwordError) setPasswordError(null)
                  }}
                  aria-invalid={!!passwordError || undefined}
                  aria-describedby={passwordError ? 'password-error password-rules' : 'password-rules'}
                />
                <FieldError id="password-error">{passwordError && t(passwordError)}</FieldError>
                <div id="password-rules">
                  <PasswordRequirements password={password} />
                </div>
              </div>

              {alertNode}

              <AuthSubmitButton loading={submitting} disabled={lockedFor > 0}>
                {submitLabel(t('auth.createAccount'), t('auth.creatingAccount'))}
              </AuthSubmitButton>
            </form>
          </>
        )}
      </StepTransition>

      <div {...rise(4)}>
        <AuthSwitchLine prompt={t('auth.haveAccount')} to="/login" action={t('auth.signIn')} />
      </div>
    </AuthLayout>
  )
}
