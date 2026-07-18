// We Sell Rugs — messenger client
const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  activeConv: null, // { id, type, title, other, members }
  ws: null,
  renderedIds: new Set(),
  friends: [],
};

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
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#me-name").textContent = user.displayName;
  $("#me-avatar").textContent = initials(user.displayName);
  refreshAll();
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
  if (!users.length) {
    list.innerHTML = '<li class="empty-hint">No one found.</li>';
  } else {
    for (const u of users) list.appendChild(searchRow(u));
  }
  list.classList.remove("hidden");
}

function searchRow(u) {
  const li = document.createElement("li");
  li.className = "row-item";
  const avatar = `<span class="avatar sm">${initials(u.displayName)}</span>`;
  const info = `<div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div><div class="row-sub">@${escapeHtml(u.username)}</div></div>`;
  const btn = document.createElement("button");
  btn.className = "pill-btn";
  btn.type = "button";
  const setState = (s) => {
    btn.disabled = false;
    if (s === "friends") { btn.textContent = "Message"; btn.className = "pill-btn primary"; btn.onclick = (ev) => { ev.stopPropagation(); startDm(u); }; }
    else if (s === "requested") { btn.textContent = "Requested"; btn.className = "pill-btn"; btn.disabled = true; btn.onclick = null; }
    else if (s === "incoming") { btn.textContent = "Accept"; btn.className = "pill-btn primary"; btn.onclick = async (ev) => { ev.stopPropagation(); await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ fromUserId: u.id }) }); setState("friends"); refreshAll(); }; }
    else { btn.textContent = "Add friend"; btn.className = "pill-btn"; btn.onclick = async (ev) => { ev.stopPropagation(); const { state: st } = await api("/api/friends/request", { method: "POST", body: JSON.stringify({ toUserId: u.id }) }); setState(st); refreshAll(); }; }
  };
  setState(u.friendState);
  li.innerHTML = avatar + info;
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
    li.innerHTML = `<span class="avatar sm">${initials(u.displayName)}</span>
      <div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div><div class="row-sub">wants to be friends</div></div>`;
    const accept = document.createElement("button");
    accept.className = "pill-btn primary"; accept.type = "button"; accept.textContent = "✓";
    accept.title = "Accept";
    accept.onclick = async () => { await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ fromUserId: u.id }) }); refreshAll(); };
    const decline = document.createElement("button");
    decline.className = "pill-btn"; decline.type = "button"; decline.textContent = "✕";
    decline.title = "Decline";
    decline.onclick = async () => { await api("/api/friends/decline", { method: "POST", body: JSON.stringify({ fromUserId: u.id }) }); refreshAll(); };
    li.appendChild(accept); li.appendChild(decline);
    list.appendChild(li);
  }
}

// ---------- Friends ----------
async function loadFriends() {
  let friends = [];
  try { ({ friends } = await api("/api/friends")); } catch { return; }
  state.friends = friends;
  const list = $("#friends-list");
  list.innerHTML = "";
  if (!friends.length) { list.innerHTML = '<li class="empty-hint">No friends yet — search above to add some.</li>'; return; }
  for (const u of friends) {
    const li = document.createElement("li");
    li.className = "row-item";
    li.innerHTML = `<span class="avatar sm">${initials(u.displayName)}</span>
      <div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div><div class="row-sub">@${escapeHtml(u.username)}</div></div>`;
    li.onclick = () => startDm(u);
    list.appendChild(li);
  }
}

// ---------- Conversations ----------
async function loadConversations() {
  let conversations = [];
  try { ({ conversations } = await api("/api/conversations")); } catch { return; }
  const list = $("#conversation-list");
  list.innerHTML = "";
  if (!conversations.length) { list.innerHTML = '<li class="empty-hint">No chats yet.</li>'; return; }
  for (const c of conversations) {
    const li = document.createElement("li");
    li.className = "row-item";
    if (state.activeConv && state.activeConv.id === c.id) li.classList.add("active");
    const icon = c.type === "group" ? '<span class="avatar sm group">👥</span>' : `<span class="avatar sm">${initials(c.title)}</span>`;
    const preview = c.lastMessage ? escapeHtml(c.lastMessage.body.slice(0, 38)) : (c.type === "group" ? "New group" : "Say hello 👋");
    li.innerHTML = `${icon}<div class="row-main"><div class="row-name">${escapeHtml(c.title)}</div><div class="row-sub">${preview}</div></div>`;
    li.onclick = () => openConversation(c);
    list.appendChild(li);
  }
}

async function startDm(friend) {
  const { conversationId } = await api("/api/dm", { method: "POST", body: JSON.stringify({ withUserId: friend.id }) });
  openConversation({ id: conversationId, type: "dm", title: friend.displayName, other: friend, members: [friend] });
  $("#search-results").classList.add("hidden");
  $("#search-input").value = "";
  loadConversations();
}

// ---------- Open a conversation ----------
async function openConversation(conv) {
  state.activeConv = conv;
  state.renderedIds = new Set();
  $("#chat-empty").classList.add("hidden");
  $("#chat-active").classList.remove("hidden");
  $("#app").classList.add("viewing-chat");
  $("#peer-name").textContent = conv.title;
  if (conv.type === "group") {
    $("#peer-avatar").textContent = "👥";
    $("#peer-avatar").classList.add("group");
    const names = (conv.members || []).map((m) => m.displayName);
    $("#peer-status").textContent = `${(conv.members || []).length + 1} members · You, ${names.join(", ")}`;
  } else {
    $("#peer-avatar").textContent = initials(conv.title);
    $("#peer-avatar").classList.remove("group");
    $("#peer-status").textContent = conv.other ? "@" + conv.other.username : "";
  }
  $("#messages").innerHTML = "";
  const { messages } = await api("/api/messages?conversation=" + encodeURIComponent(conv.id));
  for (const m of messages) renderMessage(m);
  scrollBottom();
  connectWs(conv.id);
  document.querySelectorAll("#conversation-list .row-item").forEach((el) => el.classList.remove("active"));
}

function connectWs(convId) {
  if (state.ws) { state.ws.close(); state.ws = null; }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?conversation=${encodeURIComponent(convId)}`);
  state.ws = ws;
  ws.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "message" && state.activeConv && data.message.conversationId === state.activeConv.id) {
        renderMessage(data.message);
        scrollBottom();
        loadConversations();
      }
    } catch {}
  });
}

function renderMessage(m) {
  if (state.renderedIds.has(m.id)) return;
  state.renderedIds.add(m.id);
  const mine = m.senderId === state.me.id;
  const div = document.createElement("div");
  div.className = "msg " + (mine ? "me" : "them");
  const showName = !mine && state.activeConv && state.activeConv.type === "group";
  const nameLabel = showName ? `<span class="msg-sender">${escapeHtml(m.senderName)}</span>` : "";
  div.innerHTML = `${nameLabel}<span class="body">${escapeHtml(m.body)}</span><span class="time">${fmtTime(m.createdAt)}</span>`;
  $("#messages").appendChild(div);
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
      li.innerHTML = `<label><input type="checkbox" value="${f.id}" /> <span class="avatar sm">${initials(f.displayName)}</span> ${escapeHtml(f.displayName)}</label>`;
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
