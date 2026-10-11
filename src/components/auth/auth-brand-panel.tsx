/**
 * Start-side brand panel of the auth split screen (≥lg only).
 *
 * Full-bleed footage of the real product (captured frame by frame from the
 * viewer — the warehouse is the demo workspace's Acme Warehouse), one
 * seamless 32 s loop that covers the whole platform rather than one camera
 * move:
 *   0–13.5 s   the full warehouse orbit — racks, docks, bins, safety markers
 *              and live worker positions, every layer on
 *   13.5–24.5  the full supermarket orbit — aisles, zones, carts, safety
 *   24.5–32    push-in on live staff + equipment in the supermarket
 * Each cut dips through the page background (white / black) instead of
 * double-exposing two buildings, and the last scene dips back into the
 * first so the loop has no seam. A caption chip names the scene on screen
 * (SCENES below mirrors those timings — re-time both together).
 *
 * Assets (public/auth/): `facilities-{light,dark}.mp4` (1080p H.264, crf 31,
 * +faststart, ~8 MB) + `.jpg` posters. The supermarket was only captured
 * in light mode; the dark loop uses it through `negate,hue=h=180`, which
 * reproduces the dark map style closely (labels come out light). Recipe
 * (light shown; dark = the warehouse orbit captured with the dark map style,
 * the negate filter on inputs 1–2, and fadeblack):
 *   ffmpeg -i warehouse-footage-light/videos/rotate-full.mp4
 *     -i supermarket-footage-light/videos/sm-rotate-full.mp4
 *     -i supermarket-footage-light/videos/sm-dolly-staff.mp4 -filter_complex
 *     "[0:v]split[w1][w2];[w1]trim=1:15,setpts=PTS-STARTPTS[a];[w2]trim=0:1,setpts=PTS-STARTPTS[a0];
 *      [1:v]setpts=PTS-STARTPTS[b];[2:v]setpts=PTS-STARTPTS[c];
 *      [a][b]xfade=transition=fadewhite:duration=1:offset=13[ab];
 *      [ab][c]xfade=transition=fadewhite:duration=1:offset=24[abc];
 *      [abc][a0]xfade=transition=fadewhite:duration=1:offset=31,scale=1920:-2,format=yuv420p[v]"
 *     -map "[v]" -an -c:v libx264 -preset slow -crf 31 -movflags +faststart facilities-light.mp4
 *   poster: ffmpeg -ss 3 -i <warehouse rotate-full> -frames:v 1 -vf scale=1920:-2 -q:v 5 facilities-<mode>.jpg
 *
 * Loading: the <video> is only mounted at ≥lg (a hidden parent does not stop
 * a video from downloading); under prefers-reduced-motion the poster still
 * is shown instead. Purely decorative → aria-hidden.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, Radio, Share2 } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResolvedTheme } from '@/hooks/useResolvedTheme'
import { AuthBrandMark } from './auth-brand-mark'

/** Scene captions, keyed to the loop's timeline (seconds, exclusive end). */
const SCENES: ReadonlyArray<{ until: number; key: string }> = [
  { until: 13.5, key: 'auth.brand.sceneWarehouse' },
  { until: 24.5, key: 'auth.brand.sceneRetail' },
  { until: 31.5, key: 'auth.brand.sceneStaff' },
  { until: Infinity, key: 'auth.brand.sceneWarehouse' },
]
const sceneAt = (t: number) => SCENES.findIndex((s) => t < s.until)

function ProductFootage() {
  const { t } = useTranslation()
  const mode = useResolvedTheme()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [scene, setScene] = useState(0)
  if (!desktop) return null
  const poster = `/auth/facilities-${mode}.jpg`
  const media = 'absolute inset-0 h-full w-full object-cover'
  return (
    <>
      {reducedMotion ? (
        <img src={poster} alt="" className={media} />
      ) : (
        <video
          // Remount on mode change so the matching take loads immediately.
          key={mode}
          className={media}
          src={`/auth/facilities-${mode}.mp4`}
          poster={poster}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          onTimeUpdate={(e) => {
            const next = sceneAt(e.currentTarget.currentTime)
            if (next !== scene) setScene(next)
          }}
        />
      )}
      <div
        key={SCENES[scene].key}
        className="sgv-auth-rise absolute end-10 top-10 z-10 flex items-center gap-2 rounded-full border bg-background/85 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur xl:end-14"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        {t(SCENES[scene].key)}
      </div>
    </>
  )
}

/**
 * <lg: the same product shot as a still card above the form. A poster
 * image, not the video — 200 KB instead of 5 MB on a phone connection.
 * Hidden on short screens where it would push the form below the fold.
 */
export function AuthMobileProductShot() {
  const mode = useResolvedTheme()
  const desktop = useMediaQuery('(min-width: 1024px)')
  if (desktop) return null
  return (
    <div
      aria-hidden
      className="sgv-auth-rise mb-8 aspect-[16/9] overflow-hidden rounded-2xl border bg-muted shadow-sm [@media(max-height:700px)]:hidden"
    >
      {/* The orbit is framed wide for a full-bleed panel; zoom the still
          so the facility, not the surrounding map, fills a phone card. */}
      <img src={`/auth/facilities-${mode}.jpg`} alt="" className="h-full w-full scale-[1.6] object-cover" />
    </div>
  )
}

export function AuthBrandPanel() {
  const { t } = useTranslation()
  const features = [
    { icon: LayoutGrid, label: t('auth.brand.featureLayout') },
    { icon: Radio, label: t('auth.brand.featureLive') },
    { icon: Share2, label: t('auth.brand.featureShare') },
  ]
  return (
    <aside
      aria-hidden
      className="relative hidden h-dvh flex-col overflow-hidden border-e bg-background lg:sticky lg:top-0 lg:flex"
    >
      {/* Footage fills everything above the copy and fades into it, so the
          headline always sits on plain background — legible in every
          palette × mode, at every viewport height, whatever frame is up. */}
      <div className="relative min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
        <ProductFootage />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background via-background/80 to-transparent" />
        <div className="absolute start-10 top-10 xl:start-14">
          <AuthBrandMark className="sgv-auth-rise" />
        </div>
      </div>

      <div className="relative space-y-5 px-10 pb-10 pt-2 xl:px-14 xl:pb-14">
        <div className="max-w-xl space-y-2.5">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-foreground xl:text-4xl">
            {t('auth.brand.headline')}
          </p>
          <p className="max-w-md text-[15px] leading-relaxed text-muted-foreground">{t('auth.brand.subline')}</p>
        </div>
        <ul className="flex max-w-xl flex-wrap gap-2 [@media(max-height:700px)]:hidden">
          {features.map(({ icon: Icon, label }) => (
            <li
              key={label}
              className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1.5 text-xs font-medium text-foreground"
            >
              <Icon className="h-3.5 w-3.5 text-primary" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
