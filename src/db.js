// Data layer for The Book.
// Each bet is one row in the `bets` table. When Supabase isn't configured,
// everything falls back to localStorage so the app still works offline / locally.
import { supabase, isSupabaseConfigured } from "./supabaseClient";

const TABLE = "bets";
const PLAYERS_TABLE = "players";
const PERIODS_TABLE = "periods";
const LS_BETS = "the-book.bets.v1";
const LS_PLAYERS = "the-book.players.v1";
const LS_PERIODS = "the-book.periods.v1";

// ---- localStorage fallback ---------------------------------------------------
function lsReadKey(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function lsWriteKey(key, arr) {
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* storage full / unavailable → session only */
  }
}
const lsRead = () => lsReadKey(LS_BETS);
const lsWrite = (arr) => lsWriteKey(LS_BETS, arr);

// row in DB  <->  entry in the UI
const rowToEntry = (r) => ({
  id: r.id,
  person: r.person || "",
  name: r.name || "",
  amount: Number(r.amount),
  outcome: r.outcome,
  bet_date: r.bet_date || "",
  period_id: r.period_id || "",
  seq: r.seq != null ? Number(r.seq) : 0,
  created_at: r.created_at || "",
});

// ---- public API --------------------------------------------------------------
// PostgREST caps each request at 1000 rows, so page through until we have them
// all — otherwise the oldest bets beyond 1000 silently never load.
const PAGE = 1000;
export async function fetchBets() {
  if (!isSupabaseConfigured) return lsRead();
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE) break;
  }
  return all.map(rowToEntry);
}

export async function insertBet(entry) {
  if (!isSupabaseConfigured) {
    lsWrite([entry, ...lsRead()]);
    return;
  }
  const { error } = await supabase.from(TABLE).insert({
    id: entry.id,
    person: entry.person,
    name: entry.name,
    amount: entry.amount,
    outcome: entry.outcome,
    bet_date: entry.bet_date || null,
    period_id: entry.period_id || null,
    seq: entry.seq,
    created_at: entry.created_at,
  });
  if (error) throw error;
}

// Bulk-assign a settle period to a set of bets (closes those days).
export async function assignPeriod(ids, periodId) {
  if (!ids.length) return;
  if (!isSupabaseConfigured) {
    const set = new Set(ids);
    lsWrite(lsRead().map((e) => (set.has(e.id) ? { ...e, period_id: periodId } : e)));
    return;
  }
  const { error } = await supabase.from(TABLE).update({ period_id: periodId }).in("id", ids);
  if (error) throw error;
}

// Update arbitrary fields of a bet (e.g. { name, amount }).
export async function updateBet(id, fields) {
  if (!isSupabaseConfigured) {
    lsWrite(lsRead().map((e) => (e.id === id ? { ...e, ...fields } : e)));
    return;
  }
  const { error } = await supabase.from(TABLE).update(fields).eq("id", id);
  if (error) throw error;
}

export async function updateBetOutcome(id, outcome) {
  if (!isSupabaseConfigured) {
    lsWrite(lsRead().map((e) => (e.id === id ? { ...e, outcome } : e)));
    return;
  }
  const { error } = await supabase.from(TABLE).update({ outcome }).eq("id", id);
  if (error) throw error;
}

export async function deleteBet(id) {
  if (!isSupabaseConfigured) {
    lsWrite(lsRead().filter((e) => e.id !== id));
    return;
  }
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

export async function clearBets() {
  if (!isSupabaseConfigured) {
    lsWrite([]);
    return;
  }
  // delete every row (id is text and always present)
  const { error } = await supabase.from(TABLE).delete().neq("id", "");
  if (error) throw error;
}

// ---- players -----------------------------------------------------------------
const playerRowToObj = (r) => ({ id: r.id, name: r.name || "" });

export async function fetchPlayers() {
  if (!isSupabaseConfigured) return lsReadKey(LS_PLAYERS);
  const { data, error } = await supabase.from(PLAYERS_TABLE).select("*").order("name");
  if (error) throw error;
  return (data || []).map(playerRowToObj);
}

export async function insertPlayer(player) {
  if (!isSupabaseConfigured) {
    lsWriteKey(LS_PLAYERS, [...lsReadKey(LS_PLAYERS), player]);
    return;
  }
  const { error } = await supabase.from(PLAYERS_TABLE).insert({ id: player.id, name: player.name });
  if (error) throw error;
}

export async function updatePlayer(id, name) {
  if (!isSupabaseConfigured) {
    lsWriteKey(LS_PLAYERS, lsReadKey(LS_PLAYERS).map((p) => (p.id === id ? { ...p, name } : p)));
    return;
  }
  const { error } = await supabase.from(PLAYERS_TABLE).update({ name }).eq("id", id);
  if (error) throw error;
}

// Cascade a rename to every bet linked to the old player name (bets reference a
// player by the `person` name string, so this keeps them attached after a rename).
export async function renameBetsPerson(oldName, newName) {
  if (!isSupabaseConfigured) {
    lsWrite(lsRead().map((e) => (e.person === oldName ? { ...e, person: newName } : e)));
    return;
  }
  const { error } = await supabase.from(TABLE).update({ person: newName }).eq("person", oldName);
  if (error) throw error;
}

// ---- periods (manual settlement cycles) --------------------------------------
export async function fetchPeriods() {
  if (!isSupabaseConfigured) return lsReadKey(LS_PERIODS);
  const { data, error } = await supabase
    .from(PERIODS_TABLE)
    .select("*")
    .order("started_at");
  if (error) throw error;
  return (data || []).map((r) => ({ id: r.id, started_at: r.started_at }));
}

export async function addPeriod(period) {
  if (!isSupabaseConfigured) {
    lsWriteKey(LS_PERIODS, [...lsReadKey(LS_PERIODS), period]);
    return;
  }
  const { error } = await supabase
    .from(PERIODS_TABLE)
    .insert({ id: period.id, started_at: period.started_at });
  if (error) throw error;
}

// ---- realtime ----------------------------------------------------------------
// Subscribe to any change on the bets/players tables (insert/update/delete) from
// any device. Calls onChange() on each event. Returns an unsubscribe function.
// No-op (returns a noop) when Supabase isn't configured.
// onChange(kind, eventType, row) is called per row change (row already mapped;
// for DELETE, row holds at least the id). onResync() fires whenever the socket
// (re)connects, so callers can catch up on anything missed while offline.
export function subscribeChanges(onChange, onResync) {
  if (!isSupabaseConfigured) return () => {};
  const rowOf = (p, map) => (p.new && p.new.id ? map(p.new) : p.old);
  const channel = supabase
    .channel("the-book-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, (p) =>
      onChange("bet", p.eventType, rowOf(p, rowToEntry))
    )
    .on("postgres_changes", { event: "*", schema: "public", table: PLAYERS_TABLE }, (p) =>
      onChange("player", p.eventType, rowOf(p, playerRowToObj))
    )
    .on("postgres_changes", { event: "*", schema: "public", table: PERIODS_TABLE }, (p) =>
      onChange("period", p.eventType, rowOf(p, (r) => ({ id: r.id, started_at: r.started_at })))
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") onResync && onResync();
    });
  return () => supabase.removeChannel(channel);
}
