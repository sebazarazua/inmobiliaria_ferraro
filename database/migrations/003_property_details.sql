ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS size_m2 numeric(10,2),
  ADD COLUMN IF NOT EXISTS bedrooms integer,
  ADD COLUMN IF NOT EXISTS bathrooms integer,
  ADD COLUMN IF NOT EXISTS market_value_usd numeric(14,2);
