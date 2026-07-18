// ChatRoom Durable Object — one instance per conversation.
// Uses the WebSocket Hibernation API so connections survive DO hibernation
// (they don't silently drop, and the DO can be evicted without losing sockets).

import { randomId } from "./auth.js";
import { getVapidKeys, sendPush } from "./push.js";

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Platform answers "ping" with "pong" without waking the DO — keeps
    // connections alive through proxies for free.
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/ws")) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Accept with hibernation; stash this socket's identity on the socket itself.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      conversationId: url.searchParams.get("conversation"),
      userId: url.searchParams.get("userId"),
      displayName: url.searchParams.get("displayName") || "Someone",
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") return; // handled by auto-response, but just in case
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const meta = ws.deserializeAttachment() || {};

    if (data.type === "typing") {
      this.broadcastExcept(ws, JSON.stringify({
        type: "typing",
        conversationId: meta.conversationId,
        userId: meta.userId,
        displayName: meta.displayName,
      }));
      return;
    }

    if (data.type === "read") {
      this.broadcastExcept(ws, JSON.stringify({
        type: "read",
        conversationId: meta.conversationId,
        userId: meta.userId,
        at: Date.now(),
      }));
      return;
    }

    // WebRTC call signalling — relay opaquely to the other participant(s).
    if (typeof data.type === "string" && data.type.startsWith("call:")) {
      this.broadcastExcept(ws, JSON.stringify({ ...data, fromId: meta.userId, fromName: meta.displayName }));
      return;
    }

    // Disappearing-messages timer changed — relay so the other side updates its UI.
    if (data.type === "disappear") {
      this.broadcastExcept(ws, JSON.stringify({ type: "disappear", conversationId: meta.conversationId, seconds: data.seconds | 0 }));
      return;
    }

    // Reaction changed — relay the new aggregated reactions for that message.
    if (data.type === "reaction") {
      this.broadcastExcept(ws, JSON.stringify({ type: "reaction", messageId: data.messageId, reactions: data.reactions }));
      return;
    }

    if (data.type === "message") {
      const body = typeof data.body === "string" ? data.body.trim().slice(0, 4000) : "";
      let imageUrl = typeof data.imageUrl === "string" ? data.imageUrl : "";
      if (imageUrl && !imageUrl.startsWith("/api/message-image/")) imageUrl = "";
      let audioUrl = typeof data.audioUrl === "string" ? data.audioUrl : "";
      if (audioUrl && !audioUrl.startsWith("/api/message-audio/")) audioUrl = "";
      if (!body && !imageUrl && !audioUrl) return;
      const reply = data.replyTo
        ? { replyTo: String(data.replyTo).slice(0, 64), replySender: String(data.replySender || "").slice(0, 60), replySnippet: String(data.replySnippet || "").slice(0, 140) }
        : {};
      await this.persistAndBroadcast(meta, { body, imageUrl, audioUrl, ...reply });
    }
  }

  broadcastExcept(exceptWs, payload) {
    for (const socket of this.state.getWebSockets()) {
      if (socket === exceptWs) continue;
      try { socket.send(payload); } catch {}
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code || 1000, "closed"); } catch {}
  }
  async webSocketError() {}

  async persistAndBroadcast(meta, opts) {
    const { body = "", imageUrl = "", audioUrl = "", replyTo = null, replySender = null, replySnippet = null } = opts;
    const conv = await this.env.DB
      .prepare("SELECT disappear_seconds FROM conversations WHERE id = ?")
      .bind(meta.conversationId)
      .first();
    const secs = conv && conv.disappear_seconds ? conv.disappear_seconds : 0;
    const createdAt = Date.now();
    const expiresAt = secs > 0 ? createdAt + secs * 1000 : null;
    const message = {
      id: randomId(12),
      conversationId: meta.conversationId,
      senderId: meta.userId,
      senderName: meta.displayName,
      body,
      imageUrl: imageUrl || "",
      audioUrl: audioUrl || "",
      replyTo,
      replySender,
      replySnippet,
      reactions: {},
      expiresAt,
      createdAt,
    };
    await this.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, sender_id, body, image_url, audio_url, reply_to, reply_sender, reply_snippet, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(message.id, message.conversationId, message.senderId, message.body, message.imageUrl || null, message.audioUrl || null, replyTo, replySender, replySnippet, expiresAt, createdAt)
      .run();

    const payload = JSON.stringify({ type: "message", message });
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(payload); } catch {}
    }

    // Push to participants who aren't currently in this room.
    try { await this.pushToAbsent(meta); } catch {}
  }

  // Send a web-push "tickle" to conversation members who don't have this room open.
  async pushToAbsent(meta) {
    const present = new Set();
    for (const socket of this.state.getWebSockets()) {
      const a = socket.deserializeAttachment();
      if (a && a.userId) present.add(a.userId);
    }
    const { results: parts } = await this.env.DB
      .prepare("SELECT user_id FROM participants WHERE conversation_id = ? AND user_id != ?")
      .bind(meta.conversationId, meta.userId)
      .all();
    const targets = parts.map((r) => r.user_id).filter((uid) => !present.has(uid));
    if (!targets.length) return;

    const placeholders = targets.map(() => "?").join(",");
    const { results: subs } = await this.env.DB
      .prepare(`SELECT endpoint FROM push_subscriptions WHERE user_id IN (${placeholders})`)
      .bind(...targets)
      .all();
    if (!subs.length) return;

    const vapid = await getVapidKeys(this.env.DB);
    for (const sub of subs) {
      try {
        const status = await sendPush(sub.endpoint, vapid);
        if (status === 404 || status === 410) {
          await this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        }
      } catch {}
    }
  }
}
