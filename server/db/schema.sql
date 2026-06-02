-- Run this in your Supabase SQL editor to set up the schema

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  group_type  TEXT NOT NULL CHECK (group_type IN ('paid', 'organic', 'vendor')),
  color       TEXT NOT NULL DEFAULT '#888888',
  display_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,  -- YYYY-MM
  spend       NUMERIC(12,2) NOT NULL DEFAULT 0,
  revenue     NUMERIC(12,2) NOT NULL DEFAULT 0,
  leads       INTEGER NOT NULL DEFAULT 0,
  booked      INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual | google_ads | lsa | granot | invoice
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, month)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  message       TEXT,
  rows_affected INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

-- Seed channels
INSERT INTO channels (id, name, group_type, color, display_order) VALUES
  ('google_ads',   'Google Ads (Search)',      'paid',    '#4285F4', 1),
  ('lsa_1',        'LSA Account 1',            'paid',    '#34A853', 2),
  ('lsa_2',        'LSA Account 2',            'paid',    '#0F9D58', 3),
  ('lsa_3',        'LSA Account 3',            'paid',    '#0B7B43', 4),
  ('website',      'Website (Organic/Direct)', 'organic', '#38c9a8', 5),
  ('safeship',     'Safeship',                 'vendor',  '#f7a84f', 6),
  ('movebuddha',   'MoveBuddha',               'vendor',  '#c87ff7', 7),
  ('forbes',       'Forbes',                   'vendor',  '#f75a5a', 8),
  ('homeadvisor',  'HomeAdvisor',              'vendor',  '#FF6C2F', 9)
ON CONFLICT (id) DO NOTHING;
