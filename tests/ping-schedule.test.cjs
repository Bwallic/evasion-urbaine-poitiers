const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, before, after, beforeEach } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const migrationPath = fs.readdirSync(path.join(__dirname, '..', 'supabase/migrations'))
  .find(file => file.endsWith('_reconcile_confirmed_ping_schedule.sql'));
const migration = read(`supabase/migrations/${migrationPath}`);
const eventId = '11111111-1111-1111-1111-111111111111';
const organizerId = '22222222-2222-2222-2222-222222222222';
const hunterId = '33333333-3333-3333-3333-333333333333';
const targetId = '44444444-4444-4444-4444-444444444444';
const expected = [0,20,30,40,50,60,80,95,100,105,110];
let db;
const query = async sql => (await db.query(sql)).rows;
async function asParticipant(id, sql) {
  await db.exec(`set request.jwt.claim.sub = '${id}'; set role authenticated;`);
  try { return await query(sql); } finally { await db.exec('reset role'); }
}

before(async () => {
  db = new PGlite();
  // Real PostgreSQL functions, tables and RLS. Hosted Auth, pgcrypto and the
  // Realtime publication are outside this timing test; only Auth identity is stubbed.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  await db.exec(read('supabase/schema.sql')
    .replace('create extension if not exists pgcrypto;', '')
    .split('\ndo $$')[0]);
  await db.exec(`alter table public.events add column actual_started_at timestamptz,
    add column actual_ends_at timestamptz;`);
  const pushSource = read('supabase/20260929_push_notifications_ping0.sql');
  await db.exec(pushSource.slice(pushSource.indexOf('create table if not exists public.push_jobs ('),
    pushSource.indexOf('alter table public.push_jobs enable')));
  await db.exec(`create function public.dispatch_due_push_jobs() returns void
    language sql as $$ select null::void $$;
    create table public.push_subscriptions(participant_id uuid references public.participants(id));`);
  await db.exec(read('supabase/seed-event.sql'));
  await db.exec(migration);
  const resetSource = read('supabase/20261027_final_cleanup.sql');
  await db.exec(resetSource.slice(resetSource.indexOf('create or replace function public.reset_total_test()'),
    resetSource.indexOf('-- Reduce timing drift')));
  await db.exec(`insert into auth.users(id) values ('${organizerId}'),('${hunterId}'),('${targetId}');
    insert into public.participants(id,event_id,pseudo,role,user_id) values
    ('${organizerId}','${eventId}','Organisateur','organizer','${organizerId}'),
    ('${hunterId}','${eventId}','Chasseur','hunter','${hunterId}'),
    ('${targetId}','${eventId}','Cible','target','${targetId}');`);
});
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  await db.exec(`delete from public.pings; delete from public.hunter_pings;
    delete from public.hunter_required_pings; delete from public.push_jobs;
    update public.events set status='scheduled', actual_started_at=null,
      actual_ends_at=null, active_extraction_key=null;
    update public.participants set user_id=id;
    update public.ping_slots s set scheduled_at=e.starts_at +
      make_interval(mins=>public.ping_offset_minutes(s.ordinal))
    from public.events e where s.event_id=e.id;`);
});

async function offsetsFrom(column) {
  return (await query(`select s.ordinal, extract(epoch from (s.scheduled_at-e.${column}))/60 as minutes
    from public.ping_slots s join public.events e on e.id=s.event_id order by s.ordinal`))
    .map(row => Number(row.minutes));
}

test('seed, demo and SQL agree on all eleven target slots', async () => {
  assert.deepEqual(await offsetsFrom('starts_at'), expected);
  const context = { window: {} };
  vm.runInNewContext(read('config.js'), context);
  const times = Array.from(context.window.CHASSE_CONFIG.PING_TIMES);
  assert.deepEqual(times, expected.map(offset => {
    const mins = 20*60 + offset;
    return `${Math.floor(mins/60)}:${String(mins%60).padStart(2,'0')}`;
  }));
});

test('START schedules exactly eleven push jobs relative to the actual departure', async () => {
  const [event] = await asParticipant(organizerId, 'select * from public.start_event_now()');
  assert.deepEqual(await offsetsFrom('actual_started_at'), expected);
  const jobs = await query(`select extract(epoch from (j.scheduled_at-e.actual_started_at))/60 as minutes
    from public.push_jobs j join public.events e on e.id=j.event_id
    join public.ping_slots s on s.id=j.slot_id order by s.ordinal`);
  assert.deepEqual(jobs.map(row => Number(row.minutes)), expected);
  assert.equal(new Date(event.actual_ends_at)-new Date(event.actual_started_at), 120*60000);
  const [again] = await asParticipant(organizerId, 'select * from public.start_event_now()');
  assert.equal(new Date(again.actual_started_at).getTime(), new Date(event.actual_started_at).getTime());
  assert.equal((await query('select count(*)::int as n from public.push_jobs'))[0].n, 11);
});

