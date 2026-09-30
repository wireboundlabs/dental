-- Keep the model's verdict for every scored item, not just the ones that became leads,
-- so the score distribution and near-misses can be inspected. pain_summary is NULL when the
-- model flagged possible patient details.
ALTER TABLE items ADD COLUMN relevance REAL;
ALTER TABLE items ADD COLUMN pain_summary TEXT;
CREATE INDEX idx_items_relevance ON items(relevance);
