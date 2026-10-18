-- DKVS portal: shared employee profiles and portal records.
-- Run in Supabase SQL Editor after configuring Auth. Safe to rerun for updates.
-- Keep the publishable key in the browser; never put a service_role key in the site.

create table if not exists public.dkvs_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  login_name text not null,
  auth_email text not null,
  display_name text not null,
  player_id text not null default '',
  role text not null default 'Співробітник'
    check (role in ('Власник сайту','Лідер','Заступник','Співробітник','Слідкуючий ДКВС')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.dkvs_profiles add column if not exists login_name text;
alter table public.dkvs_profiles add column if not exists auth_email text;
alter table public.dkvs_profiles drop constraint if exists dkvs_profiles_role_check;
update public.dkvs_profiles set role = 'Слідкуючий ДКВС' where role = 'Слідкуючий';
alter table public.dkvs_profiles add constraint dkvs_profiles_role_check
  check (role in ('Власник сайту','Лідер','Заступник','Співробітник','Слідкуючий ДКВС'));
update public.dkvs_profiles
set login_name = lower(regexp_replace(trim(display_name), '\s+', '_', 'g'))
where login_name is null or trim(login_name) = '';
update public.dkvs_profiles p set auth_email = u.email
from auth.users u where u.id = p.user_id and p.auth_email is null;
alter table public.dkvs_profiles alter column login_name set not null;
alter table public.dkvs_profiles alter column auth_email set not null;

drop index if exists public.dkvs_profiles_login_name_unique;
create unique index dkvs_profiles_login_name_unique
  on public.dkvs_profiles (lower(login_name)) where active = true;

create table if not exists public.dkvs_records (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('prisoner','blacklist','vehicle','announcement')),
  payload jsonb not null,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dkvs_records_category_created_idx
  on public.dkvs_records (category, created_at desc);

create table if not exists public.dkvs_presence (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  display_name text not null,
  last_seen timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index if not exists dkvs_presence_last_seen_idx
  on public.dkvs_presence (last_seen desc);

create or replace function public.dkvs_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.dkvs_profiles
  where user_id = auth.uid() and active = true
$$;

create or replace function public.dkvs_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select coalesce(public.dkvs_current_role() = 'Власник сайту', false) $$;

-- New accounts always start as regular employees. Client metadata cannot assign roles.
create or replace function public.dkvs_create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n text;
  uname text;
  pid text;
begin
  n := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1));
  uname := coalesce(nullif(trim(new.raw_user_meta_data->>'login_name'), ''), lower(split_part(new.email, '@', 1)));
  pid := coalesce(new.raw_user_meta_data->>'player_id', '');
  insert into public.dkvs_profiles(user_id, login_name, auth_email, display_name, player_id, role)
    values (new.id, uname, new.email, n, pid, 'Співробітник');
  return new;
end;
$$;

drop trigger if exists dkvs_auth_user_created on auth.users;
create trigger dkvs_auth_user_created
  after insert on auth.users
  for each row execute function public.dkvs_create_profile();

alter table public.dkvs_profiles enable row level security;
alter table public.dkvs_records enable row level security;
alter table public.dkvs_presence enable row level security;

drop policy if exists "Active staff can view active profiles" on public.dkvs_profiles;
create policy "Active staff can view active profiles"
  on public.dkvs_profiles for select to authenticated
  using ((active = true and public.dkvs_current_role() is not null) or public.dkvs_is_owner());

drop policy if exists "Owners can update profiles" on public.dkvs_profiles;
create policy "Owners can update profiles"
  on public.dkvs_profiles for update to authenticated
  using (public.dkvs_is_owner()) with check (public.dkvs_is_owner());

drop policy if exists "Active staff can view online presence" on public.dkvs_presence;
create policy "Active staff can view online presence"
  on public.dkvs_presence for select to authenticated
  using (public.dkvs_current_role() is not null);
drop policy if exists "Users can add own presence" on public.dkvs_presence;
create policy "Users can add own presence"
  on public.dkvs_presence for insert to authenticated
  with check (user_id = auth.uid() and public.dkvs_current_role() is not null);
drop policy if exists "Users can update own presence" on public.dkvs_presence;
create policy "Users can update own presence"
  on public.dkvs_presence for update to authenticated
  using (user_id = auth.uid() and public.dkvs_current_role() is not null)
  with check (user_id = auth.uid() and public.dkvs_current_role() is not null);
drop policy if exists "Users can delete own presence" on public.dkvs_presence;
create policy "Users can delete own presence"
  on public.dkvs_presence for delete to authenticated
  using (user_id = auth.uid());
