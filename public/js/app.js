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

  // Setiap modul punya 1 room doang (Discord: 1 server = 1 channel)
  const MODULES = {
    chat: { room: "general", channel: "general", title: "Chat Forum", desc: "Obrolan bebas semua topik" },
    help: { room: "help", channel: "help", title: "Help Forum", desc: "Tanya jawab & bantuan" },
    voice: { room: "voice", channel: "voice", title: "Voice", desc: "Ngobrol pakai mic & share screen" },
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
  function msgEl(m, animate) {
    const mine = me && m.username === me.name;
    const div = document.createElement("div");
    div.className = "msg" + (mine ? " mine" : "");
    if (!animate) div.style.animation = "none";
    div.innerHTML = `
      <div class="meta"><b>${escapeHtml(m.username)}</b> <span class="time">· ${timeLabel(m.created_at)}</span></div>
      <div class="bubble">${escapeHtml(m.text)}</div>`;
    return div;
  }

  function currentRoom() {
    return MODULES[activeModule].room;
  }

  function loadHistory(room) {
    const listEl = $("#messages");
    fetch(`/api/history?room=${encodeURIComponent(room)}&limit=50`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        listEl.innerHTML = "";
        for (const m of data.messages) listEl.appendChild(msgEl(m, false));
        scrollBottom(listEl);
      })
      .catch(() => {});
  }

  // ---------- Presence (panel member kanan, ala Discord) ----------
  function renderPresence(list) {
    $("#member-count").textContent = list.length;
    const ul = $("#member-list");
    ul.innerHTML = "";
    list.sort((a, b) => a.id - b.id);
    for (const p of list) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="status-dot"></span><span class="member-name"></span>`;
      li.querySelector(".member-name").textContent = p.name;
      if (me && p.id === me.id) li.classList.add("me");
      ul.appendChild(li);
    }
  }

  // ---------- Modul (berpindah kayak Discord) ----------
  function setModule(mod) {
    activeModule = mod;
    const info = MODULES[mod];

    $$(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.module === mod));

    // kolom channel: section teks vs panel voice
    const isVoice = mod === "voice";
    $("#channel-section").classList.toggle("hidden", isVoice);
    $("#voice-connected").classList.toggle("hidden", !isVoice);
    $("#channels-title").textContent = info.title;
    $("#channel-name").textContent = info.channel;

    // pane utama
    $("#pane-title").textContent = "# " + info.channel;
    $("#pane-desc").textContent = info.desc;
    $("#screen-grid").classList.toggle("hidden", !isVoice);
    $("#chat-text").placeholder = `Ketik ke # ${info.channel}...`;

    if (mod === "voice") {
      enterVoice();
    } else {
      exitVoice();
    }

    socket.emit("rooms:join", info.room);
    loadHistory(info.room);
  }

  // ---------- Voice (WebRTC mesh: mic + share screen, tanpa kamera) ----------

  const peers = new Map(); // socketId -> { pc, polite, makingOffer, isSettingRemoteAnswer }
  const screenVideos = new Map(); // socketId -> <video>
  const remoteAudios = new Set(); // <audio> remote
  let localMicStream = null;
  let localScreenStream = null;
  let micOn = true;
  let deafened = false;
  let inVoice = false;

  let voiceUsers = []; // [{id, name, micOn, deafened}]

  function audioElFor(stream) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    document.body.appendChild(audio);
    remoteAudios.add(audio);
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

  // --- Daftar user di voice channel (ala Discord) ---
  function renderVoiceUsers() {
    const el = $("#voice-users");
    el.innerHTML = "";
    const sorted = [...voiceUsers].sort((a, b) => (a.id === (me && me.id) ? -1 : 0));
    for (const u of sorted) {
      const div = document.createElement("div");
      div.className = "voice-user" + (me && u.id === me.id ? " me" : "");
      const icon = u.deafened ? "🔇" : u.micOn ? "🎤" : "🔇";
      div.innerHTML = `<span class="voice-ico">${icon}</span><span class="voice-name">${escapeHtml(u.name)}</span>`;
      el.appendChild(div);
    }
    if (!voiceUsers.length) {
      const div = document.createElement("div");
      div.className = "voice-empty";
      div.textContent = "Belum ada yang nyambung. Klik tombol mic buat join.";
      el.appendChild(div);
    }
  }

  function updateVoiceStateUi() {
    const micBtn = $("#mic-btn");
    const deafBtn = $("#deafen-btn");
    micBtn.classList.toggle("on", micOn && !deafened);
    deafBtn.classList.toggle("on", deafened);
    micBtn.textContent = deafened ? "🔇" : micOn ? "🎤" : "🔇";
    deafBtn.textContent = deafened ? "🔈" : "🔇";
  }

  async function enterVoice() {
    if (inVoice) return;
    inVoice = true;
    if (!localMicStream) {
      try {
        localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !deafened));
      } catch (err) {
        console.error("Mic tidak bisa diakses:", err);
        micOn = false;
        alert("Mic tidak bisa diakses. Pastikan izin mic sudah diberikan.");
      }
    }
    socket.emit("voice:join");
    socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
  }

  function exitVoice() {
    if (!inVoice) return;
    inVoice = false;
    socket.emit("voice:leave");
    for (const sid of Array.from(peers.keys())) closePeer(sid);
    for (const a of remoteAudios) {
      try {
        a.srcObject = null;
        a.remove();
      } catch (_) {}
    }
    remoteAudios.clear();
    const grid = $("#screen-grid");
    grid.innerHTML = "";
    screenVideos.clear();
    voiceUsers = [];
    renderVoiceUsers();
  }

  function toggleMic() {
    micOn = !micOn;
    if (localMicStream) {
      localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !deafened));
    }
    socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
    updateVoiceStateUi();
  }

  function toggleDeafen() {
    deafened = !deafened;
    for (const a of remoteAudios) a.muted = deafened;
    if (localMicStream) {
      localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !deafened));
    }
    socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
    updateVoiceStateUi();
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

    addScreenVideo("__self", localScreenStream, `${me ? me.name : "Kamu"} · Layar`);

    for (const peer of peers.values()) {
      try {
        for (const t of localScreenStream.getVideoTracks()) peer.pc.addTrack(t, localScreenStream);
        await renegotiate(peer);
      } catch (err) {
        console.error("add screen to peer", err);
      }
    }
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
    $("#screen-btn").classList.remove("on");
  }

  // ---------- Kirim pesan ----------
  function bindChatForm() {
    $("#chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#chat-text");
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit("message:send", { room: currentRoom(), text });
      input.value = "";
      input.focus();
    });
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
      renderPresence([]);
      $("#current-user").textContent = "🕶️ " + me.name;
    } catch (err) {
      alert("Gagal mendapatkan identitas anonim. Coba muat ulang.");
      return;
    }

    socket = io({ auth: { deviceToken }, reconnectionAttempts: 5 });

    socket.on("connect", () => {
      $("#conn-status").textContent = "🟢 online";
      if (me) socket.emit("rooms:join", currentRoom());
      if (inVoice) socket.emit("voice:join");
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
      if (m.room !== currentRoom()) return;
      $("#messages").appendChild(msgEl(m, true));
      scrollBottom($("#messages"));
    });

    socket.on("room:joined", ({ room }) => {
      loadHistory(room);
    });

    // Voice events
    socket.on("voice:users", (list) => {
      voiceUsers = list;
      renderVoiceUsers();
    });

    socket.on("voice:peer-joined", ({ from }) => {
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
    $$(".rail-btn").forEach((b) => {
      b.addEventListener("click", () => setModule(b.dataset.module));
    });

    $("#mic-btn").addEventListener("click", toggleMic);
    $("#deafen-btn").addEventListener("click", toggleDeafen);
    $("#screen-btn").addEventListener("click", toggleScreen);
    $("#leave-voice-btn").addEventListener("click", () => {
      exitVoice();
      setModule("chat");
    });

    bindChatForm();
    updateVoiceStateUi();
    setModule("chat");

    $("#loading").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  init();
})();
