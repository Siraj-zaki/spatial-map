import { useTheme } from '@/components/theme-provider';
import { useEffect, useState } from 'react';

/**
 * Fixed decorative background that swaps between the light and dark
 * theme images based on the resolved theme mode. The `variant` prop
 * still exists for backward compatibility but both variants resolve
 * to the same per-theme image now — the same `white_theme_bg_image` /
 * `dark_theme_bg_image` pair is used on auth and admin screens alike
 * so the whole app reads as one surface.
 *
 *   - `auth`      — used on login / signup
 *   - `dashboard` — used on every workspace-admin route
 *
 * Renders behind everything at `-z-10`. Callers must ensure ancestor
 * containers don't ship an opaque `bg-*` class that would sit ABOVE
 * this — the App shell uses a `-z-20` fallback surface so this layer
 * shows on any screen that mounts it, without affecting screens that
 * don't (they still see the default `bg-background`).
 *
 * Only ONE of the two images loads per view: the resolved mode picks
 * the src at render time and the browser never fetches the other.
 * The image is blurred (28px) and covered by an `sgv-mesh-overlay`
 * tint layer + a semi-transparent `bg-background` slab so foreground
 * content stays legible. The overlay opacity is tuned lower than the
 * original 85/90 so the image reads as a real background, not a faint
 * tint; auth screens additionally apply `.sgv-auth-shadow` on their
 * bare text for contrast.
 *
 * Total: ~2.0–2.3 MB uncompressed jpegs, cached after first hit.
 */
type Variant = 'auth' | 'dashboard'

const IMAGES: Record<Variant, { light: string; dark: string }> = {
  auth: {
    light: '/bgimages/lightOne.jpeg',
    dark: '/bgimages/darkOne.jpeg',
  },
  dashboard: {
    light: '/bgimages/lightTwo.jpeg',
    dark: '/bgimages/darkTwo.jpeg',
  },
}

function resolveMode(theme: string): 'light' | 'dark' {
  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  // `system` — read the OS preference at call time.
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemedBackground({ variant }: { variant: Variant }) {
  const { theme } = useTheme()
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveMode(theme))

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolved(resolveMode(theme))
    // Track OS-level changes only while the user is on `system` — a
    // manual light/dark selection is a one-shot decision, no subscription
    // needed.
    if (theme !== 'system' || typeof window === 'undefined') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) =>
      setResolved(e.matches ? 'dark' : 'light')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [theme])

  const src = IMAGES[variant][resolved]
  // Overlay opacity is intentionally low (35/45) so the theme image is
  // clearly visible as a real background, not a faint tint. The blur on
  // the image layer (10px) keeps it soft enough to not compete with
  // foreground content. Auth screens and admin PageHero/PageChapter
  // text apply `.sgv-auth-shadow` for contrast over the busier image
  // (see index.css). Form bodies and cards keep their own `bg-card`
  // and don't need the shadow.
  const overlayClass =
    resolved === 'dark' ? 'bg-background/45' : 'bg-background/35'
  return (
    <div aria-hidden className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
      {/* Image layer. `filter: blur()` is applied directly here so the
          image itself softens; the overlay above it stays crisp.
          The negative inset covers the transparent halo `blur()` leaves
          at the edges — a blur of radius r feathers ~3r inwards, so the
          overspill has to exceed that or the viewport corners show a
          feathered outline of the page background. A percentage scale
          can't guarantee this (it yields less overspill the smaller the
          viewport), so it's a fixed pixel bleed instead. */}
      <div
        className="absolute -inset-32 bg-center bg-no-repeat bg-cover"
        style={{
          backgroundImage: `url(${src})`,
          filter: 'blur(10px)',
        }}
      />
      {/* Adds the existing `.sgv-mesh-*` radial-gradient tints (blue
          anchor + palette bleed + cyan wash) on top of the base image
          so the branded colour wash we had before this change still
          reads. Deliberately NOT `.sgv-mesh-bg` — that variant paints
          a solid `bg-background` which would cover the image. The
          `bg-background/*` opacity is the second contrast layer. */}
      <div className={`sgv-mesh-overlay absolute inset-0 ${overlayClass}`} />
    </div>
  )
}
