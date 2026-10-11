import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import type { ParamInputProps } from './types'

/**
 * Boolean toggle. Uses the existing shadcn Switch primitive so the
 * visual language matches every other toggle in the app.
 */
export function ParamCheckbox({ param, value, onChange }: ParamInputProps<boolean>) {
  const id = `param-${param.id}`
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={Boolean(value)}
        onCheckedChange={(v) => onChange(Boolean(v))}
      />
      <Label htmlFor={id} className="text-sm text-muted-foreground">
        {param.label ?? param.id}
      </Label>
    </div>
  )
}