test('all RESET variants restore the confirmed theoretical target schedule', async () => {
  for (const fn of ['reset_event_start','reset_party','reset_total_test']) {
    await db.exec('update public.participants set user_id=id');
    await asParticipant(organizerId, 'select * from public.start_event_now()');
    await asParticipant(organizerId, `select public.${fn}()`);
    assert.deepEqual(await offsetsFrom('starts_at'), expected);
    assert.equal((await query('select status from public.events'))[0].status, 'scheduled');
  }
});

test('hunter status and submission accept +60/+95/+110; all three are required', async () => {
  for (let i=0; i<3; i++) {
    const offset = [60,95,110][i];
    await db.exec(`update public.events set status='live',
      actual_started_at=clock_timestamp()-interval '${offset} minutes',
      actual_ends_at=clock_timestamp()+interval '${120-offset} minutes'`);
    const [status] = await asParticipant(hunterId, 'select * from public.my_required_hunter_ping_status()');
    assert.equal(status.sent, false);
    const [event] = await query('select actual_started_at from public.events');
    assert.equal(new Date(status.scheduled_at)-new Date(event.actual_started_at), offset*60000);
    await asParticipant(hunterId, 'select * from public.submit_required_hunter_ping(46.58,0.34,10)');
  }
  assert.deepEqual((await query('select offset_minutes from public.hunter_required_pings order by offset_minutes'))
    .map(row => row.offset_minutes), [60,95,110]);
  assert.equal((await asParticipant(hunterId, 'select * from public.my_required_hunter_ping_status()'))[0].sent, true);
  await asParticipant(hunterId, 'select * from public.submit_required_hunter_ping(46.59,0.35,10)');
  assert.equal((await query('select count(*)::int as n from public.hunter_required_pings'))[0].n, 3);
  await assert.rejects(asParticipant(targetId,
    'select * from public.submit_required_hunter_ping(46.58,0.34,10)'), /réservé aux Chasseurs/);
});

test('hunter validation checks both sides of the sixty-second window', async () => {
  for (const delta of [-61,-59,59,61]) {
    await db.exec(`delete from public.hunter_required_pings;
      update public.events set status='live',
      actual_started_at=clock_timestamp()-interval '95 minutes'-make_interval(secs=>${delta}),
      actual_ends_at=clock_timestamp()+interval '25 minutes'`);
    const send = () => asParticipant(hunterId,
      'select * from public.submit_required_hunter_ping(46.58,0.34,10)');
    if (Math.abs(delta) < 60) assert.equal((await send()).length, 1);
    else await assert.rejects(send(), /Aucun ping obligatoire/);
  }
});

test('a missed +60 does not block +95 but cannot count toward three completed pings', async () => {
  await db.exec(`update public.events set status='live',
    actual_started_at=clock_timestamp()-interval '95 minutes',
    actual_ends_at=clock_timestamp()+interval '25 minutes'`);
  const [status] = await asParticipant(hunterId, 'select * from public.my_required_hunter_ping_status()');
  assert.ok(Math.abs(new Date(status.scheduled_at)-Date.now()) < 5000);
  await asParticipant(hunterId, 'select * from public.submit_required_hunter_ping(46.58,0.34,10)');
  await db.exec(`update public.events set actual_started_at=clock_timestamp()-interval '110 minutes',
    actual_ends_at=clock_timestamp()+interval '10 minutes'`);
  await asParticipant(hunterId, 'select * from public.submit_required_hunter_ping(46.58,0.34,10)');
  await db.exec(`update public.events set actual_started_at=clock_timestamp()-interval '112 minutes'`);
  const [missed] = await asParticipant(hunterId, 'select * from public.my_required_hunter_ping_status()');
  assert.equal(missed.sent, false);
  assert.equal(missed.scheduled_at, null);
});

test('old +100 hunter timing and a late +95 submission are rejected', async () => {
  for (const offset of [100,96.1]) {
    await db.exec(`update public.events set status='live',
      actual_started_at=clock_timestamp()-interval '${offset} minutes',
      actual_ends_at=clock_timestamp()+interval '20 minutes'`);
    await assert.rejects(asParticipant(hunterId,
      'select * from public.submit_required_hunter_ping(46.58,0.34,10)'), /Aucun ping obligatoire/);
  }
  await assert.rejects(db.exec(`insert into public.hunter_required_pings
    (event_id,participant_id,offset_minutes,lat,lng) values
    ('${eventId}','${hunterId}',100,46.58,0.34)`), /hunter_required_pings_offset_minutes_check/);
});

