// Tests admin moderation + broadcast. Local admin = demouser (via .dev.vars ADMIN_USER_ID).
const BASE = process.env.BASE || "http://localhost:8788";
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
  return { cookie: cookieFrom(res), user: (await res.json()).user, username: u.username };
}
async function api(path, cookie, opts = {}) {
  const res = await fetch(BASE + path, { method: opts.method || "GET", headers: { "Content-Type": "application/json", Cookie: cookie }, body: opts.body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  const admin = await login("demouser", "secret123");
  assert(admin.status === 200 && admin.body.user && admin.body.user.isAdmin === true, "demouser logs in as admin (isAdmin=true)");
  const A = admin.cookie;
  console.log("Admin logged in (demouser).");

  const victim = await register("Victim");
  const recipient = await register("Recipient");

  console.log("1. Non-admin is blocked from moderation endpoints…");
  const blocked = await api("/api/admin/user/ban", victim.cookie, { method: "POST", body: JSON.stringify({ userId: recipient.user.id, banned: true }) });
  assert(blocked.status === 403, "non-admin ban blocked");
  console.log("   ✓ non-admin blocked (403)");

  console.log("2. Broadcast reaches every user as a 'We Sell Rugs' DM…");
  const bc = await api("/api/admin/broadcast", A, { method: "POST", body: JSON.stringify({ message: "Big rug sale this weekend!" }) });
  assert(bc.status === 200 && bc.data.sent >= 2, "broadcast sent to users, sent=" + bc.data.sent);
  const rConvs = await api("/api/conversations", recipient.cookie);
  const sysDm = rConvs.data.conversations.find((c) => c.title === "We Sell Rugs");
  assert(sysDm && sysDm.lastMessage && sysDm.lastMessage.body === "Big rug sale this weekend!", "recipient got the announcement DM");
  console.log("   ✓ announcement delivered to recipient from 'We Sell Rugs'");

  console.log("3. Ban blocks login; unban restores it…");
  await api("/api/admin/user/ban", A, { method: "POST", body: JSON.stringify({ userId: victim.user.id, banned: true }) });
  const banned = await login(victim.username, "secret123");
  assert(banned.status === 403, "banned user can't log in (got " + banned.status + ")");
  await api("/api/admin/user/ban", A, { method: "POST", body: JSON.stringify({ userId: victim.user.id, banned: false }) });
  const unbanned = await login(victim.username, "secret123");
  assert(unbanned.status === 200, "unbanned user can log in again");
  console.log("   ✓ ban/unban works");

  console.log("4. Reset password gives a working temp password…");
  const rp = await api("/api/admin/user/reset-password", A, { method: "POST", body: JSON.stringify({ userId: victim.user.id }) });
  assert(rp.status === 200 && rp.data.tempPassword, "temp password returned");
  const oldLogin = await login(victim.username, "secret123");
  assert(oldLogin.status === 401, "old password no longer works");
  const newLogin = await login(victim.username, rp.data.tempPassword);
  assert(newLogin.status === 200, "temp password works");
  console.log("   ✓ password reset works (" + rp.data.tempPassword + ")");

  console.log("5. Delete a message…");
  let adminData = await api("/api/admin/data", A);
  const aMsg = adminData.data.messages.find((m) => m.body === "Big rug sale this weekend!");
  assert(aMsg, "found a broadcast message to delete");
  const del = await api("/api/admin/message/delete", A, { method: "POST", body: JSON.stringify({ messageId: aMsg.id }) });
  assert(del.status === 200, "message deleted");
  adminData = await api("/api/admin/data", A);
  assert(!adminData.data.messages.some((m) => m.id === aMsg.id), "message is gone");
  console.log("   ✓ message deleted");

  console.log("6. Delete a user removes them entirely…");
  const throwaway = await register("Throwaway");
  const du = await api("/api/admin/user/delete", A, { method: "POST", body: JSON.stringify({ userId: throwaway.user.id }) });
  assert(du.status === 200, "user deleted");
  const gone = await login(throwaway.username, "secret123");
  assert(gone.status === 401, "deleted user can't log in");
  console.log("   ✓ user deleted");

  console.log("\n✅ ALL MODERATION + BROADCAST CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
