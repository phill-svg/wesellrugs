// Tests disappearing messages.
const BASE = process.env.BASE || "http://localhost:8788";
const WS_BASE = BASE.replace(/^http/, "ws");
const s = Date.now().toString(36);
function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
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

  console.log("1. Set disappearing to 5s…");
  const set = await api("/api/conversation/disappearing", alice.cookie, { method: "POST", body: JSON.stringify({ conversationId: convId, seconds: 5 }) });
  assert(set.data.seconds === 5, "timer set to 5s");
  const convs = await api("/api/conversations", bob.cookie);
  assert(convs.data.conversations.find((c) => c.id === convId).disappearSeconds === 5, "both sides see the 5s timer");
  console.log("   ✓ timer set to 5s and visible to both");

  console.log("2. A sent message gets an expiry ~5s out…");
  const wa = openWs(convId, alice.cookie);
  await new Promise((res, rej) => { wa.addEventListener("open", res); setTimeout(() => rej(new Error("ws")), 5000); });
  wa.send(JSON.stringify({ type: "message", body: "vanish me" }));
  await wait(600);
  let hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  const msg = hist.data.messages.find((m) => m.body === "vanish me");
  assert(msg && msg.expiresAt > Date.now() && msg.expiresAt <= Date.now() + 6000, "message has ~5s expiry");
  console.log("   ✓ message present with expiry");

  console.log("3. After the timer, the message is gone (purged)…");
  await wait(5200);
  hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  assert(!hist.data.messages.some((m) => m.body === "vanish me"), "message disappeared from history");
  console.log("   ✓ message auto-deleted after 5s");

  console.log("4. Turn off → new messages persist…");
  await api("/api/conversation/disappearing", alice.cookie, { method: "POST", body: JSON.stringify({ conversationId: convId, seconds: 0 }) });
  wa.send(JSON.stringify({ type: "message", body: "i stay" }));
  await wait(600);
  hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  const stay = hist.data.messages.find((m) => m.body === "i stay");
  assert(stay && (!stay.expiresAt || stay.expiresAt === 0), "message with timer off has no expiry");
  console.log("   ✓ with timer off, messages stay");

  console.log("5. Invalid duration is rejected/clamped to off…");
  const bad = await api("/api/conversation/disappearing", alice.cookie, { method: "POST", body: JSON.stringify({ conversationId: convId, seconds: 999 }) });
  assert(bad.data.seconds === 0, "invalid seconds clamped to 0");
  console.log("   ✓ invalid duration clamped");

  wa.close();
  console.log("\n✅ ALL DISAPPEARING-MESSAGE CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