test('required hunter markers are visible to all participant roles through RPC', async () => {
  await db.exec(`insert into public.hunter_required_pings
    (event_id,participant_id,offset_minutes,lat,lng) values
    ('${eventId}','${hunterId}',60,46.58,0.34)`);
  for (const id of [organizerId,hunterId,targetId]) {
    assert.equal((await asParticipant(id, 'select * from public.visible_required_hunter_pings()')).length, 1);
  }
  await assert.rejects(asParticipant(targetId, 'select * from public.hunter_required_pings'), /permission denied/);
});

test('migration repairs the previous +75/+90 target schedule and removes unused extras', async () => {
  await db.exec(`update public.ping_slots set scheduled_at=scheduled_at-interval '5 minutes' where ordinal in (6,7);
    insert into public.ping_slots(event_id,label,scheduled_at,ordinal)
    values ('${eventId}','Ping 11',now(),11);`);
  await db.exec(migration);
  assert.deepEqual(await offsetsFrom('starts_at'), expected);
  await db.exec(migration); // rerunnable while waiting for START
  assert.deepEqual(await offsetsFrom('starts_at'), expected);
});

test('migration upgrades the original one-ping hunter table without losing its position', async () => {
  await db.exec(`alter table public.hunter_required_pings
    drop constraint hunter_required_pings_event_participant_offset_key;
    alter table public.hunter_required_pings drop column offset_minutes;
    alter table public.hunter_required_pings add constraint hunter_required_pings_event_id_participant_id_key
      unique(event_id,participant_id);
    insert into public.hunter_required_pings(event_id,participant_id,lat,lng)
    values ('${eventId}','${hunterId}',46.58,0.34);`);
  await db.exec(migration);
  assert.deepEqual(await query('select offset_minutes,lat from public.hunter_required_pings'),
    [{offset_minutes:60,lat:46.58}]);
  await db.exec(`insert into public.hunter_required_pings(event_id,participant_id,offset_minutes,lat,lng)
    values ('${eventId}','${hunterId}',95,46.59,0.35),('${eventId}','${hunterId}',110,46.60,0.36);`);
  assert.equal((await query('select count(*)::int as n from public.hunter_required_pings'))[0].n, 3);
});

test('migration preserves target positions by refusing to move their slots', async () => {
  await db.exec(`insert into public.pings(event_id,participant_id,slot_id,lat,lng,valid_window,delta_seconds)
    select '${eventId}','${targetId}',id,46.58,0.34,true,0
    from public.ping_slots where event_id='${eventId}' and ordinal=0;`);
  await assert.rejects(db.exec(migration), /Des pings Cibles existent/);
  await db.exec('rollback');
  assert.equal((await query('select count(*)::int as n from public.pings'))[0].n, 1);
});

test('migration aborts rather than moving a live event or relabelling old +100 positions', async () => {
  await asParticipant(organizerId, 'select * from public.start_event_now()');
  await assert.rejects(db.exec(migration), /en attente du START/);
  await db.exec('rollback');
  assert.equal((await query('select status from public.events'))[0].status, 'live');
  await db.exec(`update public.events set status='scheduled',actual_started_at=null;
    alter table public.hunter_required_pings drop constraint hunter_required_pings_offset_minutes_check;
    insert into public.hunter_required_pings(event_id,participant_id,offset_minutes,lat,lng)
    values ('${eventId}','${hunterId}',100,46.58,0.34);`);
  await assert.rejects(db.exec(migration), /ancien \+100/);
  await db.exec('rollback');
  assert.equal((await query('select offset_minutes from public.hunter_required_pings'))[0].offset_minutes, 100);
  await db.exec(`delete from public.hunter_required_pings;
    alter table public.hunter_required_pings add constraint hunter_required_pings_offset_minutes_check
    check (offset_minutes in (60,95,110));`);
});

test('push titles use the actual matching target slots for all required hunter pings', async () => {
  const source = read('supabase/functions/push-dispatch/index.ts');
  const mapping = JSON.parse(source.match(/\(\{ (5: 60, 7: 95, 10: 110) \} as/)[1]
    .replace(/(\d+):/g,'"$1":').replace(/^/,'{').replace(/$/,'}'));
  for (const [ordinal, offset] of Object.entries(mapping)) {
    assert.equal((await query(`select public.ping_offset_minutes(${Number(ordinal)}) as minutes`))[0].minutes, offset);
  }
});
