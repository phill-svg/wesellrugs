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

    if (data.type === "message") {
      const body = typeof data.body === "string" ? data.body.trim().slice(0, 4000) : "";
      let imageUrl = typeof data.imageUrl === "string" ? data.imageUrl : "";
      if (imageUrl && !imageUrl.startsWith("/api/message-image/")) imageUrl = ""; // only allow our own images
      if (!body && !imageUrl) return;
      await this.persistAndBroadcast(meta, body, imageUrl);
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

  async persistAndBroadcast(meta, body, imageUrl) {
    const message = {
      id: randomId(12),
      conversationId: meta.conversationId,
      senderId: meta.userId,
      senderName: meta.displayName,
      body,
      imageUrl: imageUrl || "",
      createdAt: Date.now(),
    };
    await this.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, sender_id, body, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(message.id, message.conversationId, message.senderId, message.body, message.imageUrl || null, message.createdAt)
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
