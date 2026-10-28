const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("expired push subscriptions can be reactivated after an active status", async () => {
  let enabled = true;
  let subscription = {};
  let calls = 0;
  const button = { textContent: "ACTIVER", disabled: false };
  const status = {};
  const document = {
    head: { appendChild() {} }, createElement: () => ({}),
    getElementById: (id) => id.endsWith("Status") ? status : button
  };
  const window = {
    CHASSE_CONFIG: {}, PushManager: {}, Notification: {},
    CHASSE_LIVE_CLIENT: { async rpc() { calls++; return { data: enabled }; } }
  };
  const navigator = {
    userAgent: "Test",
    serviceWorker: {
      async register() {},
      ready: Promise.resolve({ pushManager: { async getSubscription() { return subscription; } } })
    }
  };
  const source = read("assets/notifications.js");
  const context = vm.createContext({ window, document, navigator, Notification: { permission: "granted" } });
  vm.runInContext(source.slice(0, source.indexOf('  injectPlayerControl("targetPanel", "target");'))
    + "window.refresh = refreshNotificationStatus;})();", context);

  await window.refresh("target");
  assert.equal(button.disabled, true);
  enabled = false;
  subscription = null;
  await window.refresh("target");
  assert.equal(calls, 2);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "ACTIVER LES NOTIFICATIONS");

  subscription = {};
  await window.refresh("target");
  assert.equal(button.textContent, "RÉACTIVER LES NOTIFICATIONS");
});

function managerHarness() {
  const handlers = {};
  const intervals = [];
  let rows = [];
  let calls = 0;
  let finishRequest;
  let delayRequest = false;
  const list = {
    innerHTML: "", editors: [], focused: false,
    contains() { return this.focused; },
    querySelectorAll(selector) { return selector === ".player-editor" ? this.editors : []; }
  };
  const game = { classList: { contains: () => false } };
  const document = {
    hidden: false, head: { appendChild() {} }, body: { classList: { remove() {} } },
    createElement: () => ({}), querySelectorAll: () => [],
    getElementById: (id) => ({ gameView: game, playerManagerList: list })[id] || null,
    addEventListener(name, callback) { handlers[name] = callback; }
  };
  const client = {
    async rpc(name) {
      assert.equal(name, "organizer_manage_list");
      calls++;
      if (delayRequest) await new Promise((resolve) => { finishRequest = resolve; });
      return { data: rows };
    },
    from() { return { select() { return { eq() { return { async single() { return { data: { status: "scheduled" } }; } }; } }; } }; }
  };
  const window = {
    CHASSE_CONFIG: {}, CHASSE_LIVE_CLIENT: client,
    addEventListener(name, callback) { handlers[name] = callback; }
  };
  const source = read("assets/game-upgrades.js");
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    window.testing = {
      refresh: () => refreshPlayerManager(true),
      setParticipant: (value) => { participant = value; }
    };
  })();`), { window, document, setInterval: (fn, ms) => intervals.push({ fn, ms }) });
  window.testing.setParticipant({ id: "organizer", role: "organizer" });
  return {
    window, document, list, handlers, intervals,
    setRows(value) { rows = value; }, get calls() { return calls; },
    delay() { delayRequest = true; }, finish() { finishRequest(); }
  };
}

test("organizer focus and the 60-second fallback refresh changed player metadata", async () => {
  const h = managerHarness();
  const row = { id: "player", pseudo: "Alice", role: "target", active: true, device_linked: false };
  h.setRows([row]);
  await h.window.testing.refresh();
  assert.match(h.list.innerHTML, /APPAREIL LIBRE/);
  h.setRows([{ ...row, device_linked: true }]);
  h.handlers.focus();
  await new Promise(setImmediate);
  assert.match(h.list.innerHTML, /APPAREIL LIÉ/);
  h.setRows([{ ...row, pseudo: "Bob" }]);
  h.intervals.find((interval) => interval.ms === 60000).fn();
  await new Promise(setImmediate);
  assert.match(h.list.innerHTML, /Bob/);
  const before = h.calls;
  h.document.hidden = true;
  h.handlers.focus();
  await h.window.testing.refresh();
  assert.equal(h.calls, before);
});

test("automatic organizer refresh preserves edits started during the request", async () => {
  const h = managerHarness();
  const row = { id: "player", pseudo: "Alice", role: "target", active: true };
  h.setRows([row]);
  await h.window.testing.refresh();
  const previous = h.list.innerHTML;
  h.delay();
  h.setRows([{ ...row, pseudo: "Remote change" }]);
  const pending = h.window.testing.refresh();
  const fields = { pseudo: { value: "Unfinished edit" }, role: { value: "target" }, active: { checked: true }, code: { value: "" } };
  h.list.editors = [{ dataset: { playerId: "player" }, querySelector: (selector) => fields[selector.match(/data-field="(\w+)"/)?.[1]] }];
  h.finish();
  await pending;
  assert.equal(h.list.innerHTML, previous);
});

test("an organizer response cannot repopulate the manager after logout", async () => {
  const h = managerHarness();
  h.list.innerHTML = "Before request";
  h.delay();
  h.setRows([{ id: "player", pseudo: "Stale result", role: "target", active: true }]);
  const pending = h.window.testing.refresh();
  h.handlers["evasion:logout"]();
  h.finish();
  await pending;
  assert.equal(h.list.innerHTML, "Before request");
});

test("prisoner notification topics fit the Web Push limit for UUID participants", () => {
  const source = read("supabase/functions/push-dispatch/index.ts");
  const prisonerBranch = source.slice(source.indexOf('if (body?.mode === "prisoner")'), source.indexOf('if (body?.mode === "extraction")'));
  const expression = prisonerBranch.match(/topic:\s*([^\n]+),/)[1];
  const topic = vm.runInNewContext(expression, { prisonerId: "12345678-1234-4234-8234-123456789abc" });
  assert.match(topic, /^[A-Za-z0-9_-]{1,32}$/);
  const other = vm.runInNewContext(expression, { prisonerId: "12345678-1234-4234-8234-123456789abd" });
  assert.notEqual(topic, other);
});
