-- Payly V3: run ONCE in a NEW Supabase project, as the project SQL editor owner.
-- This is a real multi-user prototype, NOT a regulated payment system.
-- Public RPCs below are intentionally SECURITY DEFINER; audit before production.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null check (char_length(trim(display_name)) between 1 and 80),
 created_at timestamptz not null default now()
);
create table public.chats (
 id uuid primary key default gen_random_uuid(),
 name text not null check (char_length(trim(name)) between 1 and 100),
 kind text not null check (kind in ('group','direct')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
create table public.chat_members (
 chat_id uuid not null references public.chats(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null default 'member' check (role in ('owner','member')),
 joined_at timestamptz not null default now(),
 primary key (chat_id,user_id)
);
create index on public.chat_members(user_id,chat_id);
create table public.chat_invites (
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null references public.chats(id) on delete cascade,
 token_hash text not null unique,
 created_by uuid not null references auth.users(id),
 expires_at timestamptz not null,
 max_uses int not null check(max_uses between 1 and 25),
 used_count int not null default 0 check(used_count >= 0),
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);
create index on public.chat_invites(chat_id,created_at desc);
create table public.messages (
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null references public.chats(id) on delete cascade,
 sender_id uuid not null references auth.users(id),
 body text not null check(char_length(trim(body)) between 1 and 2000),
 created_at timestamptz not null default now()
);
create index on public.messages(chat_id,created_at);
create index on public.messages(sender_id,created_at);
create table public.expenses (
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null references public.chats(id) on delete cascade,
 paid_by uuid not null references auth.users(id),
 title text not null check(char_length(trim(title)) between 1 and 200),
 amount_cents int not null check(amount_cents between 1 and 100000000),
 currency text not null default 'EUR' check(currency = 'EUR'),
 created_at timestamptz not null default now()
);
create index on public.expenses(chat_id,created_at);
create table public.expense_shares (
 expense_id uuid not null references public.expenses(id) on delete cascade,
 user_id uuid not null references auth.users(id),
 amount_cents int not null check(amount_cents >= 0),
 status text not null default 'pending' check(status in ('pending','approved','disputed')),
 question text check(question is null or char_length(question) <= 1500),
 responded_at timestamptz,
 primary key(expense_id,user_id)
);
create index on public.expense_shares(user_id,status);

-- New signups automatically receive a profile; never trust the client for profile ownership.
create function public.create_my_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.profiles(id,display_name)
 values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),'Payly user'),80))
 on conflict (id) do nothing;
 return new;
end $$;
create trigger payly_new_auth_user after insert on auth.users
for each row execute function public.create_my_profile();

