-- Add live column to equity_snapshots (idempotent)
ALTER TABLE equity_snapshots 
ADD COLUMN IF NOT EXISTS live BOOLEAN NOT NULL DEFAULT false;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_live 
ON equity_snapshots(live, created_at DESC);

-- Mark existing rows as paper (they were recorded from paperBalance)
UPDATE equity_snapshots SET live = false WHERE live IS NULL;
