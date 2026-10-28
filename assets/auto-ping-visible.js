(() => {
  let attemptedSlotId = null;
  let attemptedAt = 0;
  let checkInFlight = false;

  function targetPanelIsActive() {
    const panel = document.getElementById("targetPanel");
    return panel && !panel.classList.contains("hidden");
  }

  async function maybeSendAutomaticPing() {
    if (checkInFlight) return;
    if (document.visibilityState !== "visible") return;
    if (!targetPanelIsActive()) return;

    const client = window.CHASSE_LIVE_CLIENT;
    const button = document.getElementById("sendPingBtn");
    if (!client || !button || button.disabled) return;

    checkInFlight = true;
    try {
      const row = await window.CHASSE_REFRESH_TARGET_TIMING?.();
      if (button.disabled || !row || row.event_status !== "live" || row.all_sent || !row.slot_id || !row.scheduled_at) return;

      const dueAt = new Date(row.scheduled_at).getTime();
      const now = Date.now();
      const lateness = now - dueAt;

      // Automatique uniquement si la page est réellement au premier plan
      // au moment du ping. Après 55 s, on laisse la notification / le bouton
      // manuel prendre le relais afin de ne pas envoyer hors fenêtre.
      if (lateness < 0 || lateness > 55000) return;
      if (attemptedSlotId === row.slot_id && Date.now() - attemptedAt < 10000) return;

      attemptedSlotId = row.slot_id;
      attemptedAt = Date.now();
      button.click();
    } finally {
      checkInFlight = false;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      maybeSendAutomaticPing().catch(() => {});
    }
  });

  window.addEventListener("focus", () => {
    maybeSendAutomaticPing().catch(() => {});
  });

  setInterval(() => {
    maybeSendAutomaticPing().catch(() => {});
  }, 10000);
})();

