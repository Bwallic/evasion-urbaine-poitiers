-- Événement : 28 octobre 2026, Poitiers.
-- Le 28/10/2026, Poitiers est en UTC+1 après le passage à l'heure d'hiver.

insert into public.events (id, name, starts_at, ends_at, status)
values (
  '11111111-1111-1111-1111-111111111111',
  'Évasion Urbaine — Poitiers',
  '2026-10-28 20:00:00+01',
  '2026-10-28 22:00:00+01',
  'scheduled'
)
on conflict (id) do update set
  name = excluded.name,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at;

insert into public.zones (event_id, zone_key, name, zone_type, sort_order) values
('11111111-1111-1111-1111-111111111111','play-area','Périmètre de jeu','perimeter',0),
('11111111-1111-1111-1111-111111111111','extraction-1','Extraction 1 - Eglise','extraction',1),
('11111111-1111-1111-1111-111111111111','extraction-2','Extraction 2 - Ilot Tison','extraction',2),
('11111111-1111-1111-1111-111111111111','extraction-3','Extraction 3 - Dernier étage Parking de la gare','extraction',3),
('11111111-1111-1111-1111-111111111111','extraction-4','Extraction 4 - Pont Neuf','extraction',4),
('11111111-1111-1111-1111-111111111111','extraction-5','Extraction 5 - Anneaux Palais de justice','extraction',5),
('11111111-1111-1111-1111-111111111111','extraction-6','Extraction 6 - Cité Marie Curie','extraction',6),
('11111111-1111-1111-1111-111111111111','prison','Prison','prison',10)
on conflict (event_id, zone_key) do update
set name=excluded.name, zone_type=excluded.zone_type, sort_order=excluded.sort_order;

insert into public.ping_slots (event_id, label, scheduled_at, ordinal) values
('11111111-1111-1111-1111-111111111111','Ping 0','2026-10-28 20:00:00+01',0),
('11111111-1111-1111-1111-111111111111','Ping 1','2026-10-28 20:20:00+01',1),
('11111111-1111-1111-1111-111111111111','Ping 2','2026-10-28 20:30:00+01',2),
('11111111-1111-1111-1111-111111111111','Ping 3','2026-10-28 20:40:00+01',3),
('11111111-1111-1111-1111-111111111111','Ping 4','2026-10-28 20:50:00+01',4),
('11111111-1111-1111-1111-111111111111','Ping 5','2026-10-28 21:00:00+01',5),
('11111111-1111-1111-1111-111111111111','Ping 6','2026-10-28 21:20:00+01',6),
('11111111-1111-1111-1111-111111111111','Ping 7','2026-10-28 21:35:00+01',7),
('11111111-1111-1111-1111-111111111111','Ping 8','2026-10-28 21:40:00+01',8),
('11111111-1111-1111-1111-111111111111','Ping 9','2026-10-28 21:45:00+01',9),
('11111111-1111-1111-1111-111111111111','Ping 10','2026-10-28 21:50:00+01',10)
on conflict (event_id, ordinal) do update
set label=excluded.label, scheduled_at=excluded.scheduled_at;
