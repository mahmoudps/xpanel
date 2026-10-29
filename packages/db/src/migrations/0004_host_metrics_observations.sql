-- Legacy account counters and historical host rows retain their original values.
-- New host observations carry explicit nullable measurements instead of interpreting
-- legacy NOT NULL counter defaults as observed host values.
ALTER TABLE metrics_history ADD COLUMN host_observation_json TEXT
  CHECK (host_observation_json IS NULL OR (scope = 'host' AND json_valid(host_observation_json) AND json_type(host_observation_json) = 'object'));
