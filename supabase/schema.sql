-- Chasse Urbaine — Poitiers
-- Schéma Supabase / PostgreSQL pour la V1.

create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key,
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active_extraction_key text,
  status text not null default 'scheduled' check (status in ('scheduled','live','finished')),
  created_at timestamptz not null default now()
);

create table if not exists public.zones (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  zone_key text not null,
  name text not null,
  zone_type text not null check (zone_type in ('perimeter','extraction','prison')),
  sort_order integer not null default 0,
  unique(event_id, zone_key)
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  pseudo text not null,
  role text not null check (role in ('target','hunter','organizer')),
  team text,
  user_id uuid unique references auth.users(id) on delete set null,
  active boolean not null default true,
  play_state text not null default 'free' check (play_state in ('free','capturing','prisoner')),
  play_state_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique(event_id, pseudo)
);

create table if not exists public.access_codes (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  code_hash text not null unique
);

create table if not exists public.ping_slots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  label text not null,
  scheduled_at timestamptz not null,
  ordinal integer not null,
  unique(event_id, ordinal)
);

create table if not exists public.pings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  slot_id uuid not null references public.ping_slots(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m double precision,
  sent_at timestamptz not null default now(),
  valid_window boolean not null,
  delta_seconds integer not null,
  unique(participant_id, slot_id)
);

create table if not exists public.hunter_pings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m double precision,
  sent_at timestamptz not null default now()
);

create index if not exists hunter_pings_event_sent_idx on public.hunter_pings(event_id, sent_at desc);
create table if not exists public.hunter_required_pings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  offset_minutes integer not null default 60
    constraint hunter_required_pings_offset_minutes_check check (offset_minutes in (60,95,110)),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m double precision,
  sent_at timestamptz not null default now(),
  constraint hunter_required_pings_event_participant_offset_key
    unique(event_id, participant_id, offset_minutes)
);

create index if not exists hunter_required_pings_event_idx on public.hunter_required_pings(event_id, sent_at desc);


create index if not exists pings_event_idx on public.pings(event_id, sent_at desc);
create index if not exists participants_event_idx on public.participants(event_id, role);

create or replace function public.my_event_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.event_id
  from public.participants p
  where p.user_id = auth.uid() and p.active = true
  limit 1
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.participants p
  where p.user_id = auth.uid() and p.active = true
  limit 1
$$;

create or replace function public.claim_participant(p_code text)
returns table (
  id uuid,
  event_id uuid,
  pseudo text,
  role text,
  team text,
  active boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_participant public.participants%rowtype;
begin
  if v_uid is null then
    raise exception 'Session anonyme requise';
  end if;

  v_hash := encode(digest(upper(trim(p_code)), 'sha256'), 'hex');

  select p.* into v_participant
  from public.participants p
  join public.access_codes c on c.participant_id = p.id
  where c.code_hash = v_hash
  limit 1;

  if v_participant.id is null then
    raise exception 'Code invalide';
  end if;

  if not v_participant.active then
    raise exception 'Participant désactivé';
  end if;

  if v_participant.user_id is null then
    update public.participants
      set user_id = v_uid
      where public.participants.id = v_participant.id;
  elsif v_participant.user_id <> v_uid then
    raise exception 'Code déjà utilisé sur un autre appareil';
  end if;

  return query
    select p.id, p.event_id, p.pseudo, p.role, p.team, p.active
    from public.participants p
    where p.id = v_participant.id;
end;
$$;

create or replace function public.submit_ping(
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns table (
  id uuid,
  slot_id uuid,
  sent_at timestamptz,
  valid_window boolean,
  delta_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_slot public.ping_slots%rowtype;
  v_sent timestamptz := clock_timestamp();
  v_delta integer;
  v_ping public.pings%rowtype;
begin
  select * into v_participant
  from public.participants
  where user_id = v_uid and active = true
  limit 1;

  if v_participant.id is null or v_participant.role <> 'target' then
    raise exception 'Accès réservé aux Cibles';
  end if;

  select s.* into v_slot
  from public.ping_slots s
  where s.event_id = v_participant.event_id
    and not exists (
      select 1 from public.pings p
      where p.participant_id = v_participant.id and p.slot_id = s.id
    )
  order by s.ordinal
  limit 1;

  if v_slot.id is null then
    raise exception 'Tous les pings ont déjà été envoyés';
  end if;

  v_delta := abs(extract(epoch from (v_sent - v_slot.scheduled_at))::integer);

  insert into public.pings (
    event_id, participant_id, slot_id, lat, lng, accuracy_m, sent_at, valid_window, delta_seconds
  ) values (
    v_participant.event_id, v_participant.id, v_slot.id, p_lat, p_lng, p_accuracy_m,
    v_sent, v_delta <= 60, v_delta
  ) returning * into v_ping;

  return query
    select v_ping.id, v_ping.slot_id, v_ping.sent_at, v_ping.valid_window, v_ping.delta_seconds;
end;
$$;

create or replace function public.draw_extraction_zone()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid := public.my_event_id();
  v_key text;
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;

  select e.active_extraction_key into v_key
  from public.events e
  where e.id = v_event;

  if v_key is not null then
    return v_key;
  end if;

  select z.zone_key into v_key
  from public.zones z
  where z.event_id = v_event and z.zone_type = 'extraction'
  order by random()
  limit 1;

  if v_key is null then
    raise exception 'Aucune zone d''extraction configurée';
  end if;

  update public.events set active_extraction_key = v_key where public.events.id = v_event;
  return v_key;
end;
$$;

alter table public.events enable row level security;
alter table public.zones enable row level security;
alter table public.participants enable row level security;
alter table public.access_codes enable row level security;
alter table public.ping_slots enable row level security;
alter table public.pings enable row level security;
alter table public.hunter_pings enable row level security;
alter table public.hunter_required_pings enable row level security;

drop policy if exists "event members read event" on public.events;
create policy "event members read event" on public.events for select to authenticated
using (id = public.my_event_id());

drop policy if exists "event members read zones" on public.zones;
create policy "event members read zones" on public.zones for select to authenticated
using (event_id = public.my_event_id());

drop policy if exists "event members read participants" on public.participants;
create policy "event members read participants" on public.participants for select to authenticated
using (event_id = public.my_event_id());

drop policy if exists "event members read slots" on public.ping_slots;
create policy "event members read slots" on public.ping_slots for select to authenticated
using (event_id = public.my_event_id());

drop policy if exists "event members read pings" on public.pings;
create policy "event members read pings" on public.pings for select to authenticated
using (event_id = public.my_event_id());

grant execute on function public.claim_participant(text) to authenticated;
grant execute on function public.submit_ping(double precision,double precision,double precision) to authenticated;
grant execute on function public.draw_extraction_zone() to authenticated;
grant execute on function public.my_event_id() to authenticated;
grant execute on function public.my_role() to authenticated;

grant select on public.events to authenticated;
grant select on public.zones to authenticated;
grant select on public.participants to authenticated;
grant select on public.ping_slots to authenticated;
grant select on public.pings to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='pings'
  ) then
    alter publication supabase_realtime add table public.pings;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;

