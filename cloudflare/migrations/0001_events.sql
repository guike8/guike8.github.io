-- Schema only: counters are initialized atomically by the first admitted event.
CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
  method TEXT NOT NULL CHECK (length(method) <= 16),
  path TEXT NOT NULL CHECK (length(path) <= 160),
  category TEXT NOT NULL CHECK (length(category) <= 32),
  status INTEGER CHECK (status BETWEEN 100 AND 599),
  source_hash TEXT CHECK (source_hash IS NULL OR length(source_hash) = 64),
  country TEXT CHECK (country IS NULL OR length(country) = 2),
  user_agent TEXT NOT NULL CHECK (length(user_agent) <= 160)
);
CREATE INDEX events_timestamp_id ON events (timestamp_ms, id);

CREATE TABLE telemetry_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count BETWEEN 0 AND 20000),
  cleanup_after_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE telemetry_days (
  day INTEGER PRIMARY KEY,
  admitted_count INTEGER NOT NULL CHECK (admitted_count BETWEEN 0 AND 5000)
);

CREATE TRIGGER events_admitted AFTER INSERT ON events BEGIN
  INSERT INTO telemetry_stats (id, retained_count, cleanup_after_ms) VALUES (1, 1, 0)
    ON CONFLICT(id) DO UPDATE SET retained_count = retained_count + 1;
  INSERT INTO telemetry_days (day, admitted_count)
    VALUES (CAST(NEW.timestamp_ms / 86400000 AS INTEGER), 1)
    ON CONFLICT(day) DO UPDATE SET admitted_count = admitted_count + 1;
END;
CREATE TRIGGER events_removed AFTER DELETE ON events BEGIN
  UPDATE telemetry_stats SET retained_count = retained_count - 1 WHERE id = 1;
END;
