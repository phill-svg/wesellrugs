// Tests profile picture upload / serve / delete via R2.
const BASE = process.env.BASE || "http://localhost:8788";
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
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

(async () => {
  const a = await register("Pic");
  assert(!a.user.avatarUrl, "new user has no picture");
  console.log("1. Upload a PNG…");
  let res = await fetch(BASE + "/api/me/avatar", { method: "POST", headers: { "Content-Type": "image/png", Cookie: a.cookie }, body: PNG });
  let data = await res.json();
  assert(res.ok && data.avatarUrl && data.avatarUrl.includes(a.user.id), "upload returns avatarUrl");
  console.log("   ✓ uploaded:", data.avatarUrl);
  const avatarUrl = data.avatarUrl;

  console.log("2. Picture is served from that URL…");
  res = await fetch(BASE + avatarUrl);
  assert(res.status === 200, "avatar GET 200");
  assert((res.headers.get("content-type") || "").startsWith("image/"), "served as image");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert(bytes.length === PNG.length, "served bytes match uploaded (" + bytes.length + ")");
  console.log("   ✓ served", bytes.length, "bytes as", res.headers.get("content-type"));

  console.log("3. /api/me reflects the picture…");
  const me = await api("/api/me", a.cookie);
  assert(me.user.avatarUrl === avatarUrl, "me has avatarUrl");
  console.log("   ✓ profile has the picture");

  console.log("4. Reject non-image uploads…");
  res = await fetch(BASE + "/api/me/avatar", { method: "POST", headers: { "Content-Type": "text/plain", Cookie: a.cookie }, body: "hello" });
  assert(res.status === 400, "non-image rejected (got " + res.status + ")");
  console.log("   ✓ non-image rejected");

  console.log("5. Remove the picture…");
  await api("/api/me/avatar", a.cookie, { method: "DELETE" });
  const me2 = await api("/api/me", a.cookie);
  assert(!me2.user.avatarUrl, "avatarUrl cleared");
  res = await fetch(BASE + avatarUrl);
  assert(res.status === 404, "avatar 404 after delete (got " + res.status + ")");
  console.log("   ✓ removed and no longer served (404)");

  console.log("\n✅ ALL AVATAR CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
