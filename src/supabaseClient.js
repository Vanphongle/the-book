import { createClient } from "@supabase/supabase-js";

// Read from Vite env vars. In Vercel these come from Project → Settings → Environment Variables.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

// When keys are missing we leave this null and the app falls back to localStorage,
// so it still runs locally before Supabase is hooked up.
export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null;
