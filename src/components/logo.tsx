import { cn } from '@/lib/utils'

interface LogoProps {
  className?: string
}

export function Logo({ className }: LogoProps) {
  return (
    <svg
      className={cn('flex-shrink-0', className)}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="sgv-logo-gradient"
          x1="0"
          y1="0"
          x2="36"
          y2="36"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--primary) / 0.55)" />
        </linearGradient>
        <linearGradient
          id="sgv-logo-shine"
          x1="0"
          y1="0"
          x2="0"
          y2="36"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="white" stopOpacity="0.25" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="36" height="36" rx="9" fill="url(#sgv-logo-gradient)" />
      <rect width="36" height="36" rx="9" fill="url(#sgv-logo-shine)" />
      <path
        d="M10 10v16M26 10v16M8 14h20M8 22h20"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.85"
      />
      <circle cx="18" cy="18" r="2.75" fill="white" />
      <circle cx="18" cy="18" r="4.5" stroke="white" strokeWidth="1" opacity="0.4" />
    </svg>
  )
}
