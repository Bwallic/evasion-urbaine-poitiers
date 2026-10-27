(() => {
  const cfg = window.CHASSE_CONFIG;
  if (!cfg) return;

  let registrationPromise = null;
  let autoActionDone = false;
  let pushAckDone = false;

  const style = document.createElement("style");
  style.textContent = `
    .notification-control {
      margin: 10px 0 14px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      background: rgba(255,255,255,.035);
    }
    .notification-control .panel-row { gap: 10px; }
    .notification-status { margin-top: 4px; }
    .start-check-list { display: grid; gap: 8px; margin-top: 10px; }
    .start-check-row {
      display: grid;
      grid-template-columns: minmax(110px, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 9px;
      background: rgba(255,255,255,.025);
    }
    .start-check-flags { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .start-check-flag { font-size: .78rem; white-space: nowrap; }
    @media (max-width: 620px) {
      .start-check-row { grid-template-columns: 1fr; }
      .start-check-flags { justify-content: flex-start; }
    }
  `;
  document.head.appendChild(style);

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent);
  }

  function isStandalone() {
    return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  }

  function supportsPush() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[c]));
  }

  function base64UrlToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function getRegistration() {
    if (!supportsPush()) throw new Error("Notifications push non prises en charge sur ce navigateur.");
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register("./sw.js").then(() => navigator.serviceWorker.ready);
    }
    return registrationPromise;
  }

  async function getPublicPushKey(client) {
    const { data, error } = await client.functions.invoke("push-dispatch", {
      body: { mode: "public-key" }
    });
    if (error) throw error;
    if (!data?.publicKey) throw new Error("Clé de notifications indisponible.");
    return data.publicKey;
  }

  async function activateNotifications(prefix) {
    const status = document.getElementById(`${prefix}NotificationStatus`);
    const button = document.getElementById(`${prefix}NotificationBtn`);
    const client = window.CHASSE_LIVE_CLIENT;
    if (!client || !status || !button) return;

    try {
      if (isIOS() && !isStandalone()) {
        throw new Error("Sur iPhone/iPad, ajoute d'abord le site à l'écran d'accueil puis ouvre-le depuis cette icône.");
      }
      if (!supportsPush()) throw new Error("Notifications push non prises en charge sur ce navigateur.");

      button.disabled = true;
      status.textContent = "Activation des notifications…";

      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Autorisation de notification refusée.");

      const registration = await getRegistration();
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const publicKey = await getPublicPushKey(client);
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey)
        });
      }

      const serialized = subscription.toJSON();
      const { error } = await client.rpc("save_push_subscription", {
        p_endpoint: serialized.endpoint,
        p_p256dh: serialized.keys?.p256dh,
        p_auth: serialized.keys?.auth,
        p_user_agent: navigator.userAgent
      });
      if (error) throw error;

      status.textContent = "Notifications activées sur cet appareil.";
      button.textContent = "NOTIFICATIONS ACTIVES";
      button.disabled = true;
    } catch (error) {
      status.textContent = error?.message || "Impossible d'activer les notifications.";
      button.textContent = "ACTIVER LES NOTIFICATIONS";
      button.disabled = false;
    }
  }

  async function refreshNotificationStatus(prefix) {
    const status = document.getElementById(`${prefix}NotificationStatus`);
    const button = document.getElementById(`${prefix}NotificationBtn`);
    const client = window.CHASSE_LIVE_CLIENT;
    if (!status || !button) return;

    if (isIOS() && !isStandalone()) {
      status.textContent = "iPhone/iPad : ajoute le site à l'écran d'accueil pour recevoir les notifications.";
      button.textContent = "NOTIFICATIONS VIA ÉCRAN D'ACCUEIL";
      button.disabled = true;
      return;
    }

    if (!supportsPush()) {
      status.textContent = "Notifications push non prises en charge par ce navigateur.";
      button.disabled = true;
      return;
    }

    if (Notification.permission === "denied") {
      status.textContent = "Notifications bloquées dans les réglages du navigateur.";
      button.disabled = true;
      return;
    }

    if (!client) {
      status.textContent = "Connexion en cours…";
      return;
    }

    try {
      const registration = await getRegistration();
      const subscription = await registration.pushManager.getSubscription();
      const { data, error } = await client.rpc("my_push_subscription_status");
      if (error) throw error;

      if (Notification.permission === "granted" && subscription && data === true) {
        status.textContent = "Notifications activées sur cet appareil.";
        button.textContent = "NOTIFICATIONS ACTIVES";
        button.disabled = true;
      } else {
        status.textContent = "Active les notifications avant le START pour recevoir tous les pings obligatoires prévus.";
        button.textContent = subscription ? "RÉACTIVER LES NOTIFICATIONS" : "ACTIVER LES NOTIFICATIONS";
        button.disabled = false;
      }
    } catch (error) {
      status.textContent = error?.message || "État des notifications indisponible.";
      button.disabled = false;
    }
  }

  function injectPlayerControl(panelId, prefix) {
    const panel = document.getElementById(panelId);
    if (!panel || document.getElementById(`${prefix}NotificationControl`)) return;

    const block = document.createElement("div");
    block.id = `${prefix}NotificationControl`;
    block.className = "notification-control";
    block.innerHTML = `
      <div class="panel-row">
        <div>
          <span class="eyebrow">NOTIFICATIONS DE PING</span>
          <div id="${prefix}NotificationStatus" class="notification-status muted">Vérification…</div>
        </div>
        <button id="${prefix}NotificationBtn" class="ghost small">ACTIVER</button>
      </div>
    `;

    const anchor = panel.querySelector(".ping-countdown") || panel.querySelector("p.muted") || panel.firstElementChild;
    if (anchor) panel.insertBefore(block, anchor);
    else panel.appendChild(block);

    document.getElementById(`${prefix}NotificationBtn`)?.addEventListener("click", () => activateNotifications(prefix));

    const observer = new MutationObserver(() => {
      if (!panel.classList.contains("hidden")) refreshNotificationStatus(prefix);
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
  }

  function injectOrganizerStartCheck() {
    const panel = document.getElementById("organizerPanel");
    if (!panel || document.getElementById("startCheckBlock")) return;

    const block = document.createElement("div");
    block.id = "startCheckBlock";
    block.innerHTML = `
      <div class="divider"></div>
      <div>
        <span class="eyebrow">CONTRÔLE DE DÉPART</span>
        <div class="big-status">Notifications et Ping 0</div>
      </div>
      <p class="muted compact">Avant le START, vérifie que les joueurs ont activé les notifications. Après le START, les Cibles valident leur position avec Ping 0 et les Chasseurs ouvrent la notification de contrôle.</p>
      <div id="startCheckList" class="start-check-list"><span class="muted">Chargement…</span></div>
    `;

    panel.appendChild(block);
  }

  async function refreshOrganizerStartCheck() {
    const panel = document.getElementById("organizerPanel");
    const list = document.getElementById("startCheckList");
    const client = window.CHASSE_LIVE_CLIENT;
    if (!panel || panel.classList.contains("hidden") || !list || !client) return;

    const { data, error } = await client.rpc("organizer_start_check_status");
    if (error) {
      list.innerHTML = `<span class="muted">${escapeHtml(error.message || "État indisponible")}</span>`;
      return;
    }

    const rows = data || [];
    list.innerHTML = rows.length ? rows.map((row) => {
      const notif = row.notifications_enabled ? "Notif ✓" : "Notif —";
      const clicked = row.ping0_clicked ? "Ouverture ✓" : "Ouverture —";
      const position = row.role === "target" ? (row.ping0_position_received ? "Position ✓" : "Position —") : null;
      return `
        <div class="start-check-row">
          <div><strong>${escapeHtml(row.pseudo)}</strong><br><small class="muted">${row.role === "target" ? "Cible" : "Chasseur"}</small></div>
          <div class="start-check-flags">
            <span class="badge ${row.notifications_enabled ? "badge-green" : "badge-muted"} start-check-flag">${notif}</span>
            <span class="badge ${row.ping0_clicked ? "badge-green" : "badge-muted"} start-check-flag">${clicked}</span>
            ${position ? `<span class="badge ${row.ping0_position_received ? "badge-green" : "badge-muted"} start-check-flag">${position}</span>` : ""}
          </div>
        </div>
      `;
    }).join("") : '<span class="muted">Aucun joueur actif.</span>';
  }

  function cleanActionQuery() {
    const url = new URL(window.location.href);
    url.searchParams.delete("pushJob");
    url.searchParams.delete("pingAction");
    url.searchParams.delete("slot");
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function handleNotificationAction() {
    if (autoActionDone) return;

    const params = new URLSearchParams(window.location.search);
    const jobId = params.get("pushJob");
    const wantsPing = params.get("pingAction") === "1";
    const expectedSlot = params.get("slot");
    if (!jobId && !wantsPing) {
      autoActionDone = true;
      return;
    }

    const client = window.CHASSE_LIVE_CLIENT;
    const gameView = document.getElementById("gameView");
    if (!client || !gameView || gameView.classList.contains("hidden")) return;

    if (jobId && !pushAckDone) {
      await client.rpc("ack_push_notification", { p_job_id: jobId });
      pushAckDone = true;
    }

    if (!wantsPing) {
      autoActionDone = true;
      cleanActionQuery();
      return;
    }

    const targetPanel = document.getElementById("targetPanel");
    if (!targetPanel || targetPanel.classList.contains("hidden")) return;

    if (expectedSlot !== null) {
      const { data, error } = await client.rpc("my_next_ping_status");
      if (error) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.all_sent || row.event_status !== "live" || row.slot_label !== `Ping ${expectedSlot}`) {
        autoActionDone = true;
        cleanActionQuery();
        return;
      }
    }

    const button = document.getElementById("sendPingBtn");
    if (!button || button.disabled) return;

    autoActionDone = true;
    cleanActionQuery();
    button.click();
  }

  injectPlayerControl("targetPanel", "target");
  injectPlayerControl("hunterPanel", "hunter");
  injectOrganizerStartCheck();

  if (supportsPush()) getRegistration().catch(() => {});

  function refreshVisibleNotificationUI() {
    if (document.hidden) return;

    const target = document.getElementById("targetPanel");
    if (target && !target.classList.contains("hidden")) refreshNotificationStatus("target");

    const hunter = document.getElementById("hunterPanel");
    if (hunter && !hunter.classList.contains("hidden")) refreshNotificationStatus("hunter");

    refreshOrganizerStartCheck();
    handleNotificationAction().catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshVisibleNotificationUI();
  });
  window.addEventListener("focus", refreshVisibleNotificationUI);

  refreshVisibleNotificationUI();
  setInterval(refreshVisibleNotificationUI, 10000);
})();
