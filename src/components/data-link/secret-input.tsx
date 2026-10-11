/**
 * Reusable masked secret input + a couple of tiny browser-crypto
 * helpers. Used by both the in-map import wizard and the
 * /integrations setup page so the editing affordances (eye toggle,
 * copy button, regen helper) stay consistent across surfaces.
 */

import { useState } from 'react'
import { CheckCircle2, Copy, Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'

export function MaskedSecretInput({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  placeholder,
  onCopy,
  copied,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  show: boolean
  onToggleShow: () => void
  placeholder?: string
  onCopy?: () => void
  copied?: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-8 text-xs font-mono flex-1"
      />
      <button
        type="button"
        onClick={onToggleShow}
        className="flex items-center justify-center w-7 h-7 rounded border border-input hover:bg-accent transition-colors flex-shrink-0"
        title={show ? 'Hide' : 'Show'}
        aria-label={show ? 'Hide secret' : 'Show secret'}
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center justify-center w-7 h-7 rounded border border-input hover:bg-accent transition-colors flex-shrink-0"
          title="Copy"
        >
          {copied ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      )}
    </div>
  )
}

/** Self-contained masked input that owns its own `show` toggle state. */
export function UncontrolledMaskedSecretInput(
  props: Omit<Parameters<typeof MaskedSecretInput>[0], 'show' | 'onToggleShow'>,
) {
  const [show, setShow] = useState(false)
  return (
    <MaskedSecretInput
      {...props}
      show={show}
      onToggleShow={() => setShow((v) => !v)}
    />
  )
}

/** URL-safe random bytes encoded as base64url — for source tokens, secrets, etc. */
export function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}
