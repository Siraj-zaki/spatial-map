/**
 * Wraps a control the current role can't use: the control stays visible
 * (render it `disabled`) so people learn the feature exists, and a tooltip
 * says why it's off. `message` overrides the default editor-access copy
 * (e.g. for owner/admin-only actions).
 */

import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function RoleGate({
  allowed,
  message,
  children,
}: {
  allowed: boolean
  message?: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  if (allowed) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{message ?? t('common.needsEditor', { defaultValue: 'You need editor access in this workspace to do this.' })}</TooltipContent>
    </Tooltip>
  )
}
