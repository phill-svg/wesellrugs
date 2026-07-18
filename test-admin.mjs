// Tests the admin dashboard guard: non-owner is blocked (403).
const BASE = process.env.BASE || "http://localhost:8788";
const s = Date.now().toString(36);
function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function register(name) {
  const u = { username: name.toLowerCase() + s.slice(-6), displayName: name, password: "secret123" };
  const res = await fetch(BASE + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u) });
  if (!res.ok) throw new Error("register failed: " + (await res.text()));
  return { cookie: cookieFrom(res), user: (await res.json()).user };
}
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  console.log("1. A normal user is NOT admin and is blocked from admin data…");
  const rando = await register("Rando");
  assert(rando.user.isAdmin !== true, "new user isAdmin is false");
  const res = await fetch(BASE + "/api/admin/data", { headers: { Cookie: rando.cookie } });
  assert(res.status === 403, "non-admin gets 403, got " + res.status);
  console.log("   ✓ non-owner blocked (403), isAdmin=false");

  console.log("2. Unauthenticated is blocked…");
  const res2 = await fetch(BASE + "/api/admin/data");
  assert(res2.status === 401 || res2.status === 403, "no session blocked");
  console.log("   ✓ unauthenticated blocked");

  console.log("\n✅ ADMIN GUARD CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