-- A carefully scoped membership helper avoids self-referential RLS policies.
create function public.is_chat_member(p_chat uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select (select auth.uid()) is not null and exists (
   select 1 from public.chat_members m
   where m.chat_id = p_chat and m.user_id = (select auth.uid())
 );
$$;
revoke all on function public.is_chat_member(uuid) from public,anon;
grant execute on function public.is_chat_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_invites enable row level security;
alter table public.messages enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_shares enable row level security;

-- READ access only for connected people. Nothing exposes a searchable user directory.
create policy profiles_read on public.profiles for select to authenticated using (
 id = (select auth.uid()) or exists (
   select 1 from public.chat_members me
   join public.chat_members them on them.chat_id=me.chat_id
   where me.user_id=(select auth.uid()) and them.user_id=profiles.id
 )
);
create policy profiles_update on public.profiles for update to authenticated
 using(id=(select auth.uid())) with check(id=(select auth.uid()));
create policy chats_read on public.chats for select to authenticated
 using(public.is_chat_member(id));
create policy members_read on public.chat_members for select to authenticated
 using(public.is_chat_member(chat_id));
create policy messages_read on public.messages for select to authenticated
 using(public.is_chat_member(chat_id));
create policy expenses_read on public.expenses for select to authenticated
 using(public.is_chat_member(chat_id));
create policy shares_read on public.expense_shares for select to authenticated
 using(exists(select 1 from public.expenses x where x.id=expense_id and public.is_chat_member(x.chat_id)));
-- No direct writes to chats, memberships, invites, messages, expenses or shares.
revoke all on public.profiles,public.chats,public.chat_members,public.chat_invites,public.messages,public.expenses,public.expense_shares from anon,authenticated;
grant select on public.profiles,public.chats,public.chat_members,public.messages,public.expenses,public.expense_shares to authenticated;
grant update(display_name) on public.profiles to authenticated;
-- No SELECT on chat_invites: even metadata should not be enumerable.

create function public.create_chat(p_name text,p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_user uuid := auth.uid();
begin
 if v_user is null or p_kind not in ('group','direct') or
    char_length(trim(coalesce(p_name,''))) not between 1 and 100 then
    raise exception 'Invalid chat';
 end if;
 if (select count(*) from public.chats where created_by=v_user and created_at>now()-interval '1 day')>=20 then
   raise exception 'Daily chat creation limit reached'; end if;
 insert into public.chats(name,kind,created_by)
 values(trim(p_name),p_kind,v_user) returning id into v_id;
 insert into public.chat_members(chat_id,user_id,role) values(v_id,v_user,'owner');
 return v_id;
end $$;

-- Generate 256 bits on the SERVER. Store only SHA-256 digest; reveal the secret once.
create function public.create_chat_invite(p_chat_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_kind text; v_secret text;
begin
 if v_user is null then raise exception 'Sign in first'; end if;
 select c.kind into v_kind from public.chats c
 join public.chat_members m on m.chat_id=c.id
 where c.id=p_chat_id and m.user_id=v_user and m.role='owner';
 if v_kind is null then raise exception 'Only the chat creator can invite people'; end if;
 if v_kind='direct' and (select count(*) from public.chat_members where chat_id=p_chat_id)>=2 then
   raise exception 'This direct chat already has two people'; end if;
 if exists(select 1 from public.chat_invites i
   where i.chat_id=p_chat_id and i.created_by=v_user and i.created_at>now()-interval '30 seconds') then
   raise exception 'Please wait before generating another link';
 end if;
 v_secret := translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_');
 v_secret := replace(v_secret,'=','');
 insert into public.chat_invites(chat_id,token_hash,created_by,expires_at,max_uses)
 values(p_chat_id,encode(extensions.digest(v_secret,'sha256'),'hex'),v_user,now()+interval '7 days',
   case when v_kind='direct' then 1 else 25 end);
 return v_secret;
end $$;

-- Lock invite and chat rows: redemption is atomic, including the 2-person limit.
create function public.accept_chat_invite(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_inv public.chat_invites%rowtype; v_kind text; v_count int;
begin
 if v_user is null then raise exception 'Sign in to join'; end if;
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
   raise exception 'Invalid invitation';
 end if;
 select * into v_inv from public.chat_invites i
 where i.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
 if not found or v_inv.revoked_at is not null or v_inv.expires_at<=now() or
    v_inv.used_count>=v_inv.max_uses then raise exception 'Invitation expired or invalid'; end if;
 select kind into v_kind from public.chats where id=v_inv.chat_id for update;
 if exists(select 1 from public.chat_members where chat_id=v_inv.chat_id and user_id=v_user) then
   return v_inv.chat_id;
 end if;
 select count(*) into v_count from public.chat_members where chat_id=v_inv.chat_id;
 if (v_kind='direct' and v_count>=2) or (v_kind='group' and v_count>=25) then
   raise exception 'This chat is full';
 end if;
 insert into public.chat_members(chat_id,user_id,role) values(v_inv.chat_id,v_user,'member');
 update public.chat_invites set used_count=used_count+1 where id=v_inv.id;
 return v_inv.chat_id;
end $$;

create function public.send_message(p_chat_id uuid,p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_id uuid;
begin
 if v_user is null or not public.is_chat_member(p_chat_id) then raise exception 'Access denied'; end if;
 if char_length(trim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'Message length invalid'; end if;
 if (select count(*) from public.messages where sender_id=v_user
   and created_at>now()-interval '1 minute') >= 30 then raise exception 'Slow down for a moment'; end if;
 insert into public.messages(chat_id,sender_id,body)
 values(p_chat_id,v_user,trim(p_body)) returning id into v_id;
 return v_id;
end $$;

create function public.create_expense(p_chat_id uuid,p_title text,p_amount_cents integer,p_shares jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_id uuid; v_sum bigint; v_count int;
begin
 if v_user is null or not public.is_chat_member(p_chat_id) then raise exception 'Access denied'; end if;
 if char_length(trim(coalesce(p_title,''))) not between 1 and 200 or
   p_amount_cents not between 1 and 100000000 or jsonb_typeof(p_shares) is distinct from 'array' then
   raise exception 'Invalid expense'; end if;
 v_count := jsonb_array_length(p_shares);
 if v_count not between 1 and 25 then raise exception 'Invalid share count'; end if;
 if (select count(distinct (s->>'user_id')) from jsonb_array_elements(p_shares) s)<>v_count then
   raise exception 'Duplicate participants'; end if;
 if not exists(select 1 from jsonb_array_elements(p_shares) s where s->>'user_id'=v_user::text) then
   raise exception 'Payer must be in split'; end if;
 if exists(select 1 from jsonb_array_elements(p_shares) s
   where jsonb_typeof(s->'amount_cents') is distinct from 'number' or
   (s->>'amount_cents') !~ '^[0-9]{1,9}$' or
   not exists(select 1 from public.chat_members m where m.chat_id=p_chat_id
     and m.user_id=(s->>'user_id')::uuid)) then
   raise exception 'Invalid share member or amount'; end if;
 select sum((s->>'amount_cents')::bigint) into v_sum from jsonb_array_elements(p_shares) s;
 if v_sum is distinct from p_amount_cents then raise exception 'Shares must equal total'; end if;
 insert into public.expenses(chat_id,paid_by,title,amount_cents)
 values(p_chat_id,v_user,trim(p_title),p_amount_cents) returning id into v_id;
 insert into public.expense_shares(expense_id,user_id,amount_cents,status,responded_at)
 select v_id,(s->>'user_id')::uuid,(s->>'amount_cents')::int,
 case when s->>'user_id'=v_user::text then 'approved' else 'pending' end,
 case when s->>'user_id'=v_user::text then now() else null end
 from jsonb_array_elements(p_shares) s;
 return v_id;
end $$;

create function public.respond_to_share(p_expense_id uuid,p_status text,p_question text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_payer uuid;
begin
 if v_user is null or p_status not in ('approved','disputed') then raise exception 'Invalid response'; end if;
 if p_status='disputed' and char_length(trim(coalesce(p_question,''))) not between 1 and 1500 then
   raise exception 'Add a question (up to 1500 characters)'; end if;
 select paid_by into v_payer from public.expenses where id=p_expense_id;
 if v_payer=v_user then raise exception 'Your own share is already approved'; end if;
 update public.expense_shares set status=p_status,
   question=case when p_status='disputed' then trim(p_question) else null end, responded_at=now()
 where expense_id=p_expense_id and user_id=v_user;
 if not found then raise exception 'This request is not yours'; end if;
end $$;

-- Protect every exposed definer function; never grant to unauthenticated callers.
revoke execute on function public.create_my_profile() from public,anon,authenticated;
revoke execute on function public.create_chat(text,text),public.create_chat_invite(uuid),
 public.accept_chat_invite(text),public.send_message(uuid,text),
 public.create_expense(uuid,text,integer,jsonb),public.respond_to_share(uuid,text,text)
 from public,anon;
grant execute on function public.create_chat(text,text),public.create_chat_invite(uuid),
 public.accept_chat_invite(text),public.send_message(uuid,text),
 public.create_expense(uuid,text,integer,jsonb),public.respond_to_share(uuid,text,text)
 to authenticated;
-- Keep the Supabase service_role key OUT of browsers. Never expose these tables without RLS.

-- Live updates for chat membership/messages/expenses. Supabase Realtime still applies RLS
-- to authenticated Postgres Changes subscribers; clients refresh only rows they can SELECT.
do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_members') then
      alter publication supabase_realtime add table public.chat_members;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='expenses') then
      alter publication supabase_realtime add table public.expenses;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='expense_shares') then
      alter publication supabase_realtime add table public.expense_shares;
    end if;
  end if;
end $$;
