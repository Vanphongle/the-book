// Shared, tiered progressive jackpots for the slot machines.
// Three pots — mini (small, frequent) · minor · grand (big, rare) — each a row
// in the `slot_jackpot` Supabase table. The ONLY server data any casino game
// touches; never reads or writes The Book's bet data. Everyone playing any
// machine feeds and can win the same pots; realtime keeps every device live.
// Falls back to per-device local jackpots when Supabase isn't configured.
import { supabase, isSupabaseConfigured } from "./supabaseClient";

export const TIERS = ["mini", "minor", "grand"];
const SEED = { mini: 100, minor: 1000, grand: 10000 };
const LS_LOCAL = "the-book.slot.localjackpots.v1";

let useServer = isSupabaseConfigured;

function lsGet() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_LOCAL) || "{}");
    return { mini: o.mini > 0 ? o.mini : SEED.mini, minor: o.minor > 0 ? o.minor : SEED.minor, grand: o.grand > 0 ? o.grand : SEED.grand };
  } catch { return { ...SEED }; }
}
function lsSet(o) { try { localStorage.setItem(LS_LOCAL, JSON.stringify(o)); } catch { /* ignore */ } }

// Read all three pots. Returns { amounts:{mini,minor,grand}, server }.
export async function readJackpots() {
  if (useServer) {
    const { data, error } = await supabase.from("slot_jackpot").select("id, amount").in("id", TIERS);
    if (!error && data) {
      const amounts = { ...SEED };
      for (const row of data) amounts[row.id] = Number(row.amount);
      return { amounts, server: true };
    }
    useServer = false;
  }
  return { amounts: lsGet(), server: false };
}

// Add a contribution to one tier. Atomic on the server.
export async function bumpJackpot(tier, delta) {
  if (delta <= 0) return;
  if (useServer) {
    const { error } = await supabase.rpc("slot_bump", { p_id: tier, p_delta: delta });
    if (!error) return;
    useServer = false;
  }
  const o = lsGet(); o[tier] += delta; lsSet(o);
}

// Win a tier: returns the amount won and resets that pot to its seed. Atomic.
export async function winJackpot(tier, winner) {
  if (useServer) {
    const { data, error } = await supabase.rpc("slot_win", { p_id: tier, p_winner: winner || "Guest" });
    if (!error && data != null) return Number(data);
    useServer = false;
  }
  const o = lsGet(); const won = o[tier]; o[tier] = SEED[tier]; lsSet(o);
  return won;
}

// Live updates (server only). onChange(tier, amount) fires on every change.
export function subscribeJackpots(onChange) {
  if (!useServer) return () => {};
  const channel = supabase
    .channel("slot-jackpots")
    .on("postgres_changes", { event: "*", schema: "public", table: "slot_jackpot" }, (payload) => {
      const row = payload.new;
      if (row && row.id && row.amount != null && TIERS.includes(row.id)) onChange(row.id, Number(row.amount));
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export const JACKPOT_SEED = SEED;
