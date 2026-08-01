require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const db = require("./db");

const PORT = process.env.PORT || 3000;

// Room chat forum (bertab topik)
const FORUM_ROOMS = [
  { id: "general", label: "General", emoji: "💬", desc: "Obrolan bebas semua topik" },
  { id: "tech", label: "Teknologi", emoji: "💻", desc: "Bahasa pemrograman, gadget, AI" },
  { id: "gaming", label: "Gaming", emoji: "🎮", desc: "Diskusi game dan e-sport" },
  { id: "otaku", label: "Anime", emoji: "🌟", desc: "Anime, manga, budaya pop" },
  { id: "music", label: "Musik & Film", emoji: "🎵", desc: "Lagu, film, dan serial" },
];

// Semua room yang valid (chat forum + help + voice)
const VALID_ROOMS = new Set([
  ...FORUM_ROOMS.map((r) => r.id),
  "help",
  "voice",
]);

const MODULES = [
  { id: "chat", label: "Chat Forum", emoji: "💬" },
  { id: "help", label: "Help Forum", emoji: "🆘" },
  { id: "voice", label: "Voice", emoji: "🎙️" },
];

db.init();
db.migrate().then(() => {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Identitas anonim: pengunjung tidak perlu daftar.
  // Nomor mengikuti urutan pertama kali perangkat masuk.
  app.post("/api/anon", (req, res) => {
    try {
      const token = String((req.body || {}).deviceToken || "");
      if (token.length < 8 || token.length > 64)
        return res.status(400).json({ error: "Token tidak valid." });
      const anon = db.q.getOrCreateAnon(token);
      res.json({ anon });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Terjadi kesalahan server." });
    }
  });

  app.get("/api/rooms", (req, res) => {
    res.json({ rooms: FORUM_ROOMS });
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

  // ---------- Presence (siapa yang online) ----------

  const presence = new Map(); // anonId -> { id, name, count }

  function broadcastPresence() {
    const list = [...presence.values()].map(({ id, name }) => ({ id, name }));
    io.emit("presence:update", list);
  }

  // ---------- Socket.io ----------

  io.use((socket, next) => {
    const token = socket.handshake.auth?.deviceToken;
    if (!token || token.length < 8) return next(new Error("no_token"));
    try {
      const anon = db.q.getAnonByToken(token) || db.q.getOrCreateAnon(token);
      socket.data.anon = anon;
      next();
    } catch (err) {
      next(new Error("anon_failed"));
    }
  });

  const rate = new Map();

  io.on("connection", (socket) => {
    const anon = socket.data.anon;
    const prev = presence.get(anon.id) || { id: anon.id, name: anon.name, count: 0 };
    prev.count += 1;
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
      if (!text) return;

      const key = socket.id;
      const nowT = Date.now();
      const last = rate.get(key);
      if (last && nowT - last < 500) return;
      rate.set(key, nowT);

      try {
        const msg = await db.q.addMessage(room, anon.id, anon.name, text);
        io.to(room).emit("message:new", msg);
      } catch (err) {
        console.error(err);
      }
    });

    // ---------- Voice signaling (mic + share screen, tanpa kamera) ----------

    socket.on("voice:join", () => {
      socket.broadcast.emit("voice:peer-joined", { from: socket.id, anon });
    });

    socket.on("voice:leave", () => {
      socket.broadcast.emit("voice:peer-left", { from: socket.id });
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
