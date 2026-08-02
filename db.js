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
    anonUsers: [], // { id, device_token, created_at, display_name, color, avatar_emoji }
    messages: [], // { id, room, user_id, username, text, created_at, reply_to, mentions, attachment, reactions }
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

function publicAnon(u) {
  return {
    id: u.id,
    name: u.display_name || "ANONIM-" + u.id,
    color: u.color || null,
    avatar_emoji: u.avatar_emoji || null,
  };
}

const q = {
  // Kembalikan identitas anonim untuk sebuah perangkat.
  // Nomor diambil dari urutan pertama kali perangkat itu datang.
  getOrCreateAnon(deviceToken) {
    const state = loadJsonDb();
    let u = state.anonUsers.find((x) => x.device_token === deviceToken);
    if (u) return publicAnon(u);
    state.anonCounter += 1;
    const anon = { id: state.anonCounter, device_token: deviceToken, created_at: now() };
    state.anonUsers.push(anon);
    saveJsonDb();
    return publicAnon(anon);
  },

  getAnonByToken(deviceToken) {
    const state = loadJsonDb();
    const u = state.anonUsers.find((x) => x.device_token === deviceToken);
    return u ? publicAnon(u) : null;
  },

  updateProfile(deviceToken, profile) {
    const state = loadJsonDb();
    const u = state.anonUsers.find((x) => x.device_token === deviceToken);
    if (!u) return null;
    const name = String(profile?.name || "").trim().slice(0, 20);
    if (name) u.display_name = name;
    if (profile?.color) u.color = String(profile.color).slice(0, 9);
    if (profile?.avatar_emoji) u.avatar_emoji = String(profile.avatar_emoji).slice(0, 4);
    saveJsonDb();
    return publicAnon(u);
  },

  getMessages(room, limit = 50) {
    return loadJsonDb()
      .messages.filter((m) => m.room === room)
      .slice(-limit);
  },

  findMessage(id) {
    return loadJsonDb().messages.find((m) => m.id === Number(id)) || null;
  },

  addMessage(room, userId, username, text, extra = {}) {
    const state = loadJsonDb();
    state.seq.messages += 1;
    const msg = {
      id: state.seq.messages,
      room,
      user_id: userId,
      username,
      text,
      created_at: now(),
      reply_to: extra.reply_to || null,
      mentions: Array.isArray(extra.mentions) ? extra.mentions : [],
      attachment: extra.attachment || null,
      reactions: {},
    };
    state.messages.push(msg);
    saveJsonDb();
    return { ...msg };
  },

  addReaction(messageId, emoji, userId) {
    const state = loadJsonDb();
    const msg = state.messages.find((m) => m.id === Number(messageId));
    if (!msg) return null;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    if (!msg.reactions[emoji].includes(userId)) msg.reactions[emoji].push(userId);
    saveJsonDb();
    return { ...msg.reactions };
  },

  removeReaction(messageId, emoji, userId) {
    const state = loadJsonDb();
    const msg = state.messages.find((m) => m.id === Number(messageId));
    if (!msg) return null;
    if (!msg.reactions) msg.reactions = {};
    if (msg.reactions[emoji]) {
      msg.reactions[emoji] = msg.reactions[emoji].filter((id) => id !== userId);
      if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    }
    saveJsonDb();
    return { ...msg.reactions };
  },

  deleteMessage(messageId, userId, isOwner) {
    const state = loadJsonDb();
    const idx = state.messages.findIndex((m) => m.id === Number(messageId));
    if (idx === -1) return false;
    const msg = state.messages[idx];
    if (msg.user_id !== userId && !isOwner) return false;
    state.messages.splice(idx, 1);
    saveJsonDb();
    return true;
  },
};

module.exports = {
  init,
  migrate,
  ...q,
  q,
};
