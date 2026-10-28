const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const slot = (n, extra = {}) => ({ event_status:'live', slot_id:`slot-${n}`, slot_label:`Ping ${n}`,
  scheduled_at:new Date(Date.now()+30000).toISOString(), all_sent:false, ...extra });

function harness() {
  const elements = new Map();
  const listeners = new Map();
  let timing = slot(7);
  let rpcHandler;
  let geoResolve, geoReject;
  let geoCalls = 0;
  let clicks = 0;
  let sentPings = [];
  const calls = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { textContent:'', innerHTML:'', disabled:false,
        classList:{ add(...names) { names.forEach(n=>classes.add(n)); },
          remove(...names) { names.forEach(n=>classes.delete(n)); },
          contains(n) { return classes.has(n); },
          toggle(n, enabled) { if(enabled) classes.add(n); else classes.delete(n); } },
        click() { clicks++; }, addEventListener() {} });
    }
    return elements.get(id);
  }
  for (const id of ['targetPanel','targetPingList','nextPingText','pingStatusChip','sendPingBtn',
    'pingCountdownBox','pingCountdownMain','pingCountdownSub','geoMessage','activeZoneLabel',
    'gameView','loginView','accessForm','loginError']) element(id);
  const document = { visibilityState:'visible', hidden:false,
    head:{appendChild() {}}, createElement:()=>({}),
    getElementById:id=>elements.get(id)||null,
    querySelector:()=>element('roleGrid'), addEventListener() {} };
  const client = {
    async rpc(name, params) {
      calls.push(name);
      if (rpcHandler) return rpcHandler(name,params);
      assert.equal(name,'my_next_ping_status');
      return {data:[timing]};
    },
    from(table) {
      const response = () => ({data:table==='pings' ? sentPings : table==='events' ? {status:'live'} : table==='ping_slots' ? window.appTesting.state.slots : []});
      return {select() {return this;},eq() {return this;},order() {return Promise.resolve(response());},
        single() {return Promise.resolve(response());}};
    }
  };
  const window = {
    CHASSE_CONFIG:{DEMO_MODE:false,SUPABASE_URL:'https://example.invalid',SUPABASE_ANON_KEY:'test',EVENT_TIMEZONE:'Europe/Paris'},
    CHASSE_LIVE_CLIENT:client, supabase:{createClient:()=>client},
    addEventListener(name, fn) { if(!listeners.has(name)) listeners.set(name,[]); listeners.get(name).push(fn); },
    dispatchEvent(event) { for(const fn of listeners.get(event.type)||[]) fn(event); }
  };
  const context = vm.createContext({ window,document,Date,Intl,Map,Set,Promise,
    CustomEvent:class {constructor(type,options) {this.type=type;this.detail=options?.detail;}},
    navigator:{geolocation:{getCurrentPosition(resolve,reject) {geoCalls++;geoResolve=resolve;geoReject=reject;}}},
    setTimeout() {},clearTimeout() {},setInterval() {} });
  const appSource = read('assets/app.js').replace('  boot();',
    '  window.appTesting = {state, renderTargetPanel, refreshTargetTiming, sendPing, logout};');
  vm.runInContext(appSource,context);
  let runtimeSource = read('assets/runtime-controls.js');
  for (const call of ['preparePseudoField','injectOrganizerControls','injectTargetCountdown','injectHunterCountdown']) {
    runtimeSource=runtimeSource.replace(`  ${call}();`,'');
  }
  runtimeSource=runtimeSource.replace(/\}\)\(\);\s*$/,
    'window.timingTesting={refreshTargetTiming,renderTargetCountdown};})();');
  vm.runInContext(runtimeSource,context);
  const state = window.appTesting.state;
  state.participant={id:'target',role:'target',pseudo:'Cible'};
  state.supabase=client;
  state.slots=Array.from({length:11},(_,i)=>({id:`slot-${i}`,label:`Ping ${i}`,ordinal:i}));
  state.map={setView() {},getZoom:()=>15};
  return {window,state,element,context,calls,
    setTiming(value) {timing=value;},setRpc(fn) {rpcHandler=fn;},
    setPings(value) {sentPings=value;},
    resolveGeo() {geoResolve({coords:{latitude:46.58,longitude:0.34,accuracy:10}});},
    rejectGeo() {geoReject({code:1});},get geoCalls() {return geoCalls;},get clicks() {return clicks;}};
}

test('a missed Ping 0 and earlier slots cannot replace the server-selected Ping 7', async()=>{
  const h=harness();
  h.state.pings=[{participant_id:'target',slot_id:'slot-1'}];
  await h.window.appTesting.refreshTargetTiming();
  assert.equal(h.element('nextPingText').textContent,'Ping 7');
  assert.match(h.element('pingCountdownSub').textContent,/Ping 7/);
  assert.equal(h.element('pingStatusChip').textContent,'1/11 envoyé(s)');
  h.window.appTesting.renderTargetPanel();
  assert.equal(h.element('nextPingText').textContent,'Ping 7');
  h.setTiming(slot(8));
  await h.window.timingTesting.refreshTargetTiming();
  assert.equal(h.element('nextPingText').textContent,'Ping 8');
  assert.match(h.element('pingCountdownSub').textContent,/Ping 8/);
});

