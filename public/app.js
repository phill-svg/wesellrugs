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
  refreshAll();
  requestNotifyPermission();
  pingPresence();
  setInterval(pingPresence, 30000);
  // Poll for new messages / unread across all conversations, and backfill the open chat.
  const tick = () => { loadConversations(); refreshActiveMessages(); };
  setInterval(tick, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pingPresence(); tick(); } });
  window.addEventListener("focus", () => { pingPresence(); tick(); });
}

function pingPresence() { api("/api/presence", { method: "POST" }).catch(() => {}); }

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
  state.activeConv = conv;
  state.renderedIds = new Set();
  state.typers = {};
  state.typerTimers = {};
  renderTyping();
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
  $("#messages").innerHTML = "";
  const { messages } = await api("/api/messages?conversation=" + encodeURIComponent(conv.id));
  for (const m of messages) renderMessage(m);
  scrollBottom();
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

  ws.addEventListener("open", startHeartbeat);
  ws.addEventListener("message", (ev) => {
    if (ev.data === "pong") return;
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "typing" && state.activeConv && data.conversationId === state.activeConv.id) {
        showTyping(data.userId, data.displayName);
        return;
      }
      if (data.type === "message" && state.activeConv && data.message.conversationId === state.activeConv.id) {
        renderMessage(data.message);
        scrollBottom();
        if (!document.hidden) { markRead(state.activeConv.id); state.notifiedAt[state.activeConv.id] = data.message.createdAt; }
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
    const { messages } = await api("/api/messages?conversation=" + encodeURIComponent(convId));
    if (!state.activeConv || state.activeConv.id !== convId) return;
    let added = false;
    for (const m of messages) { if (!state.renderedIds.has(m.id)) { renderMessage(m); added = true; } }
    if (added) {
      scrollBottom();
      if (!document.hidden) markRead(convId);
    }
  } catch {}
}

function renderMessage(m) {
  if (state.renderedIds.has(m.id)) return;
  state.renderedIds.add(m.id);
  const mine = m.senderId === state.me.id;
  const div = document.createElement("div");
  div.className = "msg " + (mine ? "me" : "them") + (m.imageUrl ? " has-image" : "");
  const showName = !mine && state.activeConv && state.activeConv.type === "group";
  const nameLabel = showName ? `<span class="msg-sender">${escapeHtml(m.senderName)}</span>` : "";
  const image = m.imageUrl
    ? `<a href="${escapeAttr(m.imageUrl)}" target="_blank" rel="noopener" class="msg-image-link"><img class="msg-image" src="${escapeAttr(m.imageUrl)}" alt="photo" loading="lazy"></a>`
    : "";
  const body = m.body ? `<span class="body">${escapeHtml(m.body)}</span>` : "";
  div.innerHTML = `${nameLabel}${image}${body}<span class="time">${fmtTime(m.createdAt)}</span>`;
  $("#messages").appendChild(div);
  // Someone who just sent a message isn't typing anymore.
  if (state.typers[m.senderId]) { delete state.typers[m.senderId]; renderTyping(); }
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#composer-input");
  const body = input.value.trim();
  if (!body || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: "message", body }));
  input.value = "";
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
    state.ws.send(JSON.stringify({ type: "message", body: caption, imageUrl: data.imageUrl }));
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

// ---------- Boot ----------
(async function boot() {
  try {
    const { user } = await api("/api/me");
    enterApp(user);
  } catch {}
})();
