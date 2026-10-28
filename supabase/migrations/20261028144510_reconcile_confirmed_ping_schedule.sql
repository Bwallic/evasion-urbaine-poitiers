-- Planning confirmé le 28 octobre 2026. Appliquer après les correctifs de production.
-- Cibles : Ping 0 puis +20/+30/+40/+50/+60/+80/+95/+100/+105/+110.
-- Chasseurs : +60/+95/+110. Extraction inchangée à +80 ; durée 120 minutes.
-- Transactionnel : ne redémarre aucune partie et ne réinterprète aucun ping historique.
begin;

-- Sérialiser le contrôle avec START avant de modifier le planning.
do $guard$
begin
  perform 1 from public.events
  where id='11111111-1111-1111-1111-111111111111' for update;
  if not found then
    raise exception 'Événement absent : exécuter seed-event.sql avant la réconciliation';
  end if;
  if exists (
    select 1 from public.events
    where id='11111111-1111-1111-1111-111111111111'
      and (status <> 'scheduled' or actual_started_at is not null)
  ) then
    raise exception 'Réconciliation réservée à une partie en attente du START';
  end if;
  if exists (
    select 1 from public.pings p join public.ping_slots s on s.id=p.slot_id
    where s.event_id='11111111-1111-1111-1111-111111111111'
  ) then
    raise exception 'Des pings Cibles existent : examiner les données de test avant de modifier leurs créneaux';
  end if;
end;
$guard$;

alter table public.hunter_required_pings
  add column if not exists offset_minutes integer;

do $guard$
begin
  if exists (
    select 1 from public.hunter_required_pings
    where offset_minutes is not null and offset_minutes not in (60,95,110)
  ) then
    raise exception 'Pings Chasseurs incompatibles (ancien +100) : examiner les données avant la réconciliation';
  end if;
end;
$guard$;

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

-- Retirer uniquement les anciens créneaux sans position Cible enregistrée.
-- Le contrôle ci-dessus empêche toute suppression indirecte d'une position.
delete from public.push_jobs j using public.ping_slots s
where j.slot_id=s.id
  and s.event_id='11111111-1111-1111-1111-111111111111'
  and s.ordinal not between 0 and 10;
delete from public.ping_slots
where event_id='11111111-1111-1111-1111-111111111111'
  and ordinal not between 0 and 10;

insert into public.ping_slots(event_id,label,scheduled_at,ordinal)
select e.id, 'Ping ' || x.ordinal,
       e.starts_at + make_interval(mins => public.ping_offset_minutes(x.ordinal)),
       x.ordinal
from public.events e cross join generate_series(0,10) as x(ordinal)
where e.id='11111111-1111-1111-1111-111111111111'
on conflict(event_id,ordinal) do update
  set label=excluded.label, scheduled_at=excluded.scheduled_at;

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

-- Ces RPC contrôlent le participant et le rôle ; pas de lecture directe des tables.
revoke all on function public.my_required_hunter_ping_status() from public, anon;
revoke all on function public.submit_required_hunter_ping(double precision,double precision,double precision) from public, anon;
revoke all on function public.visible_required_hunter_pings() from public, anon;
grant execute on function public.my_required_hunter_ping_status() to authenticated;
grant execute on function public.submit_required_hunter_ping(double precision,double precision,double precision) to authenticated;
grant execute on function public.visible_required_hunter_pings() to authenticated;
revoke all on public.hunter_required_pings from public, anon, authenticated;

revoke all on function public.start_event_now() from public, anon;
revoke all on function public.reset_event_start() from public, anon;
revoke all on function public.reset_party() from public, anon;
grant execute on function public.start_event_now() to authenticated;
grant execute on function public.reset_event_start() to authenticated;
grant execute on function public.reset_party() to authenticated;

commit;
