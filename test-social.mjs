// Tests search + friends + groups against a running server.
const BASE = process.env.BASE || "http://localhost:8788";
const WS_BASE = BASE.replace(/^http/, "ws");
const s = Date.now().toString(36);

function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function register(name) {
  const u = { username: name + "_" + s, displayName: name, password: "secret123" };
  const res = await fetch(BASE + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u) });
  if (!res.ok) throw new Error("register " + name + " failed: " + (await res.text()));
  const body = await res.json();
  return { cookie: cookieFrom(res), user: body.user };
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
  console.log("Registering alice, bob, carol…");
  const alice = await register("Alice");
  const bob = await register("Bob");
  const carol = await register("Carol");

  console.log("1. Search: alice searches 'bob'…");
  const { users } = await api("/api/users/search?q=bob", alice.cookie);
  assert(users.some((u) => u.id === bob.user.id), "bob should appear in search");
  assert(users.find((u) => u.id === bob.user.id).friendState === "none", "state should be none");
  console.log("   ✓ found bob (state: none)");

  console.log("2. DM before friending should be blocked…");
  let blocked = false;
  try { await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) }); }
  catch (e) { blocked = /403/.test(e.message); }
  assert(blocked, "DM to non-friend must be blocked");
  console.log("   ✓ blocked (must be friends first)");

  console.log("3. alice → bob friend request; bob accepts…");
  const r1 = await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  assert(r1.state === "requested", "should be requested");
  const inc = await api("/api/friends/requests", bob.cookie);
  assert(inc.requests.some((u) => u.id === alice.user.id), "bob should see incoming request");
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const af = await api("/api/friends", alice.cookie);
  assert(af.friends.some((u) => u.id === bob.user.id), "alice should now have bob as friend");
  console.log("   ✓ alice & bob are friends");

  console.log("4. Now DM works + live delivery…");
  const { conversationId: dm } = await api("/api/dm", alice.cookie, { method: "POST", body: JSON.stringify({ withUserId: bob.user.id }) });
  const wa = openWs(dm, alice.cookie), wb = openWs(dm, bob.cookie);
  const got = [];
  wb.addEventListener("message", (e) => got.push(JSON.parse(e.data)));
  await new Promise((res, rej) => { let n = 0; const ok = () => (++n === 2 && res()); wa.addEventListener("open", ok); wb.addEventListener("open", ok); setTimeout(() => rej(new Error("ws timeout")), 5000); });
  wa.send(JSON.stringify({ type: "message", body: "hi bob" }));
  await wait(500);
  assert(got.some((m) => m.message?.body === "hi bob"), "bob should receive DM live");
  console.log("   ✓ DM live delivery works");
  wa.close(); wb.close();

  console.log("5. Group: alice befriends carol, then makes a group with bob + carol…");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: carol.user.id }) });
  await api("/api/friends/accept", carol.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { conversationId: grp } = await api("/api/groups", alice.cookie, { method: "POST", body: JSON.stringify({ name: "Rug Squad", memberIds: [bob.user.id, carol.user.id] }) });
  assert(grp.startsWith("grp_"), "group id");
  console.log("   groupId:", grp);

  console.log("6. Group live delivery to BOTH other members…");
  const ga = openWs(grp, alice.cookie), gb = openWs(grp, bob.cookie), gc = openWs(grp, carol.cookie);
  const gotB = [], gotC = [];
  gb.addEventListener("message", (e) => gotB.push(JSON.parse(e.data)));
  gc.addEventListener("message", (e) => gotC.push(JSON.parse(e.data)));
  await new Promise((res, rej) => { let n = 0; const ok = () => (++n === 3 && res()); ga.addEventListener("open", ok); gb.addEventListener("open", ok); gc.addEventListener("open", ok); setTimeout(() => rej(new Error("ws timeout")), 5000); });
  ga.send(JSON.stringify({ type: "message", body: "hello squad" }));
  await wait(600);
  assert(gotB.some((m) => m.message?.body === "hello squad"), "bob should get group msg");
  assert(gotC.some((m) => m.message?.body === "hello squad"), "carol should get group msg");
  console.log("   ✓ both bob AND carol received the group message live");
  ga.close(); gb.close(); gc.close();

  console.log("7. Group shows in conversations with name + members…");
  const conv = await api("/api/conversations", bob.cookie);
  const g = conv.conversations.find((c) => c.id === grp);
  assert(g && g.type === "group" && g.title === "Rug Squad", "group listed with name");
  assert(g.members.length === 2, "bob sees 2 other members (alice, carol)");
  console.log("   ✓ group listed correctly for bob (title + members)");

  console.log("8. Non-member cannot read the group…");
  const dave = await register("Dave");
  let denied = false;
  try { await api("/api/messages?conversation=" + encodeURIComponent(grp), dave.cookie); }
  catch (e) { denied = /403/.test(e.message); }
  assert(denied, "non-member blocked");
  console.log("   ✓ outsider blocked from group");

  console.log("\n✅ ALL SOCIAL FEATURE CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
