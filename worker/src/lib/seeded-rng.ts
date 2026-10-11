/**
 * Tiny deterministic RNG for the canned test endpoint. Mulberry32 — small,
 * fast, fine for non-cryptographic test data. Seeded from `?seed=` so the
 * SPA can show stable previews.
 */

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SKUS = ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D', 'SKU-E', 'SKU-F']
const STATUSES = ['empty', 'occupied', 'reserved'] as const

export interface TestBin {
  externalCode: string
  sku: string
  capacity: number
  status: (typeof STATUSES)[number]
  notes: string
  zone: string
}

export function generateTestBins(count: number, seed: number): TestBin[] {
  const rand = mulberry32(seed)
  const rows: TestBin[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(rand() * 10) + 1
    const col = Math.floor(rand() * 10) + 1
    const level = Math.floor(rand() * 3)
    rows.push({
      externalCode: `A-${String(row).padStart(2, '0')}-${String(col).padStart(2, '0')}-L${String(level).padStart(2, '0')}`,
      sku: SKUS[Math.floor(rand() * SKUS.length)],
      capacity: Math.floor(rand() * 100),
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      notes: `Generated row ${i + 1}`,
      zone: `Zone-${Math.floor(rand() * 3) + 1}`,
    })
  }
  return rows
}
