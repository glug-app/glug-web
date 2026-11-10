// /auth/reset: what a password reset link shows when it does not open the
// app (a computer, or a phone without Glug).
//
// The link carries a one-time token_hash in its query
// (?token_hash=...&type=recovery), and only the app verifies it. Verifying
// spends the token, so this page, which a computer, a mail scanner or a
// phone without Glug may load, never uses the token_hash: it does not read
// it, log it, send it, store it or call Supabase with it. The one line below
// puts the bare path back in the address bar, which takes the query (and any
// fragment) out of the address bar and out of this history entry without
// reading it. It runs first, from <head>, before the page draws.
//
// Keep this page without analytics and without any other script. Its CSP
// (vercel.json, and the meta tag in auth/reset/index.html) sets
// connect-src 'none', so nothing on it can send a request of its own.
history.replaceState(null, '', location.pathname);
