// We Sell Rugs — messenger client
const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  activeConv: null, // { id, other }
  ws: null,
  renderedIds: new Set(),
};

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// ---------- Auth UI ----------
function showAuthError(msg) {
  $("#auth-error").textContent = msg || "";
}

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
    const { user } = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: f.get("username"), password: f.get("password") }),
    });
    enterApp(user);
  } catch (err) {
    showAuthError(err.message);
  }
});

$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  const f = new FormData(e.target);
  try {
    const { user } = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username: f.get("username"),
        displayName: f.get("displayName"),
        password: f.get("password"),
      }),
    });
    enterApp(user);
  } catch (err) {
    showAuthError(err.message);
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  if (state.ws) state.ws.close();
  location.reload();
});

// ---------- App ----------
function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function enterApp(user) {
  state.me = user;
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#me-name").textContent = user.displayName;
  $("#me-avatar").textContent = initials(user.displayName);
  loadPeople();
  loadConversations();
}

async function loadPeople() {
  const { users } = await api("/api/users");
  const list = $("#people-list");
  list.innerHTML = "";
  if (!users.length) {
    list.innerHTML = '<li class="empty-hint">No one else has signed up yet. Invite a friend!</li>';
    return;
  }
  for (const u of users) {
    const li = document.createElement("li");
    li.className = "row-item";
    li.innerHTML = `<span class="avatar sm">${initials(u.displayName)}</span>
      <div class="row-main"><div class="row-name">${escapeHtml(u.displayName)}</div>
      <div class="row-sub">@${escapeHtml(u.username)}</div></div>`;
    li.addEventListener("click", () => startDm(u));
    list.appendChild(li);
  }
}

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  const list = $("#conversation-list");
  list.innerHTML = "";
  if (!conversations.length) {
    list.innerHTML = '<li class="empty-hint">No conversations yet.</li>';
    return;
  }
  for (const c of conversations) {
    const li = document.createElement("li");
    li.className = "row-item";
    if (state.activeConv && state.activeConv.id === c.id) li.classList.add("active");
    const preview = c.lastMessage ? escapeHtml(c.lastMessage.body.slice(0, 40)) : "Say hello 👋";
    li.innerHTML = `<span class="avatar sm">${initials(c.other.displayName)}</span>
      <div class="row-main"><div class="row-name">${escapeHtml(c.other.displayName)}</div>
      <div class="row-sub">${preview}</div></div>`;
    li.addEventListener("click", () => openConversation(c.id, c.other));
    list.appendChild(li);
  }
}

async function startDm(otherUser) {
  const { conversationId } = await api("/api/dm", {
    method: "POST",
    body: JSON.stringify({ withUserId: otherUser.id }),
  });
  openConversation(conversationId, otherUser);
}

async function openConversation(convId, other) {
  state.activeConv = { id: convId, other };
  state.renderedIds = new Set();

  $("#chat-empty").classList.add("hidden");
  $("#chat-active").classList.remove("hidden");
  $("#app").classList.add("viewing-chat");
  $("#peer-name").textContent = other.displayName;
  $("#peer-status").textContent = "@" + other.username;
  $("#peer-avatar").textContent = initials(other.displayName);
  $("#messages").innerHTML = "";

  // history
  const { messages } = await api("/api/messages?conversation=" + encodeURIComponent(convId));
  for (const m of messages) renderMessage(m);
  scrollBottom();

  connectWs(convId);
  // refresh sidebar highlight
  document.querySelectorAll("#conversation-list .row-item").forEach((el) => el.classList.remove("active"));
}

function connectWs(convId) {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
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
  div.innerHTML = `<span class="body">${escapeHtml(m.body)}</span><span class="time">${fmtTime(m.createdAt)}</span>`;
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

function scrollBottom() {
  const el = $("#messages");
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Boot: are we already logged in? ----------
(async function boot() {
  try {
    const { user } = await api("/api/me");
    enterApp(user);
  } catch {
    // stay on auth screen
  }
})();
