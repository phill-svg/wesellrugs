// Main Worker: REST API + WebSocket routing for the messenger.
import {
  randomId,
  hashPassword,
  safeEqual,
  createSession,
  sessionCookie,
  clearCookie,
  getUser,
  deleteSession,
} from "./auth.js";

export { ChatRoom } from "./chat-room.js";

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

// Deterministic conversation id for a 1:1 DM between two user ids.
function dmConversationId(a, b) {
  return "dm_" + [a, b].sort().join("_");
}

async function ensureDm(db, userA, userB) {
  const convId = dmConversationId(userA, userB);
  const existing = await db.prepare("SELECT id FROM conversations WHERE id = ?").bind(convId).first();
  if (!existing) {
    const now = Date.now();
    await db.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)").bind(convId, now).run();
    await db
      .prepare("INSERT OR IGNORE INTO participants (conversation_id, user_id) VALUES (?, ?), (?, ?)")
      .bind(convId, userA, convId, userB)
      .run();
  }
  return convId;
}

async function isParticipant(db, convId, userId) {
  const row = await db
    .prepare("SELECT 1 FROM participants WHERE conversation_id = ? AND user_id = ?")
    .bind(convId, userId)
    .first();
  return !!row;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---- WebSocket ----
      if (pathname === "/ws") {
        return handleWs(request, env, url);
      }

      // ---- API ----
      if (pathname.startsWith("/api/")) {
        return handleApi(request, env, url);
      }
    } catch (err) {
      return json({ error: "Server error", detail: String(err && err.message || err) }, { status: 500 });
    }

    // ---- Static assets (index.html, styles.css, app.js) ----
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const db = env.DB;
  const { pathname } = url;
  const method = request.method;

  // --- Register ---
  if (pathname === "/api/register" && method === "POST") {
    const { username, displayName, password } = await request.json().catch(() => ({}));
    const u = (username || "").trim().toLowerCase();
    const name = (displayName || "").trim() || u;
    if (!/^[a-z0-9_]{3,20}$/.test(u)) {
      return json({ error: "Username must be 3–20 chars: letters, numbers, underscore." }, { status: 400 });
    }
    if (!password || password.length < 6) {
      return json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }
    const taken = await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(u).first();
    if (taken) return json({ error: "That username is taken." }, { status: 409 });

    const salt = randomId(16);
    const password_hash = await hashPassword(password, salt);
    const id = randomId(12);
    await db
      .prepare(
        "INSERT INTO users (id, username, display_name, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(id, u, name, password_hash, salt, Date.now())
      .run();

    const token = await createSession(db, id);
    return json(
      { user: { id, username: u, displayName: name } },
      { headers: { "Set-Cookie": sessionCookie(token) } }
    );
  }

  // --- Login ---
  if (pathname === "/api/login" && method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    const u = (username || "").trim().toLowerCase();
    const row = await db.prepare("SELECT * FROM users WHERE username = ?").bind(u).first();
    if (!row) return json({ error: "Invalid username or password." }, { status: 401 });
    const attempt = await hashPassword(password || "", row.salt);
    if (!safeEqual(attempt, row.password_hash)) {
      return json({ error: "Invalid username or password." }, { status: 401 });
    }
    const token = await createSession(db, row.id);
    return json(
      { user: { id: row.id, username: row.username, displayName: row.display_name } },
      { headers: { "Set-Cookie": sessionCookie(token) } }
    );
  }

  // --- Logout ---
  if (pathname === "/api/logout" && method === "POST") {
    await deleteSession(request, db);
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
  }

  // Everything below requires auth
  const me = await getUser(request, db);
  if (!me) return json({ error: "Not authenticated." }, { status: 401 });

  // --- Current user ---
  if (pathname === "/api/me" && method === "GET") {
    return json({ user: me });
  }

  // --- All other users (to start a DM) ---
  if (pathname === "/api/users" && method === "GET") {
    const { results } = await db
      .prepare("SELECT id, username, display_name FROM users WHERE id != ? ORDER BY display_name")
      .bind(me.id)
      .all();
    return json({
      users: results.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name })),
    });
  }

  // --- My conversations with last message + other participant ---
  if (pathname === "/api/conversations" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT c.id AS conv_id,
                other.id AS other_id, other.username AS other_username, other.display_name AS other_name,
                m.body AS last_body, m.created_at AS last_at
         FROM participants p
         JOIN conversations c ON c.id = p.conversation_id
         JOIN participants op ON op.conversation_id = c.id AND op.user_id != ?
         JOIN users other ON other.id = op.user_id
         LEFT JOIN messages m ON m.id = (
            SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
         )
         WHERE p.user_id = ?
         ORDER BY COALESCE(m.created_at, c.rowid) DESC`
      )
      .bind(me.id, me.id)
      .all();
    return json({
      conversations: results.map((r) => ({
        id: r.conv_id,
        other: { id: r.other_id, username: r.other_username, displayName: r.other_name },
        lastMessage: r.last_body ? { body: r.last_body, createdAt: r.last_at } : null,
      })),
    });
  }

  // --- Start / get a DM conversation ---
  if (pathname === "/api/dm" && method === "POST") {
    const { withUserId } = await request.json().catch(() => ({}));
    if (!withUserId || withUserId === me.id) return json({ error: "Invalid user." }, { status: 400 });
    const other = await db.prepare("SELECT id FROM users WHERE id = ?").bind(withUserId).first();
    if (!other) return json({ error: "User not found." }, { status: 404 });
    const convId = await ensureDm(db, me.id, withUserId);
    return json({ conversationId: convId });
  }

  // --- Message history ---
  if (pathname === "/api/messages" && method === "GET") {
    const convId = url.searchParams.get("conversation");
    if (!convId || !(await isParticipant(db, convId, me.id))) {
      return json({ error: "No access to this conversation." }, { status: 403 });
    }
    const { results } = await db
      .prepare(
        `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? ORDER BY m.created_at ASC LIMIT 200`
      )
      .bind(convId)
      .all();
    return json({
      messages: results.map((r) => ({
        id: r.id,
        senderId: r.sender_id,
        senderName: r.sender_name,
        body: r.body,
        createdAt: r.created_at,
      })),
    });
  }

  return json({ error: "Not found." }, { status: 404 });
}

async function handleWs(request, env, url) {
  const db = env.DB;
  const me = await getUser(request, db);
  if (!me) return new Response("Unauthorized", { status: 401 });

  const convId = url.searchParams.get("conversation");
  if (!convId || !(await isParticipant(db, convId, me.id))) {
    return new Response("Forbidden", { status: 403 });
  }

  // Route to the Durable Object for this conversation.
  const id = env.CHAT.idFromName(convId);
  const stub = env.CHAT.get(id);
  const doUrl = new URL(request.url);
  doUrl.pathname = "/ws";
  doUrl.searchParams.set("conversation", convId);
  doUrl.searchParams.set("userId", me.id);
  doUrl.searchParams.set("displayName", me.displayName);
  return stub.fetch(doUrl, request);
}
