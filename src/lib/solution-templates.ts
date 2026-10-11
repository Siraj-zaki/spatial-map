/**
 * Starting points for a new Solution and the identity palette.
 *
 * Icons are a curated, directly-imported set (not `lucide-icons.ts`, which
 * pulls in every Lucide icon) because the sidebar renders them on every
 * page. A stored id that isn't here falls back to the folder icon.
 *
 * `keywords` pre-tick items whose name matches when a template is picked —
 * a suggestion the user confirms, never an automatic membership.
 */

import {
  Boxes,
  Building,
  Cpu,
  Factory,
  Folder,
  HeartPulse,
  Hotel,
  Package,
  Plane,
  Radio,
  ShieldAlert,
  ShoppingCart,
  Thermometer,
  Truck,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'

export const SOLUTION_ICONS: Record<string, LucideIcon> = {
  'heart-pulse': HeartPulse,
  warehouse: Warehouse,
  'shopping-cart': ShoppingCart,
  'shield-alert': ShieldAlert,
  factory: Factory,
  truck: Truck,
  building: Building,
  hotel: Hotel,
  plane: Plane,
  boxes: Boxes,
  package: Package,
  radio: Radio,
  cpu: Cpu,
  thermometer: Thermometer,
  users: Users,
  folder: Folder,
}

export function solutionIcon(id: string | undefined | null): LucideIcon {
  return (id && SOLUTION_ICONS[id]) || Folder
}

/** Identity colours (stored as hex, rendered like a report's colour). */
export const SOLUTION_COLORS = ['#e11d48', '#d97706', '#059669', '#dc2626', '#7c3aed', '#2563eb', '#0d9488', '#db2777', '#475569'] as const

export interface SolutionTemplate {
  id: string
  /** i18n key under `solutions.template.*`. */
  key: string
  fallbackName: string
  fallbackDescription: string
  icon: string
  color: string
  keywords: string[]
}

export const SOLUTION_TEMPLATES: readonly SolutionTemplate[] = [
  {
    id: 'hospital',
    key: 'hospital',
    fallbackName: 'Hospital',
    fallbackDescription: 'Wards, beds, equipment tracking and patient-flow reports.',
    icon: 'heart-pulse',
    color: '#e11d48',
    keywords: ['hospital', 'clinic', 'health', 'patient', 'bed', 'medical', 'ward', 'equipment'],
  },
  {
    id: 'warehouse',
    key: 'warehouse',
    fallbackName: 'Warehouse',
    fallbackDescription: 'Racks, stock levels, forklifts and dock activity.',
    icon: 'warehouse',
    color: '#d97706',
    keywords: ['warehouse', 'stock', 'inventory', 'rack', 'pallet', 'forklift', 'dock', 'bin'],
  },
  {
    id: 'retail',
    key: 'retail',
    fallbackName: 'Retail',
    fallbackDescription: 'Store layouts, shelves, footfall and sales reports.',
    icon: 'shopping-cart',
    color: '#059669',
    keywords: ['supermarket', 'retail', 'store', 'shop', 'aisle', 'checkout', 'shelf', 'sales'],
  },
  {
    id: 'anti-theft',
    key: 'antiTheft',
    fallbackName: 'Anti-theft',
    fallbackDescription: 'RFID tags, gates, cameras and alarm events.',
    icon: 'shield-alert',
    color: '#dc2626',
    keywords: ['theft', 'security', 'rfid', 'tag', 'alarm', 'gate', 'camera', 'alert'],
  },
  {
    id: 'manufacturing',
    key: 'manufacturing',
    fallbackName: 'Manufacturing',
    fallbackDescription: 'Production lines, machines, sensors and output.',
    icon: 'factory',
    color: '#7c3aed',
    keywords: ['factory', 'plant', 'production', 'machine', 'line', 'sensor', 'output'],
  },
  {
    id: 'logistics',
    key: 'logistics',
    fallbackName: 'Logistics',
    fallbackDescription: 'Shipments, fleets, yards and delivery tracking.',
    icon: 'truck',
    color: '#2563eb',
    keywords: ['shipment', 'truck', 'fleet', 'logistics', 'delivery', 'yard', 'route'],
  },
]

export const BLANK_TEMPLATE: SolutionTemplate = {
  id: '',
  key: 'blank',
  fallbackName: 'Blank solution',
  fallbackDescription: 'Start empty and pick everything yourself.',
  icon: 'folder',
  color: '#475569',
  keywords: [],
}

export function matchesKeywords(name: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false
  const n = name.toLowerCase()
  return keywords.some((k) => n.includes(k))
}
