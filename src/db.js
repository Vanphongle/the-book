// Data layer for The Book.
// Each bet is one row in the `bets` table. When Supabase isn't configured,
// everything falls back to localStorage so the app still works offline / locally.
import { supabase, isSupabaseConfigured } from "./supabaseClient";

const TABLE = "bets";
const LS_BETS = "the-book.bets.v1";

// ---- localStorage fallback ---------------------------------------------------
function lsRead() {
  try {
    const raw = localStorage.getItem(LS_BETS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function lsWrite(arr) {
  try {
    localStorage.setItem(LS_BETS, JSON.stringify(arr));
  } catch {
    /* storage full / unavailable → session only */
  }
}

// row in DB  <->  entry in the UI
const rowToEntry = (r) => ({ id: r.id, name: r.name || "", amount: Number(r.amount), outcome: r.outcome });

// ---- public API --------------------------------------------------------------
export async function fetchBets() {
  if (!isSupabaseConfigured) return lsRead();
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

export async function insertBet(entry) {
  if (!isSupabaseConfigured) {
    lsWrite([entry, ...lsRead()]);
    return;
  }
  const { error } = await supabase.from(TABLE).insert({
    id: entry.id,
    name: entry.name,
    amount: entry.amount,
    outcome: entry.outcome,
  });
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
