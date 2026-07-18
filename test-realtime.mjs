// Tests presence (online/offline), typing indicators, and photo messages.
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
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

(async () => {
  const alice = await register("Alice");
  const bob = await register("Bob");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { conversationId: dm } = await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) });

  console.log("1. Presence: fresh user is offline; after a ping, online…");
  let friends = (await api("/api/friends", alice.cookie)).friends;
  assert(friends.find((f) => f.id === bob.user.id).online === false, "bob offline before pinging");
  await api("/api/presence", bob.cookie, { method: "POST" });
  friends = (await api("/api/friends", alice.cookie)).friends;
  assert(friends.find((f) => f.id === bob.user.id).online === true, "bob online after ping");
  console.log("   ✓ offline → online after presence ping");

  console.log("2. Typing: bob's typing reaches alice…");
  const wa = openWs(dm, alice.cookie), wb = openWs(dm, bob.cookie);
  const aliceEvents = [];
  wa.addEventListener("message", (e) => { try { aliceEvents.push(JSON.parse(e.data)); } catch {} });
  await new Promise((res, rej) => { let n = 0; const ok = () => (++n === 2 && res()); wa.addEventListener("open", ok); wb.addEventListener("open", ok); setTimeout(() => rej(new Error("ws timeout")), 5000); });
  wb.send(JSON.stringify({ type: "typing" }));
  await wait(400);
  const typing = aliceEvents.find((m) => m.type === "typing");
  assert(typing && typing.userId === bob.user.id && typing.displayName === "Bob", "alice sees bob typing");
  console.log("   ✓ typing event delivered:", typing.displayName, "is typing");

  console.log("3. Photo message: bob uploads + sends; alice receives image live…");
  let res = await fetch(BASE + "/api/messages/image?conversation=" + dm, { method: "POST", headers: { "Content-Type": "image/png", Cookie: bob.cookie }, body: PNG });
  let data = await res.json();
  assert(res.ok && data.imageUrl && data.imageUrl.startsWith("/api/message-image/"), "image uploaded");
  wb.send(JSON.stringify({ type: "message", body: "check this rug", imageUrl: data.imageUrl }));
  await wait(500);
  const imgMsg = aliceEvents.find((m) => m.type === "message" && m.message.imageUrl);
  assert(imgMsg && imgMsg.message.imageUrl === data.imageUrl && imgMsg.message.body === "check this rug", "alice got image message live");
  console.log("   ✓ image message delivered live (with caption)");

  console.log("4. Image is served + persists in history + preview…");
  res = await fetch(BASE + data.imageUrl);
  assert(res.status === 200 && (res.headers.get("content-type") || "").startsWith("image/"), "image served");
  const hist = (await api("/api/messages?conversation=" + dm, alice.cookie)).messages;
  assert(hist.some((m) => m.imageUrl === data.imageUrl), "history has the image");
  const conv = (await api("/api/conversations", alice.cookie)).conversations.find((c) => c.id === dm);
  assert(conv.lastMessage.imageUrl === data.imageUrl, "conversation last message carries image");
  console.log("   ✓ served, saved in history, shows in chat list");

  console.log("5. Spoofed external image URL is rejected by the server…");
  wb.send(JSON.stringify({ type: "message", body: "", imageUrl: "https://evil.example/x.png" }));
  await wait(400);
  const hist2 = (await api("/api/messages?conversation=" + dm, alice.cookie)).messages;
  assert(!hist2.some((m) => m.imageUrl && m.imageUrl.includes("evil")), "external image URL not stored");
  console.log("   ✓ external image URLs rejected");

  wa.close(); wb.close();
  console.log("\n✅ ALL PRESENCE + TYPING + PHOTO CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
