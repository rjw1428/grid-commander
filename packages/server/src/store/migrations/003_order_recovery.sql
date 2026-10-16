-- Orders track completion so a turn interrupted by a crash or restart can be handed back to the queue.
ALTER TABLE orders ADD COLUMN completed_at INTEGER;
ALTER TABLE orders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- Backfill: everything but each unit's most recent submitted order has certainly finished. The most
-- recent one is settled at boot (requeued if the unit was mid-turn, otherwise marked complete).
UPDATE orders
SET completed_at = submitted_at
WHERE submitted_at IS NOT NULL
  AND id NOT IN (
    SELECT o2.id FROM orders o2
    WHERE o2.unit_id = orders.unit_id AND o2.submitted_at IS NOT NULL
    ORDER BY o2.submitted_at DESC LIMIT 1
  );
