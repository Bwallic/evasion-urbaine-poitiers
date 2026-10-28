# Évasion Urbaine — Poitiers

Prototype V1 de l'application web mobile pour l'événement du 28 octobre 2026.

## Fonctionnalités présentes

- Carte commune Leaflet avec fond sombre OpenStreetMap/CARTO.
- Périmètre, prison et 6 zones d'extraction importés depuis le KMZ Google Earth fourni.
- Trois rôles : Cible, Chasseur, Organisateur.
- Cible : envoi automatique du ping GPS lorsque l'application est visible au créneau prévu, avec notification/clic ou bouton manuel en secours.
- Chasseur : affichage centralisé du dernier ping connu de chaque Cible.
- Organisateur : matrice de contrôle des pings, gestion des joueurs et suivi du tirage automatique de la zone d'extraction à START +80 minutes.
- Conservation de l'historique des pings côté Supabase.
- Heure du ping calculée côté serveur dans la version connectée.
- Contrôle automatique de la fenêtre ±60 secondes.
- Realtime Supabase pour actualiser les pings et la zone active sur les autres téléphones.
- Mode démo local pour tester l'interface sans backend.
- Position personnelle en temps réel sur la carte pour Cibles et Chasseurs, uniquement en local sur leur appareil.
- Timer général jusqu’à la fin de partie et fin automatique après les 2 heures.
- États Cible : libre, en cours de capture, en prison, puis libérée.
- Gestion des joueurs directement depuis l'espace Organisateur : ajout, modification, rôle, activation, code et libération d'appareil.
- Révélation automatique de la zone d'extraction à START +80 minutes, avec notification push indiquant le nom de la zone.
- Interface joueur allégée pendant la partie.

## Structure

- `index.html` : interface unique mobile.
- `assets/app.js` : logique Cible / Chasseur / Organisateur.
- `assets/styles.css` : interface sombre.
- `data/areas.geojson` : géométries exactes extraites du KMZ.
- `config.js` : configuration du site.
- `supabase/schema.sql` : tables, RLS et fonctions serveur.
- `supabase/seed-event.sql` : événement, zones et créneaux de ping Cible.
- `supabase/seed-participants-example.sql` : exemple de création de participants et codes.
- `scripts/kmz_to_geojson.py` : conversion/reconstruction des zones depuis un KMZ.

## Tester immédiatement en mode démo

`config.js` est configuré pour la partie connectée (`DEMO_MODE: false`). Pour un essai local, passer temporairement `DEMO_MODE` à `true`, puis le remettre à `false` avant publication.

Servir le dossier par HTTP, par exemple :

```bash
python -m http.server 8000
```

Puis ouvrir `http://localhost:8000`.

La géolocalisation du navigateur fonctionne normalement en HTTPS. `localhost` est également autorisé par les navigateurs modernes pour les tests.

## Passer en mode multijoueur avec Supabase

1. Créer un projet Supabase.
2. Dans l'éditeur SQL Supabase, exécuter `supabase/schema.sql`.
3. Exécuter `supabase/seed-event.sql`, puis les correctifs dans l’ordre indiqué ci-dessous. Le schéma de base et le seed seuls ne suffisent pas aux écrans actuels.
4. Activer les connexions anonymes dans Authentication > Providers > Anonymous.
5. Créer les vrais participants et leurs codes sur le modèle de `seed-participants-example.sql`.
6. Dans `config.js`, renseigner `SUPABASE_URL` et `SUPABASE_ANON_KEY`, puis mettre `DEMO_MODE: false`.

Pour une **nouvelle base**, après `schema.sql` et `seed-event.sql`, exécuter les fichiers suivants dans cet ordre (chemins relatifs à `supabase/`) :

```text
migrations/20260928_fix_claim_participant_digest_search_path.sql
20260929_runtime_controls.sql
20260929_testing_resets_countdown.sql
20260929_fix_claim_conflict_and_ping_ambiguity.sql
20260929_push_notifications_ping0.sql
20260929_push_notifications_security.sql
20260929_access_reset_controls.sql
20260929_auto_reconnect.sql
20260929_total_test_reset.sql
20260929_fix_total_reset_pseudo_conflict.sql
20260929_hunter_countdown_ping_labels.sql
20261004_post_beta_upgrades.sql
20261004_share_target_states.sql
20261004_hunter_voluntary_pings.sql
20261004_notify_prisoner.sql
20261027_hunter_team_colors_and_required_pings.sql
20261004_restrict_player_rpcs.sql
20261004_stability_indexes.sql
20261007_auto_reveal_extraction_at_start_plus_80.sql
20261027_final_cleanup.sql
migrations/20261028142527_reconcile_confirmed_ping_schedule.sql
```

Les anciens correctifs d’intervalles à 20/30 minutes et de planning irrégulier ne font pas partie de ce parcours. `20261027_remove_mandatory_pings_final_10.sql` est désormais un fichier obsolète sans effet : les obligations à +110 sont bien conservées.

