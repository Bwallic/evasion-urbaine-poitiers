-- EXEMPLE À ADAPTER avec les vrais pseudos et les codes distribués le soir du jeu.
-- Les codes sont normalisés en MAJUSCULES avant hashage.
-- Ne publie pas ce fichier avec les vrais codes si le dépôt GitHub est public.

with p as (
  insert into public.participants (event_id, pseudo, role)
  values ('11111111-1111-1111-1111-111111111111','ORGA','organizer')
  on conflict (event_id,pseudo) do update set role=excluded.role
  returning id
)
insert into public.access_codes (participant_id, code_hash)
select id, encode(extensions.digest('ORGA-CHANGE-MOI','sha256'),'hex') from p
on conflict (participant_id) do update set code_hash=excluded.code_hash;

with p as (
  insert into public.participants (event_id, pseudo, role)
  values ('11111111-1111-1111-1111-111111111111','Cible Alpha','target')
  on conflict (event_id,pseudo) do update set role=excluded.role
  returning id
)
insert into public.access_codes (participant_id, code_hash)
select id, encode(extensions.digest('ALPHA-CHANGE-MOI','sha256'),'hex') from p
on conflict (participant_id) do update set code_hash=excluded.code_hash;

with p as (
  insert into public.participants (event_id, pseudo, role, team)
  values ('11111111-1111-1111-1111-111111111111','Chasseur Rouge 1','hunter','Rouge')
  on conflict (event_id,pseudo) do update set role=excluded.role, team=excluded.team
  returning id
)
insert into public.access_codes (participant_id, code_hash)
select id, encode(extensions.digest('ROUGE1-CHANGE-MOI','sha256'),'hex') from p
on conflict (participant_id) do update set code_hash=excluded.code_hash;

