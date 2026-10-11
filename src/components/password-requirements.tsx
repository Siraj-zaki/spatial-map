/**
 * Live password-requirements checklist. Renders one row per rule with
 * a filled check when the rule is met, an empty circle otherwise.
 *
 * Every rule string comes from i18n so translations stay consistent
 * across the signup form + this component.
 */

import { Check, Circle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { evaluatePassword, MIN_PASSWORD_LENGTH } from '@/lib/password-policy'
import { cn } from '@/lib/utils'

interface Props {
  password: string
  /** Confirm-password value for the match-indicator row. Omit to hide. */
  confirmPassword?: string
}

export function PasswordRequirements({ password, confirmPassword }: Props) {
  const { t } = useTranslation()
  const rules = evaluatePassword(password)
  const labels: Record<string, string> = {
    length: t('auth.pwRuleLength', { count: MIN_PASSWORD_LENGTH }),
    diversity: t('auth.pwRuleDiversity'),
    notCommon: t('auth.pwRuleNotCommon'),
  }
  const showMatchRow = confirmPassword !== undefined
  const passwordsMatch =
    password.length > 0 && confirmPassword && confirmPassword.length > 0 && password === confirmPassword

  return (
    <ul className="mt-2 space-y-1 text-xs">
      {rules.map((rule) => (
        <RequirementRow key={rule.id} met={rule.met} label={labels[rule.id]} />
      ))}
      {showMatchRow && (
        <RequirementRow met={Boolean(passwordsMatch)} label={t('auth.pwRuleMatch')} />
      )}
    </ul>
  )
}

function RequirementRow({ met, label }: { met: boolean; label: string }) {
  const Icon = met ? Check : Circle
  return (
    <li
      className={cn(
        'flex items-center gap-2 transition-colors',
        met ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <Icon className={cn('h-3 w-3 shrink-0', met ? 'fill-primary/20' : '')} strokeWidth={met ? 3 : 2} />
      <span>{label}</span>
    </li>
  )
}