Pour une **base existante déjà équipée des correctifs de production**, appliquer uniquement `migrations/20261028142527_reconcile_confirmed_ping_schedule.sql` en dernier. Modifier un ancien fichier SQL dans GitHub ne met pas à jour les fonctions déjà installées en base. Le correctif exige une partie en attente du START ; il restaure les onze créneaux et les fonctions START/RESET, ainsi que les trois obligations Chasseurs. Il refuse de déplacer des créneaux avec des positions Cibles enregistrées ou de réinterpréter d’anciennes positions Chasseurs à +100. Dans ce cas, examiner les données et, uniquement s’il s’agit de tests à effacer, utiliser RESET PARTIE avant de réappliquer le correctif. Ne pas réexécuter le seed sur une partie démarrée.

Les notifications exigent aussi le déploiement de `supabase/functions/push-dispatch/index.ts`, sa configuration VAPID et le secret de dispatch. Le contrôle ci-dessus ne déploie pas la fonction Edge. Vérifier les jobs `chasse_push_dispatch` et `evasion_extraction_reveal` dans `cron.job`.

L'anon key Supabase peut être présente dans une application web publique : la protection repose sur les règles RLS. Ne jamais mettre la `service_role` key dans ce dépôt.

## GitHub Pages

Le front-end est statique et peut être publicé directement avec GitHub Pages.

1. Créer un dépôt, par lexemple `evasion-urbaine-poitiers`.
2. Ajouter le contenu de ce dossier à la branche `main`.
3. Dans les paramètres du dépôt, activer Pages à partir de la branche `main` / racine du dépôt.
4. Utiliser l'URL HTTPS fournie par GitHub Pages.

L'https est important : la géolocalisation navigateur exige un contexte sécurisé hors `localhost`.

## Codes d'accès

Chaque participant dispose d'un code personnel. Au premier usage, le code est associé à l'identité anonyme Supabase du navigateur. Un code ne peut ensuite pas être utilisé sur un autre appareil sans réinitialisation de son `user_id` par l'organisateur dans la base.

Les vrais codes doivent rester dans Supabase. Ne pas committer un fichier contenant les codes réels dans un dépôt public.

## Logique des pings

La base utilise **11 créneaux Cibles** : Ping 0 au START, puis +20, +30, +40, +50, +60, +80, +95, +100, +105 et +110 minutes. Les Chasseurs ont **trois pings obligatoires à +60, +95 et +110 minutes**. Les dix dernières minutes conservent donc le ping à +110.

| Rôle / action | Décalages depuis le START réel | Horaires si START à 20:00 (Europe/Paris) |
|---|---|---|
| Cibles | 0, 20, 30, 40, 50, 60, 80, 95, 100, 105, 110 min | 20:00, 20:20, 20:30, 20:40, 20:50, 21:00, 21:20, 21:35, 21:40, 21:45, 21:50 |
| Chasseurs obligatoires | 60, 95, 110 min | 21:00, 21:35, 21:50 |
| Révélation extraction | 80 min | 21:20 |
| Fin | 120 min | 22:00 |

`start_event_now()` recalcule les créneaux depuis `actual_started_at`. Les heures du seed sont théoriques : un START retardé décale tout le planning et la fin. Les RESET utilisent le même calcul des décalages.

`sent_at` vient de l’horloge du serveur. La fenêtre normale est ±60 secondes. Les pings Cibles ordinaires hors fenêtre sont conservés et signalés à l’organisateur après confirmation ; le calcul actuel utilise un écart arrondi à la seconde. Exception : Ping 0 est un contrôle accepté jusqu’à cinq minutes après le START. Les pings obligatoires Chasseurs utilisent l’écart exact et sont refusés hors fenêtre.

Les pings volontaires Chasseurs restent distincts : disponibles à partir de +10, ils sont visibles uniquement par les Chasseurs. Les pings obligatoires sont visibles par tous. L’envoi obligatoire Chasseur se fait au bouton dans `assets/hunter-required-ping.js` ; les pings volontaires sont gérés par `assets/game-upgrades.js`. Le compte à rebours Chasseur de `runtime-controls.js` annonce l’arrivée des prochains pings **Cibles** ; son bloc obligatoire possède son propre compte à rebours.

Pour vérifier le correctif localement : `npm ci`, puis `npm test`. Les tests de planning exécutent les fonctions SQL dans PostgreSQL embarqué (PGlite), sans connexion à la base de production. Ils ne remplacent pas un essai GPS et push sur téléphone.

## Zone d'extraction

Les six zones potentielles sont visibles dès le départ. À START +80 minutes, soit 40 minutes avant la fin, le serveur choisit automatiquement et aléatoirement une zone, l'active pour tous les joueurs et envoie la notification correspondante. Le bouton Organisateur reste disponible comme solution de secours une fois l'échéance atteinte si la révélation automatique n'a pas encore été enregistrée.

## Plan B recommandé

Pour la première édition, conserver le groupe WhatsApp prévu dans les règles : en cas de problème de réseau ou de backend, chaque Cible peut envoyer sa position dans le groupe général.

