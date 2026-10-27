-- Final production cleanup for Évasion Urbaine.
-- Keeps the validated interface/game rules while hardening timing, missed-ping recovery
-- and server-side final-state behavior.

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

-- Re-assert the final target schedule only while the event is waiting for START.
update public.ping_slots s
set scheduled_at = e.starts_at + make_interval(mins => public.ping_offset_minutes(s.ordinal)),
    label = 'Ping ' || s.ordinal::text
from public.events e
where s.event_id = e.id
  and e.id = '11111111-1111-1111-1111-111111111111'
  and e.status = 'scheduled'
  and e.actual_started_at is null
  and s.ordinal between 0 and 10;

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

-- Reduce timing drift while keeping database load negligible.
select cron.unschedule(jobid)
from cron.job
where jobname = 'evasion_finish_events';

select cron.schedule(
  'evasion_finish_events',
  '10 seconds',
  'select public.finish_due_events();'
);

select cron.unschedule(jobid)
from cron.job
where jobname = 'evasion_capture_release';

select cron.schedule(
  'evasion_capture_release',
  '10 seconds',
  $$update public.participants
    set play_state = 'free',
        play_state_updated_at = clock_timestamp()
    where active = true
      and role = 'target'
      and play_state = 'capturing'
      and play_state_updated_at is not null
      and play_state_updated_at + interval '15 minutes' <= clock_timestamp();$$
);
