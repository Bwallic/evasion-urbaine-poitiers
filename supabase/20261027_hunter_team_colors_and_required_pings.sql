-- Évasion Urbaine — pings Chasseurs obligatoires multiples et conservation des équipes.
-- Les pings obligatoires sont prévus à START +60, +95 (25 min avant la fin)
-- et +110 (10 min avant la fin), avec une tolérance de ±60 secondes.

alter table public.hunter_required_pings
  add column if not exists offset_minutes integer;

update public.hunter_required_pings
set offset_minutes = 60
where offset_minutes is null;

alter table public.hunter_required_pings
  alter column offset_minutes set default 60,
  alter column offset_minutes set not null;

alter table public.hunter_required_pings
  drop constraint if exists hunter_required_pings_event_id_participant_id_key;

alter table public.hunter_required_pings
  drop constraint if exists hunter_required_pings_offset_minutes_check;

alter table public.hunter_required_pings
  add constraint hunter_required_pings_offset_minutes_check
  check (offset_minutes in (60,95,110));

alter table public.hunter_required_pings
  drop constraint if exists hunter_required_pings_event_participant_offset_key;

alter table public.hunter_required_pings
  add constraint hunter_required_pings_event_participant_offset_key
  unique (event_id, participant_id, offset_minutes);

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
set search_path to 'public'
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

