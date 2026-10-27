(() => {
  const cfg = window.CHASSE_CONFIG;
  if (!cfg || !window.supabase?.createClient) return;

  const originalCreateClient = window.supabase.createClient.bind(window.supabase);
  let targetTiming = null;
  let hunterTiming = null;

  window.supabase.createClient = function patchedCreateClient(...args) {
    const client = originalCreateClient(...args);
    const originalRpc = client.rpc.bind(client);

    client.rpc = function patchedRpc(fn, params = {}, options) {
      if (fn === "claim_participant") {
        const pseudo = document.getElementById("demoPseudo")?.value?.trim() || "";
        if (!pseudo) {
          return Promise.resolve({ data: null, error: { message: "Choisis un pseudo avant d'entrer dans la partie." } });
        }
        return originalRpc("claim_participant_with_pseudo", {
          p_code: params?.p_code,
          p_pseudo: pseudo
        }, options);
      }
      return originalRpc(fn, params, options);
    };

    window.CHASSE_LIVE_CLIENT = client;
    return client;
  };

  const style = document.createElement("style");
  style.textContent = `
    #accessForm:not(.hidden) #demoPseudoWrap.hidden {
      display: flex !important;
    }
    .runtime-controls {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 14px 0 4px;
    }
    .runtime-controls .primary,
    .runtime-controls .ghost {
      width: 100%;
    }
    .runtime-status,
    .ping-countdown {
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      background: rgba(255,255,255,.035);
    }
    .ping-countdown {
      margin: 10px 0 14px;
    }
    .ping-countdown-main {
      font-size: 1.18rem;
      font-weight: 800;
      margin-top: 3px;
    }
    .ping-countdown.overdue {
      border-color: rgba(255,86,86,.55);
      background: rgba(255,86,86,.08);
    }
    .ping-countdown.overdue .ping-countdown-main {
      color: #ff8f8f;
    }
    .ping-countdown.waiting .ping-countdown-main {
      color: #ffd86b;
    }
    @media (max-width: 620px) {
      .runtime-controls { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);

  function formatClock(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: cfg.EVENT_TIMEZONE || "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Math.abs(ms) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function preparePseudoField() {
    const wrap = document.getElementById("demoPseudoWrap");
    const input = document.getElementById("demoPseudo");
    if (!wrap || !input) return;

    const label = wrap.querySelector("span");
    if (label) label.textContent = "Pseudo";
    input.maxLength = 24;
    input.autocomplete = "nickname";
    input.placeholder = "Choisis ton pseudo";

    if (!document.getElementById("pseudoHelp")) {
      const help = document.createElement("small");
      help.id = "pseudoHelp";
      help.className = "muted";
      help.textContent = "Le pseudo est associé à ton code lors de sa première utilisation.";
      wrap.appendChild(help);
    }
  }

  async function refreshRuntimeStatus() {
    const client = window.CHASSE_LIVE_CLIENT;
    const label = document.getElementById("eventRuntimeLabel");
    if (!client || !label) return;

    const { data, error } = await client
      .from("events")
      .select("status,actual_started_at,actual_ends_at")
      .eq("id", cfg.EVENT_ID)
      .single();

    if (error) {
      label.textContent = "État indisponible";
      return;
    }

    const btn = document.getElementById("startEventBtn");
    if (data?.status === "live" && data.actual_started_at) {
      label.textContent = `Partie démarrée à ${formatClock(data.actual_started_at)} · fin prévue ${formatClock(data.actual_ends_at)}`;
      if (btn) {
        btn.disabled = true;
        btn.textContent = "PARTIE DÉMARRÉE";
      }
    } else {
      label.textContent = "Partie en attente du départ";
      if (btn) {
        btn.disabled = false;
        btn.textContent = "START — DÉMARRER MAINTENANT";
      }
    }
  }

  function injectOrganizerControls() {
    const panel = document.getElementById("organizerPanel");
    if (!panel || document.getElementById("startEventBtn")) return;

    const block = document.createElement("div");
    block.innerHTML = `
      <div class="divider"></div>
      <div>
        <span class="eyebrow">DÉROULEMENT</span>
        <div class="big-status">Contrôle de la partie</div>
      </div>
      <div class="runtime-status"><span id="eventRuntimeLabel" class="muted">Chargement…</span></div>
      <div class="runtime-controls">
        <button id="startEventBtn" class="primary">START — DÉMARRER MAINTENANT</button>
        <button id="resetStartBtn" class="ghost">RESET START</button>
        <button id="resetExtractionBtn" class="ghost">RESET ZONE D'EXTRACTION</button>
        <button id="resetPartyBtn" class="ghost">RESET PARTIE</button>
      </div>
      <p class="muted compact">START enregistre l'heure réelle du départ. Départ des Chasseurs à +10 min. Pings Cibles : START/Ping 0, puis +20 / +30 / +40 / +50 / +60 / +80 / +95 / +100 / +105 / +110 min. Les pings +75, +90, +115 et +120 sont supprimés. Après +110, aucun autre ping obligatoire jusqu’à la fin. La zone d'extraction est tirée et révélée automatiquement à START +80 min, soit 40 minutes avant la fin. RESET START remet seulement le départ à zéro. RESET PARTIE efface les pings de test, la zone active et le départ, mais conserve les participants, leurs pseudos et leurs codes.</p>
    `;

    const firstDivider = panel.querySelector(".divider");
    if (firstDivider) panel.insertBefore(block, firstDivider);
    else panel.appendChild(block);

    document.getElementById("startEventBtn").addEventListener("click", async () => {
      if (!confirm("Démarrer la partie maintenant ? Ping 0 part immédiatement, les Chasseurs partent à +10 min, puis les pings Cibles suivent le planning jusqu’à +110 min. Après +110, aucun autre ping obligatoire jusqu’à la fin.")) return;
      const client = window.CHASSE_LIVE_CLIENT;
      if (!client) return alert("Connexion Supabase indisponible.");

      const btn = document.getElementById("startEventBtn");
      btn.disabled = true;
      btn.textContent = "DÉMARRAGE…";

      const { data, error } = await client.rpc("start_event_now");
      if (error) {
        btn.disabled = false;
        btn.textContent = "START — DÉMARRER MAINTENANT";
        return alert(error.message || "Impossible de démarrer la partie.");
      }

      const row = Array.isArray(data) ? data[0] : data;
      alert(`Partie démarrée à ${formatClock(row?.actual_started_at || new Date())}.`);
      document.getElementById("refreshAdminBtn")?.click();
      await refreshRuntimeStatus();
    });

    document.getElementById("resetStartBtn").addEventListener("click", async () => {
      if (!confirm("Réinitialiser uniquement le START ? Les pings déjà enregistrés seront conservés.")) return;
      const client = window.CHASSE_LIVE_CLIENT;
      if (!client) return alert("Connexion Supabase indisponible.");
      const { error } = await client.rpc("reset_event_start");
      if (error) return alert(error.message || "Impossible de réinitialiser le START.");
      alert("START réinitialisé. Les pings sont revenus à leur planning théorique.");
      document.getElementById("refreshAdminBtn")?.click();
      await refreshRuntimeStatus();
    });

    document.getElementById("resetExtractionBtn").addEventListener("click", async () => {
      if (!confirm("Réinitialiser la zone d'extraction active ? Un nouveau tirage sera ensuite possible.")) return;
      const client = window.CHASSE_LIVE_CLIENT;
      if (!client) return alert("Connexion Supabase indisponible.");

      const { error } = await client.rpc("reset_extraction_zone");
      if (error) return alert(error.message || "Impossible de réinitialiser la zone.");

      document.getElementById("refreshAdminBtn")?.click();
      await refreshRuntimeStatus();
    });

    document.getElementById("resetPartyBtn").addEventListener("click", async () => {
      if (!confirm("RESET PARTIE : effacer tous les pings de test, la zone active et le START ? Les participants, pseudos et codes seront conservés.")) return;
      const client = window.CHASSE_LIVE_CLIENT;
      if (!client) return alert("Connexion Supabase indisponible.");
      const { error } = await client.rpc("reset_party");
      if (error) return alert(error.message || "Impossible de réinitialiser la partie.");
      alert("Partie de test réinitialisée.");
      document.getElementById("refreshAdminBtn")?.click();
      await refreshRuntimeStatus();
    });

    const observer = new MutationObserver(() => {
      if (!panel.classList.contains("hidden")) refreshRuntimeStatus();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });

    document.getElementById("refreshAdminBtn")?.addEventListener("click", () => {
      setTimeout(refreshRuntimeStatus, 150);
    });
  }

  function injectTargetCountdown() {
    const panel = document.getElementById("targetPanel");
    if (!panel || document.getElementById("pingCountdownBox")) return;

    const box = document.createElement("div");
    box.id = "pingCountdownBox";
    box.className = "ping-countdown waiting";
    box.innerHTML = `
      <span class="eyebrow">TEMPS AVANT LE PROCHAIN PING</span>
      <div id="pingCountdownMain" class="ping-countdown-main">En attente du START</div>
      <small id="pingCountdownSub" class="muted">Le compte à rebours commencera au lancement de la partie.</small>
    `;

    const sendButton = document.getElementById("sendPingBtn");
    panel.insertBefore(box, sendButton);

    const observer = new MutationObserver(() => {
      if (!panel.classList.contains("hidden")) refreshTargetTiming();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });

    sendButton?.addEventListener("click", () => {
      setTimeout(refreshTargetTiming, 1200);
      setTimeout(refreshTargetTiming, 3500);
    });
  }

  function injectHunterCountdown() {
    const panel = document.getElementById("hunterPanel");
    if (!panel || document.getElementById("hunterPingCountdownBox")) return;

    const box = document.createElement("div");
    box.id = "hunterPingCountdownBox";
    box.className = "ping-countdown waiting";
    box.innerHTML = `
      <span class="eyebrow">TEMPS AVANT LE PROCHAIN PING</span>
      <div id="hunterPingCountdownMain" class="ping-countdown-main">En attente du START</div>
      <small id="hunterPingCountdownSub" class="muted">Le compte à rebours commencera au lancement de la partie.</small>
    `;

    const firstInfo = panel.querySelector("p.muted");
    if (firstInfo) panel.insertBefore(box, firstInfo);
    else panel.appendChild(box);

    const observer = new MutationObserver(() => {
      if (!panel.classList.contains("hidden")) refreshHunterTiming();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
  }

  async function refreshTargetTiming() {
    const panel = document.getElementById("targetPanel");
    const client = window.CHASSE_LIVE_CLIENT;
    if (!panel || panel.classList.contains("hidden") || !client) return;

    const { data, error } = await client.rpc("my_next_ping_status");
    if (error) {
      targetTiming = { error: error.message };
      renderTargetCountdown();
      return;
    }

    targetTiming = Array.isArray(data) ? data[0] : data;
    renderTargetCountdown();
  }

  async function refreshHunterTiming() {
    const panel = document.getElementById("hunterPanel");
    const client = window.CHASSE_LIVE_CLIENT;
    if (!panel || panel.classList.contains("hidden") || !client) return;

    const { data, error } = await client.rpc("my_next_ping_status");
    if (error) {
      hunterTiming = { error: error.message };
      renderHunterCountdown();
      return;
    }

    hunterTiming = Array.isArray(data) ? data[0] : data;
    renderHunterCountdown();
  }

  function renderTargetCountdown() {
    const box = document.getElementById("pingCountdownBox");
    const main = document.getElementById("pingCountdownMain");
    const sub = document.getElementById("pingCountdownSub");
    const button = document.getElementById("sendPingBtn");
    if (!box || !main || !sub) return;

    box.classList.remove("overdue", "waiting");

    if (!targetTiming) {
      box.classList.add("waiting");
      main.textContent = "Chargement…";
      sub.textContent = "Synchronisation avec la partie.";
      return;
    }

    if (targetTiming.error) {
      box.classList.add("waiting");
      main.textContent = "État indisponible";
      sub.textContent = targetTiming.error;
      return;
    }

    if (targetTiming.event_status === "finished") {
      main.textContent = "PARTIE TERMINÉE";
      sub.textContent = "Aucun autre ping à envoyer.";
      if (button) button.disabled = true;
      return;
    }

    if (targetTiming.event_status !== "live") {
      box.classList.add("waiting");
      main.textContent = "EN ATTENTE DU START";
      sub.textContent = "Le compte à rebours commencera au lancement de la partie.";
      if (button) button.disabled = true;
      return;
    }

    if (targetTiming.all_sent) {
      main.textContent = "TOUS LES PINGS ONT ÉTÉ ENVOYÉS";
      sub.textContent = "Aucun autre ping obligatoire pour le moment.";
      if (button) button.disabled = true;
      return;
    }

    const due = new Date(targetTiming.scheduled_at).getTime();
    const diff = due - Date.now();
    if (diff >= 0) {
      main.textContent = `DANS ${formatDuration(diff)}`;
      sub.textContent = `${targetTiming.slot_label} prévu à ${formatClock(targetTiming.scheduled_at)}.`;
      if (button) button.disabled = false;
    } else {
      box.classList.add("overdue");
      main.textContent = `DÉPASSÉ DE ${formatDuration(diff)}`;
      sub.textContent = `${targetTiming.slot_label} devait être envoyé à ${formatClock(targetTiming.scheduled_at)}.`;
      if (button) button.disabled = false;
    }
  }

  function renderHunterCountdown() {
    const box = document.getElementById("hunterPingCountdownBox");
    const main = document.getElementById("hunterPingCountdownMain");
    const sub = document.getElementById("hunterPingCountdownSub");
    if (!box || !main || !sub) return;

    box.classList.remove("overdue", "waiting");

    if (!hunterTiming) {
      box.classList.add("waiting");
      main.textContent = "Chargement…";
      sub.textContent = "Synchronisation avec la partie.";
      return;
    }

    if (hunterTiming.error) {
      box.classList.add("waiting");
      main.textContent = "État indisponible";
      sub.textContent = hunterTiming.error;
      return;
    }

    if (hunterTiming.event_status === "finished") {
      main.textContent = "PARTIE TERMINÉE";
      sub.textContent = "Aucun autre ping prévu.";
      return;
    }

    if (hunterTiming.event_status !== "live") {
      box.classList.add("waiting");
      main.textContent = "EN ATTENTE DU START";
      sub.textContent = "Le compte à rebours commencera au lancement de la partie.";
      return;
    }

    if (hunterTiming.all_sent) {
      main.textContent = "TOUS LES PINGS SONT PASSÉS";
      sub.textContent = "Aucun autre ping prévu.";
      return;
    }

    const due = new Date(hunterTiming.scheduled_at).getTime();
    const diff = due - Date.now();
    if (diff >= 0) {
      main.textContent = `DANS ${formatDuration(diff)}`;
      sub.textContent = `${hunterTiming.slot_label} prévu à ${formatClock(hunterTiming.scheduled_at)}.`;
    } else {
      box.classList.add("overdue");
      main.textContent = `PING EN COURS · +${formatDuration(diff)}`;
      sub.textContent = `Fenêtre du ${hunterTiming.slot_label} en cours.`;
    }
  }

  window.addEventListener("evasion:event-updated", () => {
    refreshRuntimeStatus();
    refreshTargetTiming();
    refreshHunterTiming();
  });

  preparePseudoField();
  injectOrganizerControls();
  injectTargetCountdown();
  injectHunterCountdown();

  setInterval(() => {
    const targetPanel = document.getElementById("targetPanel");
    if (targetPanel && !targetPanel.classList.contains("hidden")) renderTargetCountdown();

    const hunterPanel = document.getElementById("hunterPanel");
    if (hunterPanel && !hunterPanel.classList.contains("hidden")) renderHunterCountdown();
  }, 1000);

  setInterval(() => {
    const targetPanel = document.getElementById("targetPanel");
    if (targetPanel && !targetPanel.classList.contains("hidden")) refreshTargetTiming();

    const hunterPanel = document.getElementById("hunterPanel");
    if (hunterPanel && !hunterPanel.classList.contains("hidden")) refreshHunterTiming();
  }, 5000);
})();
