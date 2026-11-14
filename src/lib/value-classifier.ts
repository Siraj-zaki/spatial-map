/**
 * Semantic value classifier for the map tooltip.
 *
 * Inspects a (key, value) pair from ANY domain and returns a typed
 * descriptor (`kind`, `variant`, `display`, `icon`, …) the tooltip
 * renderer can paint with the right icon, color, and formatting.
 *
 * Domains covered:
 *   - Logistics & Supply Chain: container ISO 6346, VIN, IMO, GTIN /
 *     EAN / UPC / SSCC / ISBN, tracking numbers (UPS/FedEx/USPS/DHL),
 *     PO/BOL/ASN refs, incoterms, HS codes, IATA airport codes
 *   - WMS / Warehouse / Bin: status, occupancy, aisle/rack/level codes,
 *     pallet/lot/batch, ABC classification, reorder point
 *   - Inventory / Retail: SKU, GTIN, price, currency, in-stock states
 *   - Assets / Fleet: equipment ID, mileage, fuel level, operator,
 *     license plate, registration / insurance expiry
 *   - IoT / Sensors: temperature, humidity, pressure, battery, RSSI,
 *     CO2 / PM2.5 / PM10 / AQI / TVOC, vibration, tilt, flow, sound (dB),
 *     light (lux), power (W/kW), energy (Wh/kWh), voltage / current /
 *     frequency, motion, door / valve / gate states, smoke / gas alarms
 *   - RFID / EPC / Auto-ID: urn:epc, SGTIN, GIAI, SSCC, GLN, GS1, MAC,
 *     hex tag UIDs, antenna #, read count, phase angle
 *   - Camera / Video / CCTV: RTSP/RTMP/SRT/HLS streams, ONVIF, codec,
 *     resolution, FPS, bitrate, PTZ position
 *   - Networking: IPv4/IPv6, port, protocol, MQTT topic, MAC addresses
 *   - Security / Access: badge ID, access state, lock state
 *   - Compliance / Hazmat: UN numbers (UN1234), ADR/IMDG hazard class,
 *     temperature classification, expiration with relative time
 *   - Manufacturing: work order, OEE, defect rate, cycle time, MTBF
 *   - Priority / Severity / Grade / Direction (compass)
 *   - Time: ISO 8601, cron expressions, ISO 8601 durations, relative time
 *
 * Pure module — no DOM, no React.
 */

export type ValueKind =
  // states & ratings
  | 'status'
  | 'priority'
  | 'severity'
  | 'grade'
  | 'boolean'
  | 'door'
  | 'motion'
  | 'gas'
  | 'smoke'
  | 'lock'
  | 'valve'
  | 'power-state'
  | 'connection'
  // time
  | 'date'
  | 'datetime'
  | 'time'
  | 'duration'
  | 'iso-duration'
  | 'cron'
  | 'timezone'
  // sensors / measurements
  | 'temperature'
  | 'humidity'
  | 'pressure'
  | 'battery'
  | 'signal'
  | 'light'
  | 'sound'
  | 'vibration'
  | 'tilt'
  | 'flow'
  | 'speed'
  | 'air-quality'
  | 'percentage'
  | 'power'
  | 'energy'
  | 'voltage'
  | 'current'
  | 'frequency'
  | 'measurement'
  | 'angle'
  | 'concentration'
  // money / qty
  | 'currency'
  | 'currency-code'
  | 'number'
  // location / geography
  | 'coordinate'
  | 'country-code'
  | 'direction'
  | 'altitude'
  // identifiers
  | 'epc'
  | 'identifier'
  | 'vin'
  | 'container'
  | 'tracking'
  | 'barcode'
  | 'imei'
  | 'iccid'
  | 'license-plate'
  | 'hazmat'
  | 'incoterm'
  // network
  | 'mac'
  | 'ip'
  | 'port'
  | 'protocol'
  | 'mqtt-topic'
  | 'email'
  | 'phone'
  | 'url'
  // misc
  | 'color'
  | 'fileSize'
  | 'json'
  | 'array'
  | 'tag'
  | 'text'

export type ValueVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'critical'
  | 'info'
  | 'neutral'
  | 'primary'
  | 'cool'
  | 'hot'

export type IconName =
  // status / general
  | 'activity' | 'check-circle' | 'alert-triangle' | 'x-circle' | 'info' | 'circle'
  | 'shield' | 'shield-alert' | 'shield-check' | 'flag' | 'badge'
  // sensors
  | 'thermometer' | 'droplets' | 'gauge' | 'battery' | 'battery-low' | 'signal'
  | 'wind' | 'sun' | 'moon' | 'snowflake' | 'flame' | 'cloud-fog'
  | 'leaf' | 'lightbulb' | 'volume-2' | 'waves' | 'activity-square'
  // power / electrical
  | 'zap' | 'plug' | 'plug-zap' | 'power' | 'bolt'
  // measurement
  | 'percent' | 'dollar-sign' | 'ruler' | 'weight' | 'box' | 'scale'
  | 'compass' | 'navigation'
  // location / geo
  | 'map-pin' | 'globe' | 'route' | 'pin'
  // identifiers
  | 'qr-code' | 'barcode' | 'scan' | 'hash' | 'fingerprint'
  // hardware
  | 'cpu' | 'wifi' | 'network' | 'server' | 'router' | 'hard-drive'
  | 'satellite' | 'antenna'
  // comm
  | 'mail' | 'phone' | 'link' | 'message-square' | 'send'
  // visual / style
  | 'palette' | 'image' | 'eye' | 'eye-off'
  // data
  | 'braces' | 'list' | 'database' | 'table' | 'file-text'
  // tag / type / label
  | 'tag' | 'type' | 'bookmark' | 'sticker'
  // time
  | 'calendar' | 'clock' | 'timer' | 'alarm-clock' | 'hourglass'
  // toggle / bool
  | 'toggle-left' | 'toggle-right' | 'check' | 'x'
  // people
  | 'user' | 'users' | 'briefcase' | 'hard-hat'
  // logistics / transport
  | 'package' | 'package-2' | 'package-open' | 'truck' | 'ship'
  | 'plane' | 'train' | 'car' | 'forklift' | 'warehouse'
  | 'container' | 'pallet'
  // camera / media
  | 'camera' | 'radio' | 'video' | 'monitor'
  // security
  | 'lock' | 'unlock' | 'key' | 'door-open' | 'door-closed'
  // hazard
  | 'flame-kindling' | 'biohazard' | 'radiation' | 'skull'
  // manufacturing
  | 'factory' | 'wrench' | 'cog' | 'circuit-board'
  // navigation / arrows
  | 'arrow-up' | 'arrow-down' | 'arrow-up-right' | 'arrow-down-right'
  | 'trending-up' | 'trending-down'

export interface ClassifiedValue {
  kind: ValueKind
  variant?: ValueVariant
  display: string
  hint?: string
  icon?: IconName
  raw: unknown
  items?: ClassifiedValue[]
  json?: string
  css?: string
}

// ====================================================================
// KEY HINTS — `key`-name → presumed kind. Used as a soft override when
// the value itself is ambiguous (e.g. bare numbers under `temperature`).
// ====================================================================

