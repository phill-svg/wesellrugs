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

// Curated avatar colours (no pink).
const AVATAR_COLORS = ["#2f80ed", "#0ea5a4", "#10b981", "#f59e0b", "#f97316", "#ef4444", "#6366f1", "#64748b"];
const pickColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

// Deterministic conversation id for a 1:1 DM between two user ids.
function dmConversationId(a, b) {
  return "dm_" + [a, b].sort().join("_");
}

async function ensureDm(db, userA, userB) {
  const convId = dmConversationId(userA, userB);
  const existing = await db.prepare("SELECT id FROM conversations WHERE id = ?").bind(convId).first();
  if (!existing) {
    const now = Date.now();
    await db
      .prepare("INSERT INTO conversations (id, type, created_at) VALUES (?, 'dm', ?)")
      .bind(convId, now)
      .run();
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

// Friendship state between me and other: none | friends | requested (I sent) | incoming (they sent).
async function friendState(db, meId, otherId) {
  const row = await db
    .prepare(
      "SELECT user_a, user_b, status FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)"
    )
    .bind(meId, otherId, otherId, meId)
    .first();
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  return row.user_a === meId ? "requested" : "incoming";
}

async function areFriends(db, a, b) {
  return (await friendState(db, a, b)) === "friends";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/ws") return handleWs(request, env, url);
      if (pathname.startsWith("/api/avatar/") && request.method === "GET") return serveAvatar(request, env, pathname);
      if (pathname.startsWith("/api/")) return handleApi(request, env, url);
    } catch (err) {
      return json({ error: "Server error", detail: String((err && err.message) || err) }, { status: 500 });
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const db = env.DB;
  const { pathname } = url;
  const method = request.method;

  // ---- Register ----
  if (pathname === "/api/register" && method === "POST") {
    const { username, displayName, password } = await request.json().catch(() => ({}));
    const u = (username || "").trim().toLowerCase();
    const name = (displayName || "").trim() || u;
    if (!/^[a-z0-9_]{3,20}$/.test(u))
      return json({ error: "Username must be 3–20 chars: letters, numbers, underscore." }, { status: 400 });
    if (!password || password.length < 6)
      return json({ error: "Password must be at least 6 characters." }, { status: 400 });
    const taken = await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(u).first();
    if (taken) return json({ error: "That username is taken." }, { status: 409 });
    const salt = randomId(16);
    const password_hash = await hashPassword(password, salt);
    const id = randomId(12);
    const color = pickColor();
    await db
      .prepare("INSERT INTO users (id, username, display_name, password_hash, salt, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, u, name, password_hash, salt, color, Date.now())
      .run();
    const token = await createSession(db, id);
    return json(
      { user: { id, username: u, displayName: name, bio: "", avatarColor: color } },
      { headers: { "Set-Cookie": sessionCookie(token) } }
    );
  }

  // ---- Login ----
  if (pathname === "/api/login" && method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    const u = (username || "").trim().toLowerCase();
    const row = await db.prepare("SELECT * FROM users WHERE username = ?").bind(u).first();
    if (!row) return json({ error: "Invalid username or password." }, { status: 401 });
    const attempt = await hashPassword(password || "", row.salt);
    if (!safeEqual(attempt, row.password_hash))
      return json({ error: "Invalid username or password." }, { status: 401 });
    const token = await createSession(db, row.id);
    return json(
      { user: { id: row.id, username: row.username, displayName: row.display_name } },
      { headers: { "Set-Cookie": sessionCookie(token) } }
    );
  }

  // ---- Logout ----
  if (pathname === "/api/logout" && method === "POST") {
    await deleteSession(request, db);
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
  }

  // Everything below requires auth
  const me = await getUser(request, db);
  if (!me) return json({ error: "Not authenticated." }, { status: 401 });

  if (pathname === "/api/me" && method === "GET") return json({ user: me });

  // ---- Update my profile (display name, bio, avatar colour) ----
  if (pathname === "/api/me" && (method === "PATCH" || method === "PUT")) {
    const { displayName, bio, avatarColor } = await request.json().catch(() => ({}));
    const name = (displayName ?? me.displayName).toString().trim().slice(0, 40);
    if (!name) return json({ error: "Display name can't be empty." }, { status: 400 });
    const newBio = (bio ?? me.bio ?? "").toString().slice(0, 200);
    let color = (avatarColor ?? me.avatarColor ?? "").toString();
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) color = me.avatarColor || pickColor();
    await db
      .prepare("UPDATE users SET display_name = ?, bio = ?, avatar_color = ? WHERE id = ?")
      .bind(name, newBio, color, me.id)
      .run();
    return json({ user: { id: me.id, username: me.username, displayName: name, bio: newBio, avatarColor: color } });
  }

  // ---- Change my password ----
  if (pathname === "/api/me/password" && method === "POST") {
    const { currentPassword, newPassword } = await request.json().catch(() => ({}));
    if (!newPassword || newPassword.length < 6)
      return json({ error: "New password must be at least 6 characters." }, { status: 400 });
    const row = await db.prepare("SELECT password_hash, salt FROM users WHERE id = ?").bind(me.id).first();
    const attempt = await hashPassword(currentPassword || "", row.salt);
    if (!safeEqual(attempt, row.password_hash))
      return json({ error: "Current password is incorrect." }, { status: 403 });
    const salt = randomId(16);
    const password_hash = await hashPassword(newPassword, salt);
    await db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").bind(password_hash, salt, me.id).run();
    return json({ ok: true });
  }

  // ---- Upload my profile picture ----
  if (pathname === "/api/me/avatar" && method === "POST") {
    const contentType = request.headers.get("Content-Type") || "";
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(contentType.split(";")[0].trim()))
      return json({ error: "Please upload a JPEG, PNG, WebP or GIF image." }, { status: 400 });
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "Empty image." }, { status: 400 });
    if (buf.byteLength > 3 * 1024 * 1024) return json({ error: "Image is too large (max 3 MB)." }, { status: 413 });
    await env.AVATARS.put("avatars/" + me.id, buf, { httpMetadata: { contentType } });
    const avatarUrl = `/api/avatar/${me.id}?v=${Date.now()}`;
    await db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").bind(avatarUrl, me.id).run();
    return json({ avatarUrl });
  }

  // ---- Remove my profile picture ----
  if (pathname === "/api/me/avatar" && method === "DELETE") {
    await env.AVATARS.delete("avatars/" + me.id);
    await db.prepare("UPDATE users SET avatar_url = NULL WHERE id = ?").bind(me.id).run();
    return json({ ok: true });
  }

  // ---- View another user's public profile ----
  if (pathname === "/api/profile" && method === "GET") {
    const id = url.searchParams.get("id");
    const row = await db.prepare("SELECT id, username, display_name, bio, avatar_color, avatar_url FROM users WHERE id = ?").bind(id).first();
    if (!row) return json({ error: "User not found." }, { status: 404 });
    return json({
      user: { id: row.id, username: row.username, displayName: row.display_name, bio: row.bio || "", avatarColor: row.avatar_color || "", avatarUrl: row.avatar_url || "" },
      friendState: await friendState(db, me.id, row.id),
    });
  }

  // ---- Search users ----
  if (pathname === "/api/users/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 1) return json({ users: [] });
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    const { results } = await db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_color, avatar_url FROM users
         WHERE id != ? AND (lower(username) LIKE ? OR lower(display_name) LIKE ?)
         ORDER BY display_name LIMIT 20`
      )
      .bind(me.id, like, like)
      .all();
    const users = [];
    for (const r of results) {
      users.push({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        bio: r.bio || "",
        avatarColor: r.avatar_color || "",
        avatarUrl: r.avatar_url || "",
        friendState: await friendState(db, me.id, r.id),
      });
    }
    return json({ users });
  }

  // ---- Friend request ----
  if (pathname === "/api/friends/request" && method === "POST") {
    const { toUserId } = await request.json().catch(() => ({}));
    if (!toUserId || toUserId === me.id) return json({ error: "Invalid user." }, { status: 400 });
    const other = await db.prepare("SELECT id FROM users WHERE id = ?").bind(toUserId).first();
    if (!other) return json({ error: "User not found." }, { status: 404 });
    const st = await friendState(db, me.id, toUserId);
    if (st === "friends") return json({ error: "You're already friends." }, { status: 409 });
    if (st === "requested") return json({ state: "requested" });
    if (st === "incoming") {
      // They already requested us — accept it.
      await db
        .prepare("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?")
        .bind(toUserId, me.id)
        .run();
      return json({ state: "friends" });
    }
    await db
      .prepare("INSERT INTO friendships (user_a, user_b, status, created_at) VALUES (?, ?, 'pending', ?)")
      .bind(me.id, toUserId, Date.now())
      .run();
    return json({ state: "requested" });
  }

  // ---- Accept / decline a request ----
  if ((pathname === "/api/friends/accept" || pathname === "/api/friends/decline") && method === "POST") {
    const { fromUserId } = await request.json().catch(() => ({}));
    if (!fromUserId) return json({ error: "Invalid user." }, { status: 400 });
    const pending = await db
      .prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'pending'")
      .bind(fromUserId, me.id)
      .first();
    if (!pending) return json({ error: "No pending request from that user." }, { status: 404 });
    if (pathname.endsWith("accept")) {
      await db
        .prepare("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?")
        .bind(fromUserId, me.id)
        .run();
      return json({ state: "friends" });
    }
    await db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(fromUserId, me.id).run();
    return json({ state: "none" });
  }

  // ---- My friends ----
  if (pathname === "/api/friends" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_color, u.avatar_url FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
         WHERE (f.user_a = ?1 OR f.user_b = ?1) AND f.status = 'accepted'
         ORDER BY u.display_name`
      )
      .bind(me.id)
      .all();
    return json({
      friends: results.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        bio: r.bio || "",
        avatarColor: r.avatar_color || "",
        avatarUrl: r.avatar_url || "",
      })),
    });
  }

  // ---- Incoming friend requests ----
  if (pathname === "/api/friends/requests" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT u.id, u.username, u.display_name FROM friendships f
         JOIN users u ON u.id = f.user_a
         WHERE f.user_b = ? AND f.status = 'pending'
         ORDER BY f.created_at DESC`
      )
      .bind(me.id)
      .all();
    return json({ requests: results.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name })) });
  }

  // ---- Start / get a DM (friends only) ----
  if (pathname === "/api/dm" && method === "POST") {
    const { withUserId } = await request.json().catch(() => ({}));
    if (!withUserId || withUserId === me.id) return json({ error: "Invalid user." }, { status: 400 });
    if (!(await areFriends(db, me.id, withUserId)))
      return json({ error: "You can only message friends. Add them first." }, { status: 403 });
    const convId = await ensureDm(db, me.id, withUserId);
    return json({ conversationId: convId });
  }

  // ---- Create a group chat ----
  if (pathname === "/api/groups" && method === "POST") {
    const { name, memberIds } = await request.json().catch(() => ({}));
    const groupName = (name || "").trim().slice(0, 60);
    if (!groupName) return json({ error: "Give your group a name." }, { status: 400 });
    const ids = Array.isArray(memberIds) ? [...new Set(memberIds.filter((x) => x && x !== me.id))] : [];
    if (ids.length < 1) return json({ error: "Add at least one friend to the group." }, { status: 400 });
    // Only allow adding actual friends.
    for (const id of ids) {
      if (!(await areFriends(db, me.id, id)))
        return json({ error: "You can only add friends to a group." }, { status: 403 });
    }
    const convId = "grp_" + randomId(12);
    const now = Date.now();
    await db
      .prepare("INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)")
      .bind(convId, groupName, me.id, now)
      .run();
    const all = [me.id, ...ids];
    for (const uid of all) {
      await db
        .prepare("INSERT OR IGNORE INTO participants (conversation_id, user_id) VALUES (?, ?)")
        .bind(convId, uid)
        .run();
    }
    return json({ conversationId: convId });
  }

  // ---- My conversations (DMs + groups) ----
  if (pathname === "/api/conversations" && method === "GET") {
    const { results: convs } = await db
      .prepare(
        `SELECT c.id, c.type, c.name, c.created_at, p.last_read_at,
                (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
                (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_at,
                (SELECT u.display_name FROM messages m JOIN users u ON u.id = m.sender_id
                   WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.conversation_id = c.id AND m.created_at > p.last_read_at AND m.sender_id != ?1) AS unread
         FROM participants p JOIN conversations c ON c.id = p.conversation_id
         WHERE p.user_id = ?1
         ORDER BY COALESCE(
           (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
           c.created_at) DESC`
      )
      .bind(me.id)
      .all();

    // Gather participants for all these conversations in one query.
    const { results: parts } = await db
      .prepare(
        `SELECT p.conversation_id, u.id, u.username, u.display_name, u.bio, u.avatar_color, u.avatar_url
         FROM participants p JOIN users u ON u.id = p.user_id
         WHERE p.conversation_id IN (SELECT conversation_id FROM participants WHERE user_id = ?)`
      )
      .bind(me.id)
      .all();
    const membersByConv = {};
    for (const r of parts) {
      (membersByConv[r.conversation_id] ||= []).push({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        bio: r.bio || "",
        avatarColor: r.avatar_color || "",
        avatarUrl: r.avatar_url || "",
      });
    }

    const conversations = convs.map((c) => {
      const members = (membersByConv[c.id] || []).filter((m) => m.id !== me.id);
      const isGroup = c.type === "group";
      return {
        id: c.id,
        type: c.type,
        title: isGroup ? c.name : members[0]?.displayName || "Unknown",
        members,
        other: isGroup ? null : members[0] || null,
        unread: c.unread || 0,
        lastMessage: c.last_body ? { body: c.last_body, createdAt: c.last_at, senderName: c.last_sender } : null,
      };
    });
    return json({ conversations });
  }

  // ---- Mark a conversation as read ----
  if (pathname === "/api/conversations/read" && method === "POST") {
    const { conversationId } = await request.json().catch(() => ({}));
    if (!conversationId || !(await isParticipant(db, conversationId, me.id)))
      return json({ error: "No access to this conversation." }, { status: 403 });
    await db
      .prepare("UPDATE participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?")
      .bind(Date.now(), conversationId, me.id)
      .run();
    return json({ ok: true });
  }

  // ---- Message history ----
  if (pathname === "/api/messages" && method === "GET") {
    const convId = url.searchParams.get("conversation");
    if (!convId || !(await isParticipant(db, convId, me.id)))
      return json({ error: "No access to this conversation." }, { status: 403 });
    const { results } = await db
      .prepare(
        `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? ORDER BY m.created_at ASC LIMIT 300`
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

async function serveAvatar(request, env, pathname) {
  const id = decodeURIComponent(pathname.slice("/api/avatar/".length));
  if (!id) return new Response("Not found", { status: 404 });
  const obj = await env.AVATARS.get("avatars/" + id);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "image/jpeg");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

async function handleWs(request, env, url) {
  const db = env.DB;
  const me = await getUser(request, db);
  if (!me) return new Response("Unauthorized", { status: 401 });
  const convId = url.searchParams.get("conversation");
  if (!convId || !(await isParticipant(db, convId, me.id))) return new Response("Forbidden", { status: 403 });
  const stub = env.CHAT.get(env.CHAT.idFromName(convId));
  const doUrl = new URL(request.url);
  doUrl.pathname = "/ws";
  doUrl.searchParams.set("conversation", convId);
  doUrl.searchParams.set("userId", me.id);
  doUrl.searchParams.set("displayName", me.displayName);
  return stub.fetch(doUrl, request);
}
