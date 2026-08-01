const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";

let db;

function init() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    db = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 10000,
    });
    db.query("SELECT 1").catch((err) => {
      console.error("Postgres tidak bisa dihubungi:", err.message);
      process.exit(1);
    });
    console.log("Database: PostgreSQL");
  } else {
    const Database = require("better-sqlite3");
    db = new Database(path.join(__dirname, "data.sqlite"));
    db.pragma("journal_mode = WAL");
    console.log("Database: SQLite (data.sqlite)");
  }
  return db;
}

function migrate() {
  const idType = DATABASE_URL ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";

  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id ${idType},
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
      id ${idType},
      room TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `;

  if (DATABASE_URL) {
    const statements = schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    return db.query(statements.join(";"));
  }
  db.exec(schema);
  return Promise.resolve();
}

function normalize(row) {
  if (!row) return null;
  return { ...row };
}

const q = {
  createUser(username, passwordHash) {
    const params = [username, passwordHash];
    if (DATABASE_URL) {
      return db
        .query(
          "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
          params
        )
        .then((r) => normalize(r.rows[0]));
    }
    const info = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(...params);
    return db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(info.lastInsertRowid);
  },

  findUserByUsername(username) {
    if (DATABASE_URL) {
      return db
        .query("SELECT * FROM users WHERE username = $1", [username])
        .then((r) => normalize(r.rows[0]));
    }
    return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  },

  findUserById(id) {
    if (DATABASE_URL) {
      return db
        .query("SELECT id, username FROM users WHERE id = $1", [id])
        .then((r) => normalize(r.rows[0]));
    }
    return db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(id);
  },

  createSession(token, userId) {
    if (DATABASE_URL) {
      return db.query(
        "INSERT INTO sessions (token, user_id) VALUES ($1, $2)",
        [token, userId]
      );
    }
    db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(
      token,
      userId
    );
  },

  findUserByToken(token) {
    if (DATABASE_URL) {
      return db
        .query(
          `SELECT u.id, u.username FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token = $1`,
          [token]
        )
        .then((r) => normalize(r.rows[0]));
    }
    return db
      .prepare(
        `SELECT u.id, u.username FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(token);
  },

  deleteSession(token) {
    if (DATABASE_URL) {
      return db.query("DELETE FROM sessions WHERE token = $1", [token]);
    }
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  },

  getMessages(room, limit = 50) {
    if (DATABASE_URL) {
      return db
        .query(
          `SELECT id, room, username, text, created_at
           FROM messages WHERE room = $1
           ORDER BY created_at ASC LIMIT $2`,
          [room, limit]
        )
        .then((r) => r.rows);
    }
    return db
      .prepare(
        `SELECT id, room, username, text, created_at
         FROM messages WHERE room = ?
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(room, limit);
  },

  addMessage(room, userId, username, text) {
    const params = [room, userId, username, text];
    if (DATABASE_URL) {
      return db
        .query(
          `INSERT INTO messages (room, user_id, username, text)
           VALUES ($1, $2, $3, $4)
           RETURNING id, room, username, text, created_at`,
          params
        )
        .then((r) => normalize(r.rows[0]));
    }
    const info = db
      .prepare(
        "INSERT INTO messages (room, user_id, username, text) VALUES (?, ?, ?, ?)"
      )
      .run(...params);
    return db
      .prepare(
        "SELECT id, room, username, text, created_at FROM messages WHERE id = ?"
      )
      .get(info.lastInsertRowid);
  },
};

module.exports = { init, migrate, q, isPostgres: Boolean(DATABASE_URL) };
