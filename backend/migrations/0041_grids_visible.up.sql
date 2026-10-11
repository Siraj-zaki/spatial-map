-- Grid rows can now be individually hidden from the map like images already can,
-- so the sidebar's per-rack "Hide layer" button has somewhere to persist state.
-- Defaults to true so every existing row stays visible after the migration.
ALTER TABLE grids ADD COLUMN visible BOOLEAN NOT NULL DEFAULT true;
