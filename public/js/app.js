(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- Identitas anonim ----------
  let deviceToken = localStorage.getItem("hs_device");
  if (!deviceToken) {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    deviceToken = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("hs_device", deviceToken);
  }

  let me = null;
  let socket = null;

  let activeModule = "chat";
  let activeRoom = "general";

  const FORUM_ROOMS = [
    { id: "general", label: "General", emoji: "💬" },
    { id: "tech", label: "Teknologi", emoji: "💻" },
    { id: "gaming", label: "Gaming", emoji: "🎮" },
    { id: "otaku", label: "Anime", emoji: "🌟" },
    { id: "music", label: "Musik & Film", emoji: "🎵" },
  ];

  const MESSAGE_LISTS = {
    chat: "#chat-messages",
    help: "#help-messages",
    voice: "#voice-messages",
  };

  // ---------- Util ----------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function timeLabel(iso) {
    try {
      return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  function scrollBottom(el) {
    el.scrollTop = el.scrollHeight;
  }

  // ---------- Pesan ----------
  function appendMsg(m, listEl) {
    const mine = me && m.username === me.name;
    const div = document.createElement("div");
    div.className = "msg" + (mine ? " mine" : "");
    div.innerHTML = `
      <div class="meta"><b>${escapeHtml(m.username)}</b> <span class="time">· ${timeLabel(m.created_at)}</span></div>
      <div class="bubble">${escapeHtml(m.text)}</div>`;
    listEl.appendChild(div);
    scrollBottom(listEl);
  }

  async function loadHistory(room, listEl) {
    try {
      const res = await fetch(`/api/history?room=${encodeURIComponent(room)}&limit=50`);
      if (!res.ok) return;
      const data = await res.json();
      listEl.innerHTML = "";
      for (const m of data.messages) {
        const mine = me && m.username === me.name;
        const div = document.createElement("div");
        div.className = "msg" + (mine ? " mine" : "");
        div.style.animation = "none";
        div.innerHTML = `
          <div class="meta"><b>${escapeHtml(m.username)}</b> <span class="time">· ${timeLabel(m.created_at)}</span></div>
          <div class="bubble">${escapeHtml(m.text)}</div>`;
        listEl.appendChild(div);
      }
      scrollBottom(listEl);
    } catch (_) {}
  }

  // ---------- Presence ----------
  function renderPresence(list) {
    const count = list.length;
    $("#member-count").textContent = count;
    const ul = $("#member-list");
    ul.innerHTML = "";
    list.sort((a, b) => a.id - b.id);
    for (const p of list) {
      const li = document.createElement("li");
      li.textContent = p.name;
      if (me && p.id === me.id) li.classList.add("me");
      ul.appendChild(li);
    }
  }

  // ---------- Modul ----------
  function setModule(mod) {
    activeModule = mod;
    $$(".module-btn").forEach((b) => b.classList.toggle("active", b.dataset.module === mod));
    $$(".module").forEach((m) => m.classList.toggle("hidden", m.id !== "module-" + mod));

    if (mod === "chat") {
      joinRoom(activeRoom);
    } else if (mod === "help") {
      joinRoom("help");
    } else if (mod === "voice") {
      joinRoom("voice");
      enterVoice();
    }
  }

  function joinRoom(room) {
    activeRoom = room;
    if (socket) socket.emit("rooms:join", room);
    const listEl = $(MESSAGE_LISTS[activeModule]);
    if (listEl) loadHistory(room, listEl);
    if (activeModule === "chat") renderRoomTabs(room);
  }

  function renderRoomTabs(active) {
    const tabs = $("#chat-room-tabs");
    tabs.innerHTML = "";
    for (const r of FORUM_ROOMS) {
      const b = document.createElement("button");
      b.className = "room-tab" + (r.id === active ? " active" : "");
      b.textContent = `${r.emoji} ${r.label}`;
      b.addEventListener("click", () => {
        activeRoom = r.id;
        renderRoomTabs(r.id);
        socket.emit("rooms:join", r.id);
        loadHistory(r.id, $("#chat-messages"));
      });
      tabs.appendChild(b);
    }
  }

  // ---------- Voice (WebRTC mesh: mic + screen share, tanpa kamera) ----------

  const peers = new Map(); // socketId -> { pc, polite, makingOffer, isSettingRemoteAnswer }
  const screenVideos = new Map(); // socketId -> <video>
  let localMicStream = null;
  let localScreenStream = null;
  let micOn = true;
  let inVoice = false;

  function audioElFor(stream) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    document.body.appendChild(audio);
    return audio;
  }

  function makePeer(socketId, polite) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    const peer = { socketId, pc, polite, makingOffer: false, isSettingRemoteAnswer: false };
    peers.set(socketId, peer);

    if (localMicStream) {
      for (const t of localMicStream.getAudioTracks()) pc.addTrack(t, localMicStream);
    }
    if (localScreenStream) {
      for (const t of localScreenStream.getVideoTracks()) pc.addTrack(t, localScreenStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("voice:ice", { target: socketId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      if (e.track.kind === "audio") {
        audioElFor(new MediaStream([e.track]));
      } else if (e.track.kind === "video") {
        addScreenVideo(socketId, e.streams[0] || new MediaStream([e.track]));
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        closePeer(socketId);
      }
    };

    return peer;
  }

  function ensurePeer(socketId, polite) {
    if (!inVoice) return null;
    let peer = peers.get(socketId);
    if (!peer) peer = makePeer(socketId, polite);
    return peer;
  }

  async function handleOffer(peer, offer) {
    try {
      peer.ignoreOffer = !peer.polite && peer.makingOffer;
      if (peer.ignoreOffer) return;
      peer.isSettingRemoteAnswer = true;
      await peer.pc.setRemoteDescription(offer);
      peer.isSettingRemoteAnswer = false;
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit("voice:answer", { target: peer.socketId, sdp: peer.pc.localDescription });
    } catch (err) {
      console.error("handleOffer", err);
    }
  }

  async function handleAnswer(peer, answer) {
    try {
      await peer.pc.setRemoteDescription(answer);
    } catch (err) {
      console.error("handleAnswer", err);
    }
  }

  async function renegotiate(peer) {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      socket.emit("voice:offer", { target: peer.socketId, sdp: peer.pc.localDescription });
    } catch (err) {
      console.error("renegotiate", err);
    } finally {
      peer.makingOffer = false;
    }
  }

  function closePeer(socketId) {
    const peer = peers.get(socketId);
    if (peer) {
      try {
        peer.pc.close();
      } catch (_) {}
      peers.delete(socketId);
    }
    const video = screenVideos.get(socketId);
    if (video) {
      video.remove();
      screenVideos.delete(socketId);
    }
  }

  function leaveVoicePeer(socketId) {
    closePeer(socketId);
  }

  function addScreenVideo(socketId, stream, label) {
    const grid = $("#screen-grid");
    let video = screenVideos.get(socketId);
    if (!video) {
      video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = stream;
      screenVideos.set(socketId, video);
      const wrap = document.createElement("div");
      wrap.className = "screen-tile";
      wrap.dataset.sid = socketId;
      wrap.appendChild(video);
      const name = document.createElement("div");
      name.className = "screen-name";
      name.textContent = label || "Layar";
      wrap.appendChild(name);
      grid.appendChild(wrap);
    } else {
      video.srcObject = stream;
    }
  }

  async function enterVoice() {
    inVoice = true;
    if (!localMicStream) {
      try {
        localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (err) {
        console.error("Mic tidak bisa diakses:", err);
        $("#mic-btn").textContent = "🎤 Mic: BLOKIR";
        $("#mic-btn").classList.remove("on");
        micOn = false;
      }
    }
    socket.emit("voice:join");
  }

  function exitVoice() {
    if (!inVoice) return;
    inVoice = false;
    socket.emit("voice:leave");
    for (const sid of Array.from(peers.keys())) closePeer(sid);
    const grid = $("#screen-grid");
    grid.innerHTML = "";
  }

  function bindVoiceControls() {
    $("#mic-btn").addEventListener("click", () => {
      if (!localMicStream) return;
      micOn = !micOn;
      localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
      $("#mic-btn").classList.toggle("on", micOn);
      $("#mic-btn").textContent = micOn ? "🎤 Mic: ON" : "🎤 Mic: OFF";
    });

    $("#screen-btn").addEventListener("click", toggleScreen);
  }

  async function toggleScreen() {
    if (localScreenStream) {
      stopScreen();
      return;
    }
    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      return;
    }
    const track = localScreenStream.getVideoTracks()[0];
    if (track) track.onended = () => stopScreen();

    // preview sendiri
    addScreenVideo("__self", localScreenStream, `${me ? me.name : "Kamu"} · Layar`);

    for (const peer of peers.values()) {
      try {
        for (const t of localScreenStream.getVideoTracks()) peer.pc.addTrack(t, localScreenStream);
        await renegotiate(peer);
      } catch (err) {
        console.error("add screen to peer", err);
      }
    }
    $("#screen-btn").textContent = "⏹️ Stop Share";
    $("#screen-btn").classList.add("on");
  }

  function stopScreen() {
    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => t.stop());
      localScreenStream = null;
    }
    const self = screenVideos.get("__self");
    if (self) {
      self.remove();
      screenVideos.delete("__self");
    }
    for (const peer of peers.values()) {
      const senders = peer.pc.getSenders().filter((s) => s.track && s.track.kind === "video");
      for (const s of senders) {
        try {
          peer.pc.removeTrack(s);
        } catch (_) {}
      }
      renegotiate(peer);
    }
    $("#screen-btn").textContent = "🖥️ Share Screen";
    $("#screen-btn").classList.remove("on");
  }

  // ---------- Kirim pesan ----------
  function bindForms() {
    const bind = (formId, inputId, room) => {
      const form = $(formId);
      const input = $(inputId);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || !socket) return;
        socket.emit("message:send", { room, text });
        input.value = "";
        input.focus();
      });
    };
    bind("#chat-form", "#chat-text", () => activeRoom);
    bind("#help-form", "#help-text", "help");
    bind("#voice-form", "#voice-text", "voice");
  }

  // ---------- Init ----------
  async function init() {
    try {
      const res = await fetch("/api/anon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceToken }),
      });
      const data = await res.json();
      if (!data.anon) throw new Error("anon");
      me = data.anon;
      $("#current-user").textContent = "🕶️ " + me.name;
    } catch (err) {
      alert("Gagal mendapatkan identitas anonim. Coba muat ulang.");
      return;
    }

    socket = io({ auth: { deviceToken }, reconnectionAttempts: 5 });

    socket.on("connect", () => {
      $("#conn-status").textContent = "🟢 online";
      if (me) {
        socket.emit("rooms:join", activeModule === "help" ? "help" : activeModule === "voice" ? "voice" : activeRoom);
      }
      if (activeModule === "voice" && inVoice) socket.emit("voice:join");
    });

    socket.on("disconnect", () => {
      $("#conn-status").textContent = "🔴 offline";
    });
    socket.on("connect_error", () => {
      $("#conn-status").textContent = "🔴 offline";
    });

    socket.on("identity", (anon) => {
      me = anon;
      $("#current-user").textContent = "🕶️ " + anon.name;
    });

    socket.on("presence:update", renderPresence);

    socket.on("message:new", (m) => {
      if (m.room === "help") {
        if (activeModule !== "help") return;
        appendMsg(m, $("#help-messages"));
      } else if (m.room === "voice") {
        if (activeModule !== "voice") return;
        appendMsg(m, $("#voice-messages"));
      } else {
        if (activeModule !== "chat" || m.room !== activeRoom) return;
        appendMsg(m, $("#chat-messages"));
      }
    });

    socket.on("room:joined", ({ room }) => {
      const listEl = $(MESSAGE_LISTS[activeModule]);
      if (listEl) loadHistory(room, listEl);
    });

    // Voice events
    socket.on("voice:peer-joined", ({ from, anon }) => {
      if (!inVoice) return;
      const peer = ensurePeer(from, false);
      if (peer && !peer.pc.remoteDescription) renegotiate(peer);
    });

    socket.on("voice:peer-left", ({ from }) => closePeer(from));
    socket.on("peer:left", ({ socketId }) => closePeer(socketId));

    socket.on("voice:offer", async ({ from, sdp }) => {
      const peer = ensurePeer(from, true);
      if (peer) await handleOffer(peer, sdp);
    });

    socket.on("voice:answer", async ({ from, sdp }) => {
      const peer = peers.get(from);
      if (peer) await handleAnswer(peer, sdp);
    });

    socket.on("voice:ice", async ({ from, candidate }) => {
      const peer = peers.get(from);
      if (peer && peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(candidate);
        } catch (_) {}
      }
    });

    // Bind UI
    $$(".module-btn").forEach((b) => {
      b.addEventListener("click", () => {
        if (activeModule === "voice" && b.dataset.module !== "voice") exitVoice();
        setModule(b.dataset.module);
      });
    });

    bindForms();
    bindVoiceControls();
    renderRoomTabs(activeRoom);

    $("#loading").classList.add("hidden");
    $("#app").classList.remove("hidden");

    socket.emit("rooms:join", activeRoom);
    loadHistory(activeRoom, $("#chat-messages"));
  }

  init();
})();
