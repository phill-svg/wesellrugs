// We Sell Rugs — messenger client
const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  activeConv: null, // { id, type, title, other, members }
  ws: null,
  renderedIds: new Set(),
  friends: [],
  settingsColor: "",
  notifiedAt: {}, // conversationId -> last message time we've handled
  notifyInit: false,
  baseTitle: "We Sell Rugs",
  typers: {},      // userId -> { name, ts }
  typerTimers: {},
  othersReadAt: 0, // for the open DM: when the other person last read
  lastOutgoingAt: 0,
  msgById: {},
  replyingTo: null,
  conversations: [],
};

const AVATAR_COLORS = ["#2f80ed", "#0ea5a4", "#10b981", "#f59e0b", "#f97316", "#ef4444", "#6366f1", "#64748b"];

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// ---------- helpers ----------
function initials(name) {
  return (name || "?").split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function scrollBottom() {
  const el = $("#messages");
  el.scrollTop = el.scrollHeight;
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function colorFor(u) {
  return (u && u.avatarColor) || AVATAR_COLORS[hashStr((u && (u.username || u.displayName)) || "?") % AVATAR_COLORS.length];
}
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
function dotHtml(u) { return u && u.online ? '<span class="presence-dot" title="Online"></span>' : ""; }
function avatarHtml(u, cls = "") {
  if (u && u.avatarUrl)
    return `<span class="avatar pic ${cls}"><img src="${escapeAttr(u.avatarUrl)}" alt="" loading="lazy">${dotHtml(u)}</span>`;
  return `<span class="avatar ${cls}" style="background:${colorFor(u)}">${initials(u.displayName)}${dotHtml(u)}</span>`;
}
function paintAvatar(el, u) {
  el.classList.remove("group");
  if (u && u.avatarUrl) {
    el.classList.add("pic");
    el.style.background = "transparent";
    el.innerHTML = `<img src="${escapeAttr(u.avatarUrl)}" alt="">${dotHtml(u)}`;
  } else {
    el.classList.remove("pic");
    el.style.background = colorFor(u);
    el.innerHTML = `${escapeHtml(initials(u.displayName))}${dotHtml(u)}`;
  }
}
// Avatar for a conversation row (group photo/icon, or the other person).
function convAvatarHtml(c, cls = "") {
  if (c.type === "group") {
    if (c.avatarUrl) return `<span class="avatar pic ${cls}"><img src="${escapeAttr(c.avatarUrl)}" alt=""></span>`;
    return `<span class="avatar group ${cls}">👥</span>`;
  }
  return avatarHtml(c.other || { displayName: c.title }, cls);
}
function paintConvAvatar(el, conv) {
  el.classList.remove("group", "pic");
  if (conv.type === "group") {
    if (conv.avatarUrl) {
      el.classList.add("pic");
      el.style.background = "transparent";
      el.innerHTML = `<img src="${escapeAttr(conv.avatarUrl)}" alt="">`;
    } else {
      el.classList.add("group");
      el.style.background = "";
      el.textContent = "👥";
    }
  } else {
    paintAvatar(el, conv.other || { displayName: conv.title });
  }
}

// ---------- Auth UI ----------
function showAuthError(msg) { $("#auth-error").textContent = msg || ""; }

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("#login-form").classList.toggle("hidden", which !== "login");
    $("#register-form").classList.toggle("hidden", which !== "register");
    showAuthError("");
  });
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  const f = new FormData(e.target);
  try {
    const { user } = await api("/api/login", { method: "POST", body: JSON.stringify({ username: f.get("username"), password: f.get("password") }) });
    enterApp(user);
  } catch (err) { showAuthError(err.message); }
});

$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  const f = new FormData(e.target);
  try {
    const { user } = await api("/api/register", { method: "POST", body: JSON.stringify({ username: f.get("username"), displayName: f.get("displayName"), password: f.get("password") }) });
    enterApp(user);
  } catch (err) { showAuthError(err.message); }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  if (state.ws) state.ws.close();
  location.reload();
});

// ---------- Enter app ----------
function enterApp(user) {
  state.me = user;
  state.baseTitle = document.title;
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  renderMe();
  updateWelcome();
  refreshAll();
  registerServiceWorker();
  pingPresence();
  setInterval(pingPresence, 30000);
  // Poll for new messages / unread across all conversations, and backfill the open chat.
  const tick = () => { loadConversations(); refreshActiveMessages(); };
  setInterval(tick, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pingPresence(); tick(); } });
  window.addEventListener("focus", () => { pingPresence(); tick(); });
}

function pingPresence() { api("/api/presence", { method: "POST" }).catch(() => {}); }

// ---------- Web Push notifications ----------
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); } catch { return null; }
}
async function refreshNotifState() {
  const btn = $("#enable-notifs-btn");
  if (!btn) return;
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.textContent = "🔔 Notifications not supported here";
    btn.disabled = true;
    return;
  }
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) subscribed = !!(await reg.pushManager.getSubscription());
  } catch {}
  if (Notification.permission === "granted" && subscribed) { btn.textContent = "🔔 Notifications are on"; btn.disabled = true; }
  else if (Notification.permission === "denied") { btn.textContent = "🔕 Notifications blocked in browser settings"; btn.disabled = true; }
  else { btn.textContent = "🔔 Enable notifications"; btn.disabled = false; }
}
async function enablePush() {
  const msg = $("#notif-msg");
  msg.className = "modal-msg";
  msg.textContent = "";
  if (!("Notification" in window) || !("PushManager" in window)) { msg.textContent = "This device doesn't support notifications."; msg.classList.add("err"); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { msg.textContent = "Permission not granted."; msg.classList.add("err"); return; }
    const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
    await navigator.serviceWorker.ready;
    const { publicKey } = await api("/api/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
    msg.textContent = "Notifications enabled ✓";
    msg.classList.add("ok");
    refreshNotifState();
  } catch (err) { msg.textContent = "Couldn't enable: " + err.message; msg.classList.add("err"); }
}

function requestNotifyPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {}
}

function updateTitle(total) {
  document.title = (total > 0 ? `(${total}) ` : "") + state.baseTitle;
}

