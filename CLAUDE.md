**Never write outside this repo.** glug-app sits next to it (../glug-app) and has its own sessions; never edit, create, stage or commit a file there, even when a prompt names a file that only exists there. If a task needs a change in glug-app, stop and say so in the report, with the exact change, so Adit can send it to a glug-app session.

## What this repo is

The static site at https://www.glug-wine.com: plain HTML, CSS and a little JS, with no build step, no package.json and no tests. Vercel serves it (`vercel.json`: clean URLs, redirects, rewrites, per-route headers and CSP) and a push to `main` deploys it.

- `index.html`, `styles.css`, `assets/`: the landing page with its fonts, badges, logos and photos.
- `waitlist/` (form, `thanks/`, `error/`): the form posts to the Supabase `waitlist-signup` function.
- `u/`, `l/`, `s/`: the share pages for a public profile, a shared log and a shared menu scan, rewritten from `/u/:id`, `/l/:id` and `/s/:id`. `/l` and `/s` run `share.js`, which reads glug-app's public `share-view` function; `/u` has a small inline script.
- `.well-known/`: `apple-app-site-association` and `assetlinks.json`, the Universal Links and App Links files for `com.glug.app`, served as `application/json` by `vercel.json`.
- `auth/reset/` and `auth/reset.js`: what a password-reset link shows when it does not open the app. The page never reads the token and has its own CSP.
- `privacy/`, `terms/`, `support/`, `delete-account/`: the policy and support pages.
- `hoexters/`: a noindex page for Hoexter's wine list.
- `admin/`: the noindex /admin dashboard. It talks only to glug-app's `admin-dashboard` function; `admin/vendor/` holds pinned chart.js and supabase-js builds; `admin/fixture.json` is local only (gitignored).
- `photos-inbox/`: a local, gitignored holding folder for photos and review screenshots. The site uses `assets/photos/`.

## D5: the debug key stays out of assetlinks.json

The debug signing key stays out of `.well-known/assetlinks.json` (D5 in glug-app's `docs/architecture/SHARE_LINKS_PLAN.md`: the file is public, so a listed debug key would let anyone holding that keystore claim the links). A debug build therefore does not verify the domain (the Pixel reports 1024). On a Pixel walk with a debug build, approve it by hand after each install with `~/Library/Android/sdk/platform-tools/adb shell pm set-app-links --package com.glug.app 2 www.glug-wine.com`; `pm get-app-links com.glug.app` then shows the domain as approved.
