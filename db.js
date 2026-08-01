const fs = require("fs");
const os = require("os");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ALT_DATA_FILE = path.join(os.tmpdir(), "chat-forum-data.json");

// ---------- Penyimpanan default: file JSON murni JS (tanpa modul native) ----------
// Bisa dipakai di platform mana pun. Gunakan DATABASE_URL PostgreSQL bila perlu.

let jsonDb = null;
let pgPool = null;
let dataFile = DATA_FILE;

function loadJsonDb() {
  if (jsonDb) return jsonDb;
  let pathToUse = DATA_FILE;
  if (!fs.existsSync(pathToUse) && fs.existsSync(ALT_DATA_FILE)) {
    pathToUse = ALT_DATA_FILE;
  }
  dataFile = pathToUse;
  let state = { users: [], sessions: [], messages: [], seq: { users: 0, messages: 0 } };
  if (fs.existsSync(pathToUse)) {
    try {
      state = JSON.parse(fs.readFileSync(pathToUse, "utf8"));
      if (!state.users || !state.sessions || !state.messages || !state.seq) {
        state = { users: [], sessions: [], messages: [], seq: { users: 0, messages: 0 } };
      }
    } catch (_) {
      state = { users: [], sessions: [], messages: [], seq: { users: 0, messages: 0 } };
    }
  }
  jsonDb = state;
  return jsonDb;
}

function saveJsonDb() {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(jsonDb));
  } catch (err) {
    if (dataFile === DATA_FILE) {
      dataFile = ALT_DATA_FILE;
      console.warn("Tidak bisa menulis di direktori app, fallback ke:", dataFile);
      try {
        fs.writeFileSync(dataFile, JSON.stringify(jsonDb));
      } catch (e2) {
        console.error("Penyimpanan data tidak tersedia:", e2.message);
      }
    } else {
      console.error("Penyimpanan data tidak tersedia:", err.message);
    }
  }
}

function normalize(row) {
  if (!row) return null;
  return { ...row };
}

function init() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 10000,
    });
    pgPool.query("SELECT 1").catch((err) => {
      console.error("Postgres tidak bisa dihubungi:", err.message);
      process.exit(1);
    });
    console.log("Database: PostgreSQL");
  } else {
    loadJsonDb();
    console.log("Database: JSON file (data.json)");
  }
}

function migrate() {
  if (DATABASE_URL) {
    const schema = `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        room TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `;
    const statements = schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    return pgPool.query(statements.join(";"));
  }
  return Promise.resolve();
}

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const q = {
  async createUser(username, passwordHash) {
    if (DATABASE_URL) {
      const r = await pgPool.query(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
        [username, passwordHash]
      );
      return normalize(r.rows[0]);
    }
    const state = loadJsonDb();
    state.seq.users += 1;
    const user = { id: state.seq.users, username, password_hash: passwordHash, created_at: now() };
    state.users.push(user);
    saveJsonDb();
    return { id: user.id, username: user.username };
  },

  async findUserByUsername(username) {
    if (DATABASE_URL) {
      const r = await pgPool.query("SELECT * FROM users WHERE username = $1", [username]);
      return normalize(r.rows[0]);
    }
    return normalize(loadJsonDb().users.find((u) => u.username === username));
  },

  async findUserById(id) {
    if (DATABASE_URL) {
      const r = await pgPool.query("SELECT id, username FROM users WHERE id = $1", [id]);
      return normalize(r.rows[0]);
    }
    const u = loadJsonDb().users.find((x) => x.id === id);
    return u ? { id: u.id, username: u.username } : null;
  },

  async createSession(token, userId) {
    if (DATABASE_URL) {
      return pgPool.query("INSERT INTO sessions (token, user_id) VALUES ($1, $2)", [
        token,
        userId,
      ]);
    }
    const state = loadJsonDb();
    state.sessions.push({ token, user_id: userId, created_at: now() });
    saveJsonDb();
  },

  async findUserByToken(token) {
    if (DATABASE_URL) {
      const r = await pgPool.query(
        `SELECT u.id, u.username FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = $1`,
        [token]
      );
      return normalize(r.rows[0]);
    }
    const state = loadJsonDb();
    const s = state.sessions.find((x) => x.token === token);
    if (!s) return null;
    const u = state.users.find((x) => x.id === s.user_id);
    return u ? { id: u.id, username: u.username } : null;
  },

  async deleteSession(token) {
    if (DATABASE_URL) {
      return pgPool.query("DELETE FROM sessions WHERE token = $1", [token]);
    }
    const state = loadJsonDb();
    state.sessions = state.sessions.filter((x) => x.token !== token);
    saveJsonDb();
  },

  async getMessages(room, limit = 50) {
    if (DATABASE_URL) {
      const r = await pgPool.query(
        `SELECT id, room, username, text, created_at
         FROM messages WHERE room = $1
         ORDER BY created_at ASC LIMIT $2`,
        [room, limit]
      );
      return r.rows;
    }
    return loadJsonDb()
      .messages.filter((m) => m.room === room)
      .slice(-limit);
  },

  async addMessage(room, userId, username, text) {
    if (DATABASE_URL) {
      const r = await pgPool.query(
        `INSERT INTO messages (room, user_id, username, text)
         VALUES ($1, $2, $3, $4)
         RETURNING id, room, username, text, created_at`,
        [room, userId, username, text]
      );
      return normalize(r.rows[0]);
    }
    const state = loadJsonDb();
    state.seq.messages += 1;
    const msg = {
      id: state.seq.messages,
      room,
      user_id: userId,
      username,
      text,
      created_at: now(),
    };
    state.messages.push(msg);
    saveJsonDb();
    return normalize(msg);
  },
};

module.exports = {
  init,
  migrate,
  isPostgres: Boolean(DATABASE_URL),
  ...q,
  q,
};