function fireNotification(c) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const lm = c.lastMessage;
  if (!lm) return;
  const title = c.type === "group" ? c.title : lm.senderName || c.title;
  const body = c.type === "group" ? `${lm.senderName}: ${lm.body}` : lm.body;
  try {
    const n = new Notification(title, { body: String(body).slice(0, 140), tag: c.id, renotify: true });
    n.onclick = () => { window.focus(); openConversation(c); n.close(); };
  } catch {}
}

function processUnread(conversations) {
  let total = 0;
  for (const c of conversations) {
    const isActive = state.activeConv && state.activeConv.id === c.id;
    if (!isActive) total += c.unread || 0;
    const lastAt = c.lastMessage ? c.lastMessage.createdAt : 0;
    const prev = state.notifiedAt[c.id] || 0;
    if (state.notifyInit && lastAt > prev && (c.unread || 0) > 0 && (!isActive || document.hidden)) {
      fireNotification(c);
    }
    if (lastAt > prev) state.notifiedAt[c.id] = lastAt;
  }
  state.notifyInit = true;
  updateTitle(total);
}
function renderMe() {
  $("#me-name").textContent = state.me.displayName;
  paintAvatar($("#me-avatar"), state.me);
}

const WELCOME_TIPS = [
  "Tip: tap ⏱️ in a chat to make messages disappear.",
  "Tip: tap a chat's header to view a profile or edit a group.",
  "Tip: tap 📹 in a chat to start a video call.",
  "Tip: add a profile photo from your settings — tap your name, top-left.",
  "Tip: turn on 🔔 notifications so you never miss a message.",
];
function updateWelcome() {
  if (!state.me) return;
  const first = (state.me.displayName || "there").split(/\s+/)[0];
  $("#welcome-title").textContent = "Hey " + first + " 👋";
  const fcount = state.friends.length;
  const online = state.friends.filter((f) => f.online).length;
  let sub;
  if (!fcount) sub = "You haven't added anyone yet — search for people to get started.";
  else if (online) sub = `${online} of your ${fcount} friend${fcount === 1 ? "" : "s"} ${online === 1 ? "is" : "are"} online right now.`;
  else sub = `You have ${fcount} friend${fcount === 1 ? "" : "s"}. Pick a chat or start a new one.`;
  $("#welcome-sub").textContent = sub;
  $("#welcome-tip").textContent = WELCOME_TIPS[Math.floor(Math.random() * WELCOME_TIPS.length)];
  const recent = (state.conversations || []).slice(0, 4);
  const rc = $("#welcome-recent");
  rc.innerHTML = recent.map((c) => `<span class="recent-tile" data-id="${escapeAttr(c.id)}">${c.type === "group" ? "👥 " : ""}${escapeHtml(c.title)}</span>`).join("");
  rc.querySelectorAll(".recent-tile").forEach((t) =>
    t.addEventListener("click", () => { const c = state.conversations.find((x) => x.id === t.dataset.id); if (c) openConversation(c); })
  );
}
$("#wc-search").addEventListener("click", () => $("#search-input").focus());
$("#wc-group").addEventListener("click", () => $("#new-group-btn").click());
$("#wc-notif").addEventListener("click", openSettings);
$("#wc-profile").addEventListener("click", openSettings);
$("#wc-invite").addEventListener("click", async () => {
  const url = location.origin;
  const shareData = { title: "We Sell Rugs", text: "Chat with me on We Sell Rugs 💬", url };
  if (navigator.share) { try { await navigator.share(shareData); } catch {} }
  else { try { await navigator.clipboard.writeText(url); alert("Invite link copied:\n" + url); } catch { prompt("Share this link:", url); } }
});

async function refreshAll() {
  await Promise.all([loadRequests(), loadFriends(), loadConversations()]);
}

// ---------- Search ----------
let searchTimer = null;
$("#search-input").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) { $("#search-results").classList.add("hidden"); return; }
  searchTimer = setTimeout(() => runSearch(q), 250);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) $("#search-results").classList.add("hidden");
});

async function runSearch(q) {
  let users = [];
  try { ({ users } = await api("/api/users/search?q=" + encodeURIComponent(q))); } catch { return; }
  const list = $("#search-results");
  list.innerHTML = "";
  if (!users.length) list.innerHTML = '<li class="empty-hint">No one found.</li>';
  else for (const u of users) list.appendChild(searchRow(u));
  list.classList.remove("hidden");
}

function searchRow(u) {
  const li = document.createElement("li");
  li.className = "row-item";
  li.innerHTML = avatarHtml(u, "sm") + `<div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div><div class="row-sub">@${escapeHtml(u.username)}</div></div>`;
  li.onclick = () => openProfile(u.id);
  const btn = document.createElement("button");
  btn.type = "button";
  const setState = (s) => {
    btn.disabled = false;
    if (s === "friends") { btn.textContent = "Message"; btn.className = "pill-btn primary"; btn.onclick = (ev) => { ev.stopPropagation(); startDm(u); }; }
    else if (s === "requested") { btn.textContent = "Requested"; btn.className = "pill-btn"; btn.disabled = true; }
    else if (s === "incoming") { btn.textContent = "Accept"; btn.className = "pill-btn primary"; btn.onclick = async (ev) => { ev.stopPropagation(); await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ fromUserId: u.id }) }); setState("friends"); refreshAll(); }; }
    else { btn.textContent = "Add friend"; btn.className = "pill-btn"; btn.onclick = async (ev) => { ev.stopPropagation(); const { state: st } = await api("/api/friends/request", { method: "POST", body: JSON.stringify({ toUserId: u.id }) }); setState(st); refreshAll(); }; }
  };
  setState(u.friendState);
  li.appendChild(btn);
  return li;
}

