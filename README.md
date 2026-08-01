# Chat Forum

Website forum chat realtime (Node.js + Express + Socket.io).

## Fitur

- Realtime chat (WebSocket via Socket.io)
- Register & login (password di-hash dengan bcrypt)
- Multi-room / topik diskusi
- Riwayat chat tersimpan di database (SQLite lokal / PostgreSQL di produksi)
- Token sesi aman

## Struktur

```
server.js          # Express + Socket.io + API
db.js              # Lapisan database (SQLite & PostgreSQL)
public/            # Frontend (HTML/CSS/JS)
render.yaml        # Konfigurasi deploy Render (Blueprint)
.env.example       # Contoh variabel lingkungan
```

## Menjalankan secara lokal (opsional)

```bash
npm install
npm start
# buka http://localhost:3000
```

Tanpa `DATABASE_URL`, pesan otomatis tersimpan di `data.sqlite`.

## Deploy ke Render (gratis)

Cara paling cepat — pakai Blueprint (file `render.yaml` sudah disiapkan):

1. Buat akun di https://render.com (bisa login pakai GitHub).
2. Upload project ini ke GitHub repository.
3. Klik link deploy satu-klik, atau di Render dashboard: **New → Blueprint**, pilih repo, lalu **Apply**.
4. Tunggu build selesai, situs online di URL `https://chat-forum-xxxx.onrender.com`.

### Cara manual (tanpa Blueprint)

1. **New → Web Service** → pilih repo:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
2. Environment Variables:
   - `TOKEN_SECRET` = string acak panjang
3. Deploy.

> Kode ini memakai **SQLite** (tanpa database eksternal). Di Render, disk
> bersifat sementara, jadi riwayat chat tersimpan selama instance tidak
> di-deploy ulang. Kalau mau riwayat permanen, gunakan `DATABASE_URL`
> PostgreSQL (mis. Neon gratis) — kode otomatis mendeteksinya.

## Catatan penting

- Render free tier: server tidur setelah ~15 menit tanpa pengunjung, lalu
  bangun sendiri saat ada yang buka (cold start ~30-60 detik). Ini normal
  dan tidak perlu kartu kredit.
- Ganti `TOKEN_SECRET` dengan nilai acak yang panjang dan jangan dibagikan.
