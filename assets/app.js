(() => {
  const cfg = window.CHASSE_CONFIG;
  const state = {
    selectedRole: null,
    participant: null,
    supabase: null,
    map: null,
    areaData: null,
    areaLayer: null,
    pingLayers: new Map(),
    activeExtractionKey: null,
    pings: [],
    participants: [],
    slots: [],
    realtime: [],
    refreshTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const roleNames = { target: "CIBLE", hunter: "CHASSEUR", organizer: "ORGANISATEUR" };
  const storageKey = "chasse-urbaine-demo";

  function isLive() {
    return !cfg.DEMO_MODE && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY;
  }

  function setBadge(text, kind = "muted") {
    const el = $("connectionBadge");
    el.textContent = text;
    el.className = `badge badge-${kind}`;
  }

  function showError(message) {
    const el = $("loginError");
    el.textContent = message;
    el.classList.toggle("hidden", !message);
  }

  function formatClock(value) {
    if (!value) return "—";
    const d = new Date(value);
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: cfg.EVENT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(d);
  }

  function relativeAge(value) {
    if (!value) return "—";
    const sec = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }

  function getDemo() {
    try {
      return JSON.parse(localStorage.getItem(storageKey)) || { participants: [], pings: [], activeExtractionKey: null };
    } catch {
      return { participants: [], pings: [], activeExtractionKey: null };
    }
  }

  function saveDemo(data) {
    localStorage.setItem(storageKey, JSON.stringify(data));
  }

  function ensureDemoParticipant(role, pseudo) {
    const data = getDemo();
    let p = data.participants.find((x) => x.role === role && x.pseudo.toLowerCase() === pseudo.toLowerCase());
    if (!p) {
      p = { id: crypto.randomUUID(), event_id: cfg.EVENT_ID, role, pseudo, active: true };
      data.participants.push(p);
      saveDemo(data);
    }
    return p;
  }

  async function initSupabase() {
    if (!isLive()) {
      setBadge("Mode démo", "amber");
      $("accessCodeWrap").classList.add("hidden");
      return;
    }
    state.supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    const { data: sessionData } = await state.supabase.auth.getSession();
    if (!sessionData.session) {
      const { error } = await state.supabase.auth.signInAnonymously();
      if (error) throw error;
    }
    setBadge("Connecté", "green");
    $("accessCodeWrap").classList.remove("hidden");
  }

  function selectRole(role) {
    state.selectedRole = role;
    document.querySelector(".role-grid").classList.add("hidden");
    $("accessForm").classList.remove("hidden");
    $("demoPseudoWrap").classList.toggle("hidden", isLive());
    $("accessCodeWrap").classList.toggle("hidden", !isLive());
    $("demoPseudo").placeholder = role === "target" ? "Pseudo de la Cible" : role === "hunter" ? "Nom / équipe" : "Organisateur";
    showError("");
  }

  function backToRoles() {
    state.selectedRole = null;
    $("accessForm").classList.add("hidden");
    document.querySelector(".role-grid").classList.remove("hidden");
    showError("");
  }

  async function claimAccess() {
    showError("");
    $("joinButton").disabled = true;
    try {
      let participant;
      if (isLive()) {
        const code = $("accessCode").value.trim();
        if (!code) throw new Error("Saisis ton code d'accès.");
        const { data, error } = await state.supabase.rpc("claim_participant", { p_code: code });
        if (error) throw error;
        if (!data) throw new Error("Code invalide.");
        participant = Array.isArray(data) ? data[0] : data;
      } else {
        const pseudo = $("demoPseudo").value.trim() || (state.selectedRole === "target" ? "Cible Démo" : state.selectedRole === "hunter" ? "Chasseur Démo" : "Organisateur");
        participant = ensureDemoParticipant(state.selectedRole, pseudo);
      }
      if (participant.role !== state.selectedRole) throw new Error(`Ce code correspond au rôle ${roleNames[participant.role] || participant.role}.`);
      state.participant = participant;
      window.CHASSE_PARTICIPANT = participant;
      await enterGame();
    } catch (e) {
      showError(e.message || "Impossible d'entrer dans la partie.");
    } finally {
      $("joinButton").disabled = false;
    }
  }

  async function enterGame() {
    $("loginView").classList.add("hidden");
    $("gameView").classList.remove("hidden");
    $("roleLabel").textContent = roleNames[state.participant.role] || state.participant.role;
    $("identityLabel").textContent = state.participant.pseudo;
    $("targetPanel").classList.toggle("hidden", state.participant.role !== "target");
    $("hunterPanel").classList.toggle("hidden", state.participant.role !== "hunter");
    $("organizerPanel").classList.toggle("hidden", state.participant.role !== "organizer");

    if (!state.map) await initMap();
    setTimeout(() => state.map.invalidateSize(), 50);
    await refreshAll();
    if (isLive()) subscribeRealtime();
  }

  async function initMap() {
    state.map = L.map("map", { zoomControl: true, attributionControl: true }).setView(cfg.MAP_CENTER, cfg.MAP_ZOOM);
    window.CHASSE_MAP = state.map;
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(state.map);

    state.areaData = await fetch("data/areas.geojson").then((r) => r.json());
    drawAreas();
    const bounds = state.areaLayer.getBounds();
    if (bounds.isValid()) state.map.fitBounds(bounds.pad(0.03));
  }

  function areaStyle(feature) {
    const p = feature.properties;
    if (p.zone_type === "perimeter") return { color: "#b9c3c7", weight: 2, dashArray: "7 7", fillColor: "#7dff6a", fillOpacity: 0.015 };
    if (p.zone_type === "prison") return { color: "#ff5656", weight: 2, fillColor: "#ff5656", fillOpacity: 0.16 };
    if (p.zone_type === "extraction") {
      const active = p.id === state.activeExtractionKey;
      return {
        color: active ? "#7dff6a" : "#6b777c",
        weight: active ? 4 : 1.5,
        fillColor: active ? "#7dff6a" : "#687277",
        fillOpacity: active ? 0.25 : 0.06,
        dashArray: active ? null : "5 5"
      };
    }
    return { color: "#999", weight: 1 };
  }

  function drawAreas() {
    if (state.areaLayer) state.areaLayer.remove();
    state.areaLayer = L.geoJSON(state.areaData, {
      style: areaStyle,
      onEachFeature(feature, layer) {
        const p = feature.properties;
        if (p.zone_type !== "perimeter") layer.bindTooltip(p.name, { sticky: true, className: "map-label" });
      }
    }).addTo(state.map);
  }

  async function refreshAll() {
    if (isLive()) await refreshLive(); else refreshDemo();
    renderPings();
    renderActiveZone();
    if (state.participant.role === "target") renderTargetPanel();
    if (state.participant.role === "hunter") renderHunterPanel();
    if (state.participant.role === "organizer") renderOrganizer();
  }

  async function refreshLive() {
    const [partsRes, slotsRes, pingsRes, eventRes] = await Promise.all([
      state.supabase.from("participants").select("id,event_id,pseudo,role,team,active").eq("event_id", cfg.EVENT_ID).eq("active", true),
      state.supabase.from("ping_slots").select("id,event_id,label,scheduled_at,ordinal").eq("event_id", cfg.EVENT_ID).order("ordinal"),
      state.supabase.from("pings").select("id,event_id,participant_id,slot_id,lat,lng,accuracy_m,sent_at,valid_window,delta_seconds").eq("event_id", cfg.EVENT_ID).order("sent_at"),
      state.supabase.from("events").select("id,active_extraction_key,status,actual_started_at,actual_ends_at").eq("id", cfg.EVENT_ID).single()
    ]);
    for (const r of [partsRes, slotsRes, pingsRes, eventRes]) if (r.error) throw r.error;
    state.participants = partsRes.data || [];
    state.slots = slotsRes.data || [];
    state.pings = pingsRes.data || [];
    state.activeExtractionKey = eventRes.data?.active_extraction_key || null;
    window.CHASSE_EVENT_STATE = eventRes.data || null;
  }

  function refreshDemo() {
    const data = getDemo();
    state.participants = data.participants;
    state.pings = data.pings;
    state.activeExtractionKey = data.activeExtractionKey;
    state.slots = cfg.PING_TIMES.map((label, i) => ({ id: `demo-slot-${i}`, label: `Ping ${i}`, ordinal: i, scheduled_at: `${cfg.EVENT_DATE}T${label}:00+01:00` }));
  }

  function latestTargetPings() {
    const targets = state.participants.filter((p) => p.role === "target");
    return targets.map((p) => {
      const pings = state.pings.filter((x) => x.participant_id === p.id).sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
      return { participant: p, ping: pings[0] || null };
    });
  }

  function renderPings() {
    state.pingLayers.forEach((layer) => layer.remove());
    state.pingLayers.clear();
    for (const { participant, ping } of latestTargetPings()) {
      if (!ping) continue;
      const icon = L.divIcon({ className: "", html: '<div class="ping-marker" style="width:18px;height:18px"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
      const marker = L.marker([ping.lat, ping.lng], { icon })
        .bindTooltip(`${participant.pseudo} · ${formatClock(ping.sent_at)}`, { permanent: false, direction: "top", className: "map-label" })
        .addTo(state.map);
      state.pingLayers.set(participant.id, marker);
    }
    if (state.areaLayer) state.areaLayer.setStyle(areaStyle);
  }

  function renderPingList(containerId) {
    const container = $(containerId);
    const items = latestTargetPings().sort((a, b) => a.participant.pseudo.localeCompare(b.participant.pseudo, "fr"));
    container.innerHTML = items.length ? items.map(({ participant, ping }) => {
      if (!ping) return `<div class="list-item"><strong>${escapeHtml(participant.pseudo)}</strong><small>Aucun ping</small></div>`;
      return `<div class="list-item"><div><strong>${escapeHtml(participant.pseudo)}</strong><br><small>${formatClock(ping.sent_at)}</small></div><span class="badge ${ping.valid_window ? "badge-green" : "badge-red"}">${relativeAge(ping.sent_at)}</span></div>`;
    }).join("") : '<p class="muted">Aucune Cible enregistrée.</p>';
  }

  function renderTargetPanel() {
    renderPingList("targetPingList");
    const mine = state.pings.filter((p) => p.participant_id === state.participant.id);
    const sentSlotIds = new Set(mine.map((p) => p.slot_id));
    const next = state.slots.find((s) => !sentSlotIds.has(s.id));
    const button = $("sendPingBtn");
    if (!next) {
      $("nextPingText").textContent = "Tous les pings envoyés";
      $("pingStatusChip").textContent = `${mine.length}/${state.slots.length}`;
      $("pingStatusChip").className = "badge badge-green";
      button.disabled = true;
    } else {
      $("nextPingText").textContent = next.label;
      $("pingStatusChip").textContent = `${mine.length}/${state.slots.length} envoyé(s)`;
      $("pingStatusChip").className = "badge badge-muted";
      button.disabled = false;
    }
  }

  function renderHunterPanel() {
    renderPingList("hunterPingList");
    const pings = latestTargetPings().map((x) => x.ping).filter(Boolean);
    if (!pings.length) $("hunterFreshness").textContent = "Aucun ping";
    else {
      const newest = pings.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
      $("hunterFreshness").textContent = `Maj ${relativeAge(newest.sent_at)}`;
    }
  }

  function renderOrganizer() {
    const targets = state.participants.filter((p) => p.role === "target").sort((a, b) => a.pseudo.localeCompare(b.pseudo, "fr"));
    const slots = [...state.slots].sort((a, b) => a.ordinal - b.ordinal);
    const rows = targets.map((target) => {
      const cells = slots.map((slot) => {
        const ping = state.pings.find((p) => p.participant_id === target.id && p.slot_id === slot.id);
        if (!ping) return '<td class="missing">—</td>';
        const klass = ping.valid_window ? "ok" : "bad";
        const suffix = ping.valid_window ? "✓" : `⚠ ${Math.abs(ping.delta_seconds || 0)}s`;
        return `<td class="${klass}">${formatClock(ping.sent_at)} ${suffix}</td>`;
      }).join("");
      return `<tr><td><strong>${escapeHtml(target.pseudo)}</strong></td>${cells}</tr>`;
    }).join("");
    $("adminMatrix").innerHTML = `<table><thead><tr><th>Cible</th>${slots.map((s) => `<th>${escapeHtml(s.label)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${slots.length + 1}" class="missing">Aucune Cible enregistrée.</td></tr>`}</tbody></table>`;
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function renderExtractionControl() {
    const btn = $("drawZoneBtn");
    const info = $("extractionScheduleText");
    if (!btn || !info || state.participant?.role !== "organizer") return;

    const offsetMinutes = Number(cfg.EXTRACTION_REVEAL_OFFSET_MINUTES || 80);

    if (state.activeExtractionKey) {
      btn.disabled = true;
      btn.textContent = "ZONE RÉVÉLÉE";
      info.textContent = "La zone d'extraction active est maintenant visible par tous les joueurs.";
      return;
    }

    if (!isLive()) {
      btn.disabled = false;
      btn.textContent = "TIRER LA ZONE";
      info.textContent = `Mode démo : tirage manuel. En partie réelle, révélation automatique à START +${offsetMinutes} min.`;
      return;
    }

    const event = window.CHASSE_EVENT_STATE;
    if (!event?.actual_started_at || event.status === "scheduled") {
      btn.disabled = true;
      btn.textContent = `AUTO À +${offsetMinutes}`;
      info.textContent = `Révélation automatique à START +${offsetMinutes} min, soit 40 minutes avant la fin.`;
      return;
    }

    if (event.status === "finished") {
      btn.disabled = true;
      btn.textContent = "PARTIE TERMINÉE";
      info.textContent = "La partie est terminée.";
      return;
    }

    const revealAt = new Date(event.actual_started_at).getTime() + offsetMinutes * 60 * 1000;
    const diff = revealAt - Date.now();

    if (diff > 0) {
      btn.disabled = true;
      btn.textContent = `AUTO À +${offsetMinutes}`;
      info.textContent = `Révélation automatique à ${formatClock(revealAt)} · dans ${formatCountdown(diff)}.`;
      return;
    }

    btn.disabled = false;
    btn.textContent = "TIRER MAINTENANT";
    info.textContent = "Le tirage automatique est arrivé à échéance. Ce bouton reste disponible comme solution de secours jusqu'à la révélation.";
  }

  function renderActiveZone() {
    const ft = state.areaData?.features.find((f) => f.properties.id === state.activeExtractionKey);
    $("activeZoneLabel").textContent = ft ? ft.properties.name : "Aucune zone active";
    if (state.areaLayer) state.areaLayer.setStyle(areaStyle);
    renderExtractionControl();
  }

  async function sendPing() {
    const btn = $("sendPingBtn");
    btn.disabled = true;
    $("geoMessage").textContent = "Localisation GPS en cours…";
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      });
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      if (isLive()) {
        const { data, error } = await state.supabase.rpc("submit_ping", { p_lat: lat, p_lng: lng, p_accuracy_m: accuracy });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        $("geoMessage").textContent = row?.valid_window ? `Ping envoyé à ${formatClock(row.sent_at)} — dans la fenêtre.` : `Ping envoyé à ${formatClock(row?.sent_at || new Date())} — hors fenêtre.`;
      } else {
        const data = getDemo();
        const mine = data.pings.filter((p) => p.participant_id === state.participant.id);
        const slot = state.slots.find((s) => !mine.some((p) => p.slot_id === s.id));
        if (!slot) throw new Error("Tous les pings ont déjà été envoyés.");
        data.pings.push({ id: crypto.randomUUID(), event_id: cfg.EVENT_ID, participant_id: state.participant.id, slot_id: slot.id, lat, lng, accuracy_m: accuracy, sent_at: new Date().toISOString(), valid_window: true, delta_seconds: 0 });
        saveDemo(data);
        $("geoMessage").textContent = `Ping démo envoyé · précision GPS ±${Math.round(accuracy)} m.`;
      }
      await refreshAll();
      state.map.setView([lat, lng], Math.max(state.map.getZoom(), 15));
    } catch (e) {
      const msg = e.code === 1 ? "Autorisation de localisation refusée." : e.code === 2 ? "Position GPS indisponible." : e.code === 3 ? "Délai GPS dépassé." : (e.message || "Impossible d'envoyer le ping.");
      $("geoMessage").textContent = msg;
    } finally {
      btn.disabled = false;
    }
  }

  async function drawExtractionZone() {
    const btn = $("drawZoneBtn");
    btn.disabled = true;
    try {
      let key;
      if (isLive()) {
        const { data, error } = await state.supabase.rpc("draw_extraction_zone");
        if (error) throw error;
        key = typeof data === "string" ? data : data?.active_extraction_key;
      } else {
        const data = getDemo();
        const keys = state.areaData.features.filter((f) => f.properties.zone_type === "extraction").map((f) => f.properties.id);
        key = data.activeExtractionKey || keys[Math.floor(Math.random() * keys.length)];
        data.activeExtractionKey = key;
        saveDemo(data);
      }
      state.activeExtractionKey = key;
      renderActiveZone();
    } catch (e) {
      alert(e.message || "Impossible d'effectuer le tirage.");
    } finally {
      renderExtractionControl();
    }
  }

  function scheduleRefreshAll(delay = 350) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refreshAll().catch(() => {});
    }, delay);
  }

  function subscribeRealtime() {
    unsubscribeRealtime();
    const pingsChannel = state.supabase.channel(`event-pings-${cfg.EVENT_ID}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "pings", filter: `event_id=eq.${cfg.EVENT_ID}` }, () => scheduleRefreshAll())
      .subscribe();
    const eventChannel = state.supabase.channel(`event-status-${cfg.EVENT_ID}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "events", filter: `id=eq.${cfg.EVENT_ID}` }, (payload) => {
        const next = payload?.new || null;
        if (next) {
          state.activeExtractionKey = next.active_extraction_key || null;
          window.CHASSE_EVENT_STATE = next;
          renderActiveZone();
        }
        window.dispatchEvent(new CustomEvent("evasion:event-updated", { detail: next }));
      })
      .subscribe();
    state.realtime = [pingsChannel, eventChannel];
  }

  function unsubscribeRealtime() {
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (!state.supabase) return;
    for (const channel of state.realtime) state.supabase.removeChannel(channel);
    state.realtime = [];
  }

  function logout() {
    unsubscribeRealtime();
    state.participant = null;
    state.selectedRole = null;
    window.CHASSE_PARTICIPANT = null;
    window.dispatchEvent(new CustomEvent("evasion:logout"));
    state.pingLayers.forEach((layer) => layer.remove());
    state.pingLayers.clear();
    $("gameView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    backToRoles();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  }

  function bindUI() {
    document.querySelectorAll(".role-card").forEach((btn) => btn.addEventListener("click", () => selectRole(btn.dataset.role)));
    $("backButton").addEventListener("click", backToRoles);
    $("joinButton").addEventListener("click", claimAccess);
    $("sendPingBtn").addEventListener("click", sendPing);
    $("drawZoneBtn").addEventListener("click", drawExtractionZone);
    $("refreshAdminBtn").addEventListener("click", refreshAll);
    $("centerMapBtn").addEventListener("click", () => {
      const bounds = state.areaLayer?.getBounds();
      if (bounds?.isValid()) state.map.fitBounds(bounds.pad(0.03));
    });
    $("logoutBtn").addEventListener("click", logout);
  }

  async function boot() {
    bindUI();
    try {
      await initSupabase();
    } catch (e) {
      setBadge("Erreur connexion", "red");
      showError(`Supabase : ${e.message}`);
    }
  }

  boot();
  setInterval(renderExtractionControl, 1000);
})();

