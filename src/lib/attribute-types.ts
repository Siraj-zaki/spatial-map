/**
 * Field-type catalog for the schema builder.
 *
 * The backend persists `AttributeDefinition.type` as a free string, so we
 * use a wider taxonomy here to drive richer editor widgets in the bin /
 * shape data editors. Each entry maps a semantic type (e.g. `weight`,
 * `barcode`, `image`) to a base storage kind (text / number / boolean /
 * date / enum), an editor widget hint, and an optional default unit.
 *
 * The legacy types (`text`, `number`, `boolean`, `date`, `enum`) remain
 * valid — they keep working unchanged. New types degrade gracefully: any
 * type the UI doesn't recognise renders as a plain text input.
 */

/** Top-level category shown as an option-group in the type picker. */
export type AttributeTypeCategory =
  | 'basic'
  | 'identifier'
  | 'quantity'
  | 'status'
  | 'location'
  | 'people'
  | 'sensor'
  | 'network'
  | 'media'
  | 'freeform'

/**
 * Widget the editor renders for a value of this type. The bin / shape
 * editors switch on this to pick `<input type=…>`, a custom dropdown,
 * a media picker, etc.
 */
export type AttributeWidget =
  | 'text'
  | 'longText'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'duration'
  | 'enum'
  | 'color'
  | 'url'
  | 'email'
  | 'phone'
  | 'tags'
  | 'currency'
  | 'measure'
  | 'media'

export interface AttributeTypeDef {
  /** Stored as `AttributeDefinition.type`. snake-case where applicable. */
  id: string
  /** UI label shown in the type picker. */
  label: string
  category: AttributeTypeCategory
  widget: AttributeWidget
  /** Suggested default unit when the user picks this type. */
  defaultUnit?: string
  /**
   * Optional starter values for `enum` types. Users can edit/extend in
   * the schema editor. Mostly here so common enums (status, priority)
   * arrive with sensible options out of the box.
   */
  defaultEnumValues?: string[]
  /**
   * Help text shown under the field in the schema editor — explains
   * the intent so users pick the right type for their data.
   */
  hint?: string
}