test('waiting, finished and RPC errors disable sending in both rendering paths', async()=>{
  const h=harness();
  for (const status of ['scheduled','finished']) {
    h.setTiming(slot(7,{event_status:status}));
    await h.window.appTesting.refreshTargetTiming();
    assert.equal(h.element('sendPingBtn').disabled,true);
    h.window.timingTesting.renderTargetCountdown();
    assert.equal(h.element('sendPingBtn').disabled,true);
  }
  h.setRpc(async()=>({error:{message:'Connexion perdue'}}));
  await h.window.appTesting.refreshTargetTiming();
  assert.equal(h.element('nextPingText').textContent,'État indisponible');
  assert.equal(h.element('pingCountdownSub').textContent,'Connexion perdue');
  assert.equal(h.element('sendPingBtn').disabled,true);
});

test('an expired unsent Ping 0 does not falsely count as eleven sent pings', async()=>{
  const h=harness();
  h.state.pings=h.state.slots.slice(1).map(s=>({participant_id:'target',slot_id:s.id}));
  h.setTiming(slot(10,{all_sent:true,slot_id:null,scheduled_at:null}));
  await h.window.appTesting.refreshTargetTiming();
  assert.equal(h.element('nextPingText').textContent,'Aucun autre ping disponible');
  assert.equal(h.element('pingStatusChip').textContent,'10/11 envoyé(s)');
  assert.equal(h.element('sendPingBtn').disabled,true);
});

test('an older status response cannot overwrite a newer server snapshot', async()=>{
  const h=harness();
  const pending=[];
  h.setRpc(()=>new Promise(resolve=>pending.push(resolve)));
  const first=h.window.appTesting.refreshTargetTiming();
  const second=h.window.appTesting.refreshTargetTiming();
  pending[1]({data:[slot(8)]});await second;
  pending[0]({data:[slot(7)]});await first;
  assert.equal(h.element('nextPingText').textContent,'Ping 8');
  assert.match(h.element('pingCountdownSub').textContent,/Ping 8/);
});

test('a status response received after logout cannot repopulate the player display', async()=>{
  const h=harness();
  let resolve;
  h.setRpc(()=>new Promise(done=>{resolve=done;}));
  const pending=h.window.appTesting.refreshTargetTiming();
  h.window.appTesting.logout();
  h.element('nextPingText').textContent='Logged out';
  resolve({data:[slot(7)]});await pending;
  assert.equal(h.state.targetTiming,null);
  assert.equal(h.element('nextPingText').textContent,'Logged out');
});

test('countdown updates cannot re-enable the send button during GPS acquisition', async()=>{
  const h=harness();
  await h.window.appTesting.refreshTargetTiming();
  const sending=h.window.appTesting.sendPing();
  assert.equal(h.geoCalls,1);
  await h.window.appTesting.refreshTargetTiming();
  h.window.timingTesting.renderTargetCountdown();
  assert.equal(h.element('sendPingBtn').disabled,true);
  await h.window.appTesting.sendPing();
  assert.equal(h.geoCalls,1);
  h.setTiming(slot(7,{event_status:'finished'}));
  await h.window.appTesting.refreshTargetTiming();
  h.rejectGeo();await sending;
  assert.equal(h.element('sendPingBtn').disabled,true);
});

test('a successful send refreshes the label and countdown immediately to the next slot', async()=>{
  const h=harness();
  h.state.pings=h.state.slots.slice(1,7).map(s=>({participant_id:'target',slot_id:s.id}));
  await h.window.appTesting.refreshTargetTiming();
  let current=slot(7);
  h.setRpc(async(name)=>{
    if(name==='submit_ping') {
      current=slot(8);
      h.setPings([...h.state.pings,{participant_id:'target',slot_id:'slot-7'}]);
      return {data:[{sent_at:new Date().toISOString(),valid_window:true}]};
    }
    assert.equal(name,'my_next_ping_status');
    return {data:[current]};
  });
  const sending=h.window.appTesting.sendPing();
  h.resolveGeo();await sending;
  assert.equal(h.element('nextPingText').textContent,'Ping 8');
  assert.match(h.element('pingCountdownSub').textContent,/Ping 8/);
  assert.equal(h.element('pingStatusChip').textContent,'7/11 envoyé(s)');
  assert.equal(h.element('sendPingBtn').disabled,false);
});

test('the automatic sender refreshes the same server snapshot as the displayed label', async()=>{
  const h=harness();
  h.setTiming(slot(7,{scheduled_at:new Date(Date.now()-1000).toISOString()}));
  vm.runInContext(read('assets/auto-ping-visible.js').replace(/\}\)\(\);\s*$/,
    'window.checkAutomatic=maybeSendAutomaticPing;})();'),h.context);
  await h.window.checkAutomatic();
  assert.equal(h.element('nextPingText').textContent,'Ping 7');
  assert.match(h.element('pingCountdownSub').textContent,/Ping 7/);
  assert.equal(h.clicks,1);
});

test('the demo retains its local slot selection without contacting Supabase',()=>{
  const h=harness();
  h.window.CHASSE_CONFIG.DEMO_MODE=true;
  h.state.pings=[{participant_id:'target',slot_id:'slot-0'}];
  h.window.appTesting.renderTargetPanel();
  assert.equal(h.element('nextPingText').textContent,'Ping 1');
  assert.equal(h.calls.length,0);
});
