/**
 * /profile — the signed-in person's own settings, laid out as labelled
 * sections (what it is on the left, the controls on the right):
 *
 *   - Profile     name, job title, location, pronouns, about — with a live
 *                 "how others see you" card. Edits collect into a sticky
 *                 save bar (Reset / Save), ⌘/Ctrl+S saves, closing the tab
 *                 with unsaved edits warns.
 *   - Photo       click or drop an image; type + 5 MB checked before the
 *                 upload (same limits the API enforces). Saves on its own.
 *   - Account     email + verified state; "Change password" runs the
 *                 emailed-code reset flow (which signs out other devices).
 *   - Preferences language, light/dark, palette — the same settings as the
 *                 account menu, easier to find here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { BadgeCheck, Camera, Check, KeyRound, Loader2, Monitor, Moon, Sun } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { LANGUAGES } from '@/components/language-switcher'
import { THEMES } from '@/components/mode-toggle'
import { PaletteGrid } from '@/components/theme-picker'
import { useTheme } from '@/components/theme-provider'
import { useAuthStore, type AuthUser } from '@/lib/auth-store'
import { getProfile, updateProfile, uploadAvatar } from '@/lib/profile-client'
import { rewriteFilesUrlSameOrigin } from '@/lib/binary-store'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

interface ProfileForm {
  displayName: string
  bio: string
  location: string
  pronouns: string
  jobTitle: string
}

const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const BIO_MAX = 1000
const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const

// `?? ''` guards against pre-profile-migration sessions still in localStorage —
// those `user` objects lack the new fields, and reading `.length` on undefined
// crashes the page on first render before refreshSession() can fix it up.
function formFromUser(user: AuthUser): ProfileForm {
  return {
    displayName: user.displayName ?? '',
    bio: user.bio ?? '',
    location: user.location ?? '',
    pronouns: user.pronouns ?? '',
    jobTitle: user.jobTitle ?? '',
  }
}

function sameForm(a: ProfileForm, b: ProfileForm): boolean {
  return (Object.keys(a) as (keyof ProfileForm)[]).every((k) => a[k] === b[k])
}

export default function ProfilePage() {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const [form, setForm] = useState<ProfileForm>(() =>
    user ? formFromUser(user) : { displayName: '', bio: '', location: '', pronouns: '', jobTitle: '' },
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refresh from the server on mount so another device's edits show up.
  // Only replaces the form if it hasn't been touched yet.
  useEffect(() => {
    void getProfile()
      .then((fresh) => setForm((cur) => (user && sameForm(cur, formFromUser(user)) ? formFromUser(fresh) : cur)))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const baseline = user ? formFromUser(user) : form
  const dirty = !sameForm(form, baseline)
  const set = (k: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const save = useCallback(async () => {
    if (!dirty || saving) return
    setError(null)
    setSaving(true)
    try {
      const trimmed = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()])) as unknown as ProfileForm
      const fresh = await updateProfile(trimmed)
      setForm(formFromUser(fresh))
      toast.success(t('profile.saved', { defaultValue: 'Changes saved.' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.saveFailed', { defaultValue: 'Could not save profile.' }))
    } finally {
      setSaving(false)
    }
  }, [dirty, saving, form, t])

  useEffect(() => {
    if (!dirty) return
    const before = (e: BeforeUnloadEvent) => e.preventDefault()
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('beforeunload', before)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('beforeunload', before)
      window.removeEventListener('keydown', key)
    }
  }, [dirty, save])

  if (!user) {
    return <div className="p-8 text-center text-muted-foreground">{t('profile.notAuthenticated', { defaultValue: 'Sign in to view your profile.' })}</div>
  }

  return (
    <PageContainer className="gap-8">
      <div {...rise(0)}>
        <PageHero
          title={t('profile.title', { defaultValue: 'Your profile' })}
          description={t('profile.subtitleAll', { defaultValue: 'How you appear to people in your workspaces, plus your account and preferences.' })}
        />
      </div>

      <Section
        i={1}
        title={t('profile.sectionProfile', { defaultValue: 'Profile' })}
        description={t('profile.sectionProfileBody', { defaultValue: 'Shown next to your name on members lists and activity.' })}
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
          <form
            id="profile-form"
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <Field id="displayName" label={t('profile.displayName', { defaultValue: 'Display name' })}>
              <Input id="displayName" value={form.displayName} onChange={set('displayName')} placeholder={t('profile.displayNamePlaceholder', { defaultValue: 'e.g. Alex Rivera' })} maxLength={80} autoComplete="name" />
            </Field>
            <Field id="jobTitle" label={t('profile.jobTitle', { defaultValue: 'Job title' })}>
              <Input id="jobTitle" value={form.jobTitle} onChange={set('jobTitle')} placeholder={t('profile.jobTitlePlaceholder', { defaultValue: 'e.g. Facility manager' })} maxLength={120} autoComplete="organization-title" />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="location" label={t('profile.location', { defaultValue: 'Location' })}>
                <Input id="location" value={form.location} onChange={set('location')} placeholder={t('profile.locationPlaceholder', { defaultValue: 'e.g. Dubai, UAE' })} maxLength={120} />
              </Field>
              <Field id="pronouns" label={t('profile.pronouns', { defaultValue: 'Pronouns' })} optional>
                <Input id="pronouns" value={form.pronouns} onChange={set('pronouns')} placeholder={t('profile.pronounsPlaceholder', { defaultValue: 'e.g. she/her' })} maxLength={40} />
              </Field>
            </div>
            <Field
              id="bio"
              label={t('profile.bio', { defaultValue: 'About' })}
              hint={
                <span className={cn('tabular-nums', form.bio.length > BIO_MAX * 0.9 && 'text-warning')}>
                  {form.bio.length}/{BIO_MAX}
                </span>
              }
            >
              <textarea
                id="bio"
                value={form.bio}
                onChange={set('bio')}
                placeholder={t('profile.bioPlaceholder', { defaultValue: 'A short description of what you do.' })}
                maxLength={BIO_MAX}
                rows={4}
                className="flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </Field>
          </form>

          {/* Live preview */}
          <div className="hidden xl:block">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t('profile.preview', { defaultValue: 'How others see you' })}</p>
            <div className="rounded-xl border bg-background p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <Avatar user={user} name={form.displayName} size="md" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{form.displayName.trim() || user.email}</p>
                  {(form.jobTitle.trim() || form.pronouns.trim()) && (
                    <p className="truncate text-xs text-muted-foreground">
                      {[form.jobTitle.trim(), form.pronouns.trim()].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              {form.location.trim() && <p className="mt-3 text-xs text-muted-foreground">{form.location.trim()}</p>}
              {form.bio.trim() && <p className="mt-2 line-clamp-4 text-sm">{form.bio.trim()}</p>}
            </div>
          </div>
        </div>
      </Section>

      <Section
        i={2}
        title={t('profile.sectionPhoto', { defaultValue: 'Photo' })}
        description={t('profile.sectionPhotoBody', { defaultValue: 'A square image works best. JPG, PNG or WebP, up to 5 MB. Saved as soon as you pick it.' })}
      >
        <AvatarUploader user={user} name={form.displayName} />
      </Section>

      <Section
        i={3}
        title={t('profile.sectionAccount', { defaultValue: 'Account' })}
        description={t('profile.sectionAccountBody', { defaultValue: 'The email you sign in with, and your password.' })}
      >
        <div className="divide-y rounded-lg border">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">{t('auth.email', { defaultValue: 'Email' })}</p>
              <p className="truncate text-sm font-medium" dir="ltr">{user.email}</p>
            </div>
            {user.verifiedAt && (
              <Badge variant="success" className="gap-1">
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                {t('profile.verified', { defaultValue: 'Verified' })}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t('profile.password', { defaultValue: 'Password' })}</p>
              <p className="text-xs text-muted-foreground">
                {t('profile.passwordHint', { defaultValue: 'We’ll email you a code to set a new one. Changing it signs you out on your other devices.' })}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to={`/forgot-password?email=${encodeURIComponent(user.email)}`}>
                <KeyRound className="h-4 w-4" />
                {t('profile.changePassword', { defaultValue: 'Change password' })}
              </Link>
            </Button>
          </div>
        </div>
      </Section>

      <Section
        i={4}
        title={t('profile.sectionPreferences', { defaultValue: 'Preferences' })}
        description={t('profile.sectionPreferencesBody', { defaultValue: 'Only affect you, on this device.' })}
      >
        <Preferences />
      </Section>

      {/* Sticky save bar — only while there's something to save. */}
      {(dirty || saving) && (
        // Sticky to the bottom of the page's own scroll area (PageContainer),
        // so it stays inside the content column whatever the sidebar does.
        <div className="pointer-events-none sticky bottom-4 z-40 -mt-4 flex justify-center">
          <div className="sgv-rise pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg">
            <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-sm">
              {error ?? t('profile.unsaved', { defaultValue: 'You have unsaved changes' })}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setForm(baseline)} disabled={saving}>
              {t('profile.reset', { defaultValue: 'Reset' })}
            </Button>
            <Button size="sm" type="submit" form="profile-form" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Check className="h-4 w-4" />}
              {saving ? t('profile.saving', { defaultValue: 'Saving…' }) : t('profile.save', { defaultValue: 'Save changes' })}
            </Button>
          </div>
        </div>
      )}
    </PageContainer>
  )
}

