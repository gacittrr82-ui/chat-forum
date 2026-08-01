const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ALT_DATA_FILE = path.join(os.tmpdir(), "chat-forum-data.json");

// Penyimpanan murni JavaScript (file JSON). Tidak ada dependensi native,
// jadi aman di platform hosting mana pun.

let jsonDb = null;
let dataFile = DATA_FILE;

function defaultState() {
  return {
    anonCounter: 0,
    anonUsers: [], // { id, device_token, created_at }
    messages: [], // { id, room, user_id, username, text, created_at }
    seq: { messages: 0 },
  };
}

function loadJsonDb() {
  if (jsonDb) return jsonDb;
  let pathToUse = DATA_FILE;
  if (!fs.existsSync(pathToUse) && fs.existsSync(ALT_DATA_FILE)) {
    pathToUse = ALT_DATA_FILE;
  }
  dataFile = pathToUse;
  let state = defaultState();
  if (fs.existsSync(pathToUse)) {
    try {
      state = { ...defaultState(), ...JSON.parse(fs.readFileSync(pathToUse, "utf8")) };
    } catch (_) {
      state = defaultState();
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

function init() {
  loadJsonDb();
  console.log("Database: JSON file (data.json)");
}

function migrate() {
  return Promise.resolve();
}

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const q = {
  // Kembalikan identitas anonim untuk sebuah perangkat.
  // Nomor diambil dari urutan pertama kali perangkat itu datang.
  getOrCreateAnon(deviceToken) {
    const state = loadJsonDb();
    let u = state.anonUsers.find((x) => x.device_token === deviceToken);
    if (u) return { id: u.id, name: "ANONIM-" + u.id };
    state.anonCounter += 1;
    const anon = { id: state.anonCounter, device_token: deviceToken, created_at: now() };
    state.anonUsers.push(anon);
    saveJsonDb();
    return { id: anon.id, name: "ANONIM-" + anon.id };
  },

  getAnonByToken(deviceToken) {
    const state = loadJsonDb();
    const u = state.anonUsers.find((x) => x.device_token === deviceToken);
    return u ? { id: u.id, name: "ANONIM-" + u.id } : null;
  },

  getMessages(room, limit = 50) {
    return loadJsonDb()
      .messages.filter((m) => m.room === room)
      .slice(-limit);
  },

  addMessage(room, userId, username, text) {
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
    return { ...msg };
  },
};

module.exports = {
  init,
  migrate,
  ...q,
  q,
};
