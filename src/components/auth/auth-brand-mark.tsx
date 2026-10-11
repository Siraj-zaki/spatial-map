import { cn } from '@/lib/utils'

/** Product name as shown on the auth screens. A brand name — not translated. */
export const PRODUCT_NAME = 'Spatial Map'

/** Logo + wordmark. */
export function AuthBrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <img src="/logo.png" alt="" aria-hidden className="h-8 w-auto" />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</span>
    </span>
  )
}
