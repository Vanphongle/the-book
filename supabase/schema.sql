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
  bet_date   date,                        -- the day this bet is filed under (user-chosen)
  period_id  text,                        -- settle period it belongs to (null = open/unsettled)
  seq        bigint,                      -- monotonic entry/append order (for stable PDF ordering)
  created_at timestamptz not null default now()
);

create index if not exists bets_period_id_idx on public.bets (period_id);
create index if not exists bets_bet_date_idx on public.bets (bet_date);
create index if not exists bets_seq_idx on public.bets (seq);

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

-- Periods — manual settlement cycles. Each row is a "start new period" boundary
-- timestamp; bets belong to the period whose [start, next) range contains them.
-- Closing a period never deletes anything; totals just scope to the open period.
create table if not exists public.periods (
  id         text primary key,
  started_at timestamptz not null default now()
);

create index if not exists periods_started_at_idx on public.periods (started_at);

grant select, insert, update, delete on table public.periods to anon;

alter table public.periods enable row level security;

drop policy if exists "anon full access" on public.periods;
create policy "anon full access"
  on public.periods
  for all
  to anon
  using (true)
  with check (true);

-- ─── SLOT MACHINE — shared progressive jackpot ────────────────────────────────
-- A single-row table everyone playing the slot feeds and can win. Completely
-- separate from the bets data. slot_bump() adds a slice of each spin's bet;
-- slot_win() awards the whole meter and resets it to the seed, both atomic so
-- concurrent players can't corrupt or double-scoop the pot.
create table if not exists public.slot_jackpot (
  id           text primary key,
  amount       numeric not null default 1000,
  seed         numeric not null default 1000,
  last_winner  text,
  last_won_at  timestamptz,
  updated_at   timestamptz not null default now()
);

insert into public.slot_jackpot (id, amount, seed)
  values ('main', 1000, 1000)
  on conflict (id) do nothing;

create or replace function public.slot_bump(p_delta numeric)
returns numeric language sql as $$
  update public.slot_jackpot
    set amount = amount + p_delta, updated_at = now()
    where id = 'main'
  returning amount;
$$;

create or replace function public.slot_win(p_winner text)
returns numeric language plpgsql as $$
declare won numeric;
begin
  select amount into won from public.slot_jackpot where id = 'main' for update;
  update public.slot_jackpot
    set amount = seed, last_winner = p_winner, last_won_at = now(), updated_at = now()
    where id = 'main';
  return won;
end;
$$;

grant select, insert, update, delete on table public.slot_jackpot to anon;
grant execute on function public.slot_bump(numeric) to anon;
grant execute on function public.slot_win(text) to anon;

alter table public.slot_jackpot enable row level security;

drop policy if exists "anon full access" on public.slot_jackpot;
create policy "anon full access"
  on public.slot_jackpot
  for all
  to anon
  using (true)
  with check (true);