const KEY_HINTS: Array<{ re: RegExp; kind: ValueKind; icon?: IconName }> = [
  // ── general state / health
  { re: /^(status|state|health|condition|availability|mode|phase|stage)$/i, kind: 'status', icon: 'activity' },
  // ── priority / severity / grade
  { re: /^(priority|prio|importance|urgency)$/i, kind: 'priority', icon: 'flag' },
  { re: /^(severity|risk|impact|sev)$/i, kind: 'severity', icon: 'shield-alert' },
  { re: /^(grade|rating|class|tier|level|abc|classification|quality_grade)$/i, kind: 'grade', icon: 'badge' },
  // ── compliance / hazmat
  { re: /^(hazmat|hazard|hazard_class|adr|imdg|iata_dgr|un_number|un_no|dangerous_goods|dg_class)$/i, kind: 'hazmat', icon: 'flame-kindling' },
  { re: /^(incoterm|incoterms|trade_term)$/i, kind: 'incoterm', icon: 'route' },
  // ── sensor readings
  { re: /^(temp|temperature|ambient_temp|surface_temp|core_temp|cpu_temp|return_temp|supply_temp)$/i, kind: 'temperature', icon: 'thermometer' },
  { re: /^(humidity|rh|relative_humidity|moisture)$/i, kind: 'humidity', icon: 'droplets' },
  { re: /^(pressure|barometric_pressure|psi|bar|hpa|kpa|mpa|atmospheric_pressure|tire_pressure)$/i, kind: 'pressure', icon: 'gauge' },
  { re: /^(battery|batt|charge|battery_level|battery_percent|soc|state_of_charge|fuel_level|tank_level)$/i, kind: 'battery', icon: 'battery' },
  { re: /^(signal|rssi|signal_strength|signal_level|snr|sinr|csq)$/i, kind: 'signal', icon: 'signal' },
  { re: /^(light|lux|illuminance|brightness|ambient_light)$/i, kind: 'light', icon: 'sun' },
  { re: /^(sound|noise|db|spl|decibels|volume|sound_level|noise_level)$/i, kind: 'sound', icon: 'volume-2' },
  { re: /^(vibration|acceleration|accel|shock|g_force|g_load)$/i, kind: 'vibration', icon: 'activity-square' },
  { re: /^(tilt|inclination|incline|pitch|roll|yaw|orientation_angle)$/i, kind: 'tilt', icon: 'compass' },
  { re: /^(flow|flow_rate|throughput_l|gpm|cfm|m3h|liters_per_min)$/i, kind: 'flow', icon: 'waves' },
  { re: /^(speed|velocity|rpm|km_h|mph|knots)$/i, kind: 'speed', icon: 'gauge' },
  { re: /^(co2|co_2|carbon_dioxide|pm25|pm2_5|pm10|pm_10|tvoc|voc|ozone|o3|so2|no2|nox|nh3|aqi|air_quality|air_quality_index|pm1|formaldehyde|hcho)$/i, kind: 'air-quality', icon: 'cloud-fog' },
  // ── power / energy / electrical
  { re: /^(power|watts|wattage|active_power|reactive_power|apparent_power|kw|hp|horsepower)$/i, kind: 'power', icon: 'zap' },
  { re: /^(energy|kwh|wh|consumption|consumption_kwh|energy_used|energy_total)$/i, kind: 'energy', icon: 'plug-zap' },
  { re: /^(voltage|volt|volts|v_dc|v_ac|line_voltage)$/i, kind: 'voltage', icon: 'bolt' },
  { re: /^(current|amperage|amps|amperes|ma|line_current)$/i, kind: 'current', icon: 'bolt' },
  { re: /^(frequency|freq|hz|line_frequency)$/i, kind: 'frequency', icon: 'activity' },
  // ── states / discrete sensors
  { re: /^(door|gate|hatch|hatchback|trunk|tailgate|cargo_door|loading_door|door_state)$/i, kind: 'door', icon: 'door-open' },
  { re: /^(motion|movement|pir|occupancy|presence)$/i, kind: 'motion', icon: 'activity' },
  { re: /^(gas|gas_leak|leak|co|carbon_monoxide|methane|propane|lpg|natural_gas)$/i, kind: 'gas', icon: 'biohazard' },
  { re: /^(smoke|fire|flame|smoke_detector|fire_alarm)$/i, kind: 'smoke', icon: 'flame' },
  { re: /^(lock|lock_state|door_lock|padlock)$/i, kind: 'lock', icon: 'lock' },
  { re: /^(valve|valve_state|valve_position)$/i, kind: 'valve', icon: 'cog' },
  { re: /^(power_state|power_status|on_off|switch_state)$/i, kind: 'power-state', icon: 'power' },
  { re: /^(connection|connectivity|network_state|link_state|online_state)$/i, kind: 'connection', icon: 'wifi' },
  // ── identifiers / asset tags
  { re: /^(epc|epc_tag|gs1|sgtin|sgtin96|sgtin198|tid|user_memory|epc_hex)$/i, kind: 'epc', icon: 'qr-code' },
  { re: /^(rfid|rfid_uid|tag_id|tag|uid|uuid|asset_id|asset_tag|serial|serial_no|serial_number|sn|item_id|object_id|node_id|device_id|sensor_id|reader_id|antenna_id)$/i, kind: 'identifier', icon: 'fingerprint' },
  { re: /^(barcode|gtin|gtin8|gtin12|gtin13|gtin14|ean|ean8|ean13|upc|upca|upce|isbn|issn|sscc|gln|giai|gsin)$/i, kind: 'barcode', icon: 'barcode' },
  { re: /^(vin|vehicle_id|vehicle_number|chassis|chassis_number)$/i, kind: 'vin', icon: 'car' },
  { re: /^(container|container_id|container_no|container_number|iso6346)$/i, kind: 'container', icon: 'container' },
  { re: /^(tracking|tracking_no|tracking_number|awb|air_waybill|bol|bill_of_lading|consignment)$/i, kind: 'tracking', icon: 'package-2' },
  { re: /^(license_plate|plate|registration|reg|reg_number|car_plate)$/i, kind: 'license-plate', icon: 'car' },
  { re: /^(imei|imsi|meid)$/i, kind: 'imei', icon: 'cpu' },
  { re: /^(iccid|sim_id|sim_serial)$/i, kind: 'iccid', icon: 'cpu' },
  { re: /^(mac|mac_address|bssid|hw_addr)$/i, kind: 'mac', icon: 'wifi' },
  { re: /^(ip|ip_address|ipv4|ipv6|host|hostname|server_ip|gateway|dns)$/i, kind: 'ip', icon: 'network' },
  { re: /^(port|tcp_port|udp_port|listening_port)$/i, kind: 'port', icon: 'router' },
  { re: /^(protocol|scheme|transport)$/i, kind: 'protocol', icon: 'network' },
  { re: /^(topic|mqtt_topic|channel|queue|exchange|routing_key)$/i, kind: 'mqtt-topic', icon: 'send' },
  // ── contact
  { re: /^(email|e_?mail|contact_email|notify_email)$/i, kind: 'email', icon: 'mail' },
  { re: /^(phone|mobile|cell|tel|contact_phone|whatsapp|sms_phone)$/i, kind: 'phone', icon: 'phone' },
  // ── geo
  { re: /^(lat|latitude|lng|lon|long|longitude|gps|geo|geolocation|coordinates|coord)$/i, kind: 'coordinate', icon: 'map-pin' },
  { re: /^(country|country_code|iso_country|origin_country|destination_country)$/i, kind: 'country-code', icon: 'globe' },
  { re: /^(currency_code|iso_currency|ccy)$/i, kind: 'currency-code', icon: 'dollar-sign' },
  { re: /^(direction|heading|bearing|compass|wind_direction)$/i, kind: 'direction', icon: 'compass' },
  { re: /^(altitude|elevation|height_above_sea|asl|msl|amsl|agl)$/i, kind: 'altitude', icon: 'arrow-up' },
  // ── time
  { re: /^(date|day|expiry|expires|expiry_date|expires_at|due_date|production_date|manufactured|mfg|mfg_date|best_before|use_by|delivery_date|ship_date|harvest_date|installation_date|warranty_until|next_maintenance|next_service|next_calibration|last_calibration|certified_until)$/i, kind: 'date', icon: 'calendar' },
  { re: /^(time|timestamp|created_at|updated_at|last_seen|last_seen_at|last_synced|last_synced_at|last_event|last_event_at|scanned_at|received_at|seen|ts|when|moved_at|last_movement|last_read|last_login|last_active|inserted_at|completed_at|started_at|finished_at|deleted_at)$/i, kind: 'datetime', icon: 'clock' },
  { re: /^(duration|elapsed|runtime|uptime|downtime|age|dwell|dwell_time|cycle_time|hold_time|lead_time|response_time|latency|service_time|wait_time|processing_time)$/i, kind: 'duration', icon: 'timer' },
  { re: /^(cron|schedule|cron_expression|crontab)$/i, kind: 'cron', icon: 'alarm-clock' },
  { re: /^(timezone|tz|time_zone|offset|utc_offset)$/i, kind: 'timezone', icon: 'globe' },
  // ── money / qty
  { re: /^(price|cost|amount|total|revenue|value|usd|eur|gbp|cny|inr|sale_price|list_price|unit_price|net_price|gross_price|subtotal|tax|vat|discount|fee|shipping_cost|invoice_amount)$/i, kind: 'currency', icon: 'dollar-sign' },
  { re: /^(weight|gross_weight|net_weight|tare_weight|mass|kg|lb|tonnage|payload)$/i, kind: 'measurement', icon: 'weight' },
  { re: /^(quantity|qty|count|units|stock|on_hand|reserved_qty|available_qty|allocated_qty|min_stock|max_stock|reorder_point|safety_stock|backorder)$/i, kind: 'number', icon: 'package' },
  { re: /^(dimensions|dim|length|width|depth|girth|circumference|diameter|radius|perimeter|wheelbase)$/i, kind: 'measurement', icon: 'ruler' },
  { re: /^(volume|capacity_l|capacity_ml|displacement|cubic|cbm|cft)$/i, kind: 'measurement', icon: 'box' },
  // ── people / ownership
  { re: /^(owner|assigned_to|assignee|user|operator|driver|technician|contact_name|created_by|updated_by|inspector|approver|signed_by|carrier|customer|supplier|vendor|consignee|consignor|shipper)$/i, kind: 'tag', icon: 'user' },
  { re: /^(department|dept|team|division|business_unit|bu)$/i, kind: 'tag', icon: 'briefcase' },
  // ── camera / video
  { re: /^(stream|rtsp|rtmp|hls|dash|video_url|camera_url|feed_url|live_stream)$/i, kind: 'url', icon: 'radio' },
  { re: /^(codec|video_codec|audio_codec|encoding)$/i, kind: 'tag', icon: 'video' },
  { re: /^(resolution|video_resolution)$/i, kind: 'tag', icon: 'monitor' },
  { re: /^(fps|frame_rate|framerate)$/i, kind: 'number', icon: 'video' },
  { re: /^(bitrate|video_bitrate)$/i, kind: 'measurement', icon: 'gauge' },
  // ── files / data
  { re: /^(size|file_size|disk_usage|memory_usage|storage|payload_size)$/i, kind: 'fileSize', icon: 'hard-drive' },
  { re: /^(checksum|md5|sha1|sha256|sha512|hash)$/i, kind: 'identifier', icon: 'fingerprint' },
  { re: /^(version|ver|firmware|firmware_version|sw_version|hw_version|build|build_number)$/i, kind: 'tag', icon: 'tag' },
]

