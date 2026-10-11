/**
 * Form parts shared by the auth screens: the password field (show/hide +
 * caps-lock warning), the inline per-field error, and the submit button
 * with an in-place spinner.
 */

import { forwardRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowBigUp, CircleAlert, Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Height shared by every auth input + the submit button. */
const FIELD_HEIGHT = 'h-10'

export const AuthInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input>>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      // Addresses are left-to-right text even in Arabic; without this an RTL
      // page right-aligns them and the bidi algorithm can reorder "+" / "@".
      dir={props.type === 'email' ? 'ltr' : undefined}
      className={cn(
        FIELD_HEIGHT,
        'bg-background aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
        className,
      )}
      {...props}
    />
  ),
)
AuthInput.displayName = 'AuthInput'

type PasswordInputProps = Omit<ComponentProps<typeof Input>, 'type'>

/**
 * Password field with a keyboard-reachable show/hide toggle (web.dev, NIST
 * 800-63B §3.1.1.2) and a caps-lock hint, which can only be detected from
 * a key event — so it appears on the first keystroke and clears on blur.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, onKeyDown, onKeyUp, onBlur, id, ...props }, ref) => {
    const { t } = useTranslation()
    const [revealed, setRevealed] = useState(false)
    const [capsLock, setCapsLock] = useState(false)
    const readCaps = (e: KeyboardEvent<HTMLInputElement>) => {
      if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'))
    }
    return (
      <div>
        <div className="relative">
          <AuthInput
            ref={ref}
            id={id}
            type={revealed ? 'text' : 'password'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={cn('pe-11', className)}
            onKeyDown={(e) => {
              readCaps(e)
              onKeyDown?.(e)
            }}
            onKeyUp={(e) => {
              readCaps(e)
              onKeyUp?.(e)
            }}
            onBlur={(e) => {
              setCapsLock(false)
              onBlur?.(e)
            }}
            {...props}
          />
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? t('auth.hidePassword') : t('auth.showPassword')}
            aria-pressed={revealed}
            aria-controls={id}
            className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div aria-live="polite">
          {capsLock && (
            <p className="sgv-auth-alert mt-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <ArrowBigUp className="h-3.5 w-3.5 shrink-0" />
              {t('auth.capsLockOn')}
            </p>
          )}
        </div>
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'

/** Inline error under one field. `id` is what the input's aria-describedby points at. */
export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null
  return (
    <p id={id} className="sgv-auth-alert mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive">
      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/**
 * Full-width primary submit. While `loading`, the label stays (so the
 * button doesn't change width or meaning) and a spinner leads it; the
 * button is `aria-disabled` rather than `disabled` so focus isn't lost
 * mid-request, and clicks are swallowed.
 */
export function AuthSubmitButton({
  loading,
  disabled,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { loading?: boolean }) {
  const inert = loading || disabled
  return (
    <Button
      type="submit"
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (inert) e.preventDefault()
      }}
      className={cn(
        FIELD_HEIGHT,
        'w-full text-sm font-medium transition-[background-color,opacity,transform] active:scale-[0.99]',
        // Only the lockout label counts down; tabular digits elsewhere would
        // widen Inter's hyphen ("7 - day").
        disabled && 'tabular-nums',
        inert && 'cursor-not-allowed opacity-60 active:scale-100',
        className,
      )}
      {...props}
    >
      {loading && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}
      {children}
    </Button>
  )
}
