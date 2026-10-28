-- Évasion Urbaine — schéma consolidé pour une NOUVELLE base Supabase.
-- Exécuter ce fichier une seule fois, puis seed-event.sql.
-- Une base existante utilise les migrations ; ne pas réinstaller ce schéma en production.
-- Cibles : 0/20/30/40/50/60/80/95/100/105/110 ; Chasseurs : 60/95/110.
-- Les anciennes variantes restent consultables dans l’historique Git.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Tables

create table if not exists public.events (
  id uuid primary key,
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  actual_started_at timestamptz,
  actual_ends_at timestamptz,
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

create table if not exists public.app_private_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_jobs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  slot_id uuid not null references public.ping_slots(id) on delete cascade,
  scheduled_at timestamptz not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique(event_id, slot_id)
);

create table if not exists public.push_deliveries (
  job_id uuid not null references public.push_jobs(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  status text not null,
  sent_at timestamptz,
  clicked_at timestamptz,
  error text,
  updated_at timestamptz not null default now(),
  primary key(job_id, participant_id)
);

-- Index

create index if not exists hunter_pings_event_sent_idx
  on public.hunter_pings(event_id, sent_at desc);

create index if not exists hunter_required_pings_event_idx on public.hunter_required_pings(event_id, sent_at desc);

create index if not exists pings_event_idx on public.pings(event_id, sent_at desc);

create index if not exists participants_event_idx on public.participants(event_id, role);

create index if not exists push_jobs_due_idx on public.push_jobs(status, scheduled_at);

create index if not exists hunter_pings_participant_idx
  on public.hunter_pings(participant_id);

create index if not exists hunter_required_pings_participant_idx
  on public.hunter_required_pings(participant_id);

create index if not exists pings_slot_idx
  on public.pings(slot_id);

create index if not exists push_deliveries_participant_idx
  on public.push_deliveries(participant_id);

create index if not exists push_jobs_slot_idx
  on public.push_jobs(slot_id);

-- Fonctions finales

create or replace function public.my_event_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select p.event_id from public.participants p where p.user_id = auth.uid() and p.active = true limit 1 $$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$ select p.role from public.participants p where p.user_id = auth.uid() and p.active = true limit 1 $$;

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
set search_path = public, extensions
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
returns table(id uuid, slot_id uuid, sent_at timestamptz, valid_window boolean, delta_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select g.id, g.slot_id, g.sent_at, g.valid_window, g.delta_seconds
  from public.submit_ping_guarded(p_lat, p_lng, p_accuracy_m, false) g;
end;
$$;

create or replace function public.draw_extraction_zone()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event uuid := public.my_event_id();
  v_key text;
  v_name text;
  v_token text;
  v_event_row public.events%rowtype;
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;

  select e.* into v_event_row
  from public.events e
  where e.id = v_event
  for update;

  if v_event_row.id is null then
    raise exception 'Événement introuvable';
  end if;

  if v_event_row.active_extraction_key is not null then
    return v_event_row.active_extraction_key;
  end if;

  if v_event_row.status <> 'live' or v_event_row.actual_started_at is null then
    raise exception 'La partie doit être démarrée avant le tirage';
  end if;

  if clock_timestamp() < v_event_row.actual_started_at + interval '80 minutes' then
    raise exception 'La zone d''extraction sera révélée à START +80 minutes';
  end if;

  if v_event_row.actual_ends_at is not null
     and clock_timestamp() >= v_event_row.actual_ends_at then
    raise exception 'La partie est terminée';
  end if;

  select z.zone_key, z.name into v_key, v_name
  from public.zones z
  where z.event_id = v_event
    and z.zone_type = 'extraction'
  order by random()
  limit 1;

  if v_key is null then
    raise exception 'Aucune zone d''extraction configurée';
  end if;

  update public.events
  set active_extraction_key = v_key
  where id = v_event;

  select c.value into v_token
  from public.app_private_config c
  where c.key = 'push_dispatch_token';

  if v_token is not null then
    perform net.http_post(
      url := 'https://loqeiqfwiajvzbuhmycr.supabase.co/functions/v1/push-dispatch',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-dispatch-token',v_token
      ),
      body := jsonb_build_object(
        'mode','extraction',
        'eventId',v_event,
        'zoneKey',v_key,
        'zoneName',v_name
      ),
      timeout_milliseconds := 8000
    );
  end if;

  return v_key;
end;
$function$;

create or replace function public.claim_participant_with_pseudo(p_code text, p_pseudo text)
returns table(id uuid, event_id uuid, pseudo text, role text, team text, active boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_pseudo text;
  v_participant public.participants%rowtype;
  v_existing public.participants%rowtype;
  v_event_status text;
begin
  if v_uid is null then
    raise exception 'Session anonyme requise';
  end if;

  v_pseudo := regexp_replace(trim(coalesce(p_pseudo, '')), '\s+', ' ', 'g');
  if char_length(v_pseudo) < 2 or char_length(v_pseudo) > 24 then
    raise exception 'Le pseudo doit contenir entre 2 et 24 caractères';
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

  if v_participant.user_id is not null and v_participant.user_id <> v_uid then
    raise exception 'Code déjà utilisé sur un autre appareil';
  end if;

  select p.* into v_existing
  from public.participants p
  where p.user_id = v_uid
    and p.active = true
    and p.id <> v_participant.id
  limit 1;

  if v_existing.id is not null then
    raise exception 'Ce navigateur est déjà associé à % (%). Utilise un autre navigateur ou une fenêtre privée pour un second compte.', v_existing.pseudo, v_existing.role;
  end if;

  select e.status into v_event_status
  from public.events e
  where e.id = v_participant.event_id;

  if v_participant.user_id is null or v_event_status <> 'live' then
    if exists (
      select 1
      from public.participants p2
      where p2.event_id = v_participant.event_id
        and p2.id <> v_participant.id
        and lower(p2.pseudo) = lower(v_pseudo)
    ) then
      raise exception 'Ce pseudo est déjà utilisé';
    end if;

    update public.participants p
       set user_id = coalesce(p.user_id, v_uid),
           pseudo = v_pseudo
     where p.id = v_participant.id;
  end if;

  return query
    select p.id, p.event_id, p.pseudo, p.role, p.team, p.active
    from public.participants p
    where p.id = v_participant.id;
end;
$$;

create or replace function public.start_event_now()
returns table(actual_started_at timestamptz, actual_ends_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event_id uuid := public.my_event_id();
  v_event public.events%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if public.my_role() <> 'organizer' then raise exception 'Accès organisateur requis'; end if;

  select e.* into v_event
  from public.events e
  where e.id=v_event_id
  for update;

  if v_event.id is null then raise exception 'Événement introuvable'; end if;

  if v_event.actual_started_at is not null then
    return query select v_event.actual_started_at, v_event.actual_ends_at;
    return;
  end if;

  update public.ping_slots s
     set scheduled_at=v_now + make_interval(mins => public.ping_offset_minutes(s.ordinal)),
         label='Ping ' || s.ordinal::text
   where s.event_id=v_event_id and s.ordinal between 0 and 10;

  update public.events e
     set actual_started_at=v_now,
         actual_ends_at=v_now + interval '120 minutes',
         status='live',
         active_extraction_key=null
   where e.id=v_event_id;

  delete from public.push_jobs where event_id=v_event_id;

  insert into public.push_jobs(event_id,slot_id,scheduled_at)
  select s.event_id,s.id,s.scheduled_at
  from public.ping_slots s
  where s.event_id=v_event_id and s.ordinal between 0 and 10
  order by s.ordinal;

  perform public.dispatch_due_push_jobs();

  return query select v_now, v_now + interval '120 minutes';
end;
$function$;

create or replace function public.reset_extraction_zone()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid := public.my_event_id();
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;

  update public.events
     set active_extraction_key = null
   where id = v_event_id;

  return true;
end;
$$;

create or replace function public.reset_event_start()
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event_id uuid := public.my_event_id();
  v_starts_at timestamptz;
begin
  if public.my_role() <> 'organizer' then raise exception 'Accès organisateur requis'; end if;
  select starts_at into v_starts_at from public.events where id=v_event_id;
  if v_starts_at is null then raise exception 'Événement introuvable'; end if;

  delete from public.push_jobs where event_id=v_event_id;
  update public.events
     set actual_started_at=null,actual_ends_at=null,status='scheduled'
   where id=v_event_id;

  update public.ping_slots
     set scheduled_at=v_starts_at + make_interval(mins => public.ping_offset_minutes(ordinal)),
         label='Ping ' || ordinal::text
   where event_id=v_event_id and ordinal between 0 and 10;

  return true;
end;
$function$;

create or replace function public.reset_party()
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event_id uuid := public.my_event_id();
  v_starts_at timestamptz;
begin
  if public.my_role() <> 'organizer' then raise exception 'Accès organisateur requis'; end if;
  select starts_at into v_starts_at from public.events where id=v_event_id;
  if v_starts_at is null then raise exception 'Événement introuvable'; end if;

  delete from public.push_jobs where event_id=v_event_id;
  delete from public.pings where event_id=v_event_id;
  delete from public.hunter_pings where event_id=v_event_id;
  delete from public.hunter_required_pings where event_id=v_event_id;

  update public.participants
     set play_state='free',play_state_updated_at=null
   where event_id=v_event_id;

  update public.ping_slots
     set scheduled_at=v_starts_at + make_interval(mins => public.ping_offset_minutes(ordinal)),
         label='Ping ' || ordinal::text
   where event_id=v_event_id and ordinal between 0 and 10;

  update public.events
     set actual_started_at=null,actual_ends_at=null,active_extraction_key=null,status='scheduled'
   where id=v_event_id;

  return true;
end;
$function$;

create or replace function public.my_next_ping_status()
returns table(
  event_status text,
  slot_id uuid,
  slot_label text,
  scheduled_at timestamptz,
  all_sent boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_participant public.participants%rowtype;
  v_event_status text;
  v_slot public.ping_slots%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select p.* into v_participant
  from public.participants p
  where p.user_id = auth.uid() and p.active = true
  limit 1;

  if v_participant.id is null or v_participant.role not in ('target','hunter') then
    raise exception 'Accès réservé aux Cibles et Chasseurs';
  end if;

  select e.status into v_event_status
  from public.events e
  where e.id = v_participant.event_id;

  if v_participant.role = 'target' then
    select s.* into v_slot
    from public.ping_slots s
    where s.event_id = v_participant.event_id
      and not exists (
        select 1
        from public.pings pg
        where pg.participant_id = v_participant.id
          and pg.slot_id = s.id
      )
      and (s.ordinal <> 0 or s.scheduled_at + interval '5 minutes' >= v_now)
    order by
      case
        when v_now between s.scheduled_at - interval '60 seconds'
                       and s.scheduled_at + interval '60 seconds' then 0
        when s.scheduled_at < v_now then 1
        else 2
      end,
      case when s.scheduled_at < v_now then s.scheduled_at end desc nulls last,
      case when s.scheduled_at >= v_now then s.scheduled_at end asc nulls last,
      s.ordinal
    limit 1;
  else
    select s.* into v_slot
    from public.ping_slots s
    where s.event_id = v_participant.event_id
      and s.scheduled_at + interval '1 minute' >= v_now
    order by s.ordinal
    limit 1;
  end if;

  if v_slot.id is null then
    return query
    select v_event_status, null::uuid, null::text, null::timestamptz, true;
    return;
  end if;

  return query
  select v_event_status, v_slot.id, v_slot.label, v_slot.scheduled_at, false;
end;
$function$;

create or replace function public.submit_ping_guarded(
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null,
  p_confirm_outside boolean default false
)
returns table(
  id uuid,
  slot_id uuid,
  sent_at timestamptz,
  valid_window boolean,
  delta_seconds integer
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_slot public.ping_slots%rowtype;
  v_sent timestamptz := clock_timestamp();
  v_signed_delta integer;
  v_abs_delta integer;
  v_is_control boolean;
  v_ping public.pings%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentification requise';
  end if;

  select p.* into v_participant
  from public.participants p
  where p.user_id = auth.uid() and p.active = true
  limit 1;

  if v_participant.id is null then
    raise exception 'Participant non reconnu';
  end if;
  if v_participant.role <> 'target' then
    raise exception 'Seules les Cibles peuvent envoyer un ping';
  end if;

  select e.* into v_event
  from public.events e
  where e.id = v_participant.event_id;

  if v_event.id is null then
    raise exception 'Événement introuvable';
  end if;
  if v_event.status <> 'live' or v_event.actual_started_at is null then
    raise exception 'La partie n''a pas encore démarré';
  end if;
  if v_event.actual_ends_at is not null and v_sent >= v_event.actual_ends_at then
    raise exception 'La partie est terminée';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_participant.id::text, 0));

  select s.* into v_slot
  from public.ping_slots s
  where s.event_id = v_participant.event_id
    and not exists (
      select 1
      from public.pings pg
      where pg.participant_id = v_participant.id
        and pg.slot_id = s.id
    )
    and (s.ordinal <> 0 or s.scheduled_at + interval '5 minutes' >= v_sent)
  order by
    case
      when v_sent between s.scheduled_at - interval '60 seconds'
                         and s.scheduled_at + interval '60 seconds' then 0
      when s.scheduled_at < v_sent then 1
      else 2
    end,
    case when s.scheduled_at < v_sent then s.scheduled_at end desc nulls last,
    case when s.scheduled_at >= v_sent then s.scheduled_at end asc nulls last,
    s.ordinal
  limit 1;

  if v_slot.id is null then
    raise exception 'Tous les pings ont déjà été envoyés';
  end if;

  v_signed_delta := round(extract(epoch from (v_sent - v_slot.scheduled_at)))::integer;
  v_abs_delta := abs(v_signed_delta);
  v_is_control := v_slot.ordinal = 0;

  if not v_is_control and v_abs_delta > 60 and not coalesce(p_confirm_outside, false) then
    raise exception 'CONFIRM_OUTSIDE_WINDOW|%|%|%',
      case when v_signed_delta < 0 then 'early' else 'late' end,
      v_slot.label,
      v_abs_delta;
  end if;

  insert into public.pings(
    event_id, participant_id, slot_id, lat, lng, accuracy_m,
    sent_at, valid_window, delta_seconds
  )
  values(
    v_participant.event_id, v_participant.id, v_slot.id,
    p_lat, p_lng, p_accuracy_m,
    v_sent, (v_is_control or v_abs_delta <= 60), v_signed_delta
  )
  on conflict on constraint pings_participant_id_slot_id_key do nothing
  returning public.pings.* into v_ping;

  if v_ping.id is null then
    select pg.* into v_ping
    from public.pings pg
    where pg.participant_id = v_participant.id
      and pg.slot_id = v_slot.id
    limit 1;
  end if;

  return query
  select v_ping.id, v_ping.slot_id, v_ping.sent_at, v_ping.valid_window, v_ping.delta_seconds;
end;
$function$;

create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_participant public.participants%rowtype;
begin
  if v_uid is null then raise exception 'Authentification requise'; end if;

  select p.* into v_participant
  from public.participants p
  where p.user_id = v_uid and p.active = true
  limit 1;

  if v_participant.id is null or v_participant.role not in ('target','hunter') then
    raise exception 'Accès réservé aux joueurs';
  end if;

  if nullif(trim(p_endpoint), '') is null or nullif(trim(p_p256dh), '') is null or nullif(trim(p_auth), '') is null then
    raise exception 'Abonnement push incomplet';
  end if;

  delete from public.push_subscriptions
  where endpoint = p_endpoint and participant_id <> v_participant.id;

  insert into public.push_subscriptions(participant_id, endpoint, p256dh, auth, user_agent, updated_at)
  values(v_participant.id, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
  on conflict (participant_id) do update
    set endpoint = excluded.endpoint,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        updated_at = now();

  return true;
end;
$$;

create or replace function public.remove_my_push_subscription()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant_id uuid;
begin
  select p.id into v_participant_id
  from public.participants p
  where p.user_id = auth.uid() and p.active = true
  limit 1;

  if v_participant_id is null then return false; end if;
  delete from public.push_subscriptions where participant_id = v_participant_id;
  return true;
end;
$$;

create or replace function public.my_push_subscription_status()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.push_subscriptions s
    join public.participants p on p.id = s.participant_id
    where p.user_id = auth.uid() and p.active = true
  );
$$;

create or replace function public.ack_push_notification(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant_id uuid;
begin
  select p.id into v_participant_id
  from public.participants p
  where p.user_id = auth.uid() and p.active = true
  limit 1;

  if v_participant_id is null then return false; end if;

  update public.push_deliveries d
     set clicked_at = now(), status = 'clicked', updated_at = now()
   where d.job_id = p_job_id and d.participant_id = v_participant_id;

  return found;
end;
$$;

create or replace function public.organizer_start_check_status()
returns table(
  participant_id uuid,
  pseudo text,
  role text,
  notifications_enabled boolean,
  ping0_notification_status text,
  ping0_clicked boolean,
  ping0_position_received boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid := public.my_event_id();
  v_ping0_slot uuid;
  v_ping0_job uuid;
begin
  if public.my_role() <> 'organizer' then raise exception 'Accès organisateur requis'; end if;

  select s.id into v_ping0_slot
  from public.ping_slots s
  where s.event_id = v_event_id and s.ordinal = 0
  limit 1;

  select j.id into v_ping0_job
  from public.push_jobs j
  where j.event_id = v_event_id and j.slot_id = v_ping0_slot
  order by j.created_at desc
  limit 1;

  return query
  select p.id,
         p.pseudo,
         p.role,
         exists(select 1 from public.push_subscriptions ps where ps.participant_id = p.id),
         coalesce((select d.status from public.push_deliveries d where d.job_id = v_ping0_job and d.participant_id = p.id), 'pending'),
         coalesce((select d.clicked_at is not null from public.push_deliveries d where d.job_id = v_ping0_job and d.participant_id = p.id), false),
         case when p.role = 'target' then exists(
           select 1 from public.pings pg where pg.participant_id = p.id and pg.slot_id = v_ping0_slot
         ) else false end
  from public.participants p
  where p.event_id = v_event_id
    and p.active = true
    and p.role in ('target','hunter')
  order by p.role, p.pseudo;
end;
$$;

create or replace function public.claim_due_push_jobs()
returns table(id uuid, event_id uuid, slot_id uuid, scheduled_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select j.id
    from public.push_jobs j
    where j.scheduled_at <= clock_timestamp()
      and (
        j.status = 'pending'
        or (j.status = 'processing' and j.locked_at < clock_timestamp() - interval '2 minutes')
      )
    order by j.scheduled_at
    limit 10
    for update skip locked
  )
  update public.push_jobs j
     set status = 'processing',
         locked_at = clock_timestamp(),
         attempt_count = j.attempt_count + 1,
         last_error = null
    from picked p
   where j.id = p.id
  returning j.id, j.event_id, j.slot_id, j.scheduled_at;
end;
$$;

create or replace function public.dispatch_due_push_jobs()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if not exists (
    select 1 from public.push_jobs j
    where j.scheduled_at <= clock_timestamp()
      and (j.status = 'pending' or (j.status = 'processing' and j.locked_at < clock_timestamp() - interval '2 minutes'))
  ) then return; end if;

  select c.value into v_token
  from public.app_private_config c
  where c.key = 'push_dispatch_token';

  if v_token is null then return; end if;

  perform net.http_post(
    url := 'https://loqeiqfwiajvzbuhmycr.supabase.co/functions/v1/push-dispatch',
    headers := jsonb_build_object('Content-Type','application/json','x-dispatch-token',v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
end;
$$;

create or replace function public.reset_player_access()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid := public.my_event_id();
  v_count integer := 0;
begin
  if public.my_role() <> 'organizer' then raise exception 'Accès organisateur requis'; end if;
  delete from public.push_subscriptions ps using public.participants p
   where ps.participant_id = p.id and p.event_id = v_event_id and p.role in ('target','hunter');
  update public.participants p set user_id = null
   where p.event_id = v_event_id and p.role in ('target','hunter') and p.user_id is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.reset_all_access()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid := public.my_event_id();
  v_count integer := 0;
begin
  if public.my_role() <> 'organizer' then raise exception 'Accès organisateur requis'; end if;
  delete from public.push_subscriptions ps using public.participants p
   where ps.participant_id = p.id and p.event_id = v_event_id;
  update public.participants p set user_id = null where p.event_id = v_event_id and p.user_id is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.reset_total_test()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event_id uuid := public.my_event_id();
  v_starts_at timestamptz;
  v_count integer := 0;
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;

  select starts_at into v_starts_at
  from public.events
  where id = v_event_id;

  if v_starts_at is null then
    raise exception 'Événement introuvable';
  end if;

  delete from public.push_jobs
  where event_id = v_event_id;

  delete from public.push_subscriptions ps
  using public.participants p
  where ps.participant_id = p.id
    and p.event_id = v_event_id;

  delete from public.pings where event_id = v_event_id;
  delete from public.hunter_pings where event_id = v_event_id;
  delete from public.hunter_required_pings where event_id = v_event_id;

  update public.ping_slots
  set scheduled_at = v_starts_at + make_interval(mins => public.ping_offset_minutes(ordinal)),
      label = 'Ping ' || ordinal::text
  where event_id = v_event_id
    and ordinal between 0 and 10;

  update public.events
  set actual_started_at = null,
      actual_ends_at = null,
      active_extraction_key = null,
      status = 'scheduled'
  where id = v_event_id;

  update public.participants
  set user_id = null,
      play_state = 'free',
      play_state_updated_at = null,
      pseudo = '__RESET__' || replace(id::text,'-','')
  where event_id = v_event_id;

  with ranked as (
    select p.id,
           p.role,
           row_number() over (partition by p.role order by p.id) as rn
    from public.participants p
    where p.event_id = v_event_id
  )
  update public.participants p
  set pseudo = case r.role
    when 'target' then 'CIBLE ' || lpad(r.rn::text,2,'0')
    when 'hunter' then 'CHASSEUR ' || lpad(r.rn::text,2,'0')
    when 'organizer' then 'ORGA ' || lpad(r.rn::text,2,'0')
    else upper(r.role) || ' ' || lpad(r.rn::text,2,'0')
  end
  from ranked r
  where p.id = r.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create or replace function public.resume_my_participant()
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
begin
  if v_uid is null then
    return;
  end if;

  return query
  select p.id, p.event_id, p.pseudo, p.role, p.team, p.active
  from public.participants p
  where p.user_id = v_uid
    and p.active = true
  limit 1;
end;
$$;

create or replace function public.set_my_target_state(p_state text)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
  v_event uuid;
  v_pseudo text;
  v_old_state text;
  v_token text;
begin
  if p_state not in ('free','capturing','prisoner') then
    raise exception 'État invalide';
  end if;

  select p.id, p.event_id, p.pseudo, p.play_state
    into v_id, v_event, v_pseudo, v_old_state
  from public.participants p
  where p.user_id = auth.uid()
    and p.active = true
    and p.role = 'target'
  limit 1;

  if v_id is null then
    raise exception 'Accès réservé aux Cibles';
  end if;

  update public.participants
  set play_state = p_state,
      play_state_updated_at = clock_timestamp()
  where id = v_id;

  if p_state = 'prisoner' and coalesce(v_old_state,'free') <> 'prisoner' then
    select c.value into v_token
    from public.app_private_config c
    where c.key = 'push_dispatch_token';

    if v_token is not null then
      perform net.http_post(
        url := 'https://loqeiqfwiajvzbuhmycr.supabase.co/functions/v1/push-dispatch',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'x-dispatch-token',v_token
        ),
        body := jsonb_build_object(
          'mode','prisoner',
          'eventId',v_event,
          'participantId',v_id,
          'pseudo',v_pseudo
        ),
        timeout_milliseconds := 8000
      );
    end if;
  end if;

  return p_state;
end;
$function$;

create or replace function public.my_target_state()
returns table(play_state text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $function$
  select p.play_state, p.play_state_updated_at
  from public.participants p
  where p.user_id = auth.uid()
    and p.active = true
    and p.role = 'target'
  limit 1
$function$;

create or replace function public.organizer_manage_list()
returns table(
  id uuid, pseudo text, role text, team text, active boolean,
  device_linked boolean, play_state text, is_self boolean
)
language sql
stable
security definer
set search_path = public
as $function$
  select p.id,
         p.pseudo,
         p.role,
         p.team,
         p.active,
         (p.user_id is not null) as device_linked,
         p.play_state,
         (p.user_id = auth.uid()) as is_self
  from public.participants p
  where p.event_id = public.my_event_id()
    and public.my_role() = 'organizer'
  order by
    case p.role when 'organizer' then 1 when 'target' then 2 when 'hunter' then 3 else 4 end,
    p.pseudo
$function$;

create or replace function public.organizer_create_player(
  p_pseudo text, p_role text, p_team text, p_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_event uuid := public.my_event_id();
  v_id uuid;
  v_pseudo text := btrim(regexp_replace(coalesce(p_pseudo,''), '\s+', ' ', 'g'));
  v_code text := upper(btrim(coalesce(p_code,'')));
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;
  if length(v_pseudo) < 2 or length(v_pseudo) > 24 then
    raise exception 'Pseudo : 2 à 24 caractères';
  end if;
  if p_role not in ('target','hunter','organizer') then
    raise exception 'Rôle invalide';
  end if;
  if length(v_code) < 4 or length(v_code) > 24 then
    raise exception 'Code : 4 à 24 caractères';
  end if;

  insert into public.participants(event_id,pseudo,role,team,active,play_state)
  values (v_event,v_pseudo,p_role,nullif(btrim(coalesce(p_team,'')),''),true,'free')
  returning id into v_id;

  insert into public.access_codes(participant_id,code_hash)
  values (v_id, encode(digest(v_code,'sha256'),'hex'));

  return v_id;
exception
  when unique_violation then
    raise exception 'Pseudo ou code déjà utilisé';
end;
$function$;

create or replace function public.organizer_update_player(
  p_participant_id uuid,
  p_pseudo text,
  p_role text,
  p_team text,
  p_active boolean,
  p_new_code text default null::text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_event uuid := public.my_event_id();
  v_self boolean := false;
  v_pseudo text := btrim(regexp_replace(coalesce(p_pseudo,''), '\s+', ' ', 'g'));
  v_code text := upper(btrim(coalesce(p_new_code,'')));
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;
  if length(v_pseudo) < 2 or length(v_pseudo) > 24 then
    raise exception 'Pseudo : 2 à 24 caractères';
  end if;
  if p_role not in ('target','hunter','organizer') then
    raise exception 'Rôle invalide';
  end if;

  select (part.user_id = auth.uid()) into v_self
  from public.participants part
  where part.id = p_participant_id and part.event_id = v_event;

  if not found then
    raise exception 'Participant introuvable';
  end if;

  if v_self and (p_role <> 'organizer' or not p_active) then
    raise exception 'Impossible de retirer ton propre accès Organisateur';
  end if;

  update public.participants part
  set pseudo = v_pseudo,
      role = p_role,
      team = case
        when p_role <> 'hunter' then null
        when nullif(btrim(coalesce(p_team,'')),'') is null then part.team
        else nullif(btrim(p_team),'')
      end,
      active = p_active,
      play_state = case when p_role = 'target' then play_state else 'free' end
  where part.id = p_participant_id
    and part.event_id = v_event;

  if p_new_code is not null then
    if length(v_code) < 4 or length(v_code) > 24 then
      raise exception 'Code : 4 à 24 caractères';
    end if;

    insert into public.access_codes(participant_id,code_hash)
    values (p_participant_id, encode(digest(v_code,'sha256'),'hex'))
    on conflict (participant_id) do update
      set code_hash = excluded.code_hash;
  end if;

  return true;
exception
  when unique_violation then
    raise exception 'Pseudo ou code déjà utilisé';
end;
$function$;

create or replace function public.organizer_release_player(p_participant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_event uuid := public.my_event_id();
  v_self boolean := false;
begin
  if public.my_role() <> 'organizer' then
    raise exception 'Accès organisateur requis';
  end if;

  select (p.user_id = auth.uid()) into v_self
  from public.participants p
  where p.id = p_participant_id and p.event_id = v_event;

  if not found then
    raise exception 'Participant introuvable';
  end if;
  if v_self then
    raise exception 'Utilise RESET TOUS LES ACCÈS pour libérer ton propre appareil';
  end if;

  delete from public.push_subscriptions ps
  where ps.participant_id = p_participant_id;

  update public.participants
  set user_id = null
  where id = p_participant_id and event_id = v_event;

  return true;
end;
$function$;

create or replace function public.finish_due_events()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  update public.events
  set status = 'finished'
  where status = 'live'
    and actual_ends_at is not null
    and actual_ends_at <= clock_timestamp();

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create or replace function public.sync_my_event_state()
returns table(status text, actual_started_at timestamptz, actual_ends_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event uuid := public.my_event_id();
begin
  if v_event is null then
    raise exception 'Participant non associé';
  end if;

  update public.events
  set status = 'finished'
  where id = v_event
    and status = 'live'
    and actual_ends_at is not null
    and actual_ends_at <= clock_timestamp();

  return query
  select e.status, e.actual_started_at, e.actual_ends_at
  from public.events e
  where e.id = v_event;
end;
$function$;

create or replace function public.visible_target_states()
returns table(
  id uuid,
  pseudo text,
  play_state text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_event uuid := public.my_event_id();
  v_role text := public.my_role();
begin
  if v_event is null or v_role is null then
    raise exception 'Participant non associé';
  end if;

  if v_role = 'hunter' or v_role = 'organizer' then
    return query
      select p.id, p.pseudo, p.play_state, p.play_state_updated_at
      from public.participants p
      where p.event_id = v_event
        and p.active = true
        and p.role = 'target'
      order by p.pseudo;
  elsif v_role = 'target' then
    return query
      select p.id, p.pseudo, p.play_state, p.play_state_updated_at
      from public.participants p
      where p.event_id = v_event
        and p.active = true
        and p.role = 'target'
        and p.play_state = 'prisoner'
      order by p.pseudo;
  end if;

  return;
end;
$function$;

create or replace function public.submit_hunter_ping(
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns table(id uuid, sent_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_ping public.hunter_pings%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select p.* into v_participant
  from public.participants p
  where p.user_id = auth.uid()
    and p.active = true
  limit 1;

  if v_participant.id is null or v_participant.role <> 'hunter' then
    raise exception 'Accès réservé aux Chasseurs';
  end if;

  select e.* into v_event
  from public.events e
  where e.id = v_participant.event_id;

  if v_event.status <> 'live' or v_event.actual_started_at is null then
    raise exception 'La partie n''a pas démarré';
  end if;

  if v_now < v_event.actual_started_at + interval '10 minutes' then
    raise exception 'Le départ des Chasseurs n''est pas encore autorisé';
  end if;

  if v_event.actual_ends_at is not null and v_now >= v_event.actual_ends_at then
    raise exception 'La partie est terminée';
  end if;

  insert into public.hunter_pings(event_id, participant_id, lat, lng, accuracy_m, sent_at)
  values(v_participant.event_id, v_participant.id, p_lat, p_lng, p_accuracy_m, v_now)
  returning * into v_ping;

  return query
  select v_ping.id, v_ping.sent_at;
end;
$function$;

create or replace function public.visible_hunter_pings()
returns table(
  id uuid,
  participant_id uuid,
  pseudo text,
  lat double precision,
  lng double precision,
  accuracy_m double precision,
  sent_at timestamptz
)
language plpgsql
stable
security definer
set search_path=public
as $function$
declare
  v_event uuid := public.my_event_id();
begin
  if public.my_role() <> 'hunter' then
    raise exception 'Accès réservé aux Chasseurs';
  end if;

  return query
  select distinct on (hp.participant_id)
         hp.id,
         hp.participant_id,
         p.pseudo,
         hp.lat,
         hp.lng,
         hp.accuracy_m,
         hp.sent_at
  from public.hunter_pings hp
  join public.participants p on p.id = hp.participant_id
  where hp.event_id = v_event
    and p.active = true
    and p.role = 'hunter'
  order by hp.participant_id, hp.sent_at desc;
end;
$function$;

create or replace function public.my_required_hunter_ping_status()
returns table(
  event_status text,
  scheduled_at timestamptz,
  sent_at timestamptz,
  sent boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_offset integer;
  v_due timestamptz;
  v_sent timestamptz;
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
begin
  select p.* into v_participant
  from public.participants p
  where p.user_id=auth.uid() and p.active=true
  limit 1;

  if v_participant.id is null or v_participant.role <> 'hunter' then
    raise exception 'Accès réservé aux Chasseurs';
  end if;

  select e.* into v_event
  from public.events e
  where e.id=v_participant.event_id;

  if v_event.actual_started_at is null then
    return query
    select v_event.status, null::timestamptz, null::timestamptz, false;
    return;
  end if;

  foreach v_offset in array array[60,95,110]
  loop
    v_sent := null;
    select hp.sent_at into v_sent
    from public.hunter_required_pings hp
    where hp.event_id=v_participant.event_id
      and hp.participant_id=v_participant.id
      and hp.offset_minutes=v_offset
    limit 1;

    if v_sent is not null then
      continue;
    end if;

    v_due := v_event.actual_started_at + make_interval(mins => v_offset);

    if v_now <= v_due + interval '60 seconds' then
      return query
      select v_event.status, v_due, null::timestamptz, false;
      return;
    end if;
  end loop;

  select count(*), max(hp.sent_at)
    into v_count, v_sent
  from public.hunter_required_pings hp
  where hp.event_id=v_participant.event_id
    and hp.participant_id=v_participant.id
    and hp.offset_minutes in (60,95,110);

  if v_count = 3 then
    return query
    select v_event.status,
           v_event.actual_started_at + interval '110 minutes',
           v_sent,
           true;
  else
    return query
    select v_event.status,
           null::timestamptz,
           null::timestamptz,
           false;
  end if;
end;
$function$;

create or replace function public.submit_required_hunter_ping(
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null::double precision
)
returns table(id uuid, sent_at timestamptz, delta_seconds integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_due timestamptz;
  v_offset integer;
  v_delta integer;
  v_ping public.hunter_required_pings%rowtype;
begin
  select p.* into v_participant
  from public.participants p
  where p.user_id=auth.uid() and p.active=true
  limit 1;

  if v_participant.id is null or v_participant.role <> 'hunter' then
    raise exception 'Accès réservé aux Chasseurs';
  end if;

  select e.* into v_event
  from public.events e
  where e.id=v_participant.event_id;

  if v_event.status <> 'live' or v_event.actual_started_at is null then
    raise exception 'La partie n''a pas démarré';
  end if;

  select c.offset_minutes, c.due_at,
         abs(extract(epoch from (v_now - c.due_at)))::integer
    into v_offset, v_due, v_delta
  from (
    select x.offset_minutes,
           v_event.actual_started_at + make_interval(mins => x.offset_minutes) as due_at
    from (values (60),(95),(110)) as x(offset_minutes)
  ) c
  where abs(extract(epoch from (v_now - c.due_at))) <= 60
  order by abs(extract(epoch from (v_now - c.due_at)))
  limit 1;

  if v_offset is null then
    raise exception 'Aucun ping obligatoire Chasseur n''est disponible actuellement';
  end if;

  insert into public.hunter_required_pings(
    event_id, participant_id, offset_minutes, lat, lng, accuracy_m, sent_at
  )
  values(
    v_participant.event_id, v_participant.id, v_offset,
    p_lat, p_lng, p_accuracy_m, v_now
  )
  on conflict(event_id,participant_id,offset_minutes) do update
    set lat=excluded.lat,
        lng=excluded.lng,
        accuracy_m=excluded.accuracy_m,
        sent_at=excluded.sent_at
  returning * into v_ping;

  return query select v_ping.id, v_ping.sent_at, v_delta;
end;
$function$;

create or replace function public.visible_required_hunter_pings()
returns table(
  id uuid,
  participant_id uuid,
  pseudo text,
  lat double precision,
  lng double precision,
  accuracy_m double precision,
  sent_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_event uuid := public.my_event_id();
begin
  if v_event is null or public.my_role() not in ('target','hunter','organizer') then
    raise exception 'Participant non associé';
  end if;

  return query
  select distinct on (hp.participant_id)
         hp.id,
         hp.participant_id,
         p.pseudo,
         hp.lat,
         hp.lng,
         hp.accuracy_m,
         hp.sent_at
  from public.hunter_required_pings hp
  join public.participants p on p.id=hp.participant_id
  where hp.event_id=v_event
    and p.active=true
    and p.role='hunter'
  order by hp.participant_id, hp.sent_at desc;
end;
$function$;

create or replace function public.reveal_due_extraction_zones()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event record;
  v_key text;
  v_name text;
  v_token text;
  v_count integer := 0;
begin
  for v_event in
    select e.id
    from public.events e
    where e.status = 'live'
      and e.actual_started_at is not null
      and e.active_extraction_key is null
      and clock_timestamp() >= e.actual_started_at + interval '80 minutes'
      and (e.actual_ends_at is null or clock_timestamp() < e.actual_ends_at)
    for update skip locked
  loop
    select z.zone_key, z.name into v_key, v_name
    from public.zones z
    where z.event_id = v_event.id
      and z.zone_type = 'extraction'
    order by random()
    limit 1;

    if v_key is null then
      continue;
    end if;

    update public.events
    set active_extraction_key = v_key
    where id = v_event.id
      and active_extraction_key is null;

    if found then
      v_count := v_count + 1;

      select c.value into v_token
      from public.app_private_config c
      where c.key = 'push_dispatch_token';

      if v_token is not null then
        perform net.http_post(
          url := 'https://loqeiqfwiajvzbuhmycr.supabase.co/functions/v1/push-dispatch',
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'x-dispatch-token',v_token
          ),
          body := jsonb_build_object(
            'mode','extraction',
            'eventId',v_event.id,
            'zoneKey',v_key,
            'zoneName',v_name
          ),
          timeout_milliseconds := 8000
        );
      end if;
    end if;
  end loop;

  return v_count;
end;
$function$;

create or replace function public.ping_offset_minutes(p_ordinal integer)
returns integer
language sql
immutable
set search_path to 'public'
as $function$
  select case p_ordinal
    when 0 then 0
    when 1 then 20
    when 2 then 30
    when 3 then 40
    when 4 then 50
    when 5 then 60
    when 6 then 80
    when 7 then 95
    when 8 then 100
    when 9 then 105
    when 10 then 110
    else null
  end
$function$;

-- Accès et RLS

alter table public.events enable row level security;
alter table public.zones enable row level security;
alter table public.participants enable row level security;
alter table public.access_codes enable row level security;
alter table public.ping_slots enable row level security;
alter table public.pings enable row level security;
alter table public.hunter_pings enable row level security;
alter table public.hunter_required_pings enable row level security;
alter table public.app_private_config enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;
alter table public.push_deliveries enable row level security;

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


revoke all on table public.access_codes from public, anon, authenticated;
revoke all on table public.app_private_config from public, anon, authenticated;
revoke all on table public.hunter_pings from public, anon, authenticated;
revoke all on table public.hunter_required_pings from public, anon, authenticated;
revoke all on table public.push_deliveries from public, anon, authenticated;
revoke all on table public.push_jobs from public, anon, authenticated;
revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select on public.events to authenticated;
grant select on public.zones to authenticated;
grant select on public.participants to authenticated;
grant select on public.ping_slots to authenticated;
grant select on public.pings to authenticated;

revoke all on function public.my_event_id() from public, anon, authenticated;
grant execute on function public.my_event_id() to authenticated;
revoke all on function public.my_role() from public, anon, authenticated;
grant execute on function public.my_role() to authenticated;
revoke all on function public.claim_participant(text) from public, anon, authenticated;
grant execute on function public.claim_participant(text) to authenticated;
revoke all on function public.submit_ping(double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.submit_ping(double precision, double precision, double precision) to authenticated;
revoke all on function public.draw_extraction_zone() from public, anon, authenticated;
grant execute on function public.draw_extraction_zone() to authenticated;
revoke all on function public.claim_participant_with_pseudo(text, text) from public, anon, authenticated;
grant execute on function public.claim_participant_with_pseudo(text, text) to authenticated;
revoke all on function public.start_event_now() from public, anon, authenticated;
grant execute on function public.start_event_now() to authenticated;
revoke all on function public.reset_extraction_zone() from public, anon, authenticated;
grant execute on function public.reset_extraction_zone() to authenticated;
revoke all on function public.reset_event_start() from public, anon, authenticated;
grant execute on function public.reset_event_start() to authenticated;
revoke all on function public.reset_party() from public, anon, authenticated;
grant execute on function public.reset_party() to authenticated;
revoke all on function public.my_next_ping_status() from public, anon, authenticated;
grant execute on function public.my_next_ping_status() to authenticated;
revoke all on function public.submit_ping_guarded(double precision, double precision, double precision, boolean) from public, anon, authenticated;
grant execute on function public.submit_ping_guarded(double precision, double precision, double precision, boolean) to authenticated;
revoke all on function public.save_push_subscription(text,text,text,text) from public, anon, authenticated;
grant execute on function public.save_push_subscription(text,text,text,text) to authenticated;
revoke all on function public.remove_my_push_subscription() from public, anon, authenticated;
grant execute on function public.remove_my_push_subscription() to authenticated;
revoke all on function public.my_push_subscription_status() from public, anon, authenticated;
grant execute on function public.my_push_subscription_status() to authenticated;
revoke all on function public.ack_push_notification(uuid) from public, anon, authenticated;
grant execute on function public.ack_push_notification(uuid) to authenticated;
revoke all on function public.organizer_start_check_status() from public, anon, authenticated;
grant execute on function public.organizer_start_check_status() to authenticated;
revoke all on function public.claim_due_push_jobs() from public, anon, authenticated;
grant execute on function public.claim_due_push_jobs() to service_role;
revoke all on function public.dispatch_due_push_jobs() from public, anon, authenticated;
revoke all on function public.reset_player_access() from public, anon, authenticated;
grant execute on function public.reset_player_access() to authenticated;
revoke all on function public.reset_all_access() from public, anon, authenticated;
grant execute on function public.reset_all_access() to authenticated;
revoke all on function public.reset_total_test() from public, anon, authenticated;
grant execute on function public.reset_total_test() to authenticated;
revoke all on function public.resume_my_participant() from public, anon, authenticated;
grant execute on function public.resume_my_participant() to authenticated;
revoke all on function public.set_my_target_state(text) from public, anon, authenticated;
grant execute on function public.set_my_target_state(text) to authenticated;
revoke all on function public.my_target_state() from public, anon, authenticated;
grant execute on function public.my_target_state() to authenticated;
revoke all on function public.organizer_manage_list() from public, anon, authenticated;
grant execute on function public.organizer_manage_list() to authenticated;
revoke all on function public.organizer_create_player(text,text,text,text) from public, anon, authenticated;
grant execute on function public.organizer_create_player(text,text,text,text) to authenticated;
revoke all on function public.organizer_update_player(uuid,text,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.organizer_update_player(uuid,text,text,text,boolean,text) to authenticated;
revoke all on function public.organizer_release_player(uuid) from public, anon, authenticated;
grant execute on function public.organizer_release_player(uuid) to authenticated;
revoke all on function public.finish_due_events() from public, anon, authenticated;
revoke all on function public.sync_my_event_state() from public, anon, authenticated;
grant execute on function public.sync_my_event_state() to authenticated;
revoke all on function public.visible_target_states() from public, anon, authenticated;
grant execute on function public.visible_target_states() to authenticated;
revoke all on function public.submit_hunter_ping(double precision,double precision,double precision) from public, anon, authenticated;
grant execute on function public.submit_hunter_ping(double precision,double precision,double precision) to authenticated;
revoke all on function public.visible_hunter_pings() from public, anon, authenticated;
grant execute on function public.visible_hunter_pings() to authenticated;
revoke all on function public.my_required_hunter_ping_status() from public, anon, authenticated;
grant execute on function public.my_required_hunter_ping_status() to authenticated;
revoke all on function public.submit_required_hunter_ping(double precision,double precision,double precision) from public, anon, authenticated;
grant execute on function public.submit_required_hunter_ping(double precision,double precision,double precision) to authenticated;
revoke all on function public.visible_required_hunter_pings() from public, anon, authenticated;
grant execute on function public.visible_required_hunter_pings() to authenticated;
revoke all on function public.reveal_due_extraction_zones() from public, anon, authenticated;

-- Services Supabase

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
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='hunter_pings'
  ) then
    alter publication supabase_realtime add table public.hunter_pings;
  end if;
end $$;

insert into public.app_private_config(key,value,updated_at)
select 'push_dispatch_token', encode(extensions.gen_random_bytes(32),'hex'), now()
where not exists (select 1 from public.app_private_config where key='push_dispatch_token');

select cron.unschedule(jobid) from cron.job
where jobname in ('chasse_push_dispatch','evasion_extraction_reveal','evasion_finish_events','evasion_capture_release');
select cron.schedule('chasse_push_dispatch','10 seconds','select public.dispatch_due_push_jobs();');
select cron.schedule('evasion_extraction_reveal','10 seconds','select public.reveal_due_extraction_zones();');
select cron.schedule('evasion_finish_events','10 seconds','select public.finish_due_events();');
select cron.schedule('evasion_capture_release','10 seconds',
  $$update public.participants set play_state='free', play_state_updated_at=clock_timestamp()
    where active=true and role='target' and play_state='capturing'
      and play_state_updated_at is not null
      and play_state_updated_at + interval '15 minutes' <= clock_timestamp();$$);
