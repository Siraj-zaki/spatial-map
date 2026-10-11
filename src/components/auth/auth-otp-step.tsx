/**
 * The "check your email" step shared by /signup and /forgot-password:
 * where the code went (with a way to change the address), the code input
 * with auto-submit, resend with a cooldown, spam-folder guidance, and a
 * one-click "Open Gmail/Outlook/…" when the address is a known webmail.
 *
 * Stateless about the network — the page owns the requests, errors and
 * cooldowns and passes them in, so each flow keeps its own error handling.
 */

import type { ReactNode, Ref } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { ExternalLink, MailCheck } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { formatCountdown } from '@/lib/auth-errors'
import { AuthHeader } from './auth-layout'
import { AuthSubmitButton, FieldError } from './auth-fields'
import { OtpInput } from './otp-input'

export const OTP_LENGTH = 6

const WEBMAIL: Array<{ domains: RegExp; name: string; href: string }> = [
  { domains: /^(gmail|googlemail)\.com$/, name: 'Gmail', href: 'https://mail.google.com/mail/u/0/#inbox' },
  { domains: /^(outlook|hotmail|live|msn)\.[a-z.]+$/, name: 'Outlook', href: 'https://outlook.live.com/mail/0/inbox' },
  { domains: /^(yahoo|ymail)\.[a-z.]+$/, name: 'Yahoo Mail', href: 'https://mail.yahoo.com' },
  { domains: /^(icloud|me|mac)\.com$/, name: 'iCloud Mail', href: 'https://www.icloud.com/mail' },
  { domains: /^proton(mail)?\.(me|com)$/, name: 'Proton Mail', href: 'https://mail.proton.me' },
]

function webmailFor(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return WEBMAIL.find((w) => w.domains.test(domain)) ?? null
}

export function AuthOtpStep({
  title,
  subtitleKey,
  email,
  code,
  onCodeChange,
  onSubmit,
  submitting,
  submitLabel,
  codeError,
  alert,
  locked,
  resendIn,
  resending,
  onResend,
  onChangeEmail,
  footnote,
  inputRef,
}: {
  title: string
  /** i18n key rendered with <strong>{{email}}</strong> via <Trans>. */
  subtitleKey: string
  email: string
  code: string
  onCodeChange: (code: string) => void
  onSubmit: (code: string) => void
  submitting: boolean
  submitLabel: string
  codeError?: string | null
  alert?: ReactNode
  /** True while a 429 lockout is counting down. */
  locked?: boolean
  resendIn: number
  resending: boolean
  onResend: () => void
  onChangeEmail: () => void
  footnote?: ReactNode
  inputRef?: Ref<HTMLInputElement>
}) {
  const { t } = useTranslation()
  const webmail = webmailFor(email)
  const errorId = 'code-error'

  return (
    <>
      <AuthHeader
        icon={<MailCheck />}
        title={title}
        subtitle={
          <Trans
            i18nKey={subtitleKey}
            values={{ email }}
            components={{ strong: <strong className="inline-block max-w-full break-all align-bottom font-medium text-foreground" /> }}
          />
        }
      />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (!submitting && !locked) onSubmit(code)
        }}
        className="space-y-5"
      >
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <Label htmlFor="code">{t('auth.verificationCode')}</Label>
            <button
              type="button"
              onClick={onChangeEmail}
              className="rounded-sm text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('auth.changeEmail')}
            </button>
          </div>
          <OtpInput
            ref={inputRef}
            id="code"
            value={code}
            onChange={onCodeChange}
            onComplete={(full) => {
              if (!submitting && !locked) onSubmit(full)
            }}
            length={OTP_LENGTH}
            invalid={!!codeError}
            disabled={submitting}
            autoFocus
            aria-describedby={codeError ? errorId : 'code-hint'}
          />
          <FieldError id={errorId}>{codeError}</FieldError>
          <p id="code-hint" className="sr-only">
            {t('auth.codeHint', { digits: OTP_LENGTH })}
          </p>
        </div>

        {alert}

        <AuthSubmitButton loading={submitting} disabled={locked}>
          {submitLabel}
        </AuthSubmitButton>
      </form>

      <div className="mt-6 space-y-3 rounded-lg border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <p>{t('auth.otpNotReceived')}</p>
        <p>
          <button
            type="button"
            onClick={onResend}
            disabled={resendIn > 0 || resending || submitting}
            className="rounded-sm font-medium tabular-nums text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            {resending
              ? t('auth.sendingCode')
              : resendIn > 0
                ? t('auth.resendIn', { time: formatCountdown(resendIn) })
                : t('auth.resend')}
          </button>
        </p>
        {webmail && (
          <a
            href={webmail.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('auth.openInbox', { provider: webmail.name })}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {footnote}
      </div>
    </>
  )
}
