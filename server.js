require("dotenv").config();
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || "chat-forum-dev-secret";

const ROOMS = [
  { id: "general", label: "General", desc: "Obrolan bebas untuk semua topik" },
  { id: "tech", label: "Teknologi", desc: "Bahasa pemrograman, gadget, AI" },
  { id: "gaming", label: "Gaming", desc: "Diskusi game dan e-sport" },
  { id: "otaku", label: "Anime & Otaku", desc: "Anime, manga, dan budaya pop" },
  { id: "music", label: "Musik & Film", desc: "Lagu, film, dan serial" },
];

db.init();
db.migrate().then(() => {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  function signToken(token) {
    return crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(token)
      .digest("hex");
  }

  function createToken() {
    const raw = crypto.randomBytes(32).toString("hex");
    return `${raw}.${signToken(raw)}`;
  }

  function verifyToken(token) {
    if (!token || typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    return signToken(parts[0]) === parts[1];
  }

  function getToken(req) {
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) return auth.slice(7);
    return req.body.token || req.query.token || null;
  }

  function error(res, status, message) {
    return res.status(status).json({ error: message });
  }

  async function authedUser(req) {
    const token = getToken(req);
    if (!token || !verifyToken(token)) return null;
    return db.findUserByToken(token);
  }

  // ---------- API ----------

  app.post("/api/register", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const name = String(username || "").trim();
      if (name.length < 3 || name.length > 20)
        return error(res, 400, "Username harus 3-20 karakter.");
      if (!/^[A-Za-z0-9_.-]+$/.test(name))
        return error(res, 400, "Username hanya boleh huruf, angka, titik, strip.");
      if (!password || String(password).length < 6)
        return error(res, 400, "Password minimal 6 karakter.");

      const existing = await db.findUserByUsername(name);
      if (existing) return error(res, 409, "Username sudah dipakai.");

      const passwordHash = bcrypt.hashSync(String(password), 10);
      const user = await db.createUser(name, passwordHash);
      const token = createToken();
      await db.createSession(token, user.id);

      res.json({ token, user: { id: user.id, username: user.username } });
    } catch (err) {
      console.error(err);
      error(res, 500, "Terjadi kesalahan server.");
    }
  });

  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const name = String(username || "").trim();
      const user = await db.findUserByUsername(name);
      if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash))
        return error(res, 401, "Username atau password salah.");

      const token = createToken();
      await db.createSession(token, user.id);
      res.json({ token, user: { id: user.id, username: user.username } });
    } catch (err) {
      console.error(err);
      error(res, 500, "Terjadi kesalahan server.");
    }
  });

  app.post("/api/logout", async (req, res) => {
    try {
      const token = getToken(req);
      if (token) await db.deleteSession(token);
      res.json({ ok: true });
    } catch (err) {
      error(res, 500, "Terjadi kesalahan server.");
    }
  });

  app.get("/api/me", async (req, res) => {
    try {
      const user = await authedUser(req);
      if (!user) return error(res, 401, "Belum login.");
      res.json({ user });
    } catch (err) {
      error(res, 500, "Terjadi kesalahan server.");
    }
  });

  app.get("/api/rooms", (req, res) => {
    res.json({ rooms: ROOMS });
  });

  app.get("/api/history", async (req, res) => {
    try {
      const room = String(req.query.room || "general");
      if (!ROOMS.some((r) => r.id === room))
        return error(res, 400, "Room tidak ditemukan.");
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const messages = await db.getMessages(room, limit);
      res.json({ messages });
    } catch (err) {
      error(res, 500, "Terjadi kesalahan server.");
    }
  });

  // ---------- Socket.io ----------

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token || !verifyToken(token)) return next(new Error("auth_failed"));
    try {
      const user = await db.findUserByToken(token);
      if (!user) return next(new Error("auth_failed"));
      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error("auth_failed"));
    }
  });

  const rate = new Map();

  io.on("connection", (socket) => {
    const user = socket.data.user;
    socket.join("general");
    socket.emit("rooms:list", ROOMS);

    socket.on("rooms:join", (roomId) => {
      if (!ROOMS.some((r) => r.id === roomId)) return;
      socket.leaveAll?.();
      socket.join(roomId);
      socket.emit("room:joined", { room: roomId });
    });

    socket.on("message:send", async (payload) => {
      const room = String(payload?.room || "general");
      if (!ROOMS.some((r) => r.id === room)) return;

      const text = String(payload?.text || "").trim().slice(0, 2000);
      if (!text) return;

      const key = socket.id;
      const now = Date.now();
      const last = rate.get(key);
      if (last && now - last < 500) return;
      rate.set(key, now);

      try {
        const msg = await db.addMessage(room, user.id, user.username, text);
        io.to(room).emit("message:new", msg);
      } catch (err) {
        console.error(err);
      }
    });

    socket.on("disconnect", () => {
      rate.delete(socket.id);
    });
  });

  server.listen(PORT, () => {
    console.log(`Chat Forum jalan di port ${PORT}`);
  });
});
