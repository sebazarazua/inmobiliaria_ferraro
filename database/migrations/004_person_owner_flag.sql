ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

UPDATE persons pe
SET is_owner = true
WHERE EXISTS (
  SELECT 1
  FROM property_owners po
  WHERE po.person_id = pe.id
);
