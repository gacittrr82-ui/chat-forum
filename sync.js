// Sinkronisasi data ke instance remote (Belmo).
// - registerBackup(): dipakai di sisi "server penyimpanan" (Belmo) -> menyediakan /api/backup.
// - startLocalSync(): dipakai di sisi exe lokal -> tarik data saat start, dorong berkala.

const http = require("http");
const https = require("https");
const db = require("./db");

function request(url, method, key, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return reject(err);
    }
    u.searchParams.set("key", key);
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request(
      u,
      {
        method,
        headers: data ? { "Content-Type": "application/json" } : {},
        timeout: 15000,
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Endpoint untuk instance penyimpanan (dipanggil di server.js saat ada BACKUP_KEY)
function registerBackup(app, key) {
  app.get("/api/backup", (req, res) => {
    if (req.query.key !== key) return res.status(403).json({ error: "forbidden" });
    res.json(db.exportJson());
  });

  app.post("/api/backup", (req, res) => {
    if (req.query.key !== key) return res.status(403).json({ error: "forbidden" });
    const raw = req.body;
    if (!raw || typeof raw !== "object") return res.status(400).json({ error: "bad payload" });
    db.mergeJson(raw);
    res.json({ ok: true, messages: db.exportJson().messages.length });
  });
}

// Sinkronisasi sisi lokal (exe): tarik data saat start, lalu dorong berkala.
function startLocalSync({ url, key, intervalMs = 60000 }) {
  const api = url.replace(/\/+$/, "") + "/api/backup";

  async function pull() {
    try {
      const r = await request(api, "GET", key);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const before = db.exportJson().messages.length;
        if (data && typeof data === "object" && Array.isArray(data.messages)) {
          db.mergeJson(data);
          const after = db.exportJson().messages.length;
          console.log(
            `[sync] Tarik data dari remote: ${before} -> ${after} pesan (${r.status})`
          );
        }
      } else {
        console.warn(`[sync] Tarik data gagal: HTTP ${r.status}`);
      }
    } catch (err) {
      console.warn("[sync] Gagal tarik data dari remote:", err.message);
    }
  }

  async function push() {
    try {
      const r = await request(api, "POST", key, db.exportJson());
      if (r.status === 200) {
        console.log(`[sync] Data tersimpan ke remote (${db.exportJson().messages.length} pesan)`);
      } else {
        console.warn(`[sync] Kirim data gagal: HTTP ${r.status}`);
      }
    } catch (err) {
      console.warn("[sync] Gagal kirim data ke remote:", err.message);
    }
  }

  console.log(`[sync] Sinkronisasi aktif -> ${api}`);
  pull().then(() => {
    push();
    setInterval(push, intervalMs);
  });
}

module.exports = { registerBackup, startLocalSync };
