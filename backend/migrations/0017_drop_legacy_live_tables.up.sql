-- Slice 6c2 of the data-link refactor. Drops the per-entity live-data
-- tables that the deleted per-entity handlers wrote to. Every ingest
-- now lands in `entity_states` + `entity_events` via the generic
-- `POST /api/v1/streams/:id/ingest` endpoint (see 0015/0016 for the
-- creation of those tables).

DROP TABLE IF EXISTS cv_detections;
DROP TABLE IF EXISTS asset_positions;
DROP TABLE IF EXISTS sensor_readings;
DROP TABLE IF EXISTS rfid_reads;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS sensors;
DROP TABLE IF EXISTS rfid_tags;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS cameras;
