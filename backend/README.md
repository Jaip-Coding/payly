# Payly backend — Supabase

Run `supabase-schema.sql` in a **new Supabase project**. It creates the backend used by `cloud.js`.

### Data model

`profiles` → public display names tied 1:1 to Supabase Auth users  
`chats` → direct/group conversation metadata  
`chat_members` → membership + owner/member role  
`chat_invites` → hashed, expiring invitation secrets  
`messages` → member-only chat messages  
`expenses` → payer/title/amount in integer cents  
`expense_shares` → per-person amount and pending/approved/disputed response

### Authorization

All exposed tables use Row Level Security. Browser users receive read/update privileges only where required, while sensitive creation/mutation routes go through authenticated RPC functions. The service-role key is never required by this frontend and must never be shipped to a browser.

### Functions exposed to authenticated users

- `create_chat(name, kind)`
- `create_chat_invite(chat_id)`
- `accept_chat_invite(token)`
- `send_message(chat_id, body)`
- `create_expense(chat_id, title, amount_cents, shares)`
- `respond_to_share(expense_id, status, question)`

The migration also adds the relevant tables to `supabase_realtime` where that publication exists. The client listens for changes and refreshes data under the same RLS rules.

### Deployment checklist

Keep email confirmation enabled, set exact production Site/Redirect URLs, use HTTPS, use only the publishable key in `config.js`, and test access with two unrelated accounts before public launch. For production, add database policy tests and abuse controls rather than relying only on manual testing.
