// Tests profile editing, bio, avatar colour, password change, profile view.
const BASE = process.env.BASE || "http://localhost:8788";
const s = Date.now().toString(36);
function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function register(name) {
  const uname = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) + s.slice(-6);
  const u = { username: uname, displayName: name, password: "secret123" };
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
async function loginRaw(username, password) {
  const res = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  return res.status;
}
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  console.log("Register user…");
  const a = await register("Profile Tester");
  assert(a.user.avatarColor && /^#/.test(a.user.avatarColor), "new user gets a default avatar colour");
  console.log("   ✓ default avatar colour:", a.user.avatarColor);

  console.log("1. Edit profile (name, bio, colour)…");
  const upd = await api("/api/me", a.cookie, { method: "PATCH", body: JSON.stringify({ displayName: "Rug Master", bio: "I love a good rug.", avatarColor: "#10b981" }) });
  assert(upd.user.displayName === "Rug Master", "name updated");
  assert(upd.user.bio === "I love a good rug.", "bio updated");
  assert(upd.user.avatarColor === "#10b981", "colour updated");
  const me = await api("/api/me", a.cookie);
  assert(me.user.bio === "I love a good rug.", "bio persisted");
  console.log("   ✓ profile saved and persisted");

  console.log("2. Invalid colour is rejected (kept as previous)…");
  const bad = await api("/api/me", a.cookie, { method: "PATCH", body: JSON.stringify({ avatarColor: "red; drop table" }) });
  assert(bad.user.avatarColor === "#10b981", "invalid colour ignored");
  console.log("   ✓ invalid colour ignored");

  console.log("3. Another user views the profile…");
  const b = await register("Viewer");
  const view = await api("/api/profile?id=" + a.user.id, b.cookie);
  assert(view.user.bio === "I love a good rug.", "viewer sees bio");
  assert(view.friendState === "none", "friendState present");
  console.log("   ✓ profile visible to others with bio + friendState");

  console.log("4. Change password (wrong current rejected)…");
  let rejected = false;
  try { await api("/api/me/password", a.cookie, { method: "POST", body: JSON.stringify({ currentPassword: "wrong", newPassword: "newpass123" }) }); }
  catch (e) { rejected = /403/.test(e.message); }
  assert(rejected, "wrong current password rejected");
  await api("/api/me/password", a.cookie, { method: "POST", body: JSON.stringify({ currentPassword: "secret123", newPassword: "newpass123" }) });
  assert((await loginRaw(a.user.username, "secret123")) === 401, "old password no longer works");
  assert((await loginRaw(a.user.username, "newpass123")) === 200, "new password works");
  console.log("   ✓ password changed correctly");

  console.log("\n✅ ALL PROFILE CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