// ====================================================================
// STATUS WORDS — value-string → variant. Compared case-insensitively.
// ====================================================================

const STATUS_WORDS: Record<string, ValueVariant> = {
  // success / positive
  active: 'success', online: 'success', ok: 'success', okay: 'success',
  healthy: 'success', ready: 'success', available: 'success', normal: 'success',
  running: 'success', connected: 'success', success: 'success', successful: 'success',
  done: 'success', complete: 'success', completed: 'success', resolved: 'success',
  verified: 'success', delivered: 'success', received: 'success', shipped: 'success',
  approved: 'success', accepted: 'success', enabled: 'success', on: 'success',
  passed: 'success', granted: 'success', authorized: 'success', authenticated: 'success',
  charged: 'success', full: 'success', stocked: 'success', operational: 'success',
  compliant: 'success', calibrated: 'success', valid: 'success', live: 'success',
  fresh: 'success', new: 'success', clean: 'success', secure: 'success',
  locked: 'success', armed: 'success', closed: 'success', sealed: 'success',
  paid: 'success', confirmed: 'success', cleared: 'success', synced: 'success',
  pass: 'success', good: 'success', positive: 'success',
  'in stock': 'success', instock: 'success', 'in-stock': 'success',
  'on time': 'success', ontime: 'success',
  // warning / caution
  warning: 'warning', warn: 'warning', pending: 'warning', idle: 'warning',
  low: 'warning', partial: 'warning', maintenance: 'warning', degraded: 'warning',
  slow: 'warning', syncing: 'warning', reserved: 'warning', paused: 'warning',
  queued: 'warning', delayed: 'warning', stale: 'warning', triage: 'warning',
  backlog: 'warning', staging: 'warning', draft: 'warning', review: 'warning',
  inspecting: 'warning', testing: 'warning', verifying: 'warning',
  uncertified: 'warning', unverified: 'warning', preliminary: 'warning',
  caution: 'warning', soft: 'warning',
  charging: 'warning', discharging: 'warning',
  ajar: 'warning', open: 'warning', unlocked: 'warning', disarmed: 'warning',
  outdated: 'warning', overdue: 'warning', expiring: 'warning',
  near: 'warning', medium: 'warning', mid: 'warning',
  'in review': 'warning', inreview: 'warning',
  'low stock': 'warning', 'low-stock': 'warning', lowstock: 'warning',
  'needs review': 'warning', 'pending approval': 'warning',
  // danger / failure
  critical: 'critical', urgent: 'critical', emergency: 'critical', high: 'danger',
  error: 'danger', down: 'danger', offline: 'danger', failed: 'danger',
  fail: 'danger', failure: 'danger', fault: 'danger', dead: 'danger',
  lost: 'danger', alarm: 'danger', broken: 'danger', alert: 'danger',
  alerted: 'danger', stopped: 'danger', halted: 'danger', frozen: 'danger',
  rejected: 'danger', expired: 'danger', missing: 'danger', timeout: 'danger',
  disconnected: 'danger', unauthorized: 'danger', forbidden: 'danger',
  blocked: 'danger', denied: 'danger', cancelled: 'danger', canceled: 'danger',
  voided: 'danger', terminated: 'danger', destroyed: 'danger',
  contaminated: 'danger', spoiled: 'danger', damaged: 'danger',
  unhealthy: 'danger', breach: 'danger', breached: 'danger',
  detected: 'danger', triggered: 'danger', tripped: 'danger', fire: 'critical',
  smoke: 'danger', leak: 'danger',
  'non-compliant': 'danger', noncompliant: 'danger', 'non compliant': 'danger',
  'out of stock': 'danger', 'out-of-stock': 'danger', outofstock: 'danger',
  'past due': 'danger', overheating: 'critical', overheated: 'critical',
  // info / in-progress
  info: 'info', scheduled: 'info', processing: 'info', transferring: 'info',
  picking: 'info', moving: 'info', loading: 'info', unloading: 'info',
  occupied: 'info', tracking: 'info', returning: 'info', inbound: 'info',
  outbound: 'info', delivering: 'info', dispatched: 'info', escalated: 'info',
  acknowledged: 'info', triaged: 'info', assigned: 'info',
  reconnecting: 'info', connecting: 'info', booting: 'info', starting: 'info',
  initializing: 'info', updating: 'info', upgrading: 'info', installing: 'info',
  observing: 'info', monitoring: 'info', researching: 'info',
  todo: 'info', planned: 'info',
  'in transit': 'info', 'in-transit': 'info', intransit: 'info',
  'in progress': 'info', inprogress: 'info', 'in-progress': 'info',
  'on hold': 'info', onhold: 'info', wip: 'info',
  // neutral
  empty: 'neutral', none: 'neutral', unknown: 'neutral', 'n/a': 'neutral',
  na: 'neutral', null: 'neutral', default: 'neutral', off: 'neutral',
  disabled: 'neutral', inactive: 'neutral', archived: 'neutral',
  'not applicable': 'neutral', notapplicable: 'neutral',
  standby: 'neutral', sleep: 'neutral', hibernate: 'neutral', sleeping: 'neutral',
  ended: 'neutral', closed_complete: 'neutral', retired: 'neutral',
  obsolete: 'neutral', deprecated: 'neutral', historical: 'neutral',
  // door / motion / discrete
  detected_yes: 'warning', clear: 'success', open_state: 'warning',
  // priority / severity literals
  p0: 'critical', p1: 'danger', p2: 'warning', p3: 'info', p4: 'neutral',
  sev0: 'critical', sev1: 'danger', sev2: 'warning', sev3: 'info', sev4: 'neutral',
  blocker: 'critical', trivial: 'neutral', minor: 'info', major: 'warning',
  // grade
  'a+': 'success', a: 'success', 'a-': 'success',
  'b+': 'info', b: 'info', 'b-': 'info',
  'c+': 'warning', c: 'warning', 'c-': 'warning',
  d: 'danger', f: 'danger', e: 'danger',
  // ABC inventory class
  class_a: 'success', class_b: 'info', class_c: 'warning',
}

// ====================================================================
// DOMAIN DICTIONARIES
// ====================================================================

const INCOTERMS = new Set([
  'EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP',
  'FAS', 'FOB', 'CFR', 'CIF',
])

// Most-used ISO 3166-1 alpha-2 country codes. Limited to common ones to
// avoid false positives on 2-letter strings that aren't really countries.
const COUNTRY_ALPHA2 = new Set([
  'US', 'GB', 'CN', 'JP', 'DE', 'FR', 'IT', 'ES', 'CA', 'AU', 'NZ',
  'IN', 'PK', 'BD', 'ID', 'PH', 'TH', 'VN', 'MY', 'SG', 'KR', 'KP',
  'TW', 'HK', 'MO', 'RU', 'UA', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG',
  'GR', 'TR', 'CY', 'PT', 'BE', 'NL', 'LU', 'CH', 'AT', 'LI', 'IE',
  'IS', 'NO', 'SE', 'FI', 'DK', 'EE', 'LV', 'LT', 'BY', 'MD', 'GE',
  'AM', 'AZ', 'KZ', 'UZ', 'KG', 'TJ', 'TM', 'AF', 'IR', 'IQ', 'SY',
  'LB', 'JO', 'IL', 'PS', 'SA', 'YE', 'OM', 'AE', 'QA', 'BH', 'KW',
  'EG', 'LY', 'TN', 'DZ', 'MA', 'SD', 'SS', 'ER', 'DJ', 'SO', 'ET',
  'KE', 'UG', 'TZ', 'RW', 'BI', 'CD', 'CG', 'CF', 'CM', 'GA', 'GQ',
  'TD', 'NE', 'NG', 'BJ', 'TG', 'GH', 'CI', 'LR', 'SL', 'GN', 'GW',
  'SN', 'GM', 'ML', 'BF', 'MR', 'CV', 'ST', 'AO', 'NA', 'ZA', 'BW',
  'ZW', 'ZM', 'MW', 'MZ', 'MG', 'MU', 'SC', 'KM', 'BR', 'AR', 'CL',
  'UY', 'PY', 'BO', 'PE', 'EC', 'CO', 'VE', 'GY', 'SR', 'GF', 'PA',
  'CR', 'NI', 'HN', 'SV', 'GT', 'BZ', 'MX', 'CU', 'JM', 'HT', 'DO',
  'PR', 'BS', 'BB', 'TT', 'GD', 'LC', 'VC', 'AG', 'KN', 'DM', 'AW',
  'MQ', 'GP', 'BM', 'KY', 'TC', 'VG', 'AI', 'MS', 'FK', 'GS', 'PM',
])

