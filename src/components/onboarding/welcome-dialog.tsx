/**
 * WelcomeDialog — shown on the dashboard to every signed-in user until they
 * close it (remembered per user in this browser, so clearing site data
 * shows it again): an illustrated
 * host waves and says hi, then three ways forward — the docs, a step-by-step
 * tutorial, or the project's community on GitHub. The host is
 * inline SVG; skin/hair are illustration colours (`--sgv-host-*` in
 * index.css), everything else is theme tokens. Motion: `.sgv-host*`.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, BookOpen, GraduationCap, MessageSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAuthStore } from '@/lib/auth-store'
import { cn } from '@/lib/utils'

const DOCS_URL = 'https://spatialmap.io/docs/getting-started'
const TUTORIAL_URL = 'https://spatialmap.io/docs/examples/new-workspace-and-first-facility'
const COMMUNITY_URL = 'https://github.com/Siraj-zaki/spatial-map/issues'

const seenKey = (uid: number) => `sgv-welcome-seen:${uid}`

function shouldShow(user: { id: number } | null): boolean {
  if (!user) return false
  try {
    return localStorage.getItem(seenKey(user.id)) === null
  } catch {
    return false
  }
}

export function WelcomeDialog() {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const [open, setOpen] = useState(() => shouldShow(user))
  if (!user) return null

  const close = () => {
    setOpen(false)
    try {
      localStorage.setItem(seenKey(user.id), new Date().toISOString())
    } catch {
      /* shows again next visit — harmless */
    }
  }
  const firstName = (user.displayName || '').trim().split(/\s+/)[0]

  const actions = [
    { icon: BookOpen, title: t('welcomeHost.docsTitle', { defaultValue: 'Read the docs' }), body: t('welcomeHost.docsBody', { defaultValue: 'How every part of Spatial Map works, from floor plans to live data.' }), href: DOCS_URL },
    { icon: GraduationCap, title: t('welcomeHost.tutorialTitle', { defaultValue: 'Follow a tutorial' }), body: t('welcomeHost.tutorialBody', { defaultValue: 'Step by step: your first facility on the map in a few minutes.' }), href: TUTORIAL_URL },
    {
      icon: MessageSquare,
      title: t('welcomeHost.communityTitle', { defaultValue: 'Ask the community' }),
      body: t('welcomeHost.communityBody', { defaultValue: 'Stuck, found a bug or have an idea? Open an issue on GitHub.' }),
      href: COMMUNITY_URL,
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <div className="relative flex items-end justify-center bg-primary/10 px-6 pt-6">
          <WelcomeHost />
          <div className="sgv-host-bubble absolute end-[12%] top-6 rounded-2xl rounded-es-sm bg-card px-3.5 py-1.5 text-lg font-semibold shadow-md">
            {t('welcomeHost.hi', { defaultValue: 'Hi!' })} <span className="sgv-host-wave-emoji inline-block" aria-hidden>👋</span>
          </div>
        </div>
        <div className="space-y-4 px-6 pb-6 pt-5">
          <div className="sgv-rise space-y-1.5 text-center" style={{ '--sgv-i': 2 } as React.CSSProperties}>
            <DialogTitle className="text-xl">
              {firstName
                ? t('welcomeHost.titleNamed', { name: firstName, defaultValue: 'Welcome to Spatial Map, {{name}}!' })
                : t('welcomeHost.title', { defaultValue: 'Welcome to Spatial Map!' })}
            </DialogTitle>
            <DialogDescription>
              {t('welcomeHost.body', { defaultValue: 'We’re glad you’re here. Turn a floor plan into a live map of your facility — and if you’d like a hand getting started, pick one of these:' })}
            </DialogDescription>
          </div>
          <div className="grid gap-2">
            {actions.map((a, i) => {
              const inner = (
                <>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <a.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-sm font-medium">
                      {a.title}
                      <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </span>
                    <span className="block text-xs text-muted-foreground">{a.body}</span>
                  </span>
                </>
              )
              const cls = cn('sgv-rise sgv-lift flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-start hover:border-primary/40')
              const style = { '--sgv-i': i + 3 } as React.CSSProperties
              return (
                <a key={a.title} href={a.href} target="_blank" rel="noopener noreferrer" className={cls} style={style}>{inner}</a>
              )
            })}
          </div>
          <Button className="sgv-rise w-full" style={{ '--sgv-i': 6 } as React.CSSProperties} onClick={close}>
            {t('welcomeHost.start', { defaultValue: 'Let’s get started' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The host: a friendly guide with a headset, waving. */
function WelcomeHost() {
  return (
    <svg viewBox="0 0 220 200" className="sgv-host h-44 w-auto" role="img" aria-hidden>
      {/* backdrop + sparkles */}
      <circle cx="110" cy="118" r="82" fill="hsl(var(--primary) / 0.14)" />
      {[[36, 56, 0], [184, 44, 1], [196, 120, 2], [28, 132, 3]].map(([x, y, i]) => (
        <path key={i} className="sgv-host-spark" style={{ '--sgv-i': i, transformOrigin: `${x}px ${y}px` } as React.CSSProperties}
          d={`M${x} ${y - 7} Q${x + 1.5} ${y - 1.5} ${x + 7} ${y} Q${x + 1.5} ${y + 1.5} ${x} ${y + 7} Q${x - 1.5} ${y + 1.5} ${x - 7} ${y} Q${x - 1.5} ${y - 1.5} ${x} ${y - 7}Z`}
          fill="hsl(var(--primary))" />
      ))}

      {/* hair, back layer */}
      <path d="M62 102 C60 58 84 38 110 38 C136 38 160 58 158 102 L160 166 C150 176 134 174 128 164 L92 164 C86 174 70 176 60 166 Z" fill="var(--sgv-host-hair)" />
      {/* body */}
      <path d="M44 200 C46 172 70 158 110 158 C150 158 174 172 176 200 Z" fill="hsl(var(--primary))" />
      <path d="M97 159 L110 176 L123 159 Z" fill="var(--sgv-host-skin-shade)" />
      <rect x="100" y="134" width="20" height="28" rx="9" fill="var(--sgv-host-skin-shade)" />
      {/* ears + head */}
      <circle cx="75" cy="108" r="7" fill="var(--sgv-host-skin-shade)" />
      <circle cx="145" cy="108" r="7" fill="var(--sgv-host-skin-shade)" />
      <ellipse cx="110" cy="104" rx="35" ry="38" fill="var(--sgv-host-skin)" />
      {/* bangs */}
      <path d="M74 98 C70 66 90 54 112 56 C134 58 150 74 146 100 C138 86 124 76 108 75 C98 86 86 94 74 98 Z" fill="var(--sgv-host-hair)" />
      {/* brows, eyes, blush, smile */}
      <path d="M90 95 Q96 91 102 94" stroke="var(--sgv-host-hair)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M118 94 Q124 91 130 95" stroke="var(--sgv-host-hair)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <g className="sgv-host-eyes">
        <ellipse cx="97" cy="106" rx="3.8" ry="4.8" fill="var(--sgv-host-ink)" />
        <ellipse cx="123" cy="106" rx="3.8" ry="4.8" fill="var(--sgv-host-ink)" />
        <circle cx="98.4" cy="104.4" r="1.3" fill="hsl(0 0% 100%)" />
        <circle cx="124.4" cy="104.4" r="1.3" fill="hsl(0 0% 100%)" />
      </g>
      <ellipse cx="87" cy="118" rx="6.5" ry="3.6" fill="var(--sgv-host-blush)" opacity="0.5" />
      <ellipse cx="133" cy="118" rx="6.5" ry="3.6" fill="var(--sgv-host-blush)" opacity="0.5" />
      <path d="M100 121 Q110 131 120 121 Q110 126 100 121 Z" fill="var(--sgv-host-mouth)" stroke="var(--sgv-host-mouth)" strokeWidth="2" strokeLinejoin="round" />
      {/* headset */}
      <path d="M72 104 C70 58 150 58 148 104" stroke="var(--sgv-host-ink)" strokeWidth="4.5" fill="none" strokeLinecap="round" />
      <rect x="64" y="96" width="12" height="20" rx="5" fill="var(--sgv-host-ink)" />
      <rect x="144" y="96" width="12" height="20" rx="5" fill="var(--sgv-host-ink)" />
      <path d="M70 114 C72 130 84 136 96 134" stroke="var(--sgv-host-ink)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <circle cx="98" cy="134" r="3.6" fill="hsl(var(--primary))" />
      {/* waving arm: sleeve from the shoulder, forearm + hand rotate at the elbow */}
      <path d="M158 178 L170 150" stroke="hsl(var(--primary))" strokeWidth="18" strokeLinecap="round" />
      <g className="sgv-host-arm" style={{ transformOrigin: '170px 150px' }}>
        <path d="M170 150 L178 120" stroke="var(--sgv-host-skin)" strokeWidth="12" strokeLinecap="round" />
        <ellipse cx="180" cy="110" rx="10" ry="12" fill="var(--sgv-host-skin)" />
        <ellipse cx="170" cy="114" rx="3.6" ry="6" fill="var(--sgv-host-skin)" transform="rotate(-35 170 114)" />
        <path d="M176 102 L176 108 M181 100 L181 107 M186 102 L185.5 108" stroke="var(--sgv-host-skin-shade)" strokeWidth="1.4" strokeLinecap="round" />
      </g>
    </svg>
  )
}
