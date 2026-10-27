(() => {
  const cfg = window.CHASSE_CONFIG;
  if (!cfg) return;

  let participant = null;
  let statusRow = null;
  let busy = false;
  let initialized = false;
  let teamCacheAt = 0;
  const teamByParticipant = new Map();
  const layers = new Map();

  const TEAM_COLORS = {
    Alpha: "#3b82f6",
    Beta: "#f59e0b",
    Omega: "#a855f7"
  };

  const style = document.createElement("style");
  style.textContent = `
    .hunter-required-box {
      margin: 10px 0 14px;
      padding: 12px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 10px;
      background: rgba(255,255,255,.045);
    }
    .hunter-required-main { font-size: 1.15rem; font-weight: 850; margin-top: 3px; }
    .hunter-required-marker {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--hunter-team-color, #ff5656);
      border: 4px double #fff;
      box-shadow: 0 0 0 5px rgba(255,255,255,.16), 0 0 16px var(--hunter-team-color, #ff5656);
    }
  `;
  document.head.appendChild(style);

  function client() { return window.CHASSE_LIVE_CLIENT || null; }

  function fmt(ms) {
    const sec = Math.max(0, Math.floor(Math.abs(ms) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  function teamColor(team) {
    return TEAM_COLORS[team] || "#ff5656";
  }

  function slotOffsetMinutes() {
    if (!statusRow?.scheduled_at) return null;
    const due = new Date(statusRow.scheduled_at).getTime();
    const event = window.CHASSE_EVENT_STATE || {};

    if (event.actual_started_at) {
      return Math.round((due - new Date(event.actual_started_at).getTime()) / 60000);
    }
    if (event.actual_ends_at) {
      const minutesBeforeEnd = Math.round((new Date(event.actual_ends_at).getTime() - due) / 60000);
      return 120 - minutesBeforeEnd;
    }
    return null;
  }

  function slotLabel(offset) {
    if (offset === 60) return "PING +60 · MI-PARCOURS";
    if (offset === 100) return "PING · 20 MIN AVANT LA FIN";
    if (offset === 110) return "PING · 10 MIN AVANT LA FIN";
    return "PROCHAIN PING CHASSEUR OBLIGATOIRE";
  }

  function injectHunterControl() {
    const panel = document.getElementById("hunterPanel");
    if (!panel || document.getElementById("hunterRequiredPingBox")) return;

    const box = document.createElement("div");
    box.id = "hunterRequiredPingBox";
    box.className = "hunter-required-box";
    box.innerHTML = `
      <span class="eyebrow">PING CHASSEUR OBLIGATOIRE</span>
      <div id="hunterRequiredPingMain" class="hunter-required-main">En attente du START</div>
      <small id="hunterRequiredPingSub" class="muted">Pings obligatoires à +60 min, puis 20 min et 10 min avant la fin.</small>
      <button id="sendRequiredHunterPingBtn" class="primary small" disabled>ENVOYER LE PING OBLIGATOIRE</button>
    `;

    const anchor = panel.querySelector(".divider") || panel.firstElementChild;
    if (anchor) panel.insertBefore(box, anchor);
    else panel.appendChild(box);

    document.getElementById("sendRequiredHunterPingBtn")?.addEventListener("click", sendRequiredPing);
  }

  function renderStatus() {
    if (!participant || participant.role !== "hunter") return;
    const main = document.getElementById("hunterRequiredPingMain");
    const sub = document.getElementById("hunterRequiredPingSub");
    const btn = document.getElementById("sendRequiredHunterPingBtn");
    if (!main || !sub || !btn) return;

    btn.disabled = true;
    btn.textContent = "ENVOYER LE PING OBLIGATOIRE";

    if (!statusRow || statusRow.event_status === "scheduled") {
      main.textContent = "EN ATTENTE DU START";
      sub.textContent = "Pings obligatoires à +60 min, puis 20 min et 10 min avant la fin.";
      return;
    }

    if (statusRow.sent) {
      main.textContent = "3/3 PINGS OBLIGATOIRES ENVOYÉS";
      sub.textContent = "Les trois positions obligatoires ont été partagées avec tous les joueurs et l'Organisateur.";
      return;
    }

    if (!statusRow.scheduled_at) {
      main.textContent = statusRow.event_status === "finished"
        ? "PARTIE TERMINÉE"
        : "PING(S) OBLIGATOIRE(S) MANQUÉ(S)";
      sub.textContent = "Une ou plusieurs fenêtres obligatoires n'ont pas été validées.";
      return;
    }

    if (statusRow.event_status === "finished") {
      main.textContent = "PARTIE TERMINÉE";
      sub.textContent = "Le ping obligatoire n'est plus disponible.";
      return;
    }

    const offset = slotOffsetMinutes();
    const diff = new Date(statusRow.scheduled_at).getTime() - Date.now();
    const label = slotLabel(offset);

    if (diff > 60000) {
      main.textContent = `${label} · DANS ${fmt(diff)}`;
      sub.textContent = "La fenêtre d'envoi s'ouvre 60 secondes avant l'heure prévue.";
      return;
    }

    if (diff >= -60000) {
      main.textContent = diff >= 0 ? `${label} · DANS ${fmt(diff)}` : `${label} · À ENVOYER MAINTENANT`;
      sub.textContent = "Fenêtre obligatoire : ±60 secondes. Visible par les Cibles, les Chasseurs et l'Organisateur.";
      btn.disabled = false;
      return;
    }

    main.textContent = `${label} · MANQUÉ`;
    sub.textContent = "La fenêtre d'envoi est dépassée.";
  }

  async function refreshStatus() {
    if (!participant || participant.role !== "hunter" || !client()) return;
    const { data, error } = await client().rpc("my_required_hunter_ping_status");
    if (error) return;
    statusRow = Array.isArray(data) ? data[0] : data;
    renderStatus();
  }

  async function sendRequiredPing() {
    if (busy || !client()) return;
    const btn = document.getElementById("sendRequiredHunterPingBtn");
    const sub = document.getElementById("hunterRequiredPingSub");
    busy = true;
    if (btn) btn.disabled = true;
    if (sub) sub.textContent = "Localisation GPS en cours…";

    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0
        });
      });

      const { latitude, longitude, accuracy } = pos.coords;
      const { error } = await client().rpc("submit_required_hunter_ping", {
        p_lat: latitude,
        p_lng: longitude,
        p_accuracy_m: accuracy
      });
      if (error) throw error;

      await refreshStatus();
      await refreshVisiblePings();
    } catch (e) {
      if (sub) sub.textContent = e.message || "Impossible d'envoyer le ping obligatoire.";
    } finally {
      busy = false;
      renderStatus();
    }
  }

  async function refreshTeamCache(force = false) {
    if (!client()) return;
    if (!force && teamByParticipant.size && Date.now() - teamCacheAt < 60000) return;

    const { data, error } = await client()
      .from("participants")
      .select("id,team")
      .eq("event_id", cfg.EVENT_ID)
      .eq("role", "hunter")
      .eq("active", true);

    if (error) return;
    teamByParticipant.clear();
    (data || []).forEach((row) => teamByParticipant.set(row.id, row.team || ""));
    teamCacheAt = Date.now();
  }

  async function refreshVisiblePings() {
    if (!participant || !client()) return;
    const map = window.CHASSE_MAP;
    if (!map || !window.L) return;

    await refreshTeamCache();
    const { data, error } = await client().rpc("visible_required_hunter_pings");
    if (error) return;

    const seen = new Set();
    for (const row of data || []) {
      seen.add(row.participant_id);
      const team = teamByParticipant.get(row.participant_id) || "";
      const color = teamColor(team);
      const latlng = [row.lat, row.lng];
      const icon = L.divIcon({
        className: "",
        html: `<div class="hunter-required-marker" style="--hunter-team-color:${color}"></div>`,
        iconSize: [22,22],
        iconAnchor: [11,11]
      });

      let marker = layers.get(row.participant_id);
      if (!marker) {
        marker = L.marker(latlng, { icon, zIndexOffset: 1450 }).addTo(map);
        layers.set(row.participant_id, marker);
      } else {
        marker.setLatLng(latlng);
        marker.setIcon(icon);
      }

      marker.bindTooltip(
        `${row.pseudo} · ${team || "Chasseur"} · Ping obligatoire`,
        { direction: "top", className: "map-label" }
      );
    }

    layers.forEach((marker, id) => {
      if (!seen.has(id)) {
        marker.remove();
        layers.delete(id);
      }
    });
  }

  function setup() {
    participant = window.CHASSE_PARTICIPANT || participant;
    const game = document.getElementById("gameView");
    if (!participant || !game || game.classList.contains("hidden")) return;

    if (participant.role === "hunter") injectHunterControl();

    if (!initialized) {
      initialized = true;
      refreshTeamCache(true);
      refreshVisiblePings();
      if (participant.role === "hunter") refreshStatus();
    }
  }

  function refreshVisibleState() {
    if (document.hidden) return;
    refreshVisiblePings();
    if (participant?.role === "hunter") refreshStatus();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshVisibleState();
  });
  window.addEventListener("focus", refreshVisibleState);
  window.addEventListener("evasion:event-updated", refreshVisibleState);

  setInterval(setup, 1000);
  setInterval(renderStatus, 1000);
  setInterval(refreshVisibleState, 5000);
})();