const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'AUD', 'CAD', 'CHF', 'HKD',
  'SGD', 'KRW', 'TWD', 'THB', 'IDR', 'MYR', 'PHP', 'VND', 'PKR', 'BDT',
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'EGP', 'TRY', 'ILS',
  'RUB', 'UAH', 'BYN', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'SEK', 'NOK',
  'DKK', 'ISK', 'BRL', 'ARS', 'CLP', 'COP', 'MXN', 'PEN', 'UYU', 'VEF',
  'ZAR', 'NGN', 'KES', 'GHS', 'MAD', 'TND', 'XOF', 'XAF', 'NZD', 'FJD',
])

const PROTOCOLS = new Set([
  'http', 'https', 'mqtt', 'mqtts', 'amqp', 'amqps', 'coap', 'modbus',
  'opcua', 'opc-ua', 'bacnet', 'tcp', 'udp', 'ssh', 'sftp', 'ftp', 'ftps',
  'smtp', 'imap', 'pop3', 'snmp', 'ntp', 'lorawan', 'zigbee', 'z-wave',
  'ble', 'nfc', 'rfid', 'wifi', 'ethernet', 'rs232', 'rs485', 'canbus',
])

// Compass directions, ordered short → long so longer matches win.
const COMPASS = new Set([
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
])

// ====================================================================
// REGEX LIBRARY
// ====================================================================

const RE = {
  // color
  hexColor: /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  rgbColor: /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$/i,
  hslColor: /^hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*(?:,\s*[\d.]+\s*)?\)$/i,
  // network
  mac: /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
  ipv6: /^(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}$/i,
  // contact
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^\+?[\d][\d\s().-]{6,}\d$/,
  // time
  iso: /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  isoDuration: /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/,
  cron: /^(?:[\d*/,\-?LW#]+\s+){4,6}[\d*/,\-?LW#]+$/,
  timezone: /^(?:UTC|GMT)?[+-]\d{1,2}(?::?\d{2})?$|^(?:[A-Z][a-z_]+\/[A-Z][a-zA-Z_]+)$/,
  // identifiers
  epc: /^urn:epc:|^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f]{16}$/i,
  vin: /^[A-HJ-NPR-Z0-9]{17}$/i,                  // ISO 3779
  container: /^[A-Z]{3}U\d{7}$/,                  // ISO 6346
  imei: /^\d{15}$/,
  iccid: /^\d{19,22}$/,
  ean8: /^\d{8}$/,
  upc: /^\d{12}$/,
  ean13: /^\d{13}$/,
  gtin14: /^\d{14}$/,
  sscc: /^\d{18}$/,
  isbn13: /^97[89]\d{10}$/,
  hazmatUn: /^UN\d{4}$/i,
  hazardClass: /^[1-9](?:\.\d[A-Z]?)?$/,
  hexUid: /^[0-9a-f]{8,32}$/i,
  // shipping
  upsTracking: /^1Z[A-Z0-9]{16}$/i,
  fedex12: /^\d{12}$/,
  fedex15: /^\d{15}$/,
  uspsTracking: /^(94|93|92|95|82)\d{20}$/,
  dhl: /^\d{10,11}$/,
  // license plate (very loose — most countries)
  licensePlate: /^[A-Z0-9]{2,4}[\s-]?[A-Z0-9]{2,4}[\s-]?[A-Z0-9]{0,4}$/i,
  // measurement (unified — covers IoT, manufacturing, mech, electrical)
  measurement: /^(-?\d+(?:[.,]\d+)?)\s*(°c|°f|°k|°|deg|c|f|k|kg|g|mg|μg|ug|t|lb|lbs|oz|st|ct|m|cm|mm|nm|μm|um|km|ft|in|yd|mi|nmi|m²|m2|sqm|ft²|ft2|sqft|cm²|cm2|km²|km2|ha|acre|m³|m3|ft³|ft3|cm³|cm3|l|ml|μl|ul|cl|dl|gal|qt|pt|fl oz|psi|bar|mbar|kpa|mpa|hpa|pa|atm|mmhg|inhg|torr|%|‰|kw|w|mw|hp|kwh|wh|mwh|btu|j|kj|v|kv|mv|a|ka|ma|μa|ua|hz|khz|mhz|ghz|rpm|km\/h|kmh|mph|mps|m\/s|knots?|kn|mach|bps|kbps|mbps|gbps|tbps|kib\/s|mib\/s|gib\/s|db|dba|dbc|dbm|dbi|dbsp?l|lux|fc|cd|lm|nit|nits|g|m\/s²|mm\/s|mil|g\s?force|gpm|cfm|l\/min|m³\/h|m3\/h|ppm|ppb|ppt|μg\/m³|ug\/m³|mg\/m³|nm\/m|nm|nm·m|n\.?m|ft·lb|ft\.lb|ftlb|in·lb|kg·m|kgm|sv|usv|μsv|gy|bq|ci|ah|mah|wh|var|kvar|var\/h|ω|ohm|kω|kohm|mω|mohm|hz|mhz|°\/s|deg\/s)$/i,
  fileSize: /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib|bytes|kilobytes|megabytes|gigabytes|terabytes)$/i,
  duration: /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|yr|years)$/i,
  currency: /^([$€£¥₹₩₺₽฿])\s*(-?\d+(?:[.,]\d+)?(?:[.,]\d+)?)|^(-?\d+(?:[.,]\d+)?(?:[.,]\d+)?)\s*([A-Z]{3})$/,
  url: /^https?:\/\//i,
  streamScheme: /^(rtsp|rtmps?|srt|udp|mms):\/\//i,
  imageExt: /\.(jpe?g|png|gif|webp|svg|bmp|ico|avif|tiff?)(\?|#|$)/i,
  videoExt: /\.(mp4|webm|ogv|mov|m4v|mkv|avi)(\?|#|$)/i,
  streamExt: /\.(m3u8|mpd)(\?|#|$)/i,
  percent: /^(-?\d+(?:[.,]\d+)?)\s*%$/,
  perMille: /^(-?\d+(?:[.,]\d+)?)\s*‰$/,
  numericOnly: /^-?\d+(?:[.,]\d+)?$/,
  latLngPair: /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
  // resolution: 1920x1080, 4K, 1080p
  resolution: /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i,
  // mqtt topic — slash-separated, optional + or #
  mqttTopic: /^[a-zA-Z0-9_\-+/#]+$/,
  // port
  portOnly: /^\d{1,5}$/,
  // priority code like P1 / SEV2
  prioCode: /^(p|sev|priority|severity)[-\s]?(\d)$/i,
}

// ====================================================================
// HELPERS
// ====================================================================

function asNumber(s: string): number {
  return Number(s.replace(',', '.'))
}

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function classifyStatusWord(s: string): ValueVariant | undefined {
  const key = s.trim().toLowerCase()
  return STATUS_WORDS[key]
}

function tempVariant(value: number, unit: string): ValueVariant {
  let celsius = value
  if (/^f$/i.test(unit) || /^°f$/i.test(unit)) celsius = ((value - 32) * 5) / 9
  if (/^k$/i.test(unit)) celsius = value - 273.15
  if (celsius >= 35) return 'hot'
  if (celsius >= 25) return 'warning'
  if (celsius >= 10) return 'success'
  if (celsius >= 0) return 'cool'
  return 'info'
}
function batteryVariant(p: number): ValueVariant {
  if (p <= 15) return 'danger'
  if (p <= 35) return 'warning'
  if (p <= 70) return 'info'
  return 'success'
}
function signalVariant(dbm: number): ValueVariant {
  if (dbm >= -60) return 'success'
  if (dbm >= -75) return 'info'
  if (dbm >= -90) return 'warning'
  return 'danger'
}
function percentVariant(p: number): ValueVariant {
  if (p >= 90) return 'success'
  if (p >= 60) return 'info'
  if (p >= 30) return 'warning'
  return 'danger'
}
function lightVariant(lux: number): ValueVariant {
  if (lux < 50) return 'neutral'      // dark
  if (lux < 500) return 'info'        // normal indoor
  if (lux < 2000) return 'success'    // bright indoor
  if (lux < 20000) return 'warning'   // very bright
  return 'hot'                        // sunlight territory
}
function soundVariant(db: number): ValueVariant {
  if (db < 30) return 'neutral'
  if (db < 60) return 'success'
  if (db < 85) return 'warning'
  if (db < 100) return 'danger'
  return 'critical'
}
function co2Variant(ppm: number): ValueVariant {
  if (ppm <= 600) return 'success'
  if (ppm <= 1000) return 'info'
  if (ppm <= 2000) return 'warning'
  if (ppm <= 5000) return 'danger'
  return 'critical'
}
function pm25Variant(v: number): ValueVariant {
  if (v <= 12) return 'success'
  if (v <= 35) return 'warning'
  if (v <= 55) return 'danger'
  return 'critical'
}
function priorityVariant(p: string): ValueVariant {
  const key = p.toLowerCase()
  if (/^(p0|sev0|blocker|critical|emergency)$/.test(key)) return 'critical'
  if (/^(p1|sev1|high|urgent|major)$/.test(key)) return 'danger'
  if (/^(p2|sev2|medium|mid)$/.test(key)) return 'warning'
  if (/^(p3|sev3|low|minor)$/.test(key)) return 'info'
  return 'neutral'
}
function gradeVariant(g: string): ValueVariant {
  const key = g.toLowerCase()
  if (/^a/.test(key)) return 'success'
  if (/^b/.test(key)) return 'info'
  if (/^c/.test(key)) return 'warning'
  return 'danger'
}
function doorVariant(s: string): ValueVariant {
  const key = s.toLowerCase()
  if (/closed|shut|sealed/.test(key)) return 'success'
  if (/ajar|partial/.test(key)) return 'warning'
  if (/open/.test(key)) return 'warning'
  return 'neutral'
}
function motionVariant(s: string): ValueVariant {
  const key = s.toLowerCase()
  if (/detect|active|present|movement/.test(key)) return 'info'
  if (/clear|idle|none|no_motion/.test(key)) return 'success'
  return 'neutral'
}
function gasVariant(s: string): ValueVariant {
  const key = s.toLowerCase()
  if (/normal|safe|none|clear/.test(key)) return 'success'
  if (/detect|leak|alarm|alert/.test(key)) return 'critical'
  return 'neutral'
}
function lockVariant(s: string): ValueVariant {
  const key = s.toLowerCase()
  if (/^lock|locked$|secure/.test(key)) return 'success'
  if (/^unlock|unlocked$/.test(key)) return 'warning'
  return 'neutral'
}

function formatRelativeTime(d: Date): string | undefined {
  const ms = d.getTime() - Date.now()
  const abs = Math.abs(ms)
  const units: Array<[number, Intl.RelativeTimeFormatUnit, number]> = [
    [60_000, 'second', 1000],
    [3_600_000, 'minute', 60_000],
    [86_400_000, 'hour', 3_600_000],
    [604_800_000, 'day', 86_400_000],
    [2_629_800_000, 'week', 604_800_000],
    [31_557_600_000, 'month', 2_629_800_000],
    [Infinity, 'year', 31_557_600_000],
  ]
  let value = 0
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [limit, u, divisor] of units) {
    if (abs < limit) {
      value = Math.round(ms / divisor) || (ms < 0 ? -1 : 1)
      unit = u
      break
    }
  }
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit)
  } catch {
    return undefined
  }
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return String(seconds)
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s ? `${m}m ${s}s` : `${m}m`
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.round((seconds % 3600) / 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(seconds / 86400)
  const h = Math.round((seconds % 86400) / 3600)
  return h ? `${d}d ${h}h` : `${d}d`
}

function durationSecondsFromMatch(value: number, unit: string): number {
  const u = unit.toLowerCase()
  if (u.startsWith('ms')) return value / 1000
  if (u.startsWith('s')) return value
  if (u.startsWith('mo') || u === 'month' || u === 'months') return value * 2629800
  if (u.startsWith('m')) return value * 60
  if (u.startsWith('h')) return value * 3600
  if (u.startsWith('d')) return value * 86400
  if (u.startsWith('w')) return value * 604800
  if (u.startsWith('y')) return value * 31557600
  return value
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

function parseIsoDuration(s: string): number | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s)
  if (!m) return null
  const [, y, mo, w, d, h, mi, se] = m
  let secs = 0
  if (y) secs += +y * 31557600
  if (mo) secs += +mo * 2629800
  if (w) secs += +w * 604800
  if (d) secs += +d * 86400
  if (h) secs += +h * 3600
  if (mi) secs += +mi * 60
  if (se) secs += +se
  return secs
}

