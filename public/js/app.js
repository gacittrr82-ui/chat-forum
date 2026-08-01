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

  function avatarColor(id) {
    return `hsl(${(Number(id) * 47) % 360} 65% 55%)`;
  }

  function avatarText(name) {
    return String(name || "?").replace(/^ANONIM-/, "").slice(0, 2);
  }

  // ---------- Pesan ----------
  function msgEl(m, animate) {
    const mine = me && m.username === me.name;
    const color = avatarColor(m.user_id);
    const div = document.createElement("div");
    div.className = "msg" + (mine ? " mine" : "");
    if (!animate) div.style.animation = "none";
    div.innerHTML = `
      <div class="avatar" style="background:${color}">${escapeHtml(avatarText(m.username))}</div>
      <div class="msg-body" style="border-left-color:${color}">
        <div class="meta"><b style="color:${color}">${escapeHtml(m.username)}</b><span class="time">${timeLabel(m.created_at)}</span></div>
        <div class="bubble">${escapeHtml(m.text)}</div>
      </div>`;
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
        $("#messages-empty").classList.toggle("hidden", data.messages.length > 0);
        for (const m of data.messages) listEl.appendChild(msgEl(m, false));
        scrollBottom(listEl);
      })
      .catch(() => {});
  }

  // ---------- Presence ----------
  function renderPresence(list) {
    $("#member-count").textContent = list.length;
    $("#online-count").textContent = list.length;
    const ul = $("#member-list");
    ul.innerHTML = "";
    list.sort((a, b) => a.id - b.id);
    for (const p of list) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="avatar" style="background:${avatarColor(p.id)}">${escapeHtml(avatarText(p.name))}</span><span class="member-name"></span>`;
      li.querySelector(".member-name").textContent = p.name;
      if (me && p.id === me.id) li.classList.add("me");
      ul.appendChild(li);
    }
  }

  // ---------- Modul ----------
  function setModule(mod) {
    activeModule = mod;
    const info = MODULES[mod];
    const isVoice = mod === "voice";

    $$(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.module === mod));

    $("#channel-section").classList.toggle("hidden", isVoice);
    $("#voice-section").classList.toggle("hidden", !isVoice);
    $("#channels-title").textContent = info.title;
    $("#channel-name").textContent = info.channel;

    $("#pane-title").textContent = isVoice ? "Voice" : "# " + info.channel;
    $("#pane-desc").textContent = info.desc;
    $("#chat-text").placeholder = `Ketik ke # ${info.channel}...`;

    const msgs = $("#messages");
    msgs.classList.remove("fade");
    void msgs.offsetWidth;
    msgs.classList.add("fade");

    if (isVoice) {
      updateVoiceUi();
    } else {
      exitVoice();
    }

    socket.emit("rooms:join", info.room);
    loadHistory(info.room);
  }

  // ---------- Voice (ala Discord: klik channel = join/leave) ----------

  const peers = new Map();
  const screenVideos = new Map();
  const remoteAudios = new Set();
  let localMicStream = null;
  let localScreenStream = null;
  let micOn = true;
  let deafened = false;
  let inVoice = false;
  let speaking = false;

  let voiceUsers = [];
  let analyser = null;
  let audioCtx = null;

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
      if (e.candidate) socket.emit("voice:ice", { target: socketId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      if (e.track.kind === "audio") {
        audioElFor(new MediaStream([e.track]));
      } else if (e.track.kind === "video") {
        addScreenVideo(socketId, e.streams[0] || new MediaStream([e.track]));
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) closePeer(socketId);
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
      const live = document.createElement("div");
      live.className = "live-badge";
      live.textContent = "● LIVE";
      wrap.appendChild(live);
      grid.appendChild(wrap);
    } else {
      video.srcObject = stream;
    }
  }

  // --- UI voice ---
  function renderVoiceUsers() {
    const el = $("#voice-users");
    el.innerHTML = "";
    const sorted = [...voiceUsers].sort((a, b) => (a.id === (me && me.id) ? -1 : 0));
    for (const u of sorted) {
      const div = document.createElement("div");
      div.className = "voice-user" + (me && u.id === me.id ? " me" : "") + (speaking && me && u.id === me.id ? " speaking" : "");
      div.id = "vu-" + u.id;
      const icon = u.deafened ? "🔇" : u.micOn ? "🎤" : "🔇";
      div.innerHTML = `
        <span class="avatar speaking-ring" style="background:${avatarColor(u.id)}">${escapeHtml(avatarText(u.name))}</span>
        <span class="vu-name">${escapeHtml(u.name)}</span>
        <span class="vu-eq"><i></i><i></i><i></i></span>
        <span class="vu-ico">${icon}</span>`;
      el.appendChild(div);
    }
    if (!voiceUsers.length) {
      const div = document.createElement("div");
      div.className = "voice-empty";
      div.textContent = "Belum ada yang nyambung. Klik General Voice buat join.";
      el.appendChild(div);
    }
  }

  function setVoiceSpeaking(id, isSpeaking) {
    const row = document.getElementById("vu-" + id);
    if (row) row.classList.toggle("speaking", isSpeaking);
    if (me && Number(id) === me.id) {
      speaking = isSpeaking;
      $("#user-avatar").classList.toggle("speaking-ring", isSpeaking);
    }
  }

  function updateVoiceUi() {
    const isVoice = activeModule === "voice";
    $("#voice-stage").classList.toggle("hidden", !(isVoice && inVoice));
    $("#voice-join-banner").classList.toggle("hidden", !(isVoice && !inVoice));
    $("#voice-connected-pill").classList.toggle("hidden", !(isVoice && inVoice));
    $("#voice-channel-item").classList.toggle("joined", inVoice);

    const micBtn = $("#mic-btn");
    const deafBtn = $("#deafen-btn");
    const scrBtn = $("#screen-btn");
    micBtn.classList.toggle("on", micOn && !deafened);
    micBtn.classList.toggle("muted", !micOn || deafened);
    micBtn.textContent = "🎤";
    deafBtn.classList.toggle("on", deafened);
    deafBtn.textContent = "🎧";
    scrBtn.classList.toggle("on", !!localScreenStream);
    scrBtn.textContent = "🖥️";
    $("#screen-grid").classList.toggle("hidden", !(inVoice && localScreenStream));

    if (!isVoice) return;
    const desc = $("#voice-stage-desc");
    desc.textContent = voiceUsers.length > 1
      ? `${voiceUsers.length} orang di voice — ngomong aja!`
      : "Kamu sendirian di voice. Ajak temen buat nyambung!";
  }

  function startSpeakingWatch() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let was = false;
    let silentFor = 0;
    const eq = $("#voice-eq");
    const loop = () => {
      if (!inVoice || !analyser) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const level = Math.min(1, avg / 55);
      document.documentElement.style.setProperty("--mic-level", level.toFixed(3));
      let now = false;
      if (avg > 4) {
        now = true;
        silentFor = 0;
      } else if (was) {
        silentFor++;
        if (silentFor > 8) now = false;
        else now = true;
      }
      if (now !== was) {
        was = now;
        socket.emit("voice:speaking", { speaking: now });
        setVoiceSpeaking(me.id, now);
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  async function enterVoice() {
    if (inVoice) return;
    inVoice = true;
    if (!localMicStream) {
      try {
        localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !deafened));
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(localMicStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        startSpeakingWatch();
      } catch (err) {
        console.error("Mic gagal:", err);
        micOn = false;
        alert("Mic tidak bisa diakses. Pastikan izin mic sudah diberikan.");
      }
    }
    socket.emit("voice:join");
    socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
    $("#voice-eq").classList.add("live");
    updateVoiceUi();
  }

  function exitVoice() {
    if (!inVoice) return;
    inVoice = false;
    socket.emit("voice:leave");
    $("#voice-eq").classList.remove("live");
    document.documentElement.style.setProperty("--mic-level", "0.12");
    if (speaking) {
      speaking = false;
      socket.emit("voice:speaking", { speaking: false });
      $("#user-avatar").classList.remove("speaking-ring");
    }
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
    updateVoiceUi();
  }

  function toggleVoice() {
    if (inVoice) exitVoice();
    else enterVoice();
  }

  function toggleMic() {
    micOn = !micOn;
    if (localMicStream) localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !deafened));
    socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
    updateVoiceUi();
  }

  function toggleDeafen() {
    deafened = !deafened;
    for (const a of remoteAudios) a.muted = deafened;
    if (localMicStream) localMicStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !deafened));
    socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
    updateVoiceUi();
  }

  async function toggleScreen() {
    if (!inVoice) {
      alert("Join voice dulu (klik General Voice) sebelum share screen.");
      return;
    }
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
    updateVoiceUi();
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
    updateVoiceUi();
  }

  // ---------- Kirim pesan ----------
  function bindChatForm() {
    const input = $("#chat-text");
    let lastTyping = 0;
    input.addEventListener("input", () => {
      const now = Date.now();
      if (now - lastTyping > 2000) {
        lastTyping = now;
        socket.emit("typing:start", { room: currentRoom() });
      }
    });
    $("#chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit("message:send", { room: currentRoom(), text });
      input.value = "";
      input.focus();
    });
  }

  // ---------- Effects (partikel, cursor glow, ripple) ----------
  function initEffects() {
    // Partikel mengambang
    const host = $("#particles");
    for (let i = 0; i < 26; i++) {
      const p = document.createElement("i");
      p.className = "particle";
      const size = 2 + Math.random() * 5;
      p.style.cssText = `
        left:${Math.random() * 100}%;
        width:${size}px;height:${size}px;
        opacity:${0.08 + Math.random() * 0.2};
        animation-duration:${14 + Math.random() * 18}s;
        animation-delay:${-Math.random() * 20}s;
        background:${Math.random() > 0.5 ? "var(--blurple)" : "var(--pink)"};`;
      host.appendChild(p);
    }

    // Cursor glow (skip di layar sentuh)
    const hasFine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (!hasFine) return;
    const cursor = $("#cursor-fx");
    let cx = innerWidth / 2, cy = innerHeight / 2;
    let tx = cx, ty = cy;
    addEventListener("mousemove", (e) => {
      tx = e.clientX;
      ty = e.clientY;
      cursor.classList.toggle("hot", !!e.target.closest("button, .rail-btn, .act-btn, input, .voice-channel-row, .channel, #member-list li"));
    });
    (function follow() {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      cursor.style.transform = `translate(${cx - 260}px, ${cy - 260}px)`;
      requestAnimationFrame(follow);
    })();

    // Ripple di tombol
    document.addEventListener("pointerdown", (e) => {
      const el = e.target.closest("button, .voice-channel-row, .channel");
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const d = Math.max(rect.width, rect.height) * 2;
      const span = document.createElement("span");
      span.className = "ripple";
      span.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - rect.left - d / 2}px;top:${e.clientY - rect.top - d / 2}px;`;
      el.appendChild(span);
      setTimeout(() => span.remove(), 650);
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
      $("#user-avatar").style.background = avatarColor(me.id);
      $("#user-avatar").textContent = avatarText(me.name);
      $("#user-name").textContent = me.name;
    } catch (err) {
      alert("Gagal mendapatkan identitas anonim. Coba muat ulang.");
      return;
    }

    socket = io({ auth: { deviceToken }, reconnectionAttempts: 5 });

    socket.on("connect", () => {
      $("#conn-status").textContent = "online";
      if (me) socket.emit("rooms:join", currentRoom());
      if (inVoice) {
        socket.emit("voice:join");
        socket.emit("voice:state", { micOn: micOn && !deafened, deafened });
      }
    });

    socket.on("disconnect", () => {
      $("#conn-status").textContent = "offline";
    });
    socket.on("connect_error", () => {
      $("#conn-status").textContent = "offline";
    });

    socket.on("identity", (anon) => {
      me = anon;
      $("#user-avatar").style.background = avatarColor(anon.id);
      $("#user-avatar").textContent = avatarText(anon.name);
      $("#user-name").textContent = anon.name;
    });

    socket.on("presence:update", renderPresence);

    socket.on("message:new", (m) => {
      if (m.room !== currentRoom()) return;
      $("#messages-empty").classList.add("hidden");
      $("#messages").appendChild(msgEl(m, true));
      scrollBottom($("#messages"));
    });

    socket.on("room:joined", ({ room }) => loadHistory(room));

    // Typing indicator
    let typingHideTimer = null;
    socket.on("typing", ({ name, room }) => {
      if (room !== currentRoom()) return;
      const line = $("#typing-line");
      line.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span>${escapeHtml(name)} lagi ngetik...`;
      line.classList.remove("hidden");
      clearTimeout(typingHideTimer);
      typingHideTimer = setTimeout(() => line.classList.add("hidden"), 2500);
    });

    // Voice events
    socket.on("voice:users", (list) => {
      voiceUsers = list;
      renderVoiceUsers();
      updateVoiceUi();
    });

    socket.on("voice:speaking", ({ id, speaking: sp }) => setVoiceSpeaking(id, sp));

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
    $$(".rail-btn").forEach((b) => b.addEventListener("click", () => setModule(b.dataset.module)));
    $("#voice-channel-item").addEventListener("click", toggleVoice);
    $("#mic-btn").addEventListener("click", toggleMic);
    $("#deafen-btn").addEventListener("click", toggleDeafen);
    $("#screen-btn").addEventListener("click", toggleScreen);

    bindChatForm();
    updateVoiceUi();
    initEffects();
    setModule("chat");

    $("#loading").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  init();
})();