export const ATTRIBUTE_TYPES: ReadonlyArray<AttributeTypeDef> = [
  // ── Basic ────────────────────────────────────────────────────────────
  { id: 'text',       label: 'Text',          category: 'basic', widget: 'text' },
  { id: 'long-text',  label: 'Long text',     category: 'basic', widget: 'longText' },
  { id: 'number',     label: 'Number',        category: 'basic', widget: 'number' },
  { id: 'integer',    label: 'Integer',       category: 'basic', widget: 'integer' },
  { id: 'boolean',    label: 'Yes / No',      category: 'basic', widget: 'boolean' },
  { id: 'date',       label: 'Date',          category: 'basic', widget: 'date' },
  { id: 'datetime',   label: 'Date & time',   category: 'basic', widget: 'datetime' },
  { id: 'time',       label: 'Time',          category: 'basic', widget: 'time' },
  { id: 'duration',   label: 'Duration',      category: 'basic', widget: 'duration', defaultUnit: 'min' },
  { id: 'enum',       label: 'Pick list',     category: 'basic', widget: 'enum', hint: 'A fixed list of allowed values.' },
  { id: 'color',      label: 'Color',         category: 'basic', widget: 'color' },

  // ── Identifiers ──────────────────────────────────────────────────────
  { id: 'sku',          label: 'SKU',              category: 'identifier', widget: 'text' },
  { id: 'barcode',      label: 'Barcode',          category: 'identifier', widget: 'text' },
  { id: 'qr',           label: 'QR code',          category: 'identifier', widget: 'text' },
  { id: 'rfid',         label: 'RFID / EPC',       category: 'identifier', widget: 'text' },
  { id: 'serial',       label: 'Serial number',    category: 'identifier', widget: 'text' },
  { id: 'lot',          label: 'Lot number',       category: 'identifier', widget: 'text' },
  { id: 'batch',        label: 'Batch ID',         category: 'identifier', widget: 'text' },
  { id: 'po',           label: 'PO number',        category: 'identifier', widget: 'text' },
  { id: 'asn',          label: 'ASN',              category: 'identifier', widget: 'text' },
  { id: 'vin',          label: 'VIN',              category: 'identifier', widget: 'text' },
  { id: 'license-plate', label: 'License plate',   category: 'identifier', widget: 'text' },
  { id: 'container',    label: 'Container ID',     category: 'identifier', widget: 'text' },
  { id: 'tracking',     label: 'Tracking number',  category: 'identifier', widget: 'text' },

  // ── Quantity / units ────────────────────────────────────────────────
  { id: 'quantity',    label: 'Quantity',     category: 'quantity', widget: 'number', defaultUnit: 'units' },
  { id: 'capacity',    label: 'Capacity',     category: 'quantity', widget: 'number', defaultUnit: 'units' },
  { id: 'count',       label: 'Count',        category: 'quantity', widget: 'integer' },
  { id: 'weight',      label: 'Weight',       category: 'quantity', widget: 'measure', defaultUnit: 'kg' },
  { id: 'volume',      label: 'Volume',       category: 'quantity', widget: 'measure', defaultUnit: 'L' },
  { id: 'length',      label: 'Length',       category: 'quantity', widget: 'measure', defaultUnit: 'm' },
  { id: 'area',        label: 'Area',         category: 'quantity', widget: 'measure', defaultUnit: 'm²' },
  { id: 'percentage',  label: 'Percentage',   category: 'quantity', widget: 'number', defaultUnit: '%' },
  { id: 'currency',    label: 'Currency',     category: 'quantity', widget: 'currency', defaultUnit: 'USD' },

  // ── Status ───────────────────────────────────────────────────────────
  { id: 'status',     label: 'Status',     category: 'status', widget: 'enum',
    defaultEnumValues: ['empty', 'occupied', 'reserved', 'maintenance'] },
  { id: 'priority',   label: 'Priority',   category: 'status', widget: 'enum',
    defaultEnumValues: ['low', 'medium', 'high', 'urgent'] },
  { id: 'condition',  label: 'Condition',  category: 'status', widget: 'enum',
    defaultEnumValues: ['new', 'good', 'fair', 'damaged'] },
  { id: 'severity',   label: 'Severity',   category: 'status', widget: 'enum',
    defaultEnumValues: ['info', 'warning', 'critical'] },
  { id: 'grade',      label: 'Grade',      category: 'status', widget: 'enum',
    defaultEnumValues: ['A', 'B', 'C', 'D'] },
  { id: 'hazmat-class', label: 'Hazmat class', category: 'status', widget: 'enum',
    defaultEnumValues: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  { id: 'temperature-zone', label: 'Temperature zone', category: 'status', widget: 'enum',
    defaultEnumValues: ['ambient', 'chilled', 'frozen'] },

  // ── Location ─────────────────────────────────────────────────────────
  { id: 'address',       label: 'Address',       category: 'location', widget: 'text' },
  { id: 'location-code', label: 'Location code', category: 'location', widget: 'text' },
  { id: 'aisle',         label: 'Aisle',         category: 'location', widget: 'text' },
  { id: 'bay',           label: 'Bay',           category: 'location', widget: 'text' },
  { id: 'position',      label: 'Position',      category: 'location', widget: 'text' },
  { id: 'coordinate',    label: 'Coordinate',    category: 'location', widget: 'text' },

  // ── People ───────────────────────────────────────────────────────────
  { id: 'person', label: 'Person',  category: 'people', widget: 'text' },
  { id: 'email',  label: 'Email',   category: 'people', widget: 'email' },
  { id: 'phone',  label: 'Phone',   category: 'people', widget: 'phone' },

  // ── Sensor / IoT ─────────────────────────────────────────────────────
  { id: 'temperature',  label: 'Temperature',  category: 'sensor', widget: 'measure', defaultUnit: '°C' },
  { id: 'humidity',     label: 'Humidity',     category: 'sensor', widget: 'number', defaultUnit: '%' },
  { id: 'pressure',     label: 'Pressure',     category: 'sensor', widget: 'measure', defaultUnit: 'hPa' },
  { id: 'battery',      label: 'Battery',      category: 'sensor', widget: 'number', defaultUnit: '%' },
  { id: 'signal',       label: 'Signal',       category: 'sensor', widget: 'number', defaultUnit: 'dBm' },
  { id: 'motion-state', label: 'Motion state', category: 'sensor', widget: 'enum',
    defaultEnumValues: ['idle', 'moving', 'stopped'] },
  { id: 'occupancy',    label: 'Occupancy',    category: 'sensor', widget: 'number', defaultUnit: '%' },

  // ── Network ──────────────────────────────────────────────────────────
  { id: 'url',         label: 'URL / Link',  category: 'network', widget: 'url' },
  { id: 'ip',          label: 'IP address',  category: 'network', widget: 'text' },
  { id: 'mac',         label: 'MAC address', category: 'network', widget: 'text' },
  { id: 'mqtt-topic',  label: 'MQTT topic',  category: 'network', widget: 'text' },

  // ── Media ────────────────────────────────────────────────────────────
  { id: 'image',     label: 'Image',          category: 'media', widget: 'media',
    hint: 'A URL or data: URI. Renders in the hover tooltip.' },
  { id: 'video',     label: 'Video',          category: 'media', widget: 'media',
    hint: 'A .mp4 / .webm URL. Plays in the hover tooltip.' },
  { id: 'stream',    label: 'Stream / Camera', category: 'media', widget: 'media',
    hint: 'RTSP, RTMP, or HLS .m3u8 URL.' },
  { id: 'document',  label: 'Document',       category: 'media', widget: 'media',
    hint: 'A PDF or document URL.' },
  { id: 'audio',     label: 'Audio',          category: 'media', widget: 'media',
    hint: 'A .mp3 / .ogg URL.' },

  // ── Free-form ────────────────────────────────────────────────────────
  { id: 'tags', label: 'Tags', category: 'freeform', widget: 'tags' },
]

const TYPE_BY_ID = new Map(ATTRIBUTE_TYPES.map((t) => [t.id, t]))

export function getAttributeType(id: string | undefined): AttributeTypeDef {
  if (!id) return TYPE_BY_ID.get('text')!
  return TYPE_BY_ID.get(id) ?? TYPE_BY_ID.get('text')!
}

export const ATTRIBUTE_CATEGORIES: ReadonlyArray<{ id: AttributeTypeCategory; label: string }> = [
  { id: 'basic',      label: 'Basic' },
  { id: 'identifier', label: 'Identifier' },
  { id: 'quantity',   label: 'Quantity & units' },
  { id: 'status',     label: 'Status' },
  { id: 'location',   label: 'Location' },
  { id: 'people',     label: 'People' },
  { id: 'sensor',     label: 'Sensor / IoT' },
  { id: 'network',    label: 'Network' },
  { id: 'media',      label: 'Media' },
  { id: 'freeform',   label: 'Free-form' },
]

/** Group catalog entries by category for the type-picker UI. */
export function attributeTypesByCategory(): ReadonlyArray<{
  category: AttributeTypeCategory
  label: string
  types: AttributeTypeDef[]
}> {
  return ATTRIBUTE_CATEGORIES.map((c) => ({
    category: c.id,
    label: c.label,
    types: ATTRIBUTE_TYPES.filter((t) => t.category === c.id),
  }))
}

/** Operators that make sense for a given widget. */
export function operatorsForWidget(widget: AttributeWidget): ReadonlyArray<string> {
  switch (widget) {
    case 'boolean':
      return ['equals', 'notEquals', 'isEmpty', 'isSet']
    case 'enum':
      return ['equals', 'notEquals', 'in', 'notIn', 'isEmpty', 'isSet']
    case 'number':
    case 'integer':
    case 'currency':
    case 'measure':
      return ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'isEmpty', 'isSet']
    case 'date':
    case 'datetime':
    case 'time':
    case 'duration':
      return ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'olderThan', 'newerThan', 'isEmpty', 'isSet']
    case 'tags':
      return ['contains', 'in', 'notIn', 'isEmpty', 'isSet']
    case 'media':
    case 'url':
      return ['contains', 'startsWith', 'endsWith', 'isEmpty', 'isSet']
    default:
      return ['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'in', 'notIn', 'isEmpty', 'isSet']
  }
}

/** Default value used when a bin is first created with a schema field. */
export function coerceDefaultValue(widget: AttributeWidget, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined
  switch (widget) {
    case 'number':
    case 'integer':
    case 'currency':
    case 'measure':
    case 'duration':
      return typeof raw === 'number' ? raw : Number(raw)
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      return raw === 'true' || raw === '1' || raw === 1
    case 'tags':
      if (Array.isArray(raw)) return raw
      if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
      return [raw]
    default:
      return String(raw)
  }
}