// ====================================================================
// MAIN ENTRY POINT
// ====================================================================

export function classifyKeyValue(key: string, value: unknown): ClassifiedValue {
  const hint = KEY_HINTS.find((h) => h.re.test(key))

  if (value === null || value === undefined) {
    return { kind: 'text', display: '—', variant: 'neutral', icon: 'circle', raw: value }
  }

  if (value instanceof Date) {
    return classifyString(key, value.toISOString(), value.toISOString(), hint)
  }

  if (typeof value === 'boolean') {
    return classifyBoolean(key, value, hint)
  }

  if (Array.isArray(value)) {
    const items = value.map((v) => classifyKeyValue(key, v))
    return {
      kind: 'array',
      display: `${value.length} item${value.length === 1 ? '' : 's'}`,
      icon: 'list',
      variant: 'info',
      raw: value,
      items,
    }
  }

  if (typeof value === 'object') {
    return {
      kind: 'json',
      display: 'JSON',
      icon: 'braces',
      variant: 'info',
      raw: value,
      json: safeJson(value),
    }
  }

  if (typeof value === 'number') {
    return classifyNumber(key, value, hint)
  }

  const raw = String(value)
  const s = raw.trim()
  if (s.length === 0) {
    return { kind: 'text', display: '—', variant: 'neutral', icon: 'circle', raw }
  }
  return classifyString(key, s, raw, hint)
}

// ─── boolean ──────────────────────────────────────────────────────────

function classifyBoolean(
  key: string,
  v: boolean,
  hint?: { kind: ValueKind; icon?: IconName },
): ClassifiedValue {
  // boolean under a state-y key reads better as Active / Inactive
  if (hint?.kind === 'door') {
    return {
      kind: 'door',
      display: v ? 'Open' : 'Closed',
      variant: v ? 'warning' : 'success',
      icon: v ? 'door-open' : 'door-closed',
      raw: v,
    }
  }
  if (hint?.kind === 'motion') {
    return {
      kind: 'motion',
      display: v ? 'Detected' : 'Clear',
      variant: v ? 'info' : 'success',
      icon: 'activity',
      raw: v,
    }
  }
  if (hint?.kind === 'lock') {
    return {
      kind: 'lock',
      display: v ? 'Locked' : 'Unlocked',
      variant: v ? 'success' : 'warning',
      icon: v ? 'lock' : 'unlock',
      raw: v,
    }
  }
  if (hint?.kind === 'smoke' || hint?.kind === 'gas') {
    return {
      kind: hint.kind,
      display: v ? 'Detected' : 'Normal',
      variant: v ? 'critical' : 'success',
      icon: hint.kind === 'smoke' ? 'flame' : 'biohazard',
      raw: v,
    }
  }
  if (hint?.kind === 'connection') {
    return {
      kind: 'connection',
      display: v ? 'Online' : 'Offline',
      variant: v ? 'success' : 'danger',
      icon: 'wifi',
      raw: v,
    }
  }
  if (/active|enabled|on|present|verified|approved|paid|completed/.test(key)) {
    return {
      kind: 'boolean',
      display: v ? 'Yes' : 'No',
      variant: v ? 'success' : 'neutral',
      icon: v ? 'check' : 'x',
      raw: v,
    }
  }
  return {
    kind: 'boolean',
    display: v ? 'Yes' : 'No',
    variant: v ? 'success' : 'neutral',
    icon: v ? 'toggle-right' : 'toggle-left',
    raw: v,
  }
}

// ─── numbers ──────────────────────────────────────────────────────────

