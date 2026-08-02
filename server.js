require("dotenv").config();
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const db = require("./db");

const PORT = process.env.PORT || 8080;

const VALID_ROOMS = new Set(["general", "help", "voice"]);

const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
const ALLOWED_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "mp4", "webm", "pdf", "txt", "zip",
]);

// Deteksi akses dari localhost -> khusus pemilik (owner)
function isLocalIp(addr) {
  if (!addr) return false;
  return addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.") || addr === "localhost";
}

function applyOwner(anon, local) {
  if (!local) return anon;
  return { ...anon, name: "ANONIM-666", role: "owner" };
}

db.init();
db.migrate().then(() => {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  app.use(express.json({ limit: "12mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  // Identitas anonim: pengunjung tidak perlu daftar.
  app.post("/api/anon", (req, res) => {
    try {
      const token = String((req.body || {}).deviceToken || "");
      if (token.length < 8 || token.length > 64)
        return res.status(400).json({ error: "Token tidak valid." });
      const local = isLocalIp(req.ip || req.socket?.remoteAddress);
      const anon = applyOwner(db.q.getOrCreateAnon(token), local);
      res.json({ anon });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Terjadi kesalahan server." });
    }
  });

  // Upload file (base64 via JSON, tanpa dependensi tambahan)
  app.post("/api/upload", (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || "").slice(0, 120);
      const b64 = String(body.data || "");
      if (!name || !b64) return res.status(400).json({ error: "File tidak valid." });
      const size = Math.round((b64.length * 3) / 4);
      if (size > 8 * 1024 * 1024)
        return res.status(413).json({ error: "File terlalu besar (maks 8MB)." });

      let ext = path.extname(name).toLowerCase().replace(".", "");
      if (!ALLOWED_EXT.has(ext)) ext = "dat";
      const safeName = "f_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + "." + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), Buffer.from(b64, "base64"));

      const type = String(body.type || "application/octet-stream").slice(0, 80);
      res.json({ url: "/uploads/" + safeName, name, size, type });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Gagal menyimpan file." });
    }
  });

  app.get("/api/history", async (req, res) => {
    try {
      const room = String(req.query.room || "general");
      if (!VALID_ROOMS.has(room))
        return res.status(400).json({ error: "Room tidak ditemukan." });
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const messages = await db.q.getMessages(room, limit);
      res.json({ messages });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Terjadi kesalahan server." });
    }
  });

  // ---------- Presence ----------

  const presence = new Map(); // anonId -> { id, name, role, color, avatar_emoji, count }

  function broadcastPresence() {
    const list = [...presence.values()].map(({ id, name, role, color, avatar_emoji }) => ({
      id, name, role, color, avatar_emoji,
    }));
    io.emit("presence:update", list);
  }

  // ---------- Socket.io ----------

  io.use((socket, next) => {
    const token = socket.handshake.auth?.deviceToken;
    if (!token || token.length < 8) return next(new Error("no_token"));
    try {
      const local = isLocalIp(socket.handshake.address);
      const anon = applyOwner(db.q.getAnonByToken(token) || db.q.getOrCreateAnon(token), local);
      socket.data.token = token;
      socket.data.local = local;
      socket.data.anon = anon;
      next();
    } catch (err) {
      next(new Error("anon_failed"));
    }
  });

  const rate = new Map();

  io.on("connection", (socket) => {
    const anon = socket.data.anon;
    const prev = presence.get(anon.id) || { id: anon.id, name: anon.name, role: anon.role, color: anon.color, avatar_emoji: anon.avatar_emoji, count: 0 };
    prev.count += 1;
    prev.name = anon.name;
    prev.color = anon.color;
    prev.avatar_emoji = anon.avatar_emoji;
    presence.set(anon.id, prev);
    broadcastPresence();

    socket.emit("identity", anon);

    socket.on("rooms:join", (roomId) => {
      if (!VALID_ROOMS.has(roomId)) return;
      socket.leaveAll?.();
      socket.join(roomId);
      socket.emit("room:joined", { room: roomId });
    });

    socket.on("message:send", async (payload) => {
      const room = String(payload?.room || "general");
      if (!VALID_ROOMS.has(room)) return;
      const text = String(payload?.text || "").trim().slice(0, 2000);
      if (!text && !payload?.attachment) return;

      const key = socket.id;
      const nowT = Date.now();
      const last = rate.get(key);
      if (last && nowT - last < 500) return;
      rate.set(key, nowT);

      try {
        const msg = await db.q.addMessage(room, anon.id, anon.name, text, {
          reply_to: payload?.reply_to ? Number(payload.reply_to) : null,
          mentions: Array.isArray(payload?.mentions) ? payload.mentions.slice(0, 30) : [],
          attachment: payload?.attachment || null,
          color: anon.color || null,
          avatar_emoji: anon.avatar_emoji || null,
          role: anon.role || null,
        });
        io.to(room).emit("message:new", msg);
      } catch (err) {
        console.error(err);
      }
    });

    socket.on("typing:start", (data) => {
      const room = String(data?.room || "general");
      if (!VALID_ROOMS.has(room)) return;
      socket.broadcast.to(room).emit("typing", { name: anon.name, room });
    });

    // ---------- Profil ----------
    socket.on("profile:update", (profile) => {
      const updated = db.q.updateProfile(socket.data.token, profile);
      if (!updated) return;
      socket.data.anon = applyOwner(updated, socket.data.local);
      const p = presence.get(socket.data.anon.id);
      if (p) {
        p.name = socket.data.anon.name;
        p.color = socket.data.anon.color;
        p.avatar_emoji = socket.data.anon.avatar_emoji;
        presence.set(p.id, p);
      }
      socket.emit("identity", socket.data.anon);
      broadcastPresence();
    });

    // ---------- Reaksi emoji ----------
    socket.on("reaction:add", (data) => {
      const msg = db.q.findMessage(data?.messageId);
      if (!msg) return;
      const emoji = String(data?.emoji || "").slice(0, 8);
      if (!emoji) return;
      const reactions = db.q.addReaction(msg.id, emoji, anon.id);
      io.to(msg.room).emit("reaction:update", { id: msg.id, reactions });
    });

    socket.on("reaction:remove", (data) => {
      const msg = db.q.findMessage(data?.messageId);
      if (!msg) return;
      const emoji = String(data?.emoji || "").slice(0, 8);
      if (!emoji) return;
      const reactions = db.q.removeReaction(msg.id, emoji, anon.id);
      io.to(msg.room).emit("reaction:update", { id: msg.id, reactions });
    });

    // ---------- Hapus pesan ----------
    socket.on("message:delete", (data) => {
      const msg = db.q.findMessage(data?.messageId);
      if (!msg) return;
      const isOwner = anon.role === "owner";
      if (db.q.deleteMessage(msg.id, anon.id, isOwner)) {
        io.to(msg.room).emit("message:deleted", { id: msg.id });
      }
    });

    // ---------- Voice ----------

    const voiceUsers = new Map(); // anonId -> { id, name, micOn, deafened }

    function broadcastVoice() {
      const list = [...voiceUsers.values()];
      io.emit("voice:users", list);
    }

    socket.on("voice:join", () => {
      voiceUsers.set(anon.id, { id: anon.id, name: anon.name, micOn: true, deafened: false });
      broadcastVoice();
      socket.voiceJoined = true;
      socket.broadcast.emit("voice:peer-joined", { from: socket.id, anon });
    });

    socket.on("voice:leave", () => {
      if (voiceUsers.delete(anon.id)) broadcastVoice();
      socket.voiceJoined = false;
      socket.broadcast.emit("voice:peer-left", { from: socket.id });
    });

    socket.on("voice:state", (data) => {
      const cur = voiceUsers.get(anon.id);
      if (cur) {
        cur.micOn = data?.micOn !== false;
        cur.deafened = data?.deafened === true;
        broadcastVoice();
      }
    });

    socket.on("voice:speaking", (data) => {
      if (voiceUsers.has(anon.id)) {
        io.emit("voice:speaking", { id: anon.id, speaking: data?.speaking === true });
      }
    });

    socket.on("voice:offer", (data) => {
      if (data?.target && data?.sdp) {
        io.to(data.target).emit("voice:offer", { from: socket.id, sdp: data.sdp });
      }
    });

    socket.on("voice:answer", (data) => {
      if (data?.target && data?.sdp) {
        io.to(data.target).emit("voice:answer", { from: socket.id, sdp: data.sdp });
      }
    });

    socket.on("voice:ice", (data) => {
      if (data?.target && data?.candidate) {
        io.to(data.target).emit("voice:ice", { from: socket.id, candidate: data.candidate });
      }
    });

    socket.on("disconnect", () => {
      rate.delete(socket.id);
      if (voiceUsers.delete(anon.id)) broadcastVoice();
      const p = presence.get(anon.id);
      if (p) {
        p.count -= 1;
        if (p.count <= 0) presence.delete(anon.id);
      }
      broadcastPresence();
      io.emit("peer:left", { socketId: socket.id, anon });
    });
  });

  server.listen(PORT, () => {
    console.log(`HIDDEN SOCIETY Forums jalan di port ${PORT}`);
  });
});
