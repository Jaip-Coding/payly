# Payly V3 — live accounts, private chats and invitations

This version keeps the Payly reference design and the phone-only fullscreen experience, while adding a real free backend path through **Supabase**.

## What is now real

When Supabase is configured, these are no longer local-demo-only features:

- Email/password **sign-up and login** with persistent sessions
- Optional Supabase **email verification** and password reset
- **1:1 chats** (maximum two members)
- **Group chats** (up to 25 members in this starter)
- Real shared **chat messages** across devices
- Owner-generated **private invitation links**
- Invitation redemption after signup/login, including after email confirmation
- Shared expenses with equal/custom splits
- Each recipient can **approve or question only their own share**
- Live-ish syncing: Supabase Realtime triggers a refresh; a small polling fallback also runs
- Profile display-name updates

Real payment processing, receipt OCR, push notifications and bank connections are intentionally **not** enabled yet.

If `config.js` is left blank, Payly falls back to the original local interactive demo so you can still view the design without a backend.

## Free stack

- **Supabase Free** — Postgres database, Auth, Row Level Security, Realtime
- **Cloudflare Pages / GitHub Pages / Netlify** — static frontend hosting (pick one)
- No Node/npm runtime is required for the frontend

## 5-minute Supabase setup

1. Create a new Supabase project.
2. Open **SQL Editor** and run the complete file `backend/supabase-schema.sql` once.
3. In Supabase, open **Project Settings → API** and copy:
   - Project URL
   - Publishable key (or legacy `anon` key)
4. Open `config.js` and paste those two **public** values:

```js
window.PAYLY_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabasePublishableKey: 'YOUR_PUBLISHABLE_KEY'
};
```

**Never put a `service_role` or secret key in this project.** Browser code cannot keep secrets.

5. In **Authentication → URL Configuration** set:
   - Site URL: your actual deployed Payly URL
   - Redirect URLs: include the same deployed URL and your local development URL, for example `http://localhost:8000/**`
6. Keep **Confirm email** enabled for a real public test. During purely local development you may disable it temporarily, but re-enable it before inviting real users.
7. Serve the folder over HTTP. On Windows, double-click `start-windows.bat`, then open `http://localhost:8000`.

Opening `index.html` with a `file://` URL is not recommended for real authentication because redirect URLs and origin behavior differ from a normal website.

## How invitations work

The owner of a conversation taps **Invite** and generates a cryptographically random link. Only a SHA-256 hash of that secret is stored in the database. The original secret is shown to the inviter and placed in the URL.

- Direct-chat invitations can be redeemed once and direct chats are capped at two people.
- Group invitations expire after seven days and this starter allows up to 25 redemptions/members.
- The invitation token is removed from the browser address bar as soon as Payly reads it.
- If a new user must confirm their email first, the invite is preserved through the confirmation redirect.

## Security model

The SQL migration deliberately does **not** trust the browser for authorization:

- Row Level Security is enabled on every exposed Payly table.
- Signed-out (`anon`) users receive no table access.
- Signed-in users can read only conversations they belong to and profiles of people sharing a conversation with them.
- Sensitive writes are performed through narrow `SECURITY DEFINER` database functions with input and membership checks.
- Direct table writes for chats, memberships, invitations, messages, expenses and shares are revoked from browser roles.
- A member can approve/dispute only their own expense share.
- Invite secrets are random server-generated 256-bit values; only their hashes are stored.
- Basic rate limits are included for chat creation, invite generation and messages.
- Passwords are handled by Supabase Auth and are never stored in the Payly tables or frontend.

Before a public production launch, add automated database permission tests, abuse monitoring, CAPTCHA/bot protection, legal/privacy documents, backups, stronger rate limiting and a full security review.

## Test on two accounts

1. Create User A and User B with two separate browsers/private windows.
2. User A creates a 1:1 chat or group and generates an invite.
3. Open the invite in User B's browser and sign up/login.
4. Join the conversation.
5. Send messages from both devices.
6. Add an expense from User A.
7. Open it as User B and choose **Approve** or **Question**.
8. User A should see the update automatically or within the polling fallback window.

## Files

- `index.html` — page shell + Supabase browser SDK
- `styles.css` — Payly reference design + responsive/mobile layout
- `app.js` — original local interactive demo and automatic cloud-mode bootstrap
- `cloud.js` — authenticated Supabase mode
- `config.js` — public Supabase project configuration
- `backend/supabase-schema.sql` — schema, RLS policies and secured RPC functions
- `assets/` — design assets
- `tests/` — dependency-free frontend/demo smoke tests

This remains a pre-production prototype. Do not use it to hold or move real money yet.
