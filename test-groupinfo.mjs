// Tests group name/description/photo editing + the login-includes-avatar fix.
const BASE = process.env.BASE || "http://localhost:8788";
const s = Date.now().toString(36);
function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function register(name) {
  const u = { username: name.toLowerCase() + s.slice(-6), displayName: name, password: "secret123" };
  const res = await fetch(BASE + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u) });
  if (!res.ok) throw new Error("register failed: " + (await res.text()));
  return { cookie: cookieFrom(res), user: (await res.json()).user, uname: u.username };
}
async function api(path, cookie, opts = {}) {
  const res = await fetch(BASE + path, { method: opts.method || "GET", headers: { "Content-Type": "application/json", Cookie: cookie }, body: opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

(async () => {
  const alice = await register("Alice");
  const bob = await register("Bob");
  const dave = await register("Dave");
  await api("/api/friends/request", alice.cookie, { method: "POST", body: JSON.stringify({ toUserId: bob.user.id }) });
  await api("/api/friends/accept", bob.cookie, { method: "POST", body: JSON.stringify({ fromUserId: alice.user.id }) });
  const { conversationId: grp } = await api("/api/groups", alice.cookie, { method: "POST", body: JSON.stringify({ name: "Rug Squad", memberIds: [bob.user.id] }) });

  console.log("1. Edit group name + description…");
  const upd = await api("/api/group", alice.cookie, { method: "PATCH", body: JSON.stringify({ conversationId: grp, name: "Rug Lovers", description: "For serious rug enthusiasts only." }) });
  assert(upd.name === "Rug Lovers" && upd.description === "For serious rug enthusiasts only.", "name+desc updated");
  const conv = (await api("/api/conversations", bob.cookie)).conversations.find((c) => c.id === grp);
  assert(conv.title === "Rug Lovers" && conv.description === "For serious rug enthusiasts only.", "bob sees new name+desc");
  console.log("   ✓ name + description saved and visible to members");

  console.log("2. Upload a group photo…");
  let res = await fetch(BASE + "/api/group/avatar?conversation=" + grp, { method: "POST", headers: { "Content-Type": "image/png", Cookie: bob.cookie }, body: PNG });
  let data = await res.json();
  assert(res.ok && data.avatarUrl && data.avatarUrl.includes(grp), "group photo uploaded (by a member)");
  console.log("   ✓ uploaded:", data.avatarUrl);

  console.log("3. Group photo is served + shows in conversations…");
  res = await fetch(BASE + data.avatarUrl);
  assert(res.status === 200 && (res.headers.get("content-type") || "").startsWith("image/"), "served as image");
  const conv2 = (await api("/api/conversations", alice.cookie)).conversations.find((c) => c.id === grp);
  assert(conv2.avatarUrl === data.avatarUrl, "conversations shows group avatarUrl");
  console.log("   ✓ served + listed");

  console.log("4. Non-member can't edit or photo the group…");
  let blocked = 0;
  try { await api("/api/group", dave.cookie, { method: "PATCH", body: JSON.stringify({ conversationId: grp, name: "hacked" }) }); } catch (e) { if (/403/.test(e.message)) blocked++; }
  res = await fetch(BASE + "/api/group/avatar?conversation=" + grp, { method: "POST", headers: { "Content-Type": "image/png", Cookie: dave.cookie }, body: PNG });
  if (res.status === 403) blocked++;
  assert(blocked === 2, "non-member blocked from both edit + photo");
  console.log("   ✓ outsider blocked from editing and photo");

  console.log("5. Remove group photo…");
  await api("/api/group/avatar?conversation=" + grp, alice.cookie, { method: "DELETE" });
  const conv3 = (await api("/api/conversations", alice.cookie)).conversations.find((c) => c.id === grp);
  assert(!conv3.avatarUrl, "avatarUrl cleared");
  console.log("   ✓ removed");

  console.log("6. LOGIN now returns the user's photo (the logout bug)…");
  await fetch(BASE + "/api/me/avatar", { method: "POST", headers: { "Content-Type": "image/png", Cookie: alice.cookie }, body: PNG });
  res = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: alice.uname, password: "secret123" }) });
  data = await res.json();
  assert(data.user.avatarUrl && data.user.avatarUrl.includes(alice.user.id), "login response includes avatarUrl");
  console.log("   ✓ login returns avatarUrl:", data.user.avatarUrl);

  console.log("\n✅ ALL GROUP-INFO + LOGIN-FIX CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