// ---------- Friend requests ----------
async function loadRequests() {
  let requests = [];
  try { ({ requests } = await api("/api/friends/requests")); } catch { return; }
  const block = $("#requests-block");
  const list = $("#request-list");
  list.innerHTML = "";
  if (!requests.length) { block.classList.add("hidden"); return; }
  block.classList.remove("hidden");
  for (const u of requests) {
    const li = document.createElement("li");
    li.className = "row-item";
    li.innerHTML = avatarHtml(u, "sm") + `<div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div><div class="row-sub">wants to be friends</div></div>`;
    const accept = document.createElement("button");
    accept.className = "pill-btn primary"; accept.type = "button"; accept.textContent = "✓"; accept.title = "Accept";
    accept.onclick = async () => { await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ fromUserId: u.id }) }); refreshAll(); };
    const decline = document.createElement("button");
    decline.className = "pill-btn"; decline.type = "button"; decline.textContent = "✕"; decline.title = "Decline";
    decline.onclick = async () => { await api("/api/friends/decline", { method: "POST", body: JSON.stringify({ fromUserId: u.id }) }); refreshAll(); };
    li.appendChild(accept); li.appendChild(decline);
    list.appendChild(li);
  }
}

// ---------- Friends ----------
async function loadFriends() {
  let friends = [];
  try { ({ friends } = await api("/api/friends")); } catch { return; }
  friends.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.displayName.localeCompare(b.displayName));
  state.friends = friends;
  updateWelcome();
  const onlineCount = friends.filter((f) => f.online).length;
  const title = $("#friends-title");
  if (title) title.textContent = onlineCount ? `Friends · ${onlineCount} online` : "Friends";
  const list = $("#friends-list");
  list.innerHTML = "";
  if (!friends.length) { list.innerHTML = '<li class="empty-hint">No friends yet — search above to add some.</li>'; return; }
  for (const u of friends) {
    const li = document.createElement("li");
    li.className = "row-item";
    const sub = u.online ? '<span class="online-text">Online</span>' : "@" + escapeHtml(u.username);
    li.innerHTML = avatarHtml(u, "sm") + `<div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div><div class="row-sub">${sub}</div></div>`;
    li.onclick = () => startDm(u);
    list.appendChild(li);
  }
}

// ---------- Conversations ----------
async function loadConversations() {
  let conversations = [];
  try { ({ conversations } = await api("/api/conversations")); } catch { return; }
  state.conversations = conversations;
  updateWelcome();
  processUnread(conversations);
  updateActivePresence(conversations);
  const list = $("#conversation-list");
  list.innerHTML = "";
  if (!conversations.length) { list.innerHTML = '<li class="empty-hint">No chats yet.</li>'; return; }
  for (const c of conversations) {
    const li = document.createElement("li");
    li.className = "row-item";
    const isActive = state.activeConv && state.activeConv.id === c.id;
    if (isActive) li.classList.add("active");
    const icon = convAvatarHtml(c, "sm");
    const lm = c.lastMessage;
    const preview = lm ? (lm.body ? escapeHtml(lm.body.slice(0, 38)) : (lm.imageUrl ? "📷 Photo" : "")) : (c.type === "group" ? "New group" : "Say hello 👋");
    const unread = !isActive && c.unread > 0 ? `<span class="badge">${c.unread > 99 ? "99+" : c.unread}</span>` : "";
    li.innerHTML = `${icon}<div class="row-main"><div class="row-name">${escapeHtml(c.title)}</div><div class="row-sub">${preview}</div></div>${unread}`;
    li.onclick = () => openConversation(c);
    list.appendChild(li);
  }
}

async function markRead(convId) {
  try { await api("/api/conversations/read", { method: "POST", body: JSON.stringify({ conversationId: convId }) }); } catch {}
}

async function startDm(friend) {
  const { conversationId } = await api("/api/dm", { method: "POST", body: JSON.stringify({ withUserId: friend.id }) });
  $("#profile-modal").classList.add("hidden");
  openConversation({ id: conversationId, type: "dm", title: friend.displayName, other: friend, members: [friend] });
  $("#search-results").classList.add("hidden");
  $("#search-input").value = "";
  loadConversations();
}

// ---------- Open a conversation ----------
async function openConversation(conv) {
  if (call.pc || call.incomingOffer) endCall(true); // leaving a chat ends any call
  state.activeConv = conv;
  state.renderedIds = new Set();
  state.msgById = {};
  state.typers = {};
  state.typerTimers = {};
  cancelReply();
  renderTyping();
  $("#call-btn").classList.toggle("hidden", conv.type !== "dm");
  $("#chat-empty").classList.add("hidden");
  $("#chat-active").classList.remove("hidden");
  $("#app").classList.add("viewing-chat");
  $("#peer-name").textContent = conv.title;
  const peerAvatar = $("#peer-avatar");
  paintConvAvatar(peerAvatar, conv);
  if (conv.type === "group") {
    const names = (conv.members || []).map((m) => m.displayName);
    $("#peer-status").textContent = `${(conv.members || []).length + 1} members · Tap to edit`;
    $("#peer-status").title = "You, " + names.join(", ");
  } else {
    $("#peer-status").textContent = conv.other ? "@" + conv.other.username + (conv.other.online ? " · online" : "") : "";
  }
  $("#timer-btn").classList.remove("hidden");
  updateDisappearIndicator();
  $("#messages").innerHTML = "";
  state.othersReadAt = 0;
  state.lastOutgoingAt = 0;
  $("#read-receipt").textContent = "";
  const data = await api("/api/messages?conversation=" + encodeURIComponent(conv.id));
  state.othersReadAt = data.othersReadAt || 0;
  for (const m of data.messages) renderMessage(m);
  scrollBottom();
  updateSeen();
  connectWs(conv.id);
  document.querySelectorAll("#conversation-list .row-item").forEach((el) => el.classList.remove("active"));
  await markRead(conv.id);
  state.notifiedAt[conv.id] = Date.now();
  loadConversations();
}

