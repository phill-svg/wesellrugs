// End-to-end test against the running dev server (http://localhost:8788).
// Registers two users, opens a DM, and verifies live WebSocket delivery + persistence.
const BASE = process.env.BASE || "http://localhost:8788";
const WS_BASE = BASE.replace(/^http/, "ws");
const suffix = Date.now().toString(36);
const A = { username: "testa_" + suffix, displayName: "Test A", password: "secret123" };
const B = { username: "testb_" + suffix, displayName: "Test B", password: "secret123" };

function cookieFrom(res) {
  const sc = res.headers.get("set-cookie") || "";
  return sc.split(";")[0]; // wsr_session=...
}

async function register(u) {
  const res = await fetch(BASE + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(u),
  });
  if (!res.ok) throw new Error("register failed: " + res.status + " " + (await res.text()));
  const body = await res.json();
  return { cookie: cookieFrom(res), user: body.user };
}

async function api(path, cookie, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(opts.headers || {}) },
    method: opts.method || "GET",
    body: opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function openWs(convId, cookie) {
  const url = `${WS_BASE}/ws?conversation=${encodeURIComponent(convId)}`;
  return new WebSocket(url, { headers: { Cookie: cookie } });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("1. Registering two users…");
  const a = await register(A);
  const b = await register(B);
  console.log("   A:", a.user.id, "| B:", b.user.id);

  console.log("2. A lists users (should see B)…");
  const { users } = await api("/api/users", a.cookie);
  const foundB = users.find((u) => u.id === b.user.id);
  if (!foundB) throw new Error("A cannot see B in /api/users");
  console.log("   ✓ A sees B");

  console.log("3. A opens a DM with B…");
  const { conversationId } = await api("/api/dm", a.cookie, {
    method: "POST",
    body: JSON.stringify({ withUserId: b.user.id }),
  });
  console.log("   convId:", conversationId);

  console.log("4. Both connect WebSockets…");
  const wsA = openWs(conversationId, a.cookie);
  const wsB = openWs(conversationId, b.cookie);
  const received = [];
  wsB.addEventListener("message", (e) => received.push(JSON.parse(e.data)));
  await new Promise((res, rej) => {
    let open = 0;
    const onOpen = () => { if (++open === 2) res(); };
    wsA.addEventListener("open", onOpen);
    wsB.addEventListener("open", onOpen);
    wsA.addEventListener("error", rej);
    wsB.addEventListener("error", rej);
    setTimeout(() => rej(new Error("WS open timeout")), 5000);
  });
  console.log("   ✓ both sockets open");

  console.log("5. A sends a message; B should receive it live…");
  wsA.send(JSON.stringify({ type: "message", body: "Hello from A 👋" }));
  await wait(600);
  const got = received.find((m) => m.type === "message" && m.message.body === "Hello from A 👋");
  if (!got) throw new Error("B did NOT receive the live message. Received: " + JSON.stringify(received));
  if (got.message.senderId !== a.user.id) throw new Error("wrong senderId");
  console.log("   ✓ B received live message from A");

  console.log("6. Verify persistence via B's history…");
  const { messages } = await api("/api/messages?conversation=" + encodeURIComponent(conversationId), b.cookie);
  if (!messages.some((m) => m.body === "Hello from A 👋")) throw new Error("message not persisted in D1");
  console.log("   ✓ message persisted (history has", messages.length, "message[s])");

  console.log("7. Access control: a third user cannot read the DM…");
  const c = await register({ username: "testc_" + suffix, displayName: "Test C", password: "secret123" });
  let denied = false;
  try {
    await api("/api/messages?conversation=" + encodeURIComponent(conversationId), c.cookie);
  } catch (e) {
    denied = /403/.test(e.message);
  }
  if (!denied) throw new Error("access control FAILED: outsider could read the DM");
  console.log("   ✓ outsider correctly blocked (403)");

  wsA.close();
  wsB.close();
  console.log("\n✅ ALL CHECKS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("\n❌ TEST FAILED:", e.message);
  process.exit(1);
});
