// The Supabase project the /admin pages talk to: its URL and its anon key.
// Both are public by design (the app ships the same two values). The data is
// guarded by the admin-dashboard function, which answers only a signed-in
// internal_accounts admin, not by keeping this key secret.
export const SUPABASE_URL = "https://txjfbiriyceabushptlp.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4amZiaXJpeWNlYWJ1c2hwdGxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMjMwOTQsImV4cCI6MjA5NDY5OTA5NH0.YKB1vSJw05uRaDSfF95WAR3KsH6E1f-Se0dz68uxIE4";
