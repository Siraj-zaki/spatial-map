/**
 * Renders one type-aware editor widget for a custom-property value.
 *
 * Used by both `BinEditor` (grid cells) and `ShapeDataEditor` (non-grid
 * shapes) to render the right control for each `AttributeDefinition`.
 * The widget shape is decided by the type's `widget` hint (see
 * `attribute-types.ts`) — e.g. `enum` → `<select>`, `boolean` →
 * checkbox, `media` → URL input with a kind-aware placeholder, `date`
 * → date picker.
 *
 * All widgets emit a string / number / boolean / array as appropriate
 * so the bin's `customProperties` bag stays JSON-serialisable for the
 * backend.
 */

import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AttributeDefinition } from '@/lib/db'
import { getAttributeType } from '@/lib/attribute-types'

interface Props {
  def: AttributeDefinition
  value: unknown
  onChange: (next: unknown) => void
}

export function AttributeField({ def, value, onChange }: Props) {
  const typeDef = getAttributeType(def.type)
  const unit = def.unit ?? typeDef.defaultUnit

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center justify-between text-xs">
        <span className="truncate" title={def.description}>{def.label}</span>
        {unit && (
          <span className="font-mono text-muted-foreground text-[10px]">{unit}</span>
        )}
      </Label>
      <Widget def={def} value={value} onChange={onChange} />
      {def.description && (
        <p className="text-[10px] text-muted-foreground">{def.description}</p>
      )}
    </div>
  )
}

function Widget({ def, value, onChange }: Props) {
  const typeDef = getAttributeType(def.type)
  const placeholder = def.description ?? `prop.${def.key}`

  switch (typeDef.widget) {
    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 rounded border-input"
          />
          <span className="text-xs text-muted-foreground">
            {value === true || value === 'true' ? 'Yes' : 'No'}
          </span>
        </div>
      )

    case 'enum': {
      const opts = def.enumValues ?? []
      return (
        <select
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className="h-8 w-full text-sm rounded border border-input bg-background px-2"
        >
          <option value="">— none —</option>
          {opts.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )
    }

    case 'date':
      return (
        <Input
          type="date"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-8 text-sm"
        />
      )

    case 'datetime':
      return (
        <Input
          type="datetime-local"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-8 text-sm"
        />
      )

    case 'time':
      return (
        <Input
          type="time"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-8 text-sm"
        />
      )

    case 'longText':
      return (
        <textarea
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={placeholder}
          rows={3}
          className="w-full text-sm rounded border border-input bg-background px-2 py-1.5"
        />
      )

    case 'number':
    case 'integer':
    case 'currency':
    case 'measure':
    case 'duration':
      return (
        <Input
          type="number"
          step={typeDef.widget === 'integer' ? 1 : 'any'}
          value={value === undefined || value === null ? '' : Number(value)}
          onChange={(e) =>
            onChange(e.target.value === '' ? undefined : Number(e.target.value))
          }
          placeholder={placeholder}
          className="h-8 text-sm font-mono"
        />
      )

    case 'color':
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={typeof value === 'string' && value.startsWith('#') ? value : '#6366f1'}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-input"
          />
          <Input
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value || undefined)}
            placeholder="#hex"
            className="h-8 text-sm font-mono flex-1"
          />
        </div>
      )

    case 'url':
    case 'email':
    case 'phone':
      return (
        <Input
          type={typeDef.widget}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={placeholder}
          className="h-8 text-sm"
        />
      )

    case 'media':
      return (
        <Input
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={mediaPlaceholderFor(def.type)}
          className="h-8 text-sm font-mono"
        />
      )

    case 'tags':
      return <TagsField value={value} onChange={onChange} placeholder={placeholder} />

    default:
      return (
        <Input
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={placeholder}
          className="h-8 text-sm"
        />
      )
  }
}

function mediaPlaceholderFor(typeId: string): string {
  switch (typeId) {
    case 'image':    return 'https://… or data:image/png;base64,…'
    case 'video':    return 'https://…/clip.mp4'
    case 'stream':   return 'rtsp://… or https://…/feed.m3u8'
    case 'document': return 'https://…/file.pdf'
    case 'audio':    return 'https://…/clip.mp3'
    default:         return 'https://…'
  }
}

function TagsField({
  value,
  onChange,
  placeholder,
}: {
  value: unknown
  onChange: (next: unknown) => void
  placeholder?: string
}) {
  const list = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string' && value.length > 0
    ? value.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {list.map((tag, idx) => (
          <span
            key={`${tag}-${idx}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded-full bg-muted"
          >
            {tag}
            <button
              type="button"
              onClick={() => {
                const next = list.filter((_, i) => i !== idx)
                onChange(next.length > 0 ? next : undefined)
              }}
              className="flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-destructive/20 hover:text-destructive transition-colors"
              aria-label={`Remove ${tag}`}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <Input
        placeholder={placeholder ?? 'type and press Enter'}
        className="h-8 text-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const target = e.currentTarget
            const v = target.value.trim()
            if (v.length > 0 && !list.includes(v)) {
              onChange([...list, v])
            }
            target.value = ''
          }
        }}
      />
    </div>
  )
}