drop policy if exists "Staff can clean stale presence" on public.dkvs_presence;
create policy "Staff can clean stale presence"
  on public.dkvs_presence for delete to authenticated
  using (public.dkvs_current_role() is not null and last_seen < now() - interval '2 minutes');


drop policy if exists "Staff can read portal records" on public.dkvs_records;
create policy "Staff can read portal records"
  on public.dkvs_records for select to authenticated
  using (public.dkvs_current_role() is not null);

drop policy if exists "Staff can add portal records" on public.dkvs_records;
create policy "Staff can add portal records"
  on public.dkvs_records for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (category <> 'announcement' and public.dkvs_current_role() is not null)
      or (category = 'announcement' and public.dkvs_current_role() in ('Власник сайту','Лідер','Заступник'))
    )
  );

drop policy if exists "Authorized staff can edit portal records" on public.dkvs_records;
create policy "Authorized staff can edit portal records"
  on public.dkvs_records for update to authenticated
  using (
    public.dkvs_is_owner()
    or public.dkvs_current_role() in ('Заступник','Слідкуючий ДКВС')
    or (category = 'announcement' and public.dkvs_current_role() in ('Лідер','Заступник'))
  )
  with check (
    public.dkvs_is_owner()
    or public.dkvs_current_role() in ('Заступник','Слідкуючий ДКВС')
    or (category = 'announcement' and public.dkvs_current_role() in ('Лідер','Заступник'))
  );

drop policy if exists "Authorized staff can delete portal records" on public.dkvs_records;
create policy "Authorized staff can delete portal records"
  on public.dkvs_records for delete to authenticated
  using (public.dkvs_current_role() in ('Власник сайту','Заступник','Слідкуючий ДКВС'));

-- Run after the owner has created an account through the portal.
-- Replace the value with the exact account login name, then run this block.
-- This promotion is intentionally a manual, privileged setup action.
-- update public.dkvs_profiles set role = 'Власник сайту'
-- where lower(login_name) = lower('Дмитро Яворський');

grant usage on schema public to anon, authenticated;
grant select on public.dkvs_profiles to authenticated;
grant update (display_name, player_id, role, active) on public.dkvs_profiles to authenticated;
grant select, insert, update, delete on public.dkvs_records to authenticated;
grant select, insert, update, delete on public.dkvs_presence to authenticated;

-- Leaders may promote staff to Deputy only. Owners may assign any listed role.
create or replace function public.dkvs_assign_role(target_user uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  caller_role := public.dkvs_current_role();
  if caller_role = 'Власник сайту' then
    update public.dkvs_profiles set role = new_role
      where user_id = target_user and active = true;
    if not found then raise exception 'Працівника не знайдено'; end if;
  elsif caller_role = 'Лідер' and new_role = 'Заступник' then
    update public.dkvs_profiles set role = 'Заступник'
      where user_id = target_user and active = true and user_id <> auth.uid() and role <> 'Власник сайту';
    if not found then raise exception 'Лідер може призначити заступником лише іншого активного працівника'; end if;
  else
    raise exception 'Недостатньо прав для призначення цієї ролі';
  end if;
end;
$$;
revoke all on function public.dkvs_assign_role(uuid, text) from public, anon;
grant execute on function public.dkvs_assign_role(uuid, text) to authenticated;

-- The site logs users in with a username. Only active accounts resolve to a login address.
create or replace function public.dkvs_lookup_login(requested_login text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select auth_email from public.dkvs_profiles
  where lower(login_name) = lower(trim(requested_login)) and active = true
  order by created_at desc limit 1
$$;
revoke all on function public.dkvs_lookup_login(text) from public;
grant execute on function public.dkvs_lookup_login(text) to anon, authenticated;

-- Private evidence storage used for blacklist videos. Run this block once as well.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dkvs-evidence', 'dkvs-evidence', false, 52428800,
  array['video/mp4','video/webm','video/quicktime','video/x-msvideo'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Active staff can read DKVS evidence" on storage.objects;
create policy "Active staff can read DKVS evidence" on storage.objects
  for select to authenticated using (bucket_id = 'dkvs-evidence' and public.dkvs_current_role() is not null);
drop policy if exists "Active staff can upload DKVS evidence" on storage.objects;
create policy "Active staff can upload DKVS evidence" on storage.objects
  for insert to authenticated with check (bucket_id = 'dkvs-evidence' and public.dkvs_current_role() is not null);
drop policy if exists "Moderators can delete DKVS evidence" on storage.objects;
create policy "Moderators can delete DKVS evidence" on storage.objects
  for delete to authenticated using (bucket_id = 'dkvs-evidence' and public.dkvs_current_role() in ('Власник сайту','Заступник','Слідкуючий ДКВС'));