function Section({ i, title, description, children }: { i: number; title: string; description: string; children: React.ReactNode }) {
  return (
    <section {...rise(i, 'grid gap-4 border-t pt-8 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10')}>
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function Field({
  id,
  label,
  optional,
  hint,
  children,
}: {
  id: string
  label: string
  optional?: boolean
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {optional && <span className="ms-1.5 text-xs font-normal text-muted-foreground">{t('profile.optional', { defaultValue: 'Optional' })}</span>}
        </Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Avatar({ user, name, size }: { user: AuthUser; name: string; size: 'md' | 'lg' }) {
  const { t } = useTranslation()
  const initial = ((name.trim() || user.displayName || '') || user.email).charAt(0).toUpperCase()
  const cls = size === 'lg' ? 'h-20 w-20 text-2xl' : 'h-11 w-11 text-base'
  return user.avatarUrl ? (
    <img src={rewriteFilesUrlSameOrigin(user.avatarUrl)} alt={t('profile.avatarAlt', { defaultValue: 'Profile photo' })} className={cn('shrink-0 rounded-full object-cover', cls)} />
  ) : (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground', cls)} aria-hidden>
      {initial}
    </span>
  )
}

function AvatarUploader({ user, name }: { user: AuthUser; name: string }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError(t('profile.notImage', { defaultValue: 'That file isn’t an image.' }))
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError(t('profile.tooLarge', { defaultValue: 'That image is over 5 MB — try a smaller one.' }))
      return
    }
    setUploading(true)
    try {
      await uploadAvatar(file)
      toast.success(t('profile.photoUpdated', { defaultValue: 'Photo updated' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.uploadFailed', { defaultValue: 'Could not upload image.' }))
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void upload(e.dataTransfer.files?.[0])
      }}
      className={cn('flex flex-wrap items-center gap-4 rounded-lg border border-dashed p-4 transition-colors', over && 'border-primary bg-primary/5')}
    >
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="group relative shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('profile.changeAvatar', { defaultValue: 'Change photo' })}
      >
        <Avatar user={user} name={name} size="lg" />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {uploading ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" /> : <Camera className="h-5 w-5" />}
        </span>
        {uploading && (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/70">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{t('profile.dropHint', { defaultValue: 'Drop an image here, or' })}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <Camera className="h-4 w-4" />
          {t('profile.changeAvatar', { defaultValue: 'Change photo' })}
        </Button>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
    </div>
  )
}

function Preferences() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const current = i18n.resolvedLanguage || i18n.language || 'en'
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="pref-language">{t('userMenu.language', { defaultValue: 'Language' })}</Label>
        <select
          id="pref-language"
          value={current}
          onChange={(e) => void i18n.changeLanguage(e.target.value)}
          className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium" id="pref-appearance">{t('userMenu.appearance', { defaultValue: 'Appearance' })}</p>
        <div role="radiogroup" aria-labelledby="pref-appearance" className="grid max-w-md grid-cols-3 gap-2">
          {THEMES.map((item) => {
            const Icon = THEME_ICONS[item.value]
            const active = theme === item.value
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(item.value)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary bg-primary/5 font-medium ring-1 ring-primary' : 'hover:bg-accent/50',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t(item.labelKey)}
              </button>
            )
          })}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('theme.pickerHeading', { defaultValue: 'Palette' })}</p>
        <div className="max-w-md rounded-lg border p-3">
          <PaletteGrid />
        </div>
      </div>
    </div>
  )
}
