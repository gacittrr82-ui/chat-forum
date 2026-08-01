# HIDDEN SOCIETY Forums

Chat forum anonim realtime (Node.js + Express + Socket.io). Tanpa daftar akun —
setiap pengunjung otomatis mendapat identitas **ANONIM-<nomor>** sesuai urutan
pertama kali masuk.

## Fitur

- **Identitas anonim otomatis**: `ANONIM-1`, `ANONIM-2`, ... Nomor diberikan
  berdasarkan urutan kedatangan dan permanen untuk tiap perangkat.
- **Chat Forum**: obrolan dengan beberapa ruang topik (General, Teknologi,
  Gaming, Anime, Musik & Film).
- **Help Forum**: ruang chat khusus bantuan komunitas.
- **Voice**: voice chat (microphone) + share screen. **Kamera sengaja tidak
  dipakai** demi privasi.
- **Daftar online**: siapa saja yang sedang berada di forum.
- Riwayat pesan tersimpan di file `data.json`.

## Struktur

```
server.js          # Express + Socket.io + API + signaling voice
db.js              # Penyimpanan JSON murni JS (tanpa modul native)
public/index.html  # Halaman utama forum
public/js/app.js   # Logika client (chat, presence, WebRTC voice)
public/css/style.css
render.yaml        # (opsional) konfigurasi Render
```

## Menjalankan secara lokal (opsional)

```bash
npm install
npm start
# buka http://localhost:3000
```

## Deploy ke Belmo (gratis, tanpa kartu, server selalu hidup)

1. Pastikan repo di GitHub (branch `main`).
2. Di https://belmo.io → Connect GitHub → **New service → API**.
3. Pilih repo, branch `main`, biarkan build/start otomatis (`npm install` /
   `npm start`).
4. Klik **Deploy**. Setelah Live, situs terbuka di URL
   `https://<nama>.app.belmo.io` / `onbelmo.uk`.

## Catatan

- Data tersimpan di file `data.json`. Pada hosting, disk bisa di-reset saat
  deploy ulang, sehingga riwayat bisa hilang (normal untuk hosting gratis).
- Identitas anonim memakai token perangkat di `localStorage`; menghapus
  localStorage akan mendapatkan nomor baru.
- Voice memakai WebRTC mesh (p2p langsung antar browser), cocok untuk jumlah
  peserta sedikit.
