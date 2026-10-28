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
- `supabase/schema.sql` : installation consolidée pour une base neuve (tables, RLS, fonctions, Realtime et tâches planifiées).
- `supabase/migrations/` : historique des mises à jour des bases existantes.
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
3. Exécuter `supabase/seed-event.sql`. Le schéma consolidé contient déjà les fonctions des écrans actuels.
4. Activer les connexions anonymes dans Authentication > Providers > Anonymous.
5. Créer les vrais participants et leurs codes sur le modèle de `seed-participants-example.sql`.
6. Dans `config.js`, renseigner `SUPABASE_URL` et `SUPABASE_ANON_KEY`, puis mettre `DEMO_MODE: false`.

Pour une **nouvelle base**, `schema.sql` contient maintenant les tables, les définitions finales des fonctions, les droits, le Realtime et les quatre tâches planifiées. Exécuter `schema.sql`, puis `seed-event.sql` : aucune série de correctifs historiques n’est nécessaire. Ce fichier d’installation est réservé à une base neuve ; ne pas le réexécuter sur une partie existante.

Pour une **base existante déjà équipée des correctifs de production**, appliquer uniquement `migrations/20261028144510_reconcile_confirmed_ping_schedule.sql`. Cette migration a été appliquée au projet de production le 28 octobre 2026. Elle reste conservée pour tracer et reproduire la mise à jour. Elle exige une partie en attente du START et refuse de déplacer des créneaux avec des positions Cibles ou de réinterpréter d’anciennes positions Chasseurs à +100. Ne pas relancer le seed sur une partie démarrée.

Les anciens correctifs SQL datés à la racine de `supabase/` ont été intégrés au schéma consolidé puis supprimés. Leur historique reste disponible dans Git. Les migrations restent dans `supabase/migrations/` ; elles ne constituent pas à elles seules un installateur de base neuve.

Les notifications exigent aussi le déploiement de `supabase/functions/push-dispatch/index.ts`, sa configuration VAPID et le secret de dispatch. Vérifier les jobs `chasse_push_dispatch`, `evasion_extraction_reveal`, `evasion_finish_events` et `evasion_capture_release` dans `cron.job`.

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

Le libellé « prochain ping », son compte à rebours et l’envoi automatique utilisent le même état serveur (`my_next_ping_status`). Après un oubli, le serveur privilégie le créneau dans la fenêtre actuelle, puis le créneau manqué le plus récent ; Ping 0 n’est plus proposé après cinq minutes.

`start_event_now()` recalcule les créneaux depuis `actual_started_at`. Les heures du seed sont théoriques : un START retardé décale tout le planning et la fin. Les RESET utilisent le même calcul des décalages.

`sent_at` vient de l’horloge du serveur. La fenêtre normale est ±60 secondes. Les pings Cibles ordinaires hors fenêtre sont conservés et signalés à l’organisateur après confirmation ; le calcul actuel utilise un écart arrondi à la seconde. Exception : Ping 0 est un contrôle accepté jusqu’à cinq minutes après le START. Les pings obligatoires Chasseurs utilisent l’écart exact et sont refusés hors fenêtre.

Les pings volontaires Chasseurs restent distincts : disponibles à partir de +10, ils sont visibles uniquement par les Chasseurs. Les pings obligatoires sont visibles par tous. L’envoi obligatoire Chasseur se fait au bouton dans `assets/hunter-required-ping.js` ; les pings volontaires sont gérés par `assets/game-upgrades.js`. Le compte à rebours Chasseur de `runtime-controls.js` annonce l’arrivée des prochains pings **Cibles** ; son bloc obligatoire possède son propre compte à rebours.

Pour vérifier le correctif localement : `npm ci`, puis `npm test`. Les tests de planning installent le schéma consolidé et exécutent les fonctions SQL dans PostgreSQL embarqué (PGlite), sans connexion à la base de production. Ils ne remplacent pas un essai GPS et push sur téléphone.

## Zone d'extraction

Les six zones potentielles sont visibles dès le départ. À START +80 minutes, soit 40 minutes avant la fin, le serveur choisit automatiquement et aléatoirement une zone, l'active pour tous les joueurs et envoie la notification correspondante. Le bouton Organisateur reste disponible comme solution de secours une fois l'échéance atteinte si la révélation automatique n'a pas encore été enregistrée.

## Plan B recommandé

Pour la première édition, conserver le groupe WhatsApp prévu dans les règles : en cas de problème de réseau ou de backend, chaque Cible peut envoyer sa position dans le groupe général.

