-- The Book — database schema
-- Run this in your NEW, dedicated Supabase project:
--   Supabase dashboard → SQL Editor → New query → paste → Run.
-- This is a standalone project; it shares nothing with any other app.

create table if not exists public.bets (
  id         text primary key,            -- client-generated id
  person     text not null default '',    -- who pays / collects (the headline)
  name       text default '',             -- note / match info (secondary line)
  amount     numeric not null,            -- already multiplied by 100
  outcome    text not null check (outcome in ('win', 'halfwin', 'halflose', 'lose', 'pending', 'push')),
  created_at timestamptz not null default now()
);

create index if not exists bets_created_at_idx on public.bets (created_at desc);

-- Expose the table to the Data API for the anon role.
-- Tables created via raw SQL are NOT always auto-exposed to PostgREST, so we grant
-- explicitly. This controls whether the table is reachable at all (separate from RLS,
-- which controls which rows are visible once it is reachable).
grant usage on schema public to anon;
grant select, insert, update, delete on table public.bets to anon;

-- Row Level Security.
-- This app talks to Supabase with the public anon key straight from the browser
-- and has no login, so we open the table to the anon role. That means anyone with
-- the site URL can read/write the bets. Fine for a private/personal tool — if you
-- later want it locked down, add Supabase Auth and scope rows to auth.uid().
alter table public.bets enable row level security;

drop policy if exists "anon full access" on public.bets;
create policy "anon full access"
  on public.bets
  for all
  to anon
  using (true)
  with check (true);

-- Players — a managed list you can sort/filter bets by. A bet links to a player
-- by the `person` name string (kept simple; no FK so legacy rows keep working).
create table if not exists public.players (
  id         text primary key,            -- client-generated id
  name       text not null,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on table public.players to anon;

alter table public.players enable row level security;

drop policy if exists "anon full access" on public.players;
create policy "anon full access"
  on public.players
  for all
  to anon
  using (true)
  with check (true);
