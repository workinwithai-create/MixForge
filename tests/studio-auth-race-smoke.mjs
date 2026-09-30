import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../js/app-hub-entitlement.js', import.meta.url), 'utf8');
const resolvers = [];
const anonymousHub = { signedIn:false, hasMix:false, hasBundle:false, reason:'login' };
const anonymousLocal = { entitled:false, reason:'anonymous' };
let call = 0;
const context = vm.createContext({
  console, Promise, Boolean, String, Number, Object, Array, Set, Map, JSON, encodeURIComponent,
  setTimeout, clearTimeout, AbortController,
  fetch: () => new Promise(resolve => {
    const payload = call++ === 0 ? anonymousHub : anonymousLocal;
    resolvers.push(() => resolve({ ok:true, status:200, json:async()=>payload }));
  }),
  localStorage: { value:'', getItem(){return this.value;}, setItem(_k,v){this.value=v;}, removeItem(){this.value='';} },
  location: { hostname:'mixforge.workinwithai.com', origin:'https://mixforge.workinwithai.com', href:'https://mixforge.workinwithai.com/' },
  globalThis: {},
});
context.globalThis = context;
vm.runInContext(source, context);
const hub = context.MixForgeHub;
const refresh = hub.refresh();
hub.applyStudioStatus({
  signedIn:true, entitled:true, product:'bundle', hasMix:true, hasBundle:true,
  reason:'ok', email:'founder@example.test', userId:'studio-user', license:'studio-license'
});
assert.equal(hub.status.signedIn, true);
assert.equal(hub.status.entitled, true);
for (const resolve of resolvers) resolve();
await refresh;
assert.equal(hub.status.signedIn, true, 'late anonymous refresh must not clear Studio identity');
assert.equal(hub.status.entitled, true, 'late anonymous refresh must not clear Studio entitlement');
assert.equal(hub.status.studioSession, true);
assert.equal(hub.requireEntitlement('quickMaster').ok, true);
console.log('studio-auth-race-smoke: ok');