function connectWs(convId) {
  // Drop any previous socket (null it first so its close handler no-ops).
  if (state.ws) { const old = state.ws; state.ws = null; try { old.close(); } catch {} }
  stopHeartbeat();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?conversation=${encodeURIComponent(convId)}`);
  state.ws = ws;

  ws.addEventListener("open", () => { startHeartbeat(); sendRead(); });
  ws.addEventListener("message", (ev) => {
    if (ev.data === "pong") return;
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "typing" && state.activeConv && data.conversationId === state.activeConv.id) {
        showTyping(data.userId, data.displayName);
        return;
      }
      if (data.type === "read" && state.activeConv && data.conversationId === state.activeConv.id && data.userId !== state.me.id) {
        state.othersReadAt = Math.max(state.othersReadAt, data.at || 0);
        updateSeen();
        return;
      }
      if (typeof data.type === "string" && data.type.startsWith("call:")) { handleSignal(data); return; }
      if (data.type === "disappear" && state.activeConv && data.conversationId === state.activeConv.id) {
        state.activeConv.disappearSeconds = data.seconds || 0;
        updateDisappearIndicator();
        return;
      }
      if (data.type === "reaction" && data.messageId) {
        if (state.msgById[data.messageId]) { state.msgById[data.messageId].reactions = data.reactions || {}; renderReactions(data.messageId); }
        return;
      }
      if (data.type === "message" && state.activeConv && data.message.conversationId === state.activeConv.id) {
        renderMessage(data.message);
        scrollBottom();
        if (!document.hidden) { markRead(state.activeConv.id); sendRead(); state.notifiedAt[state.activeConv.id] = data.message.createdAt; }
        loadConversations();
      }
    } catch {}
  });

  const onDown = () => {
    stopHeartbeat();
    if (state.ws !== ws) return; // a newer socket has already replaced this one
    state.ws = null;
    // Reconnect if we're still on this conversation, and backfill anything missed.
    if (state.activeConv && state.activeConv.id === convId) {
      setTimeout(() => {
        if (state.activeConv && state.activeConv.id === convId && !state.ws) {
          refreshActiveMessages();
          connectWs(convId);
        }
      }, 1500);
    }
  };
  ws.addEventListener("close", onDown);
  ws.addEventListener("error", onDown);
}

function startHeartbeat() {
  stopHeartbeat();
  state.hb = setInterval(() => {
    try { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send("ping"); } catch {}
  }, 25000);
}
function stopHeartbeat() { if (state.hb) { clearInterval(state.hb); state.hb = null; } }

// Backstop: re-fetch the open conversation's messages and render anything new.
async function refreshActiveMessages() {
  if (!state.activeConv) return;
  const convId = state.activeConv.id;
  try {
    const data = await api("/api/messages?conversation=" + encodeURIComponent(convId));
    if (!state.activeConv || state.activeConv.id !== convId) return;
    if (typeof data.othersReadAt === "number") state.othersReadAt = Math.max(state.othersReadAt, data.othersReadAt);
    let added = false;
    for (const m of data.messages) { if (!state.renderedIds.has(m.id)) { renderMessage(m); added = true; } }
    if (added) {
      scrollBottom();
      if (!document.hidden) { markRead(convId); sendRead(); }
    }
    updateSeen();
  } catch {}
}

function renderMessage(m) {
  if (state.renderedIds.has(m.id)) return;
  state.renderedIds.add(m.id);
  if (m.expiresAt && m.expiresAt <= Date.now()) return; // already disappeared
  state.msgById[m.id] = m;
  const mine = m.senderId === state.me.id;
  const div = document.createElement("div");
  div.className = "msg " + (mine ? "me" : "them") + (m.imageUrl ? " has-image" : "") + (m.expiresAt ? " ephemeral" : "");
  div.dataset.id = m.id;
  const showName = !mine && state.activeConv && state.activeConv.type === "group";
  const nameLabel = showName ? `<span class="msg-sender">${escapeHtml(m.senderName)}</span>` : "";
  const reply = m.replyTo && m.replySnippet ? `<div class="reply-quote"><b>${escapeHtml(m.replySender || "")}</b>${escapeHtml(m.replySnippet)}</div>` : "";
  const image = m.imageUrl
    ? `<a href="${escapeAttr(m.imageUrl)}" target="_blank" rel="noopener" class="msg-image-link"><img class="msg-image" src="${escapeAttr(m.imageUrl)}" alt="photo" loading="lazy"></a>`
    : "";
  const audio = m.audioUrl ? `<audio controls preload="none" src="${escapeAttr(m.audioUrl)}"></audio>` : "";
  const body = m.body ? `<span class="body">${escapeHtml(m.body)}</span>` : "";
  div.innerHTML = `${nameLabel}${reply}${image}${audio}${body}<span class="time">${fmtTime(m.createdAt)}</span><div class="reactions"></div>`;
  div.addEventListener("click", (e) => { if (e.target.closest("a, audio, .reaction-chip")) return; openMsgMenu(m.id); });
  $("#messages").appendChild(div);
  renderReactions(m.id);
  if (state.typers[m.senderId]) { delete state.typers[m.senderId]; renderTyping(); }
  if (mine) { state.lastOutgoingAt = Math.max(state.lastOutgoingAt, m.createdAt); updateSeen(); }
  if (m.expiresAt) {
    const ms = m.expiresAt - Date.now();
    setTimeout(() => div.remove(), Math.max(0, Math.min(ms, 2147483000)));
  }
}

function renderReactions(id) {
  const m = state.msgById[id];
  const container = document.querySelector(`.msg[data-id="${CSS.escape(id)}"] .reactions`);
  if (!m || !container) return;
  const rx = m.reactions || {};
  const emojis = Object.keys(rx).filter((e) => rx[e] && rx[e].length);
  container.innerHTML = emojis
    .map((e) => {
      const mine = rx[e].includes(state.me.id);
      return `<span class="reaction-chip ${mine ? "mine" : ""}" data-emoji="${escapeAttr(e)}">${e}<span class="reaction-count">${rx[e].length}</span></span>`;
    })
    .join("");
  container.querySelectorAll(".reaction-chip").forEach((chip) =>
    chip.addEventListener("click", (ev) => { ev.stopPropagation(); toggleReaction(id, chip.dataset.emoji); })
  );
}
async function toggleReaction(id, emoji) {
  try {
    const { reactions } = await api("/api/reactions/toggle", { method: "POST", body: JSON.stringify({ messageId: id, emoji }) });
    if (state.msgById[id]) state.msgById[id].reactions = reactions;
    renderReactions(id);
    sendSignal({ type: "reaction", messageId: id, reactions });
  } catch {}
}

// ---------- Message action menu (react / reply) ----------
let menuMsgId = null;
function openMsgMenu(id) { menuMsgId = id; $("#msg-menu").classList.remove("hidden"); }
$("#msg-menu").addEventListener("click", (e) => { if (e.target.id === "msg-menu") $("#msg-menu").classList.add("hidden"); });
document.querySelectorAll(".emoji-btn").forEach((b) =>
  b.addEventListener("click", () => { if (menuMsgId) toggleReaction(menuMsgId, b.dataset.emoji); $("#msg-menu").classList.add("hidden"); })
);
$("#msg-reply-btn").addEventListener("click", () => { if (menuMsgId) startReply(menuMsgId); $("#msg-menu").classList.add("hidden"); });

// ---------- Reply ----------
function startReply(id) {
  const m = state.msgById[id];
  if (!m) return;
  const snippet = m.body ? m.body.slice(0, 90) : m.imageUrl ? "📷 Photo" : m.audioUrl ? "🎤 Voice message" : "";
  const sender = m.senderId === state.me.id ? "yourself" : m.senderName;
  state.replyingTo = { id, sender, snippet };
  $("#reply-banner-sender").textContent = sender;
  $("#reply-banner-snippet").textContent = snippet;
  $("#reply-banner").classList.remove("hidden");
  $("#composer-input").focus();
}
function cancelReply() { state.replyingTo = null; $("#reply-banner").classList.add("hidden"); }
function attachReply(payload) {
  if (state.replyingTo) { payload.replyTo = state.replyingTo.id; payload.replySender = state.replyingTo.sender; payload.replySnippet = state.replyingTo.snippet; }
  return payload;
}
$("#reply-cancel").addEventListener("click", cancelReply);

function sendRead() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify({ type: "read" })); } catch {}
  }
}
function updateSeen() {
  const el = $("#read-receipt");
  if (!el) return;
  const seen = state.activeConv && state.activeConv.type === "dm" && state.lastOutgoingAt > 0 && state.othersReadAt >= state.lastOutgoingAt;
  el.textContent = seen ? "Seen" : "";
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#composer-input");
  const body = input.value.trim();
  if (!body || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(attachReply({ type: "message", body })));
  input.value = "";
  cancelReply();
  input.focus();
});

// ---------- Typing indicator ----------
let lastTypingSent = 0;
$("#composer-input").addEventListener("input", () => {
  const now = Date.now();
  if (state.ws && state.ws.readyState === WebSocket.OPEN && now - lastTypingSent > 2000) {
    lastTypingSent = now;
    try { state.ws.send(JSON.stringify({ type: "typing" })); } catch {}
  }
});
function showTyping(userId, name) {
  if (userId === state.me.id) return;
  state.typers[userId] = { name, ts: Date.now() };
  renderTyping();
  clearTimeout(state.typerTimers[userId]);
  state.typerTimers[userId] = setTimeout(() => { delete state.typers[userId]; renderTyping(); }, 4000);
}
function renderTyping() {
  const el = $("#typing-indicator");
  if (!el) return;
  const names = Object.values(state.typers).map((t) => t.name);
  if (!names.length) { el.textContent = ""; el.classList.remove("show"); return; }
  let text;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = "Several people are typing…";
  el.textContent = text;
  el.classList.add("show");
}

// ---------- Live DM presence in the open header ----------
function updateActivePresence(conversations) {
  if (!state.activeConv || state.activeConv.type !== "dm") return;
  const c = conversations.find((x) => x.id === state.activeConv.id);
  if (!c || !c.other) return;
  state.activeConv.other = c.other;
  $("#peer-status").textContent = "@" + c.other.username + (c.other.online ? " · online" : "");
  paintConvAvatar($("#peer-avatar"), state.activeConv);
}

// ---------- Mobile back button ----------
$("#back-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#app").classList.remove("viewing-chat");
});

// ---------- Send a photo ----------
function resizeImageMax(file, maxDim = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) { const s = Math.min(maxDim / w, maxDim / h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process image."))), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That doesn't look like a valid image.")); };
    img.src = url;
  });
}
$("#attach-btn").addEventListener("click", () => $("#attach-file").click());
$("#attach-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.activeConv || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const input = $("#composer-input");
  const caption = input.value.trim();
  const oldPh = input.placeholder;
  input.placeholder = "Uploading photo…";
  input.disabled = true;
  try {
    const blob = await resizeImageMax(file, 1280);
    const res = await fetch("/api/messages/image?conversation=" + encodeURIComponent(state.activeConv.id), {
      method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    state.ws.send(JSON.stringify(attachReply({ type: "message", body: caption, imageUrl: data.imageUrl })));
    cancelReply();
    input.value = "";
    input.placeholder = oldPh;
  } catch (err) {
    input.placeholder = err.message;
    setTimeout(() => { input.placeholder = oldPh; }, 2500);
  } finally {
    input.disabled = false;
    input.focus();
  }
});

// ---------- View a profile ----------
$("#chat-header").addEventListener("click", () => {
  if (!state.activeConv) return;
  if (state.activeConv.type === "group") openGroupInfo(state.activeConv);
  else if (state.activeConv.other) openProfile(state.activeConv.other.id);
});
$("#profile-close").addEventListener("click", () => $("#profile-modal").classList.add("hidden"));
$("#profile-modal").addEventListener("click", (e) => { if (e.target.id === "profile-modal") $("#profile-modal").classList.add("hidden"); });

async function openProfile(userId) {
  let data;
  try { data = await api("/api/profile?id=" + encodeURIComponent(userId)); } catch { return; }
  const u = data.user;
  paintAvatar($("#profile-avatar"), u);
  $("#profile-name").textContent = u.displayName;
  $("#profile-username").textContent = "@" + u.username;
  const bio = $("#profile-bio");
  bio.textContent = u.bio || "No bio yet.";
  bio.classList.toggle("muted", !u.bio);
  const msgBtn = $("#profile-message");
  if (data.friendState === "friends") {
    msgBtn.classList.remove("hidden");
    msgBtn.onclick = () => startDm(u);
  } else {
    msgBtn.classList.add("hidden");
  }
  $("#search-results").classList.add("hidden");
  $("#profile-modal").classList.remove("hidden");
}

// ---------- Group info / edit ----------
$("#ginfo-close").addEventListener("click", () => $("#groupinfo-modal").classList.add("hidden"));
$("#groupinfo-modal").addEventListener("click", (e) => { if (e.target.id === "groupinfo-modal") $("#groupinfo-modal").classList.add("hidden"); });

function openGroupInfo(conv) {
  state.groupEdit = conv;
  $("#ginfo-name").value = conv.title || "";
  $("#ginfo-desc").value = conv.description || "";
  $("#ginfo-error").textContent = "";
  $("#ginfo-photo-msg").textContent = "";
  $("#ginfo-file").value = "";
  paintConvAvatar($("#ginfo-avatar"), conv);
  $("#ginfo-remove-btn").classList.toggle("hidden", !conv.avatarUrl);
  const list = $("#ginfo-members");
  list.innerHTML = "";
  const you = document.createElement("li");
  you.className = "picker-item";
  you.innerHTML = `<label>${avatarHtml(state.me, "sm")} ${escapeHtml(state.me.displayName)} <span class="row-sub">(you)</span></label>`;
  list.appendChild(you);
  for (const m of conv.members || []) {
    const li = document.createElement("li");
    li.className = "picker-item";
    li.innerHTML = `<label>${avatarHtml(m, "sm")} ${escapeHtml(m.displayName)}</label>`;
    list.appendChild(li);
  }
  $("#groupinfo-modal").classList.remove("hidden");
}

$("#ginfo-save").addEventListener("click", async () => {
  const conv = state.groupEdit;
  if (!conv) return;
  $("#ginfo-error").textContent = "";
  try {
    const { name, description } = await api("/api/group", {
      method: "PATCH",
      body: JSON.stringify({ conversationId: conv.id, name: $("#ginfo-name").value.trim(), description: $("#ginfo-desc").value }),
    });
    conv.title = name;
    conv.description = description;
    if (state.activeConv && state.activeConv.id === conv.id) $("#peer-name").textContent = name;
    $("#groupinfo-modal").classList.add("hidden");
    loadConversations();
  } catch (err) { $("#ginfo-error").textContent = err.message; }
});

$("#ginfo-upload-btn").addEventListener("click", () => $("#ginfo-file").click());
$("#ginfo-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const conv = state.groupEdit;
  if (!file || !conv) return;
  const msg = $("#ginfo-photo-msg");
  msg.className = "modal-msg";
  msg.textContent = "Uploading…";
  try {
    const blob = await resizeImage(file, 256);
    const res = await fetch("/api/group/avatar?conversation=" + encodeURIComponent(conv.id), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    conv.avatarUrl = data.avatarUrl;
    paintConvAvatar($("#ginfo-avatar"), conv);
    if (state.activeConv && state.activeConv.id === conv.id) paintConvAvatar($("#peer-avatar"), conv);
    $("#ginfo-remove-btn").classList.remove("hidden");
    msg.textContent = "Photo updated ✓";
    msg.classList.add("ok");
    loadConversations();
  } catch (err) { msg.textContent = err.message; msg.classList.add("err"); }
});
$("#ginfo-remove-btn").addEventListener("click", async () => {
  const conv = state.groupEdit;
  if (!conv) return;
  const msg = $("#ginfo-photo-msg");
  msg.className = "modal-msg";
  try {
    await api("/api/group/avatar?conversation=" + encodeURIComponent(conv.id), { method: "DELETE" });
    conv.avatarUrl = "";
    paintConvAvatar($("#ginfo-avatar"), conv);
    if (state.activeConv && state.activeConv.id === conv.id) paintConvAvatar($("#peer-avatar"), conv);
    $("#ginfo-remove-btn").classList.add("hidden");
    msg.textContent = "Photo removed.";
    msg.classList.add("ok");
    loadConversations();
  } catch (err) { msg.textContent = err.message; msg.classList.add("err"); }
});

// ---------- Edit my profile (settings) ----------
$("#me-profile-btn").addEventListener("click", openSettings);
$("#enable-notifs-btn").addEventListener("click", enablePush);
$("#settings-cancel").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
$("#settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") $("#settings-modal").classList.add("hidden"); });

function openSettings() {
  $("#settings-name").value = state.me.displayName;
  $("#settings-bio").value = state.me.bio || "";
  $("#settings-error").textContent = "";
  $("#pw-msg").textContent = "";
  $("#pw-current").value = "";
  $("#pw-new").value = "";
  state.settingsColor = state.me.avatarColor || colorFor(state.me);
  $("#avatar-msg").textContent = "";
  $("#avatar-file").value = "";
  $("#avatar-remove-btn").classList.toggle("hidden", !state.me.avatarUrl);
  renderSwatches();
  updateSettingsAvatar();
  $("#notif-msg").textContent = "";
  $("#admin-link").classList.toggle("hidden", !state.me.isAdmin);
  refreshNotifState();
  $("#settings-modal").classList.remove("hidden");
}

// ---- Profile picture upload ----
function resizeImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process image."))), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That doesn't look like a valid image.")); };
    img.src = url;
  });
}

$("#avatar-upload-btn").addEventListener("click", () => $("#avatar-file").click());
$("#avatar-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $("#avatar-msg");
  msg.className = "modal-msg";
  msg.textContent = "Uploading…";
  try {
    const blob = await resizeImage(file, 256);
    const res = await fetch("/api/me/avatar", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    state.me.avatarUrl = data.avatarUrl;
    updateSettingsAvatar();
    renderMe();
    refreshAll();
    $("#avatar-remove-btn").classList.remove("hidden");
    msg.textContent = "Photo updated ✓";
    msg.classList.add("ok");
  } catch (err) { msg.textContent = err.message; msg.classList.add("err"); }
});
$("#avatar-remove-btn").addEventListener("click", async () => {
  const msg = $("#avatar-msg");
  msg.className = "modal-msg";
  try {
    await api("/api/me/avatar", { method: "DELETE" });
    state.me.avatarUrl = "";
    updateSettingsAvatar();
    renderMe();
    refreshAll();
    $("#avatar-remove-btn").classList.add("hidden");
    msg.textContent = "Photo removed.";
    msg.classList.add("ok");
  } catch (err) { msg.textContent = err.message; msg.classList.add("err"); }
});
function renderSwatches() {
  const wrap = $("#settings-colors");
  wrap.innerHTML = "";
  for (const c of AVATAR_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c === state.settingsColor ? " selected" : "");
    b.style.background = c;
    b.onclick = () => { state.settingsColor = c; renderSwatches(); updateSettingsAvatar(); };
    wrap.appendChild(b);
  }
}
function updateSettingsAvatar() {
  paintAvatar($("#settings-avatar"), {
    displayName: $("#settings-name").value || state.me.displayName,
    avatarColor: state.settingsColor,
    avatarUrl: state.me.avatarUrl,
  });
}
$("#settings-name").addEventListener("input", updateSettingsAvatar);

$("#settings-save").addEventListener("click", async () => {
  $("#settings-error").textContent = "";
  try {
    const { user } = await api("/api/me", {
      method: "PATCH",
      body: JSON.stringify({ displayName: $("#settings-name").value.trim(), bio: $("#settings-bio").value, avatarColor: state.settingsColor }),
    });
    state.me = { ...state.me, ...user };
    renderMe();
    $("#settings-modal").classList.add("hidden");
    refreshAll();
  } catch (err) { $("#settings-error").textContent = err.message; }
});

$("#pw-save").addEventListener("click", async () => {
  const msg = $("#pw-msg");
  msg.className = "modal-msg";
  msg.textContent = "";
  try {
    await api("/api/me/password", { method: "POST", body: JSON.stringify({ currentPassword: $("#pw-current").value, newPassword: $("#pw-new").value }) });
    msg.textContent = "Password updated ✓";
    msg.classList.add("ok");
    $("#pw-current").value = "";
    $("#pw-new").value = "";
  } catch (err) { msg.textContent = err.message; msg.classList.add("err"); }
});

// ---------- Group creation ----------
$("#new-group-btn").addEventListener("click", () => {
  $("#group-name").value = "";
  $("#group-error").textContent = "";
  const picker = $("#group-friend-picker");
  picker.innerHTML = "";
  if (!state.friends.length) {
    picker.innerHTML = '<li class="empty-hint">Add some friends first, then you can group them.</li>';
  } else {
    for (const f of state.friends) {
      const li = document.createElement("li");
      li.className = "picker-item";
      li.innerHTML = `<label><input type="checkbox" value="${f.id}" /> ${avatarHtml(f, "sm")} ${escapeHtml(f.displayName)}</label>`;
      picker.appendChild(li);
    }
  }
  $("#group-modal").classList.remove("hidden");
});
$("#group-cancel").addEventListener("click", () => $("#group-modal").classList.add("hidden"));
$("#group-modal").addEventListener("click", (e) => { if (e.target.id === "group-modal") $("#group-modal").classList.add("hidden"); });

$("#group-create").addEventListener("click", async () => {
  const name = $("#group-name").value.trim();
  const memberIds = [...document.querySelectorAll("#group-friend-picker input:checked")].map((c) => c.value);
  $("#group-error").textContent = "";
  if (!name) { $("#group-error").textContent = "Give your group a name."; return; }
  if (!memberIds.length) { $("#group-error").textContent = "Pick at least one friend."; return; }
  try {
    const { conversationId } = await api("/api/groups", { method: "POST", body: JSON.stringify({ name, memberIds }) });
    $("#group-modal").classList.add("hidden");
    await loadConversations();
    const members = state.friends.filter((f) => memberIds.includes(f.id));
    openConversation({ id: conversationId, type: "group", title: name, members });
  } catch (err) { $("#group-error").textContent = err.message; }
});

// ---------- Disappearing messages ----------
const DISAPPEAR_LABELS = { 0: "off", 5: "5s", 10: "10s", 30: "30s", 60: "1m", 3600: "1h", 86400: "1d" };
function disappearLabel(s) { return DISAPPEAR_LABELS[s] || "off"; }
const DISAPPEAR_PHRASE = { 5: "after 5 seconds", 10: "after 10 seconds", 30: "after 30 seconds", 60: "after 1 minute", 3600: "after 1 hour", 86400: "after 1 day" };
function updateDisappearIndicator() {
  const secs = (state.activeConv && state.activeConv.disappearSeconds) || 0;
  const btn = $("#timer-btn");
  btn.classList.toggle("active", secs > 0);
  btn.title = secs > 0 ? "Disappearing: " + disappearLabel(secs) : "Disappearing messages: off";
  const banner = $("#disappear-banner");
  if (banner) {
    if (secs > 0) { banner.textContent = "⏱️ Messages disappear " + (DISAPPEAR_PHRASE[secs] || ""); banner.classList.remove("hidden"); }
    else banner.classList.add("hidden");
  }
}
async function setDisappear(seconds) {
  $("#timer-menu").classList.add("hidden");
  if (!state.activeConv) return;
  try {
    const r = await api("/api/conversation/disappearing", { method: "POST", body: JSON.stringify({ conversationId: state.activeConv.id, seconds }) });
    state.activeConv.disappearSeconds = r.seconds;
    sendSignal({ type: "disappear", seconds: r.seconds });
    updateDisappearIndicator();
  } catch (e) { alert(e.message); }
}
$(".header-actions").addEventListener("click", (e) => e.stopPropagation());
$("#timer-btn").addEventListener("click", () => {
  const secs = (state.activeConv && state.activeConv.disappearSeconds) || 0;
  document.querySelectorAll(".timer-opt").forEach((b) => b.classList.toggle("selected", Number(b.dataset.secs) === secs));
  $("#timer-menu").classList.remove("hidden");
});
$("#timer-menu").addEventListener("click", (e) => {
  if (e.target.id === "timer-menu") { $("#timer-menu").classList.add("hidden"); return; }
  const opt = e.target.closest(".timer-opt");
  if (opt) setDisappear(Number(opt.dataset.secs));
});

// ---------- Video calls (WebRTC) ----------
const call = { pc: null, localStream: null, role: null, peerName: "", pendingIce: [], incomingOffer: null, muted: false, camOff: false };

function sendSignal(obj) { if (state.ws && state.ws.readyState === WebSocket.OPEN) { try { state.ws.send(JSON.stringify(obj)); } catch {} } }

async function getIceServers() {
  try { const { iceServers } = await api("/api/turn-credentials"); return iceServers && iceServers.length ? iceServers : [{ urls: "stun:stun.l.google.com:19302" }]; }
  catch { return [{ urls: "stun:stun.l.google.com:19302" }]; }
}

function createPeer(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: "call:ice", candidate: e.candidate }); };
  pc.ontrack = (e) => { $("#remote-video").srcObject = e.streams[0]; $("#call-info").textContent = "Connected"; };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "failed" || st === "closed") endCall(false);
    else if (st === "disconnected") $("#call-info").textContent = "Reconnecting…";
  };
  return pc;
}

async function getMedia() {
  return await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
}
async function flushIce() {
  for (const c of call.pendingIce) { try { await call.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
  call.pendingIce = [];
}

async function startCall() {
  if (call.pc || call.incomingOffer || !state.activeConv || state.activeConv.type !== "dm") return;
  call.role = "caller";
  call.peerName = state.activeConv.other ? state.activeConv.other.displayName : "…";
  try { call.localStream = await getMedia(); } catch { alert("Camera & microphone access is needed to make a call."); return; }
  const ice = await getIceServers();
  call.pc = createPeer(ice);
  call.localStream.getTracks().forEach((t) => call.pc.addTrack(t, call.localStream));
  showCallUI("Calling " + call.peerName + "…");
  const offer = await call.pc.createOffer();
  await call.pc.setLocalDescription(offer);
  sendSignal({ type: "call:offer", sdp: offer });
}

async function acceptCall() {
  const offer = call.incomingOffer;
  if (!offer) return;
  $("#incoming-call").classList.add("hidden");
  try { call.localStream = await getMedia(); } catch { declineCall(); return; }
  const ice = await getIceServers();
  call.pc = createPeer(ice);
  call.localStream.getTracks().forEach((t) => call.pc.addTrack(t, call.localStream));
  showCallUI("Connecting…");
  await call.pc.setRemoteDescription(new RTCSessionDescription(offer));
  await flushIce();
  const answer = await call.pc.createAnswer();
  await call.pc.setLocalDescription(answer);
  sendSignal({ type: "call:answer", sdp: answer });
  call.incomingOffer = null;
}

function declineCall() {
  sendSignal({ type: "call:decline" });
  $("#incoming-call").classList.add("hidden");
  call.incomingOffer = null;
  call.role = null;
}

async function handleSignal(data) {
  switch (data.type) {
    case "call:offer":
      if (call.pc || call.incomingOffer) { sendSignal({ type: "call:busy" }); return; }
      call.role = "callee";
      call.incomingOffer = data.sdp;
      call.peerName = data.fromName || "Someone";
      showIncoming(data.fromName, data.fromId);
      break;
    case "call:answer":
      if (call.pc) { try { await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); await flushIce(); } catch {} }
      break;
    case "call:ice":
      if (call.pc && call.pc.remoteDescription) { try { await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} }
      else call.pendingIce.push(data.candidate);
      break;
    case "call:decline": $("#call-info").textContent = "Call declined"; setTimeout(() => endCall(false), 1200); break;
    case "call:hangup": endCall(false); break;
    case "call:busy": $("#call-info").textContent = (call.peerName || "They") + " is busy"; setTimeout(() => endCall(false), 1600); break;
  }
}

function showCallUI(status) {
  $("#call-info").textContent = status;
  $("#local-video").srcObject = call.localStream;
  call.muted = false; call.camOff = false;
  $("#call-mute").classList.remove("off");
  $("#call-camera").classList.remove("off");
  $("#call-overlay").classList.remove("hidden");
}
function showIncoming(name, id) {
  const other = state.activeConv && state.activeConv.other && state.activeConv.other.id === id ? state.activeConv.other : { displayName: name };
  paintAvatar($("#incoming-avatar"), other);
  $("#incoming-name").textContent = name || "Someone";
  $("#incoming-call").classList.remove("hidden");
}
function endCall(sendHangup) {
  if (sendHangup) sendSignal({ type: "call:hangup" });
  if (call.pc) { try { call.pc.close(); } catch {} }
  if (call.localStream) call.localStream.getTracks().forEach((t) => t.stop());
  call.pc = null; call.localStream = null; call.role = null; call.incomingOffer = null; call.pendingIce = [];
  $("#remote-video").srcObject = null;
  $("#local-video").srcObject = null;
  $("#call-overlay").classList.add("hidden");
  $("#incoming-call").classList.add("hidden");
}

$("#call-btn").addEventListener("click", startCall);
$("#call-hangup").addEventListener("click", () => endCall(true));
$("#incoming-accept").addEventListener("click", acceptCall);
$("#incoming-decline").addEventListener("click", declineCall);
$("#call-mute").addEventListener("click", () => {
  if (!call.localStream) return;
  call.muted = !call.muted;
  call.localStream.getAudioTracks().forEach((t) => (t.enabled = !call.muted));
  $("#call-mute").classList.toggle("off", call.muted);
});
$("#call-camera").addEventListener("click", () => {
  if (!call.localStream) return;
  call.camOff = !call.camOff;
  call.localStream.getVideoTracks().forEach((t) => (t.enabled = !call.camOff));
  $("#call-camera").classList.toggle("off", call.camOff);
});

// ---------- Voice messages ----------
let mediaRecorder = null, audioChunks = [], recTimer = null;
$("#mic-btn").addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  if (!state.activeConv || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert("Microphone access is needed for voice messages."); return; }
  audioChunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
  try { mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch { alert("Voice recording isn't supported on this device."); stream.getTracks().forEach((t) => t.stop()); return; }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    clearTimeout(recTimer);
    stream.getTracks().forEach((t) => t.stop());
    $("#mic-btn").classList.remove("recording");
    const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
    const blob = new Blob(audioChunks, { type });
    mediaRecorder = null;
    if (!blob.size || !state.activeConv || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      const res = await fetch("/api/messages/audio?conversation=" + encodeURIComponent(state.activeConv.id), { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      state.ws.send(JSON.stringify(attachReply({ type: "message", body: "", audioUrl: data.audioUrl })));
      cancelReply();
    } catch (e) { alert(e.message); }
  };
  mediaRecorder.start();
  $("#mic-btn").classList.add("recording");
  recTimer = setTimeout(() => { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); }, 60000);
});

// ---------- Boot ----------
(async function boot() {
  try {
    const { user } = await api("/api/me");
    enterApp(user);
  } catch {}
})();
