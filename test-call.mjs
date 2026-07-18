// Tests WebRTC call signalling relay + TURN endpoints.
const BASE = process.env.BASE || "http://localhost:8788";
const WS_BASE = BASE.replace(/^http/, "ws");
const s = Date.now().toString(36);
function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function login(username, password) {
  const res = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  return { status: res.status, cookie: cookieFrom(res), body: await res.json().catch(() => ({})) };
}
async function register(name) {
  const u = { username: name.toLowerCase() + s.slice(-6), displayName: name, password: "secret123" };
  const res = await fetch(BASE + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u) });
  if (!res.ok) throw new Error("register failed: " + (await res.text()));
  return { cookie: cookieFrom(res), user: (await res.json()).user };
}
async function api(path, cookie, opts = {}) {
  const res = await fetch(BASE + path, { method: opts.method || "GET", headers: { "Content-Type": "application/json", Cookie: cookie }, body: opts.body });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function openWs(convId, cookie) { return new WebSocket(`${WS_BASE}/ws?conversation=${encodeURIComponent(convId)}`, { headers: { Cookie: cookie } }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  const alice = await register("Alice");
  const bob = await register("Bob");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { data: dm } = await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) });
  const convId = dm.conversationId;

  console.log("1. ICE servers endpoint returns STUN…");
  const ice = await api("/api/turn-credentials", alice.cookie);
  assert(ice.status === 200 && ice.data.iceServers.some((s) => JSON.stringify(s).includes("stun:")), "STUN present");
  console.log("   ✓ iceServers:", ice.data.iceServers.length, "server(s)");

  console.log("2. Call signalling relays between the two peers…");
  const wa = openWs(convId, alice.cookie), wb = openWs(convId, bob.cookie);
  const bEvents = [], aEvents = [];
  wb.addEventListener("message", (e) => { try { bEvents.push(JSON.parse(e.data)); } catch {} });
  wa.addEventListener("message", (e) => { try { aEvents.push(JSON.parse(e.data)); } catch {} });
  await new Promise((res, rej) => { let n = 0; const ok = () => (++n === 2 && res()); wa.addEventListener("open", ok); wb.addEventListener("open", ok); setTimeout(() => rej(new Error("ws")), 5000); });

  wa.send(JSON.stringify({ type: "call:offer", sdp: { type: "offer", sdp: "FAKE_OFFER" } }));
  await wait(400);
  const offer = bEvents.find((m) => m.type === "call:offer");
  assert(offer && offer.sdp.sdp === "FAKE_OFFER" && offer.fromId === alice.user.id && offer.fromName === "Alice", "bob got the offer with caller identity");
  console.log("   ✓ offer relayed to Bob (from " + offer.fromName + ")");

  wb.send(JSON.stringify({ type: "call:answer", sdp: { type: "answer", sdp: "FAKE_ANSWER" } }));
  await wait(300);
  assert(aEvents.find((m) => m.type === "call:answer" && m.sdp.sdp === "FAKE_ANSWER"), "alice got the answer");
  wa.send(JSON.stringify({ type: "call:ice", candidate: { candidate: "cand1" } }));
  await wait(300);
  assert(bEvents.find((m) => m.type === "call:ice" && m.candidate.candidate === "cand1"), "ice relayed");
  wb.send(JSON.stringify({ type: "call:hangup" }));
  await wait(300);
  assert(aEvents.find((m) => m.type === "call:hangup"), "hangup relayed");
  console.log("   ✓ answer, ICE, and hangup all relayed correctly");
  wa.close(); wb.close();

  console.log("3. TURN relay config (owner only)…");
  const admin = await login("demouser", "secret123");
  assert(admin.body.user && admin.body.user.isAdmin, "admin login");
  const st1 = await api("/api/admin/turn-status", admin.cookie);
  assert(st1.status === 200, "turn-status ok for admin");
  const blocked = await api("/api/admin/turn-status", alice.cookie);
  assert(blocked.status === 403, "non-admin blocked from turn-status");
  console.log("   ✓ turn-status works for owner, blocked for others (configured=" + st1.data.configured + ")");

  console.log("\n✅ ALL CALL SIGNALLING CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
