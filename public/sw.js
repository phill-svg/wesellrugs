// Service worker for Web Push notifications.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A push arrives (payload-less) — fetch the latest unread info and show it.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "We Sell Rugs";
      let body = "You have a new message";
      try {
        const res = await fetch("/api/notify-preview", { credentials: "include" });
        if (res.ok) {
          const d = await res.json();
          if (d && d.count > 0) {
            title = d.title || title;
            body = d.body || body;
          } else if (d && d.count === 0) {
            return; // nothing unread (already read on another device)
          }
        }
      } catch {}
      await self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "wsr-message",
        renotify: true,
        data: { url: "/" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsArr) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })()
  );
});
