// ChatRoom Durable Object — one instance per conversation.
// Holds live WebSocket connections, persists messages to D1, and broadcasts.

import { randomId } from "./auth.js";

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set(); // { ws, userId, displayName }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const conversationId = url.searchParams.get("conversation");
      const userId = url.searchParams.get("userId");
      const displayName = url.searchParams.get("displayName") || "Someone";

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.accept(server, { conversationId, userId, displayName });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  accept(ws, meta) {
    ws.accept();
    const session = { ws, userId: meta.userId, displayName: meta.displayName, conversationId: meta.conversationId };
    this.sessions.add(session);

    ws.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "message" && typeof data.body === "string") {
          const body = data.body.trim().slice(0, 4000);
          if (!body) return;
          await this.persistAndBroadcast(session, body);
        }
      } catch {
        // ignore malformed frames
      }
    });

    const close = () => this.sessions.delete(session);
    ws.addEventListener("close", close);
    ws.addEventListener("error", close);
  }

  async persistAndBroadcast(session, body) {
    const message = {
      id: randomId(12),
      conversationId: session.conversationId,
      senderId: session.userId,
      senderName: session.displayName,
      body,
      createdAt: Date.now(),
    };

    // Persist to D1
    await this.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(message.id, message.conversationId, message.senderId, message.body, message.createdAt)
      .run();

    const payload = JSON.stringify({ type: "message", message });
    for (const s of this.sessions) {
      try {
        s.ws.send(payload);
      } catch {
        this.sessions.delete(s);
      }
    }
  }
}
