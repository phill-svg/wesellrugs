// Tests web-push endpoints + read receipts.
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
function openWs(convId, cookie) { return new WebSocket(`${WS_BASE}/ws?conversation=${encodeURIComponent(convId)}`, { headers: { Cookie: cookie } }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  const alice = await register("Alice");
  const bob = await register("Bob");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { conversationId: dm } = await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) });

  console.log("1. VAPID public key is generated + returned…");
  const { publicKey } = await api("/api/push/key", alice.cookie);
  assert(publicKey && publicKey.length > 80 && /^[A-Za-z0-9_-]+$/.test(publicKey), "valid base64url VAPID key");
  const { publicKey: publicKey2 } = await api("/api/push/key", bob.cookie);
  assert(publicKey === publicKey2, "same key for all users (stored server-side)");
  console.log("   ✓ VAPID key:", publicKey.slice(0, 24) + "…");

  console.log("2. Save a push subscription…");
  const fakeSub = { endpoint: "https://example.com/push/" + s, keys: { p256dh: "abc", auth: "def" } };
  await api("/api/push/subscribe", alice.cookie, { method: "POST", body: JSON.stringify({ subscription: fakeSub }) });
  console.log("   ✓ subscription saved");

  console.log("3. notify-preview shows the latest unread…");
  const wb = openWs(dm, bob.cookie);
  await new Promise((res, rej) => { wb.addEventListener("open", res); setTimeout(() => rej(new Error("ws")), 5000); });
  wb.send(JSON.stringify({ type: "message", body: "you around?" }));
  await wait(500);
  const preview = await api("/api/notify-preview", alice.cookie);
  assert(preview.count >= 1 && preview.title === "Bob" && preview.body === "you around?", "preview correct: " + JSON.stringify(preview));
  console.log("   ✓ preview:", preview.title + " — " + preview.body, "(count " + preview.count + ")");

  console.log("4. Read receipts: othersReadAt + live 'read' event…");
  const wa = openWs(dm, alice.cookie);
  const aEvents = [];
  wa.addEventListener("message", (e) => { try { aEvents.push(JSON.parse(e.data)); } catch {} });
  await new Promise((res, rej) => { wa.addEventListener("open", res); setTimeout(() => rej(new Error("ws")), 5000); });
  wa.send(JSON.stringify({ type: "message", body: "yes!" }));
  await wait(400);
  // Bob reads it
  await api("/api/conversations/read", bob.cookie, { method: "POST", body: JSON.stringify({ conversationId: dm }) });
  const hist = await api("/api/messages?conversation=" + dm, alice.cookie);
  assert(hist.othersReadAt > 0, "othersReadAt present after bob reads");
  const myMsg = hist.messages.find((m) => m.body === "yes!");
  assert(hist.othersReadAt >= myMsg.createdAt, "bob's read time covers alice's message (Seen)");
  console.log("   ✓ othersReadAt reflects Bob having read the message");

  console.log("5. Live 'read' event reaches the sender…");
  wb.send(JSON.stringify({ type: "read" }));
  await wait(400);
  const readEvt = aEvents.find((m) => m.type === "read" && m.userId === bob.user.id);
  assert(readEvt && readEvt.at > 0, "alice received bob's read event live");
  console.log("   ✓ read event delivered live");

  wa.close(); wb.close();
  console.log("\n✅ ALL PUSH + READ-RECEIPT CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
