// Tests unread counts + mark-as-read (the data behind notifications).
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  const alice = await register("Alice");
  const bob = await register("Bob");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { conversationId } = await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) });

  console.log("1. Bob sends 2 messages; Alice hasn't opened the chat…");
  const wb = new WebSocket(`${WS_BASE}/ws?conversation=${conversationId}`, { headers: { Cookie: bob.cookie } });
  await new Promise((res, rej) => { wb.addEventListener("open", res); wb.addEventListener("error", rej); setTimeout(() => rej(new Error("ws timeout")), 5000); });
  wb.send(JSON.stringify({ type: "message", body: "yo" }));
  await wait(200);
  wb.send(JSON.stringify({ type: "message", body: "you there?" }));
  await wait(500);

  console.log("2. Alice's conversation list shows unread + sender…");
  let conv = (await api("/api/conversations", alice.cookie)).conversations.find((c) => c.id === conversationId);
  assert(conv.unread === 2, "Alice should have 2 unread, got " + conv.unread);
  assert(conv.lastMessage.senderName === "Bob", "last sender should be Bob");
  assert(conv.lastMessage.body === "you there?", "last body correct");
  console.log("   ✓ unread = 2, last from Bob: \"" + conv.lastMessage.body + "\"");

  console.log("3. Bob's own view shows 0 unread (his own messages)…");
  const bobConv = (await api("/api/conversations", bob.cookie)).conversations.find((c) => c.id === conversationId);
  assert(bobConv.unread === 0, "sender should have 0 unread");
  console.log("   ✓ Bob has 0 unread");

  console.log("4. Alice marks it read → unread clears…");
  await api("/api/conversations/read", alice.cookie, { method: "POST", body: JSON.stringify({ conversationId }) });
  conv = (await api("/api/conversations", alice.cookie)).conversations.find((c) => c.id === conversationId);
  assert(conv.unread === 0, "should be 0 after read, got " + conv.unread);
  console.log("   ✓ unread cleared to 0");

  console.log("5. New message after reading counts again…");
  wb.send(JSON.stringify({ type: "message", body: "still there?" }));
  await wait(500);
  conv = (await api("/api/conversations", alice.cookie)).conversations.find((c) => c.id === conversationId);
  assert(conv.unread === 1, "new message should be unread=1, got " + conv.unread);
  console.log("   ✓ unread = 1 again");
  wb.close();

  console.log("6. Outsider can't mark-read a chat they're not in…");
  const dave = await register("Dave");
  let denied = false;
  try { await api("/api/conversations/read", dave.cookie, { method: "POST", body: JSON.stringify({ conversationId }) }); }
  catch (e) { denied = /403/.test(e.message); }
  assert(denied, "outsider blocked");
  console.log("   ✓ outsider blocked");

  console.log("\n✅ ALL NOTIFICATION-DATA CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
