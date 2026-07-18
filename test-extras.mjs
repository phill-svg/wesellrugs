// Tests reactions, replies, and voice messages.
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
const OGG = Buffer.from("T2dnUwACAAAAAAAAAAA=", "base64"); // tiny fake audio blob

(async () => {
  const alice = await register("Alice");
  const bob = await register("Bob");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { data: dm } = await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) });
  const convId = dm.conversationId;
  const wa = openWs(convId, alice.cookie);
  await new Promise((res, rej) => { wa.addEventListener("open", res); setTimeout(() => rej(new Error("ws")), 5000); });

  console.log("1. Reactions: react, aggregate, and toggle off…");
  wa.send(JSON.stringify({ type: "message", body: "react to me" }));
  await wait(500);
  let hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  const msgId = hist.data.messages.find((m) => m.body === "react to me").id;
  const r1 = await api("/api/reactions/toggle", bob.cookie, { method: "POST", body: JSON.stringify({ messageId: msgId, emoji: "❤️" }) });
  assert(r1.data.reactions["❤️"] && r1.data.reactions["❤️"].includes(bob.user.id), "bob's ❤️ recorded");
  hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  assert(hist.data.messages.find((m) => m.id === msgId).reactions["❤️"].length === 1, "reaction shows in history");
  const r2 = await api("/api/reactions/toggle", bob.cookie, { method: "POST", body: JSON.stringify({ messageId: msgId, emoji: "❤️" }) });
  assert(!r2.data.reactions["❤️"], "toggling again removes it");
  console.log("   ✓ react / aggregate / un-react all work");

  console.log("2. Reply: message carries the quoted snippet…");
  wa.send(JSON.stringify({ type: "message", body: "this is a reply", replyTo: msgId, replySender: "Alice", replySnippet: "react to me" }));
  await wait(500);
  hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  const reply = hist.data.messages.find((m) => m.body === "this is a reply");
  assert(reply.replyTo === msgId && reply.replySnippet === "react to me" && reply.replySender === "Alice", "reply fields stored");
  console.log("   ✓ reply quote stored + returned");

  console.log("3. Voice: upload + serve + send as a message…");
  let res = await fetch(BASE + "/api/messages/audio?conversation=" + convId, { method: "POST", headers: { "Content-Type": "audio/webm", Cookie: alice.cookie }, body: OGG });
  let data = await res.json();
  assert(res.ok && data.audioUrl && data.audioUrl.startsWith("/api/message-audio/"), "audio uploaded");
  res = await fetch(BASE + data.audioUrl);
  assert(res.status === 200 && (res.headers.get("content-type") || "").startsWith("audio/"), "audio served with audio content-type");
  wa.send(JSON.stringify({ type: "message", body: "", audioUrl: data.audioUrl }));
  await wait(500);
  hist = await api("/api/messages?conversation=" + convId, alice.cookie);
  assert(hist.data.messages.some((m) => m.audioUrl === data.audioUrl), "voice message in history");
  console.log("   ✓ voice message uploaded, served, and delivered");

  console.log("4. Reaction access control (outsider blocked)…");
  const dave = await register("Dave");
  const blocked = await api("/api/reactions/toggle", dave.cookie, { method: "POST", body: JSON.stringify({ messageId: msgId, emoji: "👍" }) });
  assert(blocked.status === 403, "outsider can't react");
  console.log("   ✓ outsider blocked from reacting");

  wa.close();
  console.log("\n✅ ALL REACTION + REPLY + VOICE CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
