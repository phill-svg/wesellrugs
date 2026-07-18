// ChatRoom Durable Object — one instance per conversation.
// Uses the WebSocket Hibernation API so connections survive DO hibernation
// (they don't silently drop, and the DO can be evicted without losing sockets).

import { randomId } from "./auth.js";

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
    if (data.type === "message" && typeof data.body === "string") {
      const body = data.body.trim().slice(0, 4000);
      if (!body) return;
      const meta = ws.deserializeAttachment() || {};
      await this.persistAndBroadcast(meta, body);
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code || 1000, "closed"); } catch {}
  }
  async webSocketError() {}

  async persistAndBroadcast(meta, body) {
    const message = {
      id: randomId(12),
      conversationId: meta.conversationId,
      senderId: meta.userId,
      senderName: meta.displayName,
      body,
      createdAt: Date.now(),
    };
    await this.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(message.id, message.conversationId, message.senderId, message.body, message.createdAt)
      .run();

    const payload = JSON.stringify({ type: "message", message });
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(payload); } catch {}
    }
  }
}
