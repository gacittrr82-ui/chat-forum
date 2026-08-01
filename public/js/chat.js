const $ = (sel) => document.querySelector(sel);

const API = "/api";
const token = localStorage.getItem("cf_token");

if (!token) {
  window.location.href = "index.html";
}

const messagesEl = $("#messages");
const roomListEl = $("#room-list");
const roomTitle = $("#room-title");
const roomDesc = $("#room-desc");
const chatForm = $("#chat-form");
const chatText = $("#chat-text");
const currentUserEl = $("#current-user");
const onlineBadge = $("#online-count");

let socket = null;
let currentRoom = "general";
let currentUser = null;
const ROOMS = {
  general: { label: "General", emoji: "💬" },
  tech: { label: "Teknologi", emoji: "💻" },
  gaming: { label: "Gaming", emoji: "🎮" },
  otaku: { label: "Anime", emoji: "🌟" },
  music: { label: "Musik & Film", emoji: "🎵" },
};

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeLabel(iso) {
  try {
    return new Date(iso).toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return "";
  }
}

function renderRooms() {
  roomListEl.innerHTML = "";
  for (const [id, r] of Object.entries(ROOMS)) {
    const li = document.createElement("li");
    li.dataset.room = id;
    if (id === currentRoom) li.classList.add("active");
    li.innerHTML = `<span class="room-emoji">${r.emoji}</span><span class="room-label">${r.label}</span>`;
    li.addEventListener("click", () => joinRoom(id));
    roomListEl.appendChild(li);
  }
}

function renderHistory(messages) {
  messagesEl.innerHTML = "";
  for (const m of messages) addMessage(m, true);
  scrollBottom();
}

function addMessage(m, noAnimate) {
  const mine = m.username === currentUser?.username;
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");
  if (noAnimate) div.style.animation = "none";
  div.innerHTML = `
    <div class="meta">
      <b>${escapeHtml(m.username)}</b>
      <span class="time">· ${timeLabel(m.created_at)}</span>
    </div>
    <div class="bubble">${escapeHtml(m.text)}</div>
  `;
  messagesEl.appendChild(div);
  scrollBottom();
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function joinRoom(roomId) {
  currentRoom = roomId;
  const r = ROOMS[roomId];
  roomTitle.textContent = r.label;
  roomDesc.textContent = r.emoji;
  messagesEl.innerHTML = "";
  document.querySelectorAll("#room-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.room === roomId);
  });
  if (socket) socket.emit("rooms:join", roomId);
  loadHistory(roomId);
}

async function loadHistory(roomId) {
  try {
    const res = await fetch(`${API}/history?room=${roomId}&limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    renderHistory(data.messages);
  } catch (_) {}
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatText.value.trim();
  if (!text || !socket) return;
  socket.emit("message:send", { room: currentRoom, text });
  chatText.value = "";
  chatText.focus();
});

$("#logout-btn").addEventListener("click", async () => {
  try {
    await fetch(API + "/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
  } catch (_) {}
  localStorage.removeItem("cf_token");
  window.location.href = "index.html";
});

async function init() {
  try {
    const meRes = await fetch(API + "/me", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!meRes.ok) {
      localStorage.removeItem("cf_token");
      window.location.href = "index.html";
      return;
    }
    const me = await meRes.json();
    currentUser = me.user;
    currentUserEl.textContent = "👤 " + currentUser.username;

    const roomsRes = await fetch(API + "/rooms");
    if (roomsRes.ok) {
      const data = await roomsRes.json();
      for (const r of data.rooms) {
        if (!ROOMS[r.id]) ROOMS[r.id] = { label: r.label, emoji: "📂" };
      }
    }
    renderRooms();

    socket = io({
      auth: { token },
      reconnectionAttempts: 5,
    });

    socket.on("connect", () => {
      onlineBadge.textContent = "🟢 online";
      socket.emit("rooms:join", currentRoom);
    });

    socket.on("disconnect", () => {
      onlineBadge.textContent = "🔴 offline";
    });

    socket.on("connect_error", () => {
      onlineBadge.textContent = "🔴 offline";
    });

    socket.on("message:new", (m) => {
      if (m.room !== currentRoom) return;
      addMessage(m);
    });

    socket.on("room:joined", ({ room }) => {
      if (room === currentRoom) loadHistory(room);
    });

    loadHistory(currentRoom);

    $("#loading").classList.add("hidden");
    $("#app").classList.remove("hidden");
    chatText.focus();
  } catch (err) {
    alert("Gagal memuat aplikasi: " + err.message);
    localStorage.removeItem("cf_token");
    window.location.href = "index.html";
  }
}

init();