function classifyNumber(
  _key: string,
  value: number,
  hint?: { kind: ValueKind; icon?: IconName },
): ClassifiedValue {
  const k = hint?.kind
  if (k === 'battery') {
    const p = Math.max(0, Math.min(100, value))
    return {
      kind: 'battery',
      display: `${value.toLocaleString()} %`,
      variant: batteryVariant(p),
      icon: p <= 20 ? 'battery-low' : 'battery',
      raw: value,
    }
  }
  if (k === 'humidity') {
    return { kind: 'humidity', display: `${value.toLocaleString()} %`, variant: 'info', icon: 'droplets', raw: value }
  }
  if (k === 'percentage') {
    return { kind: 'percentage', display: `${value.toLocaleString()} %`, variant: percentVariant(value), icon: 'percent', raw: value }
  }
  if (k === 'temperature') {
    return { kind: 'temperature', display: `${value.toLocaleString()} °C`, variant: tempVariant(value, 'c'), icon: 'thermometer', raw: value }
  }
  if (k === 'signal') {
    return { kind: 'signal', display: `${value} dBm`, variant: signalVariant(value), icon: 'signal', raw: value }
  }
  if (k === 'light') {
    return { kind: 'light', display: `${value.toLocaleString()} lux`, variant: lightVariant(value), icon: 'sun', raw: value }
  }
  if (k === 'sound') {
    return { kind: 'sound', display: `${value.toLocaleString()} dB`, variant: soundVariant(value), icon: 'volume-2', raw: value }
  }
  if (k === 'pressure') {
    return { kind: 'pressure', display: `${value.toLocaleString()} hPa`, variant: 'info', icon: 'gauge', raw: value }
  }
  if (k === 'flow') {
    return { kind: 'flow', display: `${value.toLocaleString()} L/min`, variant: 'info', icon: 'waves', raw: value }
  }
  if (k === 'speed') {
    return { kind: 'speed', display: `${value.toLocaleString()} km/h`, variant: 'info', icon: 'gauge', raw: value }
  }
  if (k === 'power') {
    return { kind: 'power', display: `${value.toLocaleString()} W`, variant: 'info', icon: 'zap', raw: value }
  }
  if (k === 'energy') {
    return { kind: 'energy', display: `${value.toLocaleString()} kWh`, variant: 'primary', icon: 'plug-zap', raw: value }
  }
  if (k === 'voltage') {
    return { kind: 'voltage', display: `${value.toLocaleString()} V`, variant: 'primary', icon: 'bolt', raw: value }
  }
  if (k === 'current') {
    return { kind: 'current', display: `${value.toLocaleString()} A`, variant: 'primary', icon: 'bolt', raw: value }
  }
  if (k === 'frequency') {
    return { kind: 'frequency', display: `${value.toLocaleString()} Hz`, variant: 'info', icon: 'activity', raw: value }
  }
  if (k === 'altitude') {
    return { kind: 'altitude', display: `${value.toLocaleString()} m`, variant: 'info', icon: 'arrow-up', raw: value }
  }
  if (k === 'tilt') {
    return { kind: 'tilt', display: `${value.toLocaleString()}°`, variant: Math.abs(value) > 30 ? 'warning' : 'info', icon: 'compass', raw: value }
  }
  if (k === 'vibration') {
    return { kind: 'vibration', display: `${value.toLocaleString()} G`, variant: value > 4 ? 'danger' : value > 1.5 ? 'warning' : 'success', icon: 'activity-square', raw: value }
  }
  if (k === 'air-quality') {
    return { kind: 'air-quality', display: `${value.toLocaleString()} ppm`, variant: co2Variant(value), icon: 'cloud-fog', raw: value }
  }
  if (k === 'priority' || k === 'severity') {
    const word = ['critical', 'danger', 'warning', 'info', 'neutral'][Math.max(0, Math.min(4, Math.floor(value)))]
    return {
      kind: k,
      display: `P${value}`,
      variant: word as ValueVariant,
      icon: k === 'severity' ? 'shield-alert' : 'flag',
      raw: value,
    }
  }
  if (k === 'port') {
    return { kind: 'port', display: String(value), variant: 'primary', icon: 'router', raw: value }
  }
  if (k === 'currency') {
    return {
      kind: 'currency',
      display: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value),
      icon: 'dollar-sign', variant: 'primary', raw: value,
    }
  }
  if (k === 'duration') {
    return { kind: 'duration', display: formatDuration(value), icon: 'timer', variant: 'info', raw: value }
  }
  if (k === 'date' || k === 'datetime' || k === 'time') {
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    if (!isNaN(d.getTime())) {
      return {
        kind: k,
        display: k === 'date' ? d.toLocaleDateString() : d.toLocaleString(),
        hint: formatRelativeTime(d),
        icon: k === 'date' ? 'calendar' : 'clock',
        variant: 'primary', raw: value,
      }
    }
  }
  if (k === 'fileSize') {
    return { kind: 'fileSize', display: formatFileSize(value), icon: 'hard-drive', variant: 'info', raw: value }
  }
  return {
    kind: 'number',
    display: value.toLocaleString(undefined, { maximumFractionDigits: 4 }),
    icon: hint?.icon ?? 'hash',
    variant: 'primary', raw: value,
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

// ─── strings ──────────────────────────────────────────────────────────

function classifyString(
  key: string,
  s: string,
  raw: string,
  hint?: { kind: ValueKind; icon?: IconName },
): ClassifiedValue {
  const lower = s.toLowerCase()
  const upper = s.toUpperCase()

  // ── status / state words ───────────────────────────────────────────
  const statusVariant = classifyStatusWord(s)
  if (statusVariant) {
    if (hint?.kind === 'priority' || hint?.kind === 'severity') {
      return {
        kind: hint.kind,
        display: humanize(s),
        variant: priorityVariant(s),
        icon: hint.kind === 'severity' ? 'shield-alert' : 'flag',
        raw,
      }
    }
    if (hint?.kind === 'door') {
      return { kind: 'door', display: humanize(s), variant: doorVariant(s), icon: /closed|shut/i.test(s) ? 'door-closed' : 'door-open', raw }
    }
    if (hint?.kind === 'motion') {
      return { kind: 'motion', display: humanize(s), variant: motionVariant(s), icon: 'activity', raw }
    }
    if (hint?.kind === 'gas' || hint?.kind === 'smoke') {
      return { kind: hint.kind, display: humanize(s), variant: gasVariant(s), icon: hint.kind === 'smoke' ? 'flame' : 'biohazard', raw }
    }
    if (hint?.kind === 'lock') {
      return { kind: 'lock', display: humanize(s), variant: lockVariant(s), icon: /^lock|locked$/i.test(s) ? 'lock' : 'unlock', raw }
    }
    if (hint?.kind === 'grade') {
      return { kind: 'grade', display: upper, variant: gradeVariant(s), icon: 'badge', raw }
    }
    if (hint?.kind === 'connection') {
      return { kind: 'connection', display: humanize(s), variant: statusVariant, icon: 'wifi', raw }
    }
    if (hint?.kind === 'power-state') {
      return { kind: 'power-state', display: humanize(s), variant: statusVariant, icon: 'power', raw }
    }
    // generic status
    if (hint?.kind === 'status' || isStatusy(key) || s.length <= 32) {
      return {
        kind: 'status',
        display: humanize(s),
        variant: statusVariant,
        icon: statusIcon(statusVariant),
        raw,
      }
    }
  }

  // ── priority / severity code (P0, SEV2) ───────────────────────────
  if (RE.prioCode.test(s)) {
    return {
      kind: /^sev/i.test(s) ? 'severity' : 'priority',
      display: s.toUpperCase().replace(/[-\s]/g, ''),
      variant: priorityVariant(s),
      icon: /^sev/i.test(s) ? 'shield-alert' : 'flag',
      raw,
    }
  }

  // ── grade (A+, A, B-, etc.) ───────────────────────────────────────
  if (hint?.kind === 'grade' && /^[a-f][+-]?$/i.test(s)) {
    return { kind: 'grade', display: upper, variant: gradeVariant(s), icon: 'badge', raw }
  }

  // ── hazmat (UN1234) ────────────────────────────────────────────────
  if (RE.hazmatUn.test(s) || hint?.kind === 'hazmat') {
    return { kind: 'hazmat', display: upper, variant: 'danger', icon: 'flame-kindling', raw }
  }

  // ── incoterms ──────────────────────────────────────────────────────
  if (INCOTERMS.has(upper) || hint?.kind === 'incoterm') {
    return { kind: 'incoterm', display: upper, variant: 'primary', icon: 'route', raw }
  }

  // ── ISO country / currency ─────────────────────────────────────────
  if (s.length === 2 && /^[A-Z]{2}$/.test(upper) && (COUNTRY_ALPHA2.has(upper) || hint?.kind === 'country-code')) {
    return { kind: 'country-code', display: upper, variant: 'primary', icon: 'globe', raw }
  }
  if (s.length === 3 && /^[A-Z]{3}$/.test(upper) && (CURRENCY_CODES.has(upper) || hint?.kind === 'currency-code')) {
    return { kind: 'currency-code', display: upper, variant: 'primary', icon: 'dollar-sign', raw }
  }

  // ── compass direction ─────────────────────────────────────────────
  if (COMPASS.has(upper) || hint?.kind === 'direction') {
    return { kind: 'direction', display: upper, variant: 'primary', icon: 'compass', raw }
  }

  // ── protocol / scheme ─────────────────────────────────────────────
  if (PROTOCOLS.has(lower) || hint?.kind === 'protocol') {
    return { kind: 'protocol', display: upper, variant: 'info', icon: 'network', raw }
  }

  // ── timezone ───────────────────────────────────────────────────────
  if (RE.timezone.test(s) || hint?.kind === 'timezone') {
    return { kind: 'timezone', display: s, variant: 'primary', icon: 'globe', raw }
  }

  // ── ISO 8601 duration ─────────────────────────────────────────────
  if (RE.isoDuration.test(s)) {
    const sec = parseIsoDuration(s)
    return {
      kind: 'iso-duration',
      display: sec !== null ? formatDuration(sec) : s,
      hint: s,
      icon: 'hourglass',
      variant: 'info',
      raw,
    }
  }

  // ── cron expression ───────────────────────────────────────────────
  if (hint?.kind === 'cron' && RE.cron.test(s)) {
    return { kind: 'cron', display: s, icon: 'alarm-clock', variant: 'info', raw }
  }

  // ── media / urls (kept before generic url) ────────────────────────
  if (/^data:image\//i.test(s) || RE.imageExt.test(s)) {
    return { kind: 'url', display: s, icon: 'image', variant: 'info', raw }
  }
  if (/^data:video\//i.test(s) || RE.videoExt.test(s)) {
    return { kind: 'url', display: s, icon: 'video', variant: 'info', raw }
  }
  if (RE.streamScheme.test(s) || RE.streamExt.test(s)) {
    return { kind: 'url', display: s, icon: 'radio', variant: 'warning', raw }
  }

  // ── color ─────────────────────────────────────────────────────────
  if (RE.hexColor.test(s) || RE.rgbColor.test(s) || RE.hslColor.test(s)) {
    return { kind: 'color', display: upper, icon: 'palette', raw, css: s }
  }

  // ── network identifiers ───────────────────────────────────────────
  if (RE.mac.test(s)) {
    return { kind: 'mac', display: upper, icon: 'wifi', variant: 'info', raw }
  }
  if (RE.ipv4.test(s) || RE.ipv6.test(s)) {
    return { kind: 'ip', display: s, icon: 'network', variant: 'info', raw }
  }
  if (RE.email.test(s)) {
    return { kind: 'email', display: s, icon: 'mail', variant: 'primary', raw }
  }

  // ── EPC / Auto-ID ─────────────────────────────────────────────────
  if (/^urn:epc:/i.test(s)) {
    return { kind: 'epc', display: s, icon: 'qr-code', variant: 'primary', raw }
  }
  if (hint?.kind === 'epc' && RE.epc.test(s)) {
    return { kind: 'epc', display: upper, icon: 'qr-code', variant: 'primary', raw }
  }

  // ── VIN ───────────────────────────────────────────────────────────
  if (RE.vin.test(s) && (hint?.kind === 'vin' || /^[A-HJ-NPR-Z0-9]{17}$/.test(s))) {
    return { kind: 'vin', display: upper, icon: 'car', variant: 'primary', raw }
  }

  // ── ISO 6346 container ────────────────────────────────────────────
  if (RE.container.test(s) || hint?.kind === 'container') {
    return { kind: 'container', display: upper, icon: 'container', variant: 'primary', raw }
  }

  // ── shipping tracking ─────────────────────────────────────────────
  if (RE.upsTracking.test(s)) {
    return { kind: 'tracking', display: upper, icon: 'package-2', variant: 'primary', hint: 'UPS', raw }
  }
  if (RE.uspsTracking.test(s)) {
    return { kind: 'tracking', display: s, icon: 'package-2', variant: 'primary', hint: 'USPS', raw }
  }
  if (hint?.kind === 'tracking') {
    return { kind: 'tracking', display: s, icon: 'package-2', variant: 'primary', raw }
  }

  // ── IMEI / ICCID ──────────────────────────────────────────────────
  if (hint?.kind === 'imei' && RE.imei.test(s)) {
    return { kind: 'imei', display: s, icon: 'cpu', variant: 'primary', raw }
  }
  if (hint?.kind === 'iccid' && RE.iccid.test(s)) {
    return { kind: 'iccid', display: s, icon: 'cpu', variant: 'primary', raw }
  }

  // ── barcodes (GTIN / EAN / UPC / SSCC / ISBN) ─────────────────────
  if (hint?.kind === 'barcode' || /^(barcode|gtin|ean|upc|sscc|isbn)$/i.test(key)) {
    if (RE.ean8.test(s) || RE.upc.test(s) || RE.ean13.test(s) || RE.gtin14.test(s) || RE.sscc.test(s) || RE.isbn13.test(s)) {
      const sub = RE.sscc.test(s) ? 'SSCC'
        : RE.gtin14.test(s) ? 'GTIN-14'
        : RE.ean13.test(s) ? 'EAN-13'
        : RE.upc.test(s) ? 'UPC-A'
        : RE.ean8.test(s) ? 'EAN-8'
        : 'ISBN'
      return { kind: 'barcode', display: s, hint: sub, icon: 'barcode', variant: 'primary', raw }
    }
  }

  // ── identifier / serial / generic alphanumeric IDs ────────────────
  if (
    (hint?.kind === 'identifier' || /^(sku|barcode|asset|serial|tag|hash|checksum|build|version|firmware)$/i.test(key))
    && /^[a-z0-9._:/-]+$/i.test(s)
  ) {
    return { kind: 'identifier', display: s, icon: hint?.icon ?? 'fingerprint', variant: 'primary', raw }
  }

  // ── phone ─────────────────────────────────────────────────────────
  if (RE.phone.test(s) && (hint?.kind === 'phone' || /phone|mobile|tel|cell|whatsapp/i.test(key))) {
    return { kind: 'phone', display: s, icon: 'phone', variant: 'primary', raw }
  }

  // ── coordinates ───────────────────────────────────────────────────
  const latLng = RE.latLngPair.exec(s)
  if (latLng) {
    const lat = parseFloat(latLng[1])
    const lng = parseFloat(latLng[2])
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return {
        kind: 'coordinate',
        display: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        icon: 'map-pin', variant: 'primary', raw,
      }
    }
  }

  // ── file size ─────────────────────────────────────────────────────
  const fs = RE.fileSize.exec(s)
  if (fs) {
    return {
      kind: 'fileSize',
      display: `${asNumber(fs[1]).toLocaleString()} ${fs[2].toUpperCase()}`,
      icon: 'hard-drive', variant: 'info', raw,
    }
  }

  // ── duration string ───────────────────────────────────────────────
  const du = RE.duration.exec(s)
  if (du) {
    const seconds = durationSecondsFromMatch(asNumber(du[1]), du[2])
    return { kind: 'duration', display: formatDuration(seconds), icon: 'timer', variant: 'info', raw }
  }

  // ── currency ──────────────────────────────────────────────────────
  if (RE.currency.exec(s)) {
    return { kind: 'currency', display: s, icon: 'dollar-sign', variant: 'primary', raw }
  }

  // ── per-mille (‰) ─────────────────────────────────────────────────
  const pm = RE.perMille.exec(s)
  if (pm) {
    return { kind: 'percentage', display: `${asNumber(pm[1])} ‰`, variant: 'info', icon: 'percent', raw }
  }

  // ── percentage ────────────────────────────────────────────────────
  const pct = RE.percent.exec(s)
  if (pct) {
    const p = asNumber(pct[1])
    if (hint?.kind === 'battery') {
      return { kind: 'battery', display: `${p}%`, variant: batteryVariant(p), icon: p <= 20 ? 'battery-low' : 'battery', raw }
    }
    if (hint?.kind === 'humidity') {
      return { kind: 'humidity', display: `${p}%`, icon: 'droplets', variant: 'info', raw }
    }
    return { kind: 'percentage', display: `${p}%`, variant: percentVariant(p), icon: 'percent', raw }
  }

  // ── measurement with unit ─────────────────────────────────────────
  const meas = RE.measurement.exec(s)
  if (meas) {
    const num = asNumber(meas[1])
    const unit = meas[2]
    const u = unit.toLowerCase()
    if (/^(°c|°f|°k|c|f|k|deg)$/i.test(unit) || hint?.kind === 'temperature') {
      return {
        kind: 'temperature',
        display: `${num.toLocaleString()} ${normalizeTempUnit(unit)}`,
        variant: tempVariant(num, unit), icon: 'thermometer', raw,
      }
    }
    if (/^(db|dba|dbc|dbm|dbi|dbspl)$/i.test(unit)) {
      if (/^(dbm|dbi)$/i.test(unit) || hint?.kind === 'signal') {
        return { kind: 'signal', display: `${num.toLocaleString()} ${unit}`, variant: signalVariant(num), icon: 'signal', raw }
      }
      return { kind: 'sound', display: `${num.toLocaleString()} ${unit}`, variant: soundVariant(num), icon: 'volume-2', raw }
    }
    if (/^(lux|fc|cd|lm|nits?)$/i.test(unit)) {
      return { kind: 'light', display: `${num.toLocaleString()} ${unit}`, variant: lightVariant(num), icon: 'sun', raw }
    }
    if (/^(ppm|ppb|ppt)$/i.test(unit)) {
      const v = /co2|carbon_dioxide/i.test(key) ? co2Variant(num)
        : /pm25|pm2_5/i.test(key) ? pm25Variant(num)
        : 'info'
      return { kind: 'air-quality', display: `${num.toLocaleString()} ${unit}`, variant: v, icon: 'cloud-fog', raw }
    }
    if (/^(μg\/m³|ug\/m³|mg\/m³)$/i.test(unit)) {
      const v = /pm25|pm2_5/i.test(key) ? pm25Variant(num) : 'info'
      return { kind: 'air-quality', display: `${num.toLocaleString()} ${unit}`, variant: v, icon: 'cloud-fog', raw }
    }
    if (/^(kw|w|mw|hp|kwh|wh|mwh|btu|j|kj)$/i.test(unit)) {
      const isEnergy = /(wh|btu|kj|^j$)/i.test(unit)
      return {
        kind: isEnergy ? 'energy' : 'power',
        display: `${num.toLocaleString()} ${unit}`,
        icon: isEnergy ? 'plug-zap' : 'zap',
        variant: 'primary', raw,
      }
    }
    if (/^(v|kv|mv)$/i.test(unit)) {
      return { kind: 'voltage', display: `${num.toLocaleString()} ${unit}`, icon: 'bolt', variant: 'primary', raw }
    }
    if (/^(a|ka|ma|μa|ua)$/i.test(unit)) {
      return { kind: 'current', display: `${num.toLocaleString()} ${unit}`, icon: 'bolt', variant: 'primary', raw }
    }
    if (/^(hz|khz|mhz|ghz)$/i.test(unit)) {
      return { kind: 'frequency', display: `${num.toLocaleString()} ${unit}`, icon: 'activity', variant: 'info', raw }
    }
    if (/^(km\/h|kmh|mph|knots?|kn|mach|mps|m\/s|rpm)$/i.test(unit)) {
      return { kind: 'speed', display: `${num.toLocaleString()} ${unit}`, icon: 'gauge', variant: 'info', raw }
    }
    if (/^(gpm|cfm|l\/min|m³\/h|m3\/h)$/i.test(unit)) {
      return { kind: 'flow', display: `${num.toLocaleString()} ${unit}`, icon: 'waves', variant: 'info', raw }
    }
    if (/^(psi|bar|mbar|kpa|mpa|hpa|pa|atm|mmhg|inhg|torr)$/i.test(unit)) {
      return { kind: 'pressure', display: `${num.toLocaleString()} ${unit}`, icon: 'gauge', variant: 'info', raw }
    }
    if (/^(g|m\/s²|mm\/s|mil)$/i.test(unit) || u.includes('g force')) {
      return { kind: 'vibration', display: `${num.toLocaleString()} ${unit}`, icon: 'activity-square', variant: num > 4 ? 'danger' : num > 1.5 ? 'warning' : 'success', raw }
    }
    if (/^(°|°\/s|deg\/s)$/i.test(unit) || hint?.kind === 'tilt') {
      return { kind: 'tilt', display: `${num.toLocaleString()}°`, icon: 'compass', variant: Math.abs(num) > 30 ? 'warning' : 'info', raw }
    }
    return {
      kind: 'measurement',
      display: `${num.toLocaleString()} ${unit}`,
      icon: measurementIcon(u), variant: 'primary', raw,
    }
  }

  // ── date / time ───────────────────────────────────────────────────
  if (RE.iso.test(s) || hint?.kind === 'date' || hint?.kind === 'datetime') {
    // A zone-less date-time ("2026-11-03 15:40:00", how devices and seeders write it) is UTC — the
    // reports read it that way (Postgres) — not the browser's zone, which `new Date(s)` would assume.
    const zoneless = RE.iso.test(s) && /[T ]\d{2}:\d{2}/.test(s) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)
    const d = new Date(zoneless ? `${s.replace(' ', 'T')}Z` : s)
    if (!isNaN(d.getTime())) {
      const hasTime = /[T ]\d{2}:\d{2}/.test(s)
      return {
        kind: hasTime ? 'datetime' : 'date',
        display: hasTime ? d.toLocaleString() : d.toLocaleDateString(),
        hint: formatRelativeTime(d),
        icon: hasTime ? 'clock' : 'calendar',
        variant: 'primary', raw,
      }
    }
  }

  // ── generic URL ───────────────────────────────────────────────────
  if (RE.url.test(s)) {
    return { kind: 'url', display: s, icon: 'link', variant: 'primary', raw }
  }

  // ── MQTT topic ────────────────────────────────────────────────────
  if (hint?.kind === 'mqtt-topic' && RE.mqttTopic.test(s) && s.includes('/')) {
    return { kind: 'mqtt-topic', display: s, icon: 'send', variant: 'info', raw }
  }

  // ── port number under `port` key ──────────────────────────────────
  if (hint?.kind === 'port' && RE.portOnly.test(s)) {
    return { kind: 'port', display: s, icon: 'router', variant: 'primary', raw }
  }

  // ── hex UID (catch-all for RFID-like tokens) ──────────────────────
  if (RE.hexUid.test(s) && (/^(uid|hex|tag|epc|rfid)$/i.test(key) || hint?.kind === 'identifier')) {
    return { kind: 'identifier', display: upper, icon: 'qr-code', variant: 'primary', raw }
  }

  // ── license plate ─────────────────────────────────────────────────
  if (hint?.kind === 'license-plate' && RE.licensePlate.test(s)) {
    return { kind: 'license-plate', display: upper, icon: 'car', variant: 'primary', raw }
  }

  // ── numeric string ────────────────────────────────────────────────
  if (RE.numericOnly.test(s)) {
    const n = asNumber(s)
    return classifyNumber(key, n, hint)
  }

  // ── resolution (1920x1080) ───────────────────────────────────────
  const rs = RE.resolution.exec(s)
  if (rs) {
    return { kind: 'tag', display: `${rs[1]}×${rs[2]}`, icon: 'monitor', variant: 'info', raw }
  }

  // ── short token (tag-style) ───────────────────────────────────────
  if (lower.length <= 24 && /^[a-z0-9._-]+$/i.test(s)) {
    return { kind: 'tag', display: s, icon: hint?.icon ?? 'tag', variant: 'neutral', raw }
  }

  // ── fallback: plain text ──────────────────────────────────────────
  return { kind: 'text', display: s, icon: hint?.icon ?? 'type', variant: 'neutral', raw }
}

