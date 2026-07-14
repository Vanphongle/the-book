// Shared progressive jackpot for the slot machine.
// Lives in its own Supabase table (`slot_jackpot`) — the ONLY server data any
// casino game touches, and it never reads or writes The Book's bet data.
// Everyone playing feeds the same meter and can win it; realtime keeps every
// device's number in sync. Falls back to a local (per-device) jackpot when
// Supabase isn't configured or is unreachable, so the game always works.
import { supabase, isSupabaseConfigured } from "./supabaseClient";

const SEED = 1000;                       // jackpot resets here after it's won
const LS_LOCAL = "the-book.slot.localjackpot.v1";

let useServer = isSupabaseConfigured;

const lsGet = () => {
  const v = parseFloat(localStorage.getItem(LS_LOCAL));
  return v > 0 ? v : SEED;
};
const lsSet = (v) => { try { localStorage.setItem(LS_LOCAL, String(Math.round(v))); } catch { /* ignore */ } };

// Read the current jackpot. Returns { amount, server } — server=false means
// we're on the local fallback (this device only).
export async function readJackpot() {
  if (useServer) {
    const { data, error } = await supabase.from("slot_jackpot").select("amount").eq("id", "main").single();
    if (!error && data) return { amount: Number(data.amount), server: true };
    useServer = false; // table missing / offline → fall back for the session
  }
  return { amount: lsGet(), server: false };
}

// Add a contribution (a slice of the bet) to the jackpot. Atomic on the server.
export async function bumpJackpot(delta) {
  if (delta <= 0) return;
  if (useServer) {
    const { error } = await supabase.rpc("slot_bump", { p_delta: delta });
    if (!error) return;
    useServer = false;
  }
  lsSet(lsGet() + delta);
}

// Win the whole jackpot: returns the amount won and resets the meter to seed.
// Atomic on the server so two simultaneous winners can't both scoop it.
export async function winJackpot(winner) {
  if (useServer) {
    const { data, error } = await supabase.rpc("slot_win", { p_winner: winner || "Guest" });
    if (!error && data != null) return Number(data);
    useServer = false;
  }
  const won = lsGet();
  lsSet(SEED);
  return won;
}

// Live updates from other players (server only). onChange(amount) fires on every
// change; returns an unsubscribe function (noop on the local fallback).
export function subscribeJackpot(onChange) {
  if (!useServer) return () => {};
  const channel = supabase
    .channel("slot-jackpot")
    .on("postgres_changes", { event: "*", schema: "public", table: "slot_jackpot" }, (payload) => {
      if (payload.new && payload.new.amount != null) onChange(Number(payload.new.amount), payload.new);
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export const JACKPOT_SEED = SEED;
