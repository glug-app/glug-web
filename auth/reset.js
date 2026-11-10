// /auth/reset: what a password reset link shows when it does not open the
// app (a computer, or a phone without Glug).
//
// The link's fragment (#access_token=...&refresh_token=...&type=recovery) is
// a live session meant for the app. This page never reads it, logs it, sends
// it or stores it. The one line below puts the bare path back in the address
// bar, which takes the fragment (and any query) out of the address bar and
// out of this history entry without touching it. It runs first, from <head>,
// before the page draws.
//
// Keep this page without analytics and without any other script. Its CSP
// (vercel.json, and the meta tag in auth/reset/index.html) sets
// connect-src 'none', so nothing on it can send a request of its own.
history.replaceState(null, '', location.pathname);