// ====================================================================
// ICON / UNIT HELPERS
// ====================================================================

function statusIcon(v: ValueVariant): IconName {
  switch (v) {
    case 'success': return 'check-circle'
    case 'warning': return 'alert-triangle'
    case 'danger': return 'x-circle'
    case 'critical': return 'shield-alert'
    case 'info': return 'info'
    default: return 'circle'
  }
}

function normalizeTempUnit(u: string): string {
  const x = u.toLowerCase()
  if (x === 'c' || x === '°c') return '°C'
  if (x === 'f' || x === '°f') return '°F'
  if (x === 'k' || x === '°k') return 'K'
  return u
}

function measurementIcon(u: string): IconName {
  if (/^(kg|g|mg|μg|ug|t|lb|lbs|oz|st|ct)$/.test(u)) return 'weight'
  if (/^(m|cm|mm|nm|μm|um|km|ft|in|yd|mi|nmi)$/.test(u)) return 'ruler'
  if (/^(m²|m2|sqm|ft²|ft2|sqft|cm²|cm2|km²|km2|ha|acre)$/.test(u)) return 'ruler'
  if (/^(m³|m3|ft³|ft3|cm³|cm3|l|ml|μl|ul|cl|dl|gal|qt|pt|fl oz)$/.test(u)) return 'box'
  if (/^(psi|bar|kpa|mpa|hpa|pa|atm|mmhg|inhg|torr|mbar)$/.test(u)) return 'gauge'
  if (/^(km\/h|kmh|mph|knots?|kn|mach|mps|m\/s|rpm)$/.test(u)) return 'gauge'
  if (/^(kw|w|mw|hp|kwh|wh|mwh|btu|j|kj)$/.test(u)) return 'zap'
  if (/^(bps|kbps|mbps|gbps|tbps)$/.test(u)) return 'network'
  if (/^(sv|usv|μsv|gy|bq|ci)$/.test(u)) return 'radiation'
  if (/^(ah|mah)$/.test(u)) return 'battery'
  return 'ruler'
}

function isStatusy(key: string): boolean {
  return /^(status|state|health|condition|availability|mode|phase|stage|result|outcome|verdict)$/i.test(key)
}

// ====================================================================
// PUBLIC HELPERS
// ====================================================================

export { humanize as labelFromKey }
