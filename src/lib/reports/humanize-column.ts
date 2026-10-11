/**
 * Fallback header for a report column with no configured label:
 * `product_name` → "Product name", `unitPrice` → "Unit price",
 * `sku` → "SKU". Keys that are already words ("Revenue") pass through.
 */

const ACRONYMS = new Set(['id', 'sku', 'uuid', 'url', 'ip', 'api', 'kpi', 'gtin', 'upc', 'ean', 'po', 'asn', 'soh', 'uom', 'qty'])

export function humanizeColumn(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!spaced) return key
  const words = (spaced === spaced.toUpperCase() ? spaced.toLowerCase() : spaced).split(/\s+/)
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase()
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}
