# Safebound ROAS Dashboard

Internal marketing ROAS dashboard for Safebound Moving & Storage.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in Supabase, Google Ads, Granot, LSA, and IMAP credentials.
3. Run the SQL in `server/db/schema.sql` in Supabase.
4. Install dependencies with `npm install`.
5. Start the app with `npm start`.

The dashboard is served from `client/index.html`; API routes are under `/api/metrics` and `/api/sync`.
