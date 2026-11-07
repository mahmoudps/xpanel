-- Overselling is a separate switch per resource: idx_resellers.oversell is the disk switch, this column the bandwidth one.
ALTER TABLE idx_resellers ADD COLUMN oversell_bandwidth INTEGER NOT NULL DEFAULT 0 CHECK (oversell_bandwidth IN (0, 1));
