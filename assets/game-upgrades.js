(() => {
  const cfg = window.CHASSE_CONFIG;
  if (!cfg) return;

  let participant = null;
  let eventState = null;
  let selfMarker = null;
  let selfAccuracy = null;
  let watchId = null;
  let stateRefreshBusy = false;
  let managerRefreshBusy = false;
  let managerActiveRole = "target";
  let managerRows = [];
  let initialSetupDone = false;
  let targetStateSnapshot = null;
  let targetCountdownTriggered = false;
  const hunterPingLayers = new Map();

  const TEAM_COLORS = {
    Alpha: "#3b82f6",
    Beta: "#f59e0b",
    Omega: "#a855f7"
  };

  const style = document.createElement("style");
  style.textContent = `
    .global-game-timer,
    .target-state-block,
    .organizer-player-manager {
      margin: 10px 0 14px;
      padding: 12px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      background: rgba(255,255,255,.035);
    }
    .global-game-timer-main { font-size: 1.35rem; font-weight: 850; margin-top: 3px; }
    .game-finished-banner {
      margin: 10px 0 14px; padding: 14px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.07); text-align: center; font-weight: 850;
    }
    .target-state-actions, .player-manager-actions, .player-editor-actions {
      display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;
    }
    .target-state-actions button.active-state { outline: 2px solid rgba(255,255,255,.55); outline-offset: 1px; }
    .target-state-visibility {
      margin: 10px 0 14px;
      padding: 12px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      background: rgba(255,255,255,.035);
    }
    .target-state-visibility-list { display: grid; gap: 7px; margin-top: 8px; }
    .target-state-visibility-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      padding: 7px 9px;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 8px;
    }

    .self-position-dot {
      width: 18px; height: 18px; border-radius: 50%; background: #58a6ff;
      border: 3px solid #fff; box-shadow: 0 0 0 5px rgba(88,166,255,.22);
    }
    .hunter-ping-dot {
      width: 20px; height: 20px; border-radius: 50%;
      background: var(--hunter-team-color, #ff3b3b); border: 3px solid #fff;
      box-shadow: 0 0 0 5px rgba(255,255,255,.14), 0 0 16px var(--hunter-team-color, #ff3b3b);
    }
    .hunter-ping-control {
      margin: 10px 0 14px;
      padding: 12px;
      border: 1px solid rgba(255,59,59,.35);
      border-radius: 10px;
      background: rgba(255,59,59,.06);
    }
    .hunter-ping-control .hunter-ping-button {
      width: 100%;
      margin-top: 8px;
      border-color: rgba(255,255,255,.3);
    }
    .hunter-team-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
      font-size: .78rem;
    }
    .hunter-team-key {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .hunter-team-key::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--hunter-team-color);
      box-shadow: 0 0 8px var(--hunter-team-color);
    }
    .organizer-player-manager .manager-form,
    .organizer-player-manager .player-editor { display: grid; gap: 8px; }
    .organizer-player-manager .manager-form {
      grid-template-columns: minmax(0,1fr) minmax(120px,.7fr) minmax(0,1fr) auto;
      align-items: end; margin-top: 10px;
    }
    .organizer-player-manager .manager-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0,1fr));
      gap: 7px;
      margin-top: 14px;
      padding: 4px;
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 10px;
      background: rgba(0,0,0,.16);
    }
    .organizer-player-manager .manager-tab {
      min-width: 0;
      padding: 9px 8px;
      border-radius: 8px;
      font-size: .78rem;
      font-weight: 800;
      letter-spacing: .04em;
      white-space: nowrap;
    }
    .organizer-player-manager .manager-tab.active {
      background: rgba(255,255,255,.12);
      border-color: rgba(255,255,255,.24);
    }
    .organizer-player-manager .manager-tab-count {
      display: inline-flex;
      min-width: 20px;
      height: 20px;
      padding: 0 5px;
      margin-left: 5px;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: rgba(255,255,255,.08);
      font-size: .72rem;
    }
    .organizer-player-manager .manager-role-heading {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
    }
    .organizer-player-manager .player-manager-list { display: grid; gap: 10px; margin-top: 8px; }
    .organizer-player-manager .player-editor {
      padding: 10px; border: 1px solid rgba(255,255,255,.09); border-radius: 9px;
      background: rgba(255,255,255,.025);
      grid-template-columns: minmax(0,1.2fr) minmax(110px,.7fr) auto; align-items: end;
    }
    .organizer-player-manager label { display: grid; gap: 4px; font-size: .82rem; }
    .organizer-player-manager input, .organizer-player-manager select { width: 100%; box-sizing: border-box; }
    .player-editor-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .player-code-row { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: end; }
    body.player-live-mode footer { display: none; }
    body.player-live-mode #targetPanel > h3,
    body.player-live-mode #targetPingList { display: none; }
    body.player-live-mode .role-panel { padding-top: 12px; }
    body.player-live-mode #map { min-height: 46vh; }
    @media (max-width: 720px) {
      .organizer-player-manager .manager-form, .organizer-player-manager .player-editor { grid-template-columns: 1fr; }
      .player-code-row, .player-editor-meta { grid-column: 1; }
      .organizer-player-manager .manager-tab { font-size: .72rem; padding: 9px 5px; }
    }
  `;
  document.head.appendChild(style);

  function teamColor(team) {
    return TEAM_COLORS[team] || "#ff3b3b";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"
    }[c]));
  }

  function client() { return window.CHASSE_LIVE_CLIENT || null; }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  function rolePrefix(role) { return role === "target" ? "I" : role === "hunter" ? "H" : "O"; }

  function suggestCode(pseudo, role) {
    const letters = String(pseudo || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,3);
    const core = (letters || Math.random().toString(36).slice(2,5).toUpperCase()).padEnd(3,"X");
    return `${rolePrefix(role)}-${core}`;
  }


  function injectHunterDepartureTimer() {
    const panel = document.getElementById("hunterPanel");
    if (!panel || document.getElementById("hunterDepartureTimer")) return;
    const box = document.createElement("div");
    box.id = "hunterDepartureTimer";
    box.className = "global-game-timer";
    box.innerHTML =
      '<span class="eyebrow">DÉPART DES CHASSEURS</span>' +
      '<div id="hunterDepartureTimerMain" class="global-game-timer-main">En attente du START</div>' +
      '<small id="hunterDepartureTimerSub" class="muted">Départ autorisé 10 minutes après le START.</small>';
    const anchor = panel.querySelector(".ping-countdown") || panel.firstElementChild;
    if (anchor) panel.insertBefore(box, anchor);
    else panel.appendChild(box);
  }

  function renderHunterDepartureTimer() {
    if (!participant || participant.role !== "hunter") return;
    const main = document.getElementById("hunterDepartureTimerMain");
    const sub = document.getElementById("hunterDepartureTimerSub");
    if (!main || !sub) return;

    const pingBtn = document.getElementById("sendHunterPingBtn");

    if (!eventState || !eventState.actual_started_at || eventState.status === "scheduled") {
      main.textContent = "EN ATTENTE DU START";
      sub.textContent = "Départ autorisé 10 minutes après le START.";
      if (pingBtn) pingBtn.disabled = true;
      return;
    }

    const departureAt = new Date(eventState.actual_started_at).getTime() + 10 * 60 * 1000;
    const diff = departureAt - Date.now();

    if (eventState.status === "finished") {
      main.textContent = "PARTIE TERMINÉE";
      sub.textContent = "Les pings Chasseur sont désactivés.";
      if (pingBtn) pingBtn.disabled = true;
    } else if (diff > 0) {
      main.textContent = formatDuration(diff);
      sub.textContent = "Temps restant avant le départ des Chasseurs.";
      if (pingBtn) pingBtn.disabled = true;
    } else {
      main.textContent = "DÉPART AUTORISÉ";
      sub.textContent = "La chasse est ouverte.";
      if (pingBtn) pingBtn.disabled = false;
    }
  }

  function injectTimer(panelId, prefix) {
    const panel = document.getElementById(panelId);
    if (!panel || document.getElementById(`${prefix}GlobalGameTimer`)) return;
    const box = document.createElement("div");
    box.id = `${prefix}GlobalGameTimer`;
    box.className = "global-game-timer";
    box.innerHTML = `
      <span class="eyebrow">FIN DE PARTIE</span>
      <div id="${prefix}GlobalGameTimerMain" class="global-game-timer-main">En attente du START</div>
      <small id="${prefix}GlobalGameTimerSub" class="muted">Durée totale : 2 heures.</small>
    `;
    const anchor = panel.querySelector(".ping-countdown") || panel.firstElementChild;
    if (anchor) panel.insertBefore(box, anchor); else panel.appendChild(box);
  }

  function renderGlobalTimer() {
    if (!participant || !["target","hunter"].includes(participant.role)) return;
    const prefix = participant.role;
    const main = document.getElementById(`${prefix}GlobalGameTimerMain`);
    const sub = document.getElementById(`${prefix}GlobalGameTimerSub`);
    if (!main || !sub) return;

    if (!eventState || eventState.status === "scheduled" || !eventState.actual_ends_at) {
      main.textContent = "EN ATTENTE DU START";
      sub.textContent = "Le chrono général démarrera avec la partie.";
      document.body.classList.remove("player-live-mode");
      return;
    }

    if (eventState.status === "finished") {
      main.textContent = "00:00:00";
      sub.textContent = "PARTIE TERMINÉE";
      document.body.classList.remove("player-live-mode");
      showFinishedBanner();
      const send = document.getElementById("sendPingBtn");
      if (send) send.disabled = true;
      return;
    }

    document.body.classList.add("player-live-mode");
    const remaining = new Date(eventState.actual_ends_at).getTime() - Date.now();
    if (remaining <= 0) {
      main.textContent = "00:00:00";
      sub.textContent = "Fin de partie · après le ping obligatoire +110, aucun autre ping jusqu’à la fin.";
      showFinishedBanner();
    } else {
      main.textContent = formatDuration(remaining);
      sub.textContent = "Temps restant avant la fin du jeu.";
    }
  }

  function showFinishedBanner() {
    const panel = participant?.role === "target" ? document.getElementById("targetPanel")
      : participant?.role === "hunter" ? document.getElementById("hunterPanel") : null;
    if (!panel || document.getElementById("gameFinishedBanner")) return;
    const banner = document.createElement("div");
    banner.id = "gameFinishedBanner";
    banner.className = "game-finished-banner";
    banner.textContent = "PARTIE TERMINÉE";
    panel.prepend(banner);
  }

  async function refreshEventState() {
    const game = document.getElementById("gameView");
    if (stateRefreshBusy || !participant || !client() || document.hidden || !game || game.classList.contains("hidden")) return;
    stateRefreshBusy = true;
    try {
      const cached = window.CHASSE_EVENT_STATE;
      if (cached?.status) {
        eventState = cached;
        renderGlobalTimer();
        renderHunterDepartureTimer();
      }

      const { data, error } = await client()
        .from("events")
        .select("status,actual_started_at,actual_ends_at")
        .eq("id", cfg.EVENT_ID)
        .single();

      if (!error && data) {
        eventState = data;
        window.CHASSE_EVENT_STATE = { ...(window.CHASSE_EVENT_STATE || {}), ...data };
        renderGlobalTimer();
        renderHunterDepartureTimer();
        return;
      }

      const fallback = await client().rpc("sync_my_event_state");
      if (!fallback.error && fallback.data) {
        eventState = Array.isArray(fallback.data) ? fallback.data[0] : fallback.data;
        renderGlobalTimer();
        renderHunterDepartureTimer();
      }
    } finally { stateRefreshBusy = false; }
  }

  function startOwnPosition() {
    if (!participant || !["target","hunter"].includes(participant.role)) return;
    if (!navigator.geolocation || watchId !== null) return;

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const map = window.CHASSE_MAP;
        if (!map || !window.L) return;
        const latlng = [pos.coords.latitude, pos.coords.longitude];

        if (!selfMarker) {
          const icon = L.divIcon({
            className: "", html: '<div class="self-position-dot"></div>',
            iconSize:[18,18], iconAnchor:[9,9]
          });
          selfMarker = L.marker(latlng,{icon,zIndexOffset:1500})
            .bindTooltip(participant.role === "hunter" ? "Votre position GPS" : "Vous êtes ici",{direction:"top",className:"map-label"}).addTo(map);
          selfAccuracy = L.circle(latlng,{
            radius:Math.max(5,pos.coords.accuracy||5),weight:1,fillOpacity:.05
          }).addTo(map);
        } else {
          selfMarker.setLatLng(latlng);
          selfAccuracy?.setLatLng(latlng);
          selfAccuracy?.setRadius(Math.max(5,pos.coords.accuracy||5));
        }
      },
      () => {},
      {enableHighAccuracy:true,maximumAge:5000,timeout:15000}
    );
  }


  function injectHunterPingControl() {
    const panel = document.getElementById("hunterPanel");
    if (!panel || document.getElementById("hunterPingControl")) return;

    const team = participant?.team || "";
    const color = teamColor(team);
    const box = document.createElement("div");
    box.id = "hunterPingControl";
    box.className = "hunter-ping-control";
    box.style.borderColor = color;
    box.innerHTML =
      '<span class="eyebrow">PING CHASSEUR</span>' +
      '<div class="big-status">Partager ma position aux Chasseurs</div>' +
      '<button id="sendHunterPingBtn" class="ghost hunter-ping-button">ENVOYER UN PING D\'ÉQUIPE</button>' +
      '<small id="hunterPingMessage" class="muted">À volonté après le départ. Visible uniquement par les Chasseurs.</small>' +
      '<div class="hunter-team-legend">' +
        '<span class="hunter-team-key" style="--hunter-team-color:#3b82f6">Alpha</span>' +
        '<span class="hunter-team-key" style="--hunter-team-color:#f59e0b">Beta</span>' +
        '<span class="hunter-team-key" style="--hunter-team-color:#a855f7">Omega</span>' +
      '</div>';

    const anchor = panel.querySelector(".divider") || panel.firstElementChild;
    if (anchor) panel.insertBefore(box, anchor);
    else panel.appendChild(box);

    document.getElementById("sendHunterPingBtn")?.addEventListener("click", sendHunterPing);
  }

  async function sendHunterPing() {
    const btn = document.getElementById("sendHunterPingBtn");
    const message = document.getElementById("hunterPingMessage");
    if (!btn || !message || !client()) return;

    btn.disabled = true;
    message.textContent = "Localisation GPS en cours…";

    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0
        });
      });

      const { latitude, longitude, accuracy } = pos.coords;
      const { data, error } = await client().rpc("submit_hunter_ping", {
        p_lat: latitude,
        p_lng: longitude,
        p_accuracy_m: accuracy
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      const time = row?.sent_at ? new Date(row.sent_at) : new Date();
      const team = participant?.team ? " · équipe " + participant.team : "";
      message.textContent = "Ping d'équipe envoyé à " + time.toLocaleTimeString("fr-FR", {hour:"2-digit",minute:"2-digit",second:"2-digit"}) + team + ".";
      await refreshHunterPings();
    } catch (e) {
      message.textContent = e.message || "Impossible d'envoyer le ping.";
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshHunterPings() {
    if (!participant || participant.role !== "hunter" || !client()) return;
    const map = window.CHASSE_MAP;
    if (!map || !window.L) return;

    const [pingsRes, teamsRes] = await Promise.all([
      client().rpc("visible_hunter_pings"),
      client().from("participants")
        .select("id,team")
        .eq("event_id", cfg.EVENT_ID)
        .eq("role", "hunter")
        .eq("active", true)
    ]);
    if (pingsRes.error) return;

    const teamById = new Map((teamsRes.data || []).map((row) => [row.id, row.team || ""]));
    const rows = pingsRes.data || [];
    const seen = new Set();

    rows.forEach((row) => {
      seen.add(row.participant_id);
      const latlng = [row.lat, row.lng];
      const team = teamById.get(row.participant_id) || "";
      const color = teamColor(team);
      const icon = L.divIcon({
        className: "",
        html: '<div class="hunter-ping-dot" style="--hunter-team-color:' + color + '"></div>',
        iconSize: [20,20],
        iconAnchor: [10,10]
      });
      let layer = hunterPingLayers.get(row.participant_id);

      if (!layer) {
        layer = L.marker(latlng,{icon,zIndexOffset:1400}).addTo(map);
        hunterPingLayers.set(row.participant_id, layer);
      } else {
        layer.setLatLng(latlng);
        layer.setIcon(icon);
      }

      const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(row.sent_at).getTime()) / 1000));
      const age = ageSeconds < 60 ? ageSeconds + " s" : Math.floor(ageSeconds / 60) + " min";
      layer.bindTooltip(
        row.pseudo + " · " + (team || "Chasseur") + " · ping · " + age,
        { direction:"top", className:"map-label" }
      );
    });

    hunterPingLayers.forEach((layer, participantId) => {
      if (!seen.has(participantId)) {
        layer.remove();
        hunterPingLayers.delete(participantId);
      }
    });
  }

  function injectTargetState() {
    const panel = document.getElementById("targetPanel");
    if (!panel || document.getElementById("targetStateBlock")) return;
    const block = document.createElement("div");
    block.id = "targetStateBlock";
    block.className = "target-state-block";
    block.innerHTML = `
      <span class="eyebrow">MON ÉTAT</span>
      <div id="targetStateLabel" class="big-status">Libre</div>
      <div class="target-state-actions">
        <button class="ghost small" data-target-state="capturing">EN COURS DE CAPTURE</button>
        <button class="ghost small" data-target-state="prisoner">EN PRISON</button>
        <button class="ghost small" data-target-state="free">LIBÉRÉE / LIBRE</button>
      </div>
      <div id="targetCaptureCountdown" class="runtime-status hidden">
        <span class="eyebrow">TEMPS AVANT LIBÉRATION</span>
        <div id="targetCaptureCountdownMain" class="big-status">15:00</div>
        <small class="muted">Chrono privé : visible uniquement par la Cible.</small>
      </div>
      <small class="muted">Les Chasseurs voient votre état. Les pings continuent normalement.</small>
    `;
    const divider = panel.querySelector(".divider");
    if (divider) panel.insertBefore(block,divider); else panel.appendChild(block);

    block.querySelectorAll("[data-target-state]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (targetStateSnapshot?.play_state === button.dataset.targetState) return;
        button.disabled = true;
        try {
          const { error } = await client().rpc("set_my_target_state",{p_state:button.dataset.targetState});
          if (error) throw error;
          await refreshTargetState();
        } catch (e) {
          alert(e.message || "Impossible de modifier l'état.");
        } finally { button.disabled = false; }
      });
    });
  }


  function injectVisibleTargetStates(panelId, role) {
    const panel = document.getElementById(panelId);
    if (!panel || document.getElementById(role + "VisibleTargetStates")) return;
    const box = document.createElement("div");
    box.id = role + "VisibleTargetStates";
    box.className = "target-state-visibility";
    box.innerHTML =
      '<span class="eyebrow">' + (role === "hunter" ? "ÉTAT DES CIBLES" : "CIBLES EN PRISON") + '</span>' +
      '<div id="' + role + 'VisibleTargetStatesList" class="target-state-visibility-list"><span class="muted">Chargement…</span></div>';
    const anchor = panel.querySelector(".divider") || panel.firstElementChild;
    if (anchor) panel.insertBefore(box, anchor);
    else panel.appendChild(box);
  }

  async function refreshVisibleTargetStates() {
    if (!participant || !["target","hunter"].includes(participant.role) || !client()) return;
    const role = participant.role;
    const list = document.getElementById(role + "VisibleTargetStatesList");
    if (!list) return;

    const { data, error } = await client().rpc("visible_target_states");
    if (error) {
      list.innerHTML = '<span class="muted">' + escapeHtml(error.message || "États indisponibles.") + '</span>';
      return;
    }

    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = role === "hunter"
        ? '<span class="muted">Aucune Cible active.</span>'
        : '<span class="muted">Aucune Cible en prison.</span>';
      return;
    }

    const labels = { free:"Libre", capturing:"En cours de capture", prisoner:"En prison" };
    list.innerHTML = rows.map((row) =>
      '<div class="target-state-visibility-row"><strong>' + escapeHtml(row.pseudo) + '</strong>' +
      '<span class="badge ' + (row.play_state === "prisoner" ? "badge-amber" : row.play_state === "free" ? "badge-green" : "badge-muted") + '">' +
      escapeHtml(labels[row.play_state] || row.play_state) + '</span></div>'
    ).join("");
  }

  async function refreshTargetState() {
    if (!participant || participant.role !== "target" || !client()) return;
    const { data, error } = await client().rpc("my_target_state");
    if (error) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return;
    targetStateSnapshot = row;
    if (row.play_state !== "capturing") targetCountdownTriggered = false;
    const labels = {free:"Libre",capturing:"En cours de capture",prisoner:"En prison"};
    const label = document.getElementById("targetStateLabel");
    if (label) label.textContent = labels[row.play_state] || row.play_state;
    document.querySelectorAll("[data-target-state]").forEach((button) => {
      button.classList.toggle("active-state",button.dataset.targetState === row.play_state);
    });
  }

  function renderTargetCaptureCountdown() {
    const box = document.getElementById("targetCaptureCountdown");
    const main = document.getElementById("targetCaptureCountdownMain");
    if (!box || !main) return;

    if (!targetStateSnapshot || targetStateSnapshot.play_state !== "capturing" || !targetStateSnapshot.updated_at) {
      box.classList.add("hidden");
      return;
    }

    box.classList.remove("hidden");
    const endAt = new Date(targetStateSnapshot.updated_at).getTime() + 15 * 60 * 1000;
    const remaining = endAt - Date.now();

    if (remaining > 0) {
      const total = Math.ceil(remaining / 1000);
      const min = Math.floor(total / 60);
      const sec = total % 60;
      main.textContent = String(min).padStart(2,"0") + ":" + String(sec).padStart(2,"0");
      return;
    }

    main.textContent = "00:00";
    if (!targetCountdownTriggered) {
      targetCountdownTriggered = true;
      document.querySelector('[data-target-state="free"]')?.click();
      setTimeout(() => {
        if (targetStateSnapshot?.play_state === "capturing") targetCountdownTriggered = false;
      }, 5000);
    }
  }

  function managerRoleLabel(role) {
    return role === "target" ? "Cibles" : role === "hunter" ? "Chasseurs" : "Organisateurs";
  }

  function updateManagerTabs() {
    document.querySelectorAll("[data-manager-tab]").forEach((button) => {
      const role = button.dataset.managerTab;
      button.classList.toggle("active", role === managerActiveRole);
      const count = managerRows.filter((row) => row.role === role).length;
      const counter = button.querySelector(".manager-tab-count");
      if (counter) counter.textContent = count;
    });

    const roleSelect = document.getElementById("managerNewRole");
    if (roleSelect && roleSelect.value !== managerActiveRole) roleSelect.value = managerActiveRole;

    const heading = document.getElementById("managerRoleHeadingText");
    if (heading) heading.textContent = managerRoleLabel(managerActiveRole);
  }

  function bindPlayerEditor(editor) {
    const id = editor.dataset.playerId;
    const pseudoInput = editor.querySelector('[data-field="pseudo"]');
    const roleInput = editor.querySelector('[data-field="role"]');
    const activeInput = editor.querySelector('[data-field="active"]');
    const codeInput = editor.querySelector('[data-field="code"]');

    editor.querySelector('[data-action="generate"]')?.addEventListener("click",() => {
      codeInput.value = suggestCode(pseudoInput.value,roleInput.value);
    });

    editor.querySelector('[data-action="save"]')?.addEventListener("click",async (event) => {
      const btn = event.currentTarget; btn.disabled = true;
      try {
        const { error } = await client().rpc("organizer_update_player",{
          p_participant_id:id,p_pseudo:pseudoInput.value.trim(),p_role:roleInput.value,
          p_team:null,p_active:activeInput.checked,p_new_code:codeInput.value.trim()||null
        });
        if (error) throw error;
        document.getElementById("playerManagerMessage").textContent = codeInput.value.trim()
          ? `${pseudoInput.value.trim()} mis à jour. Nouveau code : ${codeInput.value.trim().toUpperCase()}.`
          : `${pseudoInput.value.trim()} mis à jour.`;
        managerActiveRole = roleInput.value;
        await refreshPlayerManager();
      } catch (e) {
        document.getElementById("playerManagerMessage").textContent = e.message || "Modification impossible.";
      } finally { btn.disabled = false; }
    });

    editor.querySelector('[data-action="release"]')?.addEventListener("click",async (event) => {
      if (!confirm("Libérer l'appareil associé à ce joueur ? Son code pourra être réutilisé sur un autre appareil.")) return;
      const btn = event.currentTarget; btn.disabled = true;
      try {
        const { error } = await client().rpc("organizer_release_player",{p_participant_id:id});
        if (error) throw error;
        document.getElementById("playerManagerMessage").textContent = "Appareil libéré.";
        await refreshPlayerManager();
      } catch (e) {
        document.getElementById("playerManagerMessage").textContent = e.message || "Impossible de libérer l'appareil.";
      } finally { btn.disabled = false; }
    });
  }

  function renderPlayerManagerList() {
    const list = document.getElementById("playerManagerList");
    if (!list) return;

    updateManagerTabs();
    const rows = managerRows.filter((row) => row.role === managerActiveRole);

    if (!rows.length) {
      list.innerHTML = `<div class="muted compact">Aucun ${managerActiveRole === "target" ? "Cible" : managerActiveRole === "hunter" ? "Chasseur" : "Organisateur"} enregistré.</div>`;
      return;
    }

    list.innerHTML = rows.map((row) => {
      const stateLabel = row.role === "target" ? ({free:"Libre",capturing:"Capture",prisoner:"Prison"}[row.play_state] || row.play_state) : "—";
      return `
        <div class="player-editor" data-player-id="${row.id}">
          <label>Pseudo<input data-field="pseudo" maxlength="24" value="${escapeHtml(row.pseudo)}" /></label>
          <label>Rôle<select data-field="role" ${row.is_self ? "disabled" : ""}>
            <option value="target" ${row.role==="target"?"selected":""}>Cible</option>
            <option value="hunter" ${row.role==="hunter"?"selected":""}>Chasseur</option>
            <option value="organizer" ${row.role==="organizer"?"selected":""}>Organisateur</option>
          </select></label>
          <label>Actif<input data-field="active" type="checkbox" ${row.active?"checked":""} ${row.is_self?"disabled":""} /></label>
          <div class="player-code-row">
            <label>Remplacer le code<input data-field="code" maxlength="24" placeholder="Code enregistré · laisser vide pour conserver" /></label>
            <button class="ghost small" data-action="generate">GÉNÉRER</button>
          </div>
          <div class="player-editor-meta">
            <span class="badge ${row.active?"badge-green":"badge-muted"}">${row.active?"ACTIF":"INACTIF"}</span>
            <span class="badge ${row.device_linked?"badge-green":"badge-muted"}">${row.device_linked?"APPAREIL LIÉ":"APPAREIL LIBRE"}</span>
            <span class="badge badge-muted">CODE ENREGISTRÉ</span>
            ${row.role==="target" ? `<span class="badge badge-muted">État : ${escapeHtml(stateLabel)}</span>` : ""}
            ${row.is_self ? '<span class="badge badge-muted">TON ACCÈS</span>' : ""}
          </div>
          <div class="player-editor-actions">
            <button class="primary small" data-action="save">ENREGISTRER</button>
            <button class="ghost small" data-action="release" ${row.is_self||!row.device_linked?"disabled":""}>LIBÉRER APPAREIL</button>
          </div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".player-editor").forEach(bindPlayerEditor);
  }

  function injectOrganizerManager() {
    const panel = document.getElementById("organizerPanel");
    if (!panel || document.getElementById("organizerPlayerManager")) return;

    const block = document.createElement("div");
    block.id = "organizerPlayerManager";
    block.className = "organizer-player-manager";
    block.innerHTML = `
      <div class="divider"></div>
      <span class="eyebrow">GESTION DES JOUEURS</span>
      <div class="big-status">Joueurs et codes</div>
      <p class="muted compact">Les joueurs sont regroupés par rôle. Sélectionne un onglet pour gérer uniquement le groupe concerné.</p>

      <div class="manager-tabs" role="tablist" aria-label="Rôles des joueurs">
        <button class="ghost manager-tab active" data-manager-tab="target" role="tab">CIBLES <span class="manager-tab-count">0</span></button>
        <button class="ghost manager-tab" data-manager-tab="hunter" role="tab">CHASSEURS <span class="manager-tab-count">0</span></button>
        <button class="ghost manager-tab" data-manager-tab="organizer" role="tab">ORGA <span class="manager-tab-count">0</span></button>
      </div>

      <div class="manager-form">
        <label>Pseudo<input id="managerNewPseudo" maxlength="24" placeholder="Nouveau joueur" /></label>
        <label>Rôle<select id="managerNewRole">
          <option value="target">Cible</option><option value="hunter">Chasseur</option><option value="organizer">Organisateur</option>
        </select></label>
        <label>Code<input id="managerNewCode" maxlength="24" placeholder="I-XXX" /></label>
        <button id="managerAddPlayer" class="primary small">AJOUTER</button>
      </div>
      <div class="player-manager-actions">
        <button id="managerGenerateNewCode" class="ghost small">GÉNÉRER LE CODE</button>
        <button id="managerRefreshPlayers" class="ghost small">ACTUALISER</button>
      </div>
      <div id="playerManagerMessage" class="muted compact"></div>
      <div class="manager-role-heading">
        <strong id="managerRoleHeadingText">Cibles</strong>
        <small class="muted">Modification des accès existants</small>
      </div>
      <div id="playerManagerList" class="player-manager-list"></div>
    `;
    panel.appendChild(block);

    const pseudo = document.getElementById("managerNewPseudo");
    const role = document.getElementById("managerNewRole");
    const code = document.getElementById("managerNewCode");

    block.querySelectorAll("[data-manager-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        managerActiveRole = button.dataset.managerTab;
        role.value = managerActiveRole;
        if (!code.value.trim() || /^[IHO]-/.test(code.value.trim().toUpperCase())) {
          code.value = pseudo.value.trim() ? suggestCode(pseudo.value, managerActiveRole) : "";
        }
        renderPlayerManagerList();
      });
    });

    document.getElementById("managerGenerateNewCode")?.addEventListener("click",() => {
      code.value = suggestCode(pseudo.value,role.value);
    });
    pseudo?.addEventListener("blur",() => {
      if (!code.value.trim()) code.value = suggestCode(pseudo.value,role.value);
    });
    role?.addEventListener("change",() => {
      managerActiveRole = role.value;
      if (!code.value.trim() || /^[IHO]-/.test(code.value.trim().toUpperCase())) {
        code.value = suggestCode(pseudo.value,role.value);
      }
      renderPlayerManagerList();
    });

    document.getElementById("managerAddPlayer")?.addEventListener("click",async () => {
      const message = document.getElementById("playerManagerMessage");
      try {
        if (!pseudo.value.trim()) throw new Error("Saisis un pseudo.");
        if (!code.value.trim()) code.value = suggestCode(pseudo.value,role.value);
        const { error } = await client().rpc("organizer_create_player",{
          p_pseudo:pseudo.value.trim(),p_role:role.value,p_team:null,p_code:code.value.trim()
        });
        if (error) throw error;
        message.textContent = `${pseudo.value.trim()} ajouté avec le code ${code.value.trim().toUpperCase()}.`;
        managerActiveRole = role.value;
        pseudo.value = ""; code.value = "";
        await refreshPlayerManager();
      } catch (e) {
        message.textContent = e.message || "Impossible d'ajouter le joueur.";
      }
    });

    document.getElementById("managerRefreshPlayers")?.addEventListener("click",refreshPlayerManager);
    updateManagerTabs();
  }

  function hasPlayerManagerDrafts(list) {
    return [...list.querySelectorAll(".player-editor")].some((editor) => {
      const row = managerRows.find((item) => item.id === editor.dataset.playerId);
      if (!row) return false;
      return editor.querySelector('[data-field="pseudo"]').value !== row.pseudo
        || editor.querySelector('[data-field="role"]').value !== row.role
        || editor.querySelector('[data-field="active"]').checked !== row.active
        || editor.querySelector('[data-field="code"]').value.trim() !== "";
    });
  }

  async function refreshPlayerManager(automatic = false) {
    if (managerRefreshBusy || !participant || participant.role !== "organizer" || !client()) return;
    const game = document.getElementById("gameView");
    if (automatic === true && (document.hidden || !game || game.classList.contains("hidden"))) return;
    const list = document.getElementById("playerManagerList");
    if (!list) return;
    const participantId = participant.id;
    managerRefreshBusy = true;
    try {
      const { data, error } = await client().rpc("organizer_manage_list");
      if (error) throw error;
      if (participant?.id !== participantId) return;
      // Recheck after the request: edits may have begun while it was in flight.
      if (automatic === true && (document.hidden || game.classList.contains("hidden")
        || list.contains(document.activeElement) || hasPlayerManagerDrafts(list))) return;
      if (automatic === true && JSON.stringify(data || []) === JSON.stringify(managerRows)) return;
      managerRows = data || [];
      renderPlayerManagerList();
    } catch (e) {
      if (automatic === true) return;
      list.innerHTML = `<span class="muted">${escapeHtml(e.message || "Liste indisponible.")}</span>`;
    } finally { managerRefreshBusy = false; }
  }

  function setup() {
    participant = window.CHASSE_PARTICIPANT || participant;
    const game = document.getElementById("gameView");
    if (!participant || !game || game.classList.contains("hidden")) return;

    if (participant.role === "target") {
      injectTimer("targetPanel","target");
      injectTargetState();
      injectVisibleTargetStates("targetPanel","target");
      startOwnPosition();
    } else if (participant.role === "hunter") {
      injectTimer("hunterPanel","hunter");
      injectHunterDepartureTimer();
      injectHunterPingControl();
      injectVisibleTargetStates("hunterPanel","hunter");
      startOwnPosition();
    } else if (participant.role === "organizer") {
      injectOrganizerManager();
    }

    if (!initialSetupDone) {
      initialSetupDone = true;
      refreshEventState();
      if (participant.role === "target") refreshTargetState();
      if (["target","hunter"].includes(participant.role)) refreshVisibleTargetStates();
      if (participant.role === "hunter") refreshHunterPings();
      if (participant.role === "organizer") refreshPlayerManager();
    }
  }

  window.addEventListener("evasion:event-updated", (event) => {
    if (event?.detail?.status) {
      eventState = {
        status: event.detail.status,
        actual_started_at: event.detail.actual_started_at,
        actual_ends_at: event.detail.actual_ends_at
      };
      window.CHASSE_EVENT_STATE = { ...(window.CHASSE_EVENT_STATE || {}), ...eventState };
      renderGlobalTimer();
      renderHunterDepartureTimer();
    }
    refreshEventState();
  });

  function refreshVisibleState() {
    if (document.hidden) return;
    refreshEventState();
    refreshPlayerManager(true);
  }

  document.addEventListener("visibilitychange", refreshVisibleState);
  window.addEventListener("focus", refreshVisibleState);

  window.addEventListener("evasion:logout", () => {
    participant = null;
    eventState = null;
    initialSetupDone = false;
    targetStateSnapshot = null;
    targetCountdownTriggered = false;
    managerRows = [];
    document.body.classList.remove("player-live-mode");

    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    selfMarker?.remove();
    selfAccuracy?.remove();
    selfMarker = null;
    selfAccuracy = null;

    hunterPingLayers.forEach((layer) => layer.remove());
    hunterPingLayers.clear();
  });

  setInterval(setup,1000);
  setInterval(() => { renderGlobalTimer(); renderHunterDepartureTimer(); renderTargetCaptureCountdown(); },1000);
  setInterval(refreshVisibleState,60000);
  setInterval(() => {
    if (document.hidden) return;
    const game = document.getElementById("gameView");
    if (!game || game.classList.contains("hidden")) return;
    if (participant?.role === "target") refreshTargetState();
    if (["target","hunter"].includes(participant?.role)) refreshVisibleTargetStates();
    if (participant?.role === "hunter") refreshHunterPings();
  },15000);
})();

