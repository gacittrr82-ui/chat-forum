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
  let onlineUsers = [];

  const SERVERS = {
    chat: {
      id: "chat",
      label: "Chat Forum",
      icon: "💬",
      textChannels: [{ id: "general", label: "general", desc: "Obrolan bebas semua topik" }],
      voiceChannels: [],
    },
    helpvoice: {
      id: "helpvoice",
      label: "Help & Voice",
      icon: "🆘",
      textChannels: [{ id: "help", label: "bantuan", desc: "Tanya jawab & bantuan" }],
      voiceChannels: [{ id: "voice", label: "General Voice" }],
    },
  };

  let activeServerId = "chat";
  let activeText = "general";

  function currentRoom() {
    return activeText;
  }

  function currentServer() {
    return SERVERS[activeServerId];
  }

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

  // Cache pesan per room (buat resolusi reply)
  const msgCache = new Map();

  // ---------- Render pesan ----------
  const PALETTE = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

  function highlightMentions(text) {
    return escapeHtml(text).replace(/@([^\s@<]+)/g, '<span class="mention">@$1</span>');
  }

  function renderReactions(container, msg) {
    container.innerHTML = "";
    const reps = msg.reactions || {};
    for (const emoji of Object.keys(reps)) {
      const ids = reps[emoji] || [];
      if (!ids.length) continue;
      const mine = me && ids.includes(me.id);
      const b = document.createElement("button");
      b.className = "react-chip" + (mine ? " mine" : "");
      b.dataset.emoji = emoji;
      b.textContent = `${emoji} ${ids.length}`;
      container.appendChild(b);
    }
  }

  function replyQuote(m) {
    if (!m.reply_to) return "";
    const r = msgCache.get(m.reply_to);
    const name = r ? r.username : "?";
    const text = r ? (r.text || "📎 lampiran").slice(0, 90) : "Pesan telah dihapus";
    return `<div class="reply-quote"><span class="rq-ico">↩️</span><b>${escapeHtml(name)}</b><span class="rq-text">${escapeHtml(text)}</span></div>`;
  }

  function attachmentHtml(a) {
    if (!a) return "";
    const isImg = a.type && a.type.startsWith("image/");
    if (isImg) {
      return `<div class="attach"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" onclick="window.open(this.src)" /></div>`;
    }
    return `<div class="attach file-attach"><a href="${escapeHtml(a.url)}" target="_blank">📄 ${escapeHtml(a.name)}</a><span class="file-size">${formatSize(a.size)}</span></div>`;
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function msgEl(m, animate) {
    const mine = me && m.user_id === me.id;
    const color = m.color || avatarColor(m.user_id);
    const disp = m.avatar_emoji || avatarText(m.username);
    const mentionMe = me && (m.mentions || []).includes(me.id);
    const canDel = me && (mine || me.role === "owner");
    const isOwner = m.role === "owner";

    const div = document.createElement("div");
    div.className = "msg" + (mine ? " mine" : "") + (mentionMe ? " mention-me" : "");
    div.id = "msg-" + m.id;
    div.dataset.id = m.id;
    if (!animate) div.style.animation = "none";

    div.innerHTML = `
      <div class="avatar" style="background:${color}">${escapeHtml(disp)}</div>
      <div class="msg-body">
        ${replyQuote(m)}
        <div class="meta">
          <b style="color:${color}">${escapeHtml(m.username)}</b>
          ${isOwner ? '<span class="badge-owner" title="Owner">👑</span>' : ""}
          <span class="time">${timeLabel(m.created_at)}</span>
        </div>
        ${m.text ? `<div class="bubble">${highlightMentions(m.text)}</div>` : ""}
        ${attachmentHtml(m.attachment)}
        <div class="reactions"></div>
      </div>
      <div class="msg-actions">
        <button class="mact" data-act="react" title="Reaksi">😀</button>
        <button class="mact" data-act="reply" title="Balas">↩️</button>
        ${canDel ? '<button class="mact del" data-act="delete" title="Hapus">🗑️</button>' : ""}
        <div class="msg-palette hidden">
          ${PALETTE.map((e) => `<button class="palette-btn" data-emoji="${e}">${e}</button>`).join("")}
        </div>
      </div>`;

    renderReactions(div.querySelector(".reactions"), m);
    return div;
  }

  function loadHistory(room) {
    const listEl = $("#messages");
    fetch(`/api/history?room=${encodeURIComponent(room)}&limit=50`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        msgCache.clear();
        listEl.innerHTML = "";
        $("#messages-empty").classList.toggle("hidden", data.messages.length > 0);
        for (const m of data.messages) {
          msgCache.set(m.id, m);
          listEl.appendChild(msgEl(m, false));
        }
        scrollBottom(listEl);
      })
      .catch(() => {});
  }

  // ---------- Presence ----------
  function renderPresence(list) {
    onlineUsers = list;
    $("#member-count").textContent = list.length;
    $("#online-count").textContent = list.length;
    const ul = $("#member-list");
    ul.innerHTML = "";
    list.sort((a, b) => a.id - b.id);
    for (const p of list) {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="avatar" style="background:${p.color || avatarColor(p.id)}">${escapeHtml(p.avatar_emoji || avatarText(p.name))}</span>
        <span class="member-name">${escapeHtml(p.name)}</span>
        ${p.role === "owner" ? '<span class="badge-owner" title="Owner">👑</span>' : ""}`;
      if (me && p.id === me.id) li.classList.add("me");
      ul.appendChild(li);
    }
  }

  // ---------- Channel list ----------
  function renderChannels() {
    const server = currentServer();
    const body = $("#channels-body");
    body.innerHTML = "";
    $("#channels-title").textContent = server.label;

    if (server.textChannels.length) {
      const head = document.createElement("div");
      head.className = "channel-heading";
      head.textContent = "Text Channels";
      body.appendChild(head);

      for (const ch of server.textChannels) {
        const row = document.createElement("div");
        row.className = "channel" + (ch.id === activeText ? " active" : "");
        row.dataset.channel = ch.id;
        row.innerHTML = `<span class="channel-hash">#</span><span>${escapeHtml(ch.label)}</span>`;
        body.appendChild(row);
      }
    }

    if (server.voiceChannels.length) {
      const head = document.createElement("div");
      head.className = "channel-heading";
      head.textContent = "Voice Channels";
      body.appendChild(head);

      const vrow = document.createElement("div");
      vrow.className = "voice-channel-row glow-border" + (inVoice ? " joined" : "");
      vrow.id = "voice-channel-item";
      vrow.innerHTML = `
        <span class="vc-icon">🔊</span>
        <span class="vc-label">${escapeHtml(server.voiceChannels[0].label)}</span>
        <span class="vc-status hidden" id="voice-connected-pill">Connected</span>`;
      body.appendChild(vrow);

      const vu = document.createElement("div");
      vu.className = "voice-users";
      vu.id = "voice-users";
      body.appendChild(vu);
    }

    renderVoiceUsers();
    updateVoiceUi();
  }

  function setServer(id) {
    const server = SERVERS[id];
    if (!server) return;
    activeServerId = id;
    $$(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.server === id));

    exitVoice();
    cancelReply();
    cancelAttach();

    const still = server.textChannels.find((ch) => ch.id === activeText);
    activeText = still ? still.id : server.textChannels[0].id;
    renderChannels();
    selectTextChannel(activeText);
  }

  function selectTextChannel(id) {
    activeText = id;
    const server = currentServer();
    const meta = server.textChannels.find((c) => c.id === id);
    $("#pane-title").textContent = "# " + id;
    $("#pane-desc").textContent = meta ? meta.desc : "";
    $("#chat-text").placeholder = `Ketik ke # ${id}...`;

    $$(".channel[data-channel]").forEach((r) => r.classList.toggle("active", r.dataset.channel === id));

    const msgs = $("#messages");
    msgs.classList.remove("fade");
    void msgs.offsetWidth;
    msgs.classList.add("fade");

    socket.emit("rooms:join", id);
    loadHistory(id);
  }

  // ---------- Reply ----------
  let replyState = null;
  function setReply(msg) {
    replyState = { id: msg.id, username: msg.username, text: (msg.text || "📎 lampiran").slice(0, 80) };
    $("#reply-name").textContent = replyState.username;
    $("#reply-text").textContent = replyState.text;
    $("#reply-chip").classList.remove("hidden");
    $("#chat-text").focus();
  }
  function cancelReply() {
    replyState = null;
    $("#reply-chip").classList.add("hidden");
  }

  // ---------- Upload ----------
  let pendingUpload = null;
  async function handleFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      alert("File terlalu besar (maks 8MB).");
      return;
    }
    const fr = new FileReader();
    fr.onload = async () => {
      const b64 = String(fr.result).split(",")[1] || "";
      const chip = $("#attach-chip");
      $("#attach-label").textContent = "📎 Uploading " + file.name + "...";
      chip.classList.remove("hidden");
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, type: file.type, data: b64 }),
        });
        const d = await res.json();
        if (!d.url) throw new Error("upload");
        pendingUpload = d;
        $("#attach-label").textContent = "📎 " + d.name;
      } catch (err) {
        pendingUpload = null;
        chip.classList.add("hidden");
        alert("Upload gagal. Coba lagi.");
      }
    };
    fr.readAsDataURL(file);
  }
  function cancelAttach() {
    pendingUpload = null;
    $("#attach-chip").classList.add("hidden");
  }

  // ---------- Mention picker ----------
  function mentionCandidates() {
    return [me, ...onlineUsers].filter((u, i, arr) => arr.findIndex((x) => x.id === u.id) === i);
  }
  function updateMentionPicker() {
    const input = $("#chat-text");
    const list = $("#mention-list");
    const v = input.value;
    const m = v.match(/@(\S*)$/);
    if (!m) {
      list.classList.add("hidden");
      return;
    }
    const q = m[1].toLowerCase();
    const cands = mentionCandidates().filter((u) => !q || u.name.toLowerCase().includes(q));
    if (!cands.length) {
      list.classList.add("hidden");
      return;
    }
    list.innerHTML = cands
      .map((u) => `<button class="mention-item" data-id="${u.id}">${escapeHtml(u.avatar_emoji || "")}<span>${escapeHtml(u.name)}</span></button>`)
      .join("");
    list.classList.remove("hidden");
  }
  function applyMention(id) {
    const input = $("#chat-text");
    const u = mentionCandidates().find((x) => x.id === id);
    if (!u) return;
    const v = input.value;
    const idx = v.lastIndexOf("@");
    if (idx === -1) return;
    const after = v.slice(idx + 1).replace(/^\S*/, "");
    input.value = v.slice(0, idx) + "@" + u.name + " " + after;
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    $("#mention-list").classList.add("hidden");
  }
  function extractMentions(text) {
    const ids = [];
    const map = new Map(mentionCandidates().map((u) => [u.name, u.id]));
    const re = /@([^\s@]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const id = map.get(m[1]);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // ---------- Voice ----------
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

  function renderVoiceUsers() {
    const el = document.getElementById("voice-users");
    if (!el) return;
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
    $("#voice-stage").classList.toggle("hidden", !inVoice);
    $("#voice-join-banner").classList.toggle(
      "hidden",
      !(currentServer().voiceChannels.length > 0 && !inVoice)
    );

    const pill = document.getElementById("voice-connected-pill");
    if (pill) pill.classList.toggle("hidden", !inVoice);
    const vrow = document.getElementById("voice-channel-item");
    if (vrow) vrow.classList.toggle("joined", inVoice);

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

    if (!inVoice) return;
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

  // ---------- Profil modal ----------
  const COLORS = ["#5865f2", "#ec4899", "#22d3ee", "#f0b232", "#23a55a", "#f23f43", "#a78bfa", "#f97316", "#14b8a6", "#eab308", "#64748b", "#ef4444"];
  const EMOJIS = ["🕶️", "🦊", "🐉", "👻", "👽", "🤖", "🦇", "😎", "👑", "🔥", "💀", "🐺"];
  let selColor = null;
  let selEmoji = null;

  function buildProfilePicker() {
    const cp = $("#pcolor");
    cp.innerHTML = "";
    for (const c of COLORS) {
      const b = document.createElement("button");
      b.className = "swatch" + (c === selColor ? " sel" : "");
      b.style.background = c;
      b.dataset.color = c;
      cp.appendChild(b);
    }
    const ep = $("#pemoji");
    ep.innerHTML = "";
    for (const e of EMOJIS) {
      const b = document.createElement("button");
      b.className = "emojiset" + (e === selEmoji ? " sel" : "");
      b.textContent = e;
      b.dataset.emoji = e;
      ep.appendChild(b);
    }
  }

  function openProfile() {
    selColor = me.color || "#5865f2";
    selEmoji = me.avatar_emoji || "🕶️";
    $("#pname").value = me.name === "ANONIM-666" ? "" : me.name;
    buildProfilePicker();
    $("#profile-modal").classList.remove("hidden");
  }
  function closeProfile() {
    $("#profile-modal").classList.add("hidden");
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
      updateMentionPicker();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("#mention-list").classList.add("hidden");
    });

    $("#chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if ((!text && !pendingUpload) || !socket) return;
      socket.emit("message:send", {
        room: currentRoom(),
        text,
        reply_to: replyState ? replyState.id : null,
        mentions: extractMentions(text),
        attachment: pendingUpload,
      });
      input.value = "";
      cancelReply();
      cancelAttach();
      input.focus();
    });

    $("#attach-btn").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => handleFile(e.target.files[0]));
    $("#attach-cancel").addEventListener("click", cancelAttach);
    $("#reply-cancel").addEventListener("click", cancelReply);

    $("#mention-list").addEventListener("click", (e) => {
      const item = e.target.closest(".mention-item");
      if (item) applyMention(Number(item.dataset.id));
    });
  }

  // ---------- Reaksi & aksi pesan ----------
  function toggleReaction(msgId, emoji) {
    const msg = msgCache.get(msgId);
    if (!msg) return;
    const mine = (msg.reactions && msg.reactions[emoji] || []).includes(me.id);
    socket.emit(mine ? "reaction:remove" : "reaction:add", { messageId: msgId, emoji });
  }

  function bindMessageActions() {
    $("#messages").addEventListener("click", (e) => {
      const mact = e.target.closest(".mact");
      const chip = e.target.closest(".react-chip");
      const pbtn = e.target.closest(".palette-btn");

      if (pbtn) {
        const msgElm = e.target.closest(".msg");
        const id = Number(msgElm && msgElm.dataset.id);
        toggleReaction(id, pbtn.dataset.emoji);
        const pal = msgElm && msgElm.querySelector(".msg-palette");
        if (pal) pal.classList.add("hidden");
        return;
      }

      if (chip) {
        const msgElm = e.target.closest(".msg");
        const id = Number(msgElm && msgElm.dataset.id);
        toggleReaction(id, chip.dataset.emoji);
        return;
      }

      if (mact) {
        const msgElm = mact.closest(".msg");
        const id = Number(msgElm && msgElm.dataset.id);
        const act = mact.dataset.act;
        if (act === "reply") {
          const msg = msgCache.get(id);
          if (msg) setReply(msg);
        } else if (act === "delete") {
          socket.emit("message:delete", { messageId: id });
        } else if (act === "react") {
          const pal = msgElm.querySelector(".msg-palette");
          $$(".msg-palette").forEach((p) => p !== pal && p.classList.add("hidden"));
          pal.classList.toggle("hidden");
        }
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".msg-actions")) {
        $$(".msg-palette").forEach((p) => p.classList.add("hidden"));
      }
    });
  }

  // ---------- Effects ----------
  function initEffects() {
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

    document.addEventListener("pointerdown", (e) => {
      const el = e.target.closest("button, .voice-channel-row, .channel, .mention-item, .react-chip, .palette-btn");
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
  function applyMeToUI() {
    const a = $("#user-avatar");
    a.style.background = me.color || avatarColor(me.id);
    a.textContent = me.avatar_emoji || avatarText(me.name);
    a.classList.toggle("owner", me.role === "owner");
    $("#user-name").textContent = me.name;
  }

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
      applyMeToUI();
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
      applyMeToUI();
    });

    socket.on("presence:update", renderPresence);

    socket.on("message:new", (m) => {
      if (m.room !== currentRoom()) return;
      msgCache.set(m.id, m);
      $("#messages-empty").classList.add("hidden");
      $("#messages").appendChild(msgEl(m, true));
      scrollBottom($("#messages"));
    });

    socket.on("room:joined", ({ room }) => loadHistory(room));

    socket.on("reaction:update", ({ id, reactions }) => {
      const msg = msgCache.get(id);
      if (msg) msg.reactions = reactions;
      const cont = document.querySelector(`#msg-${id} .reactions`);
      if (cont) renderReactions(cont, msg || { reactions });
    });

    socket.on("message:deleted", ({ id }) => {
      const el = document.getElementById("msg-" + id);
      if (el) {
        el.classList.add("deleting");
        setTimeout(() => el.remove(), 300);
      }
      msgCache.delete(id);
    });

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
    $$(".rail-btn").forEach((b) => b.addEventListener("click", () => setServer(b.dataset.server)));

    $("#channels-body").addEventListener("click", (e) => {
      const channelRow = e.target.closest(".channel[data-channel]");
      if (channelRow) {
        selectTextChannel(channelRow.dataset.channel);
        return;
      }
      const vrow = e.target.closest("#voice-channel-item");
      if (vrow) toggleVoice();
    });

    $("#mic-btn").addEventListener("click", toggleMic);
    $("#deafen-btn").addEventListener("click", toggleDeafen);
    $("#screen-btn").addEventListener("click", toggleScreen);

    // Profil modal
    $("#user-avatar").addEventListener("click", openProfile);
    $("#p-cancel").addEventListener("click", closeProfile);
    $("#p-save").addEventListener("click", () => {
      socket.emit("profile:update", {
        name: $("#pname").value,
        color: selColor,
        avatar_emoji: selEmoji,
      });
      closeProfile();
    });
    $("#pcolor").addEventListener("click", (e) => {
      const s = e.target.closest(".swatch");
      if (!s) return;
      selColor = s.dataset.color;
      buildProfilePicker();
    });
    $("#pemoji").addEventListener("click", (e) => {
      const s = e.target.closest(".emojiset");
      if (!s) return;
      selEmoji = s.dataset.emoji;
      buildProfilePicker();
    });

    bindChatForm();
    bindMessageActions();
    initEffects();
    setServer("chat");

    $("#loading").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  init();
})();
