/**
 * Shell shared by /login, /signup and /forgot-password.
 *
 * ≥lg: split screen — AuthBrandPanel on the start side, the form column on
 * the end side. <lg: the panel is dropped and the logo moves above the
 * form. Chrome (language, palette, light/dark) sits top-end so users can
 * adjust it before signing in; legal links close the form column.
 *
 * Deliberately NO ThemedBackground photo here: the form sits on plain
 * `bg-background`, so it stays legible in every palette × mode without
 * text-shadow tricks.
 */

import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LanguageSwitcher } from '@/components/language-switcher'
import { LegalLinks } from '@/components/legal-links'
import { ModeToggle } from '@/components/mode-toggle'
import { ThemePicker } from '@/components/theme-picker'
import { AuthBrandMark } from './auth-brand-mark'
import { AuthBrandPanel, AuthMobileProductShot } from './auth-brand-panel'

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background lg:items-start lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <AuthBrandPanel />
      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="flex h-16 items-center gap-2 px-4 sm:px-6">
          <AuthBrandMark className="lg:hidden" />
          <div className="ms-auto flex items-center gap-1">
            <LanguageSwitcher />
            <ThemePicker />
            <ModeToggle />
          </div>
        </header>
        {/* Top-anchored, not vertically centred: centring made the heading
            jump every time an error or step added height. 18dvh keeps it
            optically centred on desktop. */}
        <main className="flex flex-1 justify-center px-4 pb-10 pt-4 sm:px-6 lg:pt-[18dvh]">
          <div className="w-full max-w-[400px]">
            <AuthMobileProductShot />
            {children}
          </div>
        </main>
        <LegalLinks className="mt-0 px-4 pb-6" />
      </div>
    </div>
  )
}

/** Staggered entry: element `i` rises in `i × 45ms` after the first. */
export function rise(i: number): { className: string; style: CSSProperties } {
  return { className: 'sgv-auth-rise', style: { '--sgv-i': i } as CSSProperties }
}

export function AuthHeader({
  icon,
  title,
  subtitle,
}: {
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
}) {
  return (
    <div className="mb-7 space-y-2">
      {icon && (
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border bg-card text-primary shadow-sm [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {subtitle && <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>}
    </div>
  )
}

/** "Don't have an account? Sign up" — the line under every form. */
export function AuthSwitchLine({ prompt, to, action }: { prompt: string; to: string; action: string }) {
  return (
    <p className="mt-8 text-center text-sm text-muted-foreground">
      {prompt}{' '}
      <Link
        to={to}
        className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {action}
      </Link>
    </p>
  )
}
