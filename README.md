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

## Deploy ke Render (gratis, server selalu online)

Cara paling cepat — pakai Blueprint (Postgres dibuat otomatis):

1. Buat akun di https://render.com (bisa login pakai GitHub).
2. Upload project ini ke GitHub repository.
3. Di Render dashboard: **New → Blueprint**, pilih repo, lalu **Apply**.
4. Set variabel `PUBLIC_URL` di service Web = URL situsmu (contoh `https://chat-forum.onrender.com`).
5. Tunggu build selesai, situs online di URL yang diberikan Render.

### Cara manual (tanpa Blueprint)

1. **New → PostgreSQL** → buat database gratis, catat URL-nya.
2. **New → Web Service** → pilih repo:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Environment Variables:
   - `TOKEN_SECRET` = string acak panjang
   - `DATABASE_URL` = URL Postgres dari langkah 1
   - `PUBLIC_URL` = URL situsmu
4. Deploy.

## Deploy ke Railway

1. Upload ke GitHub.
2. Di https://railway.app → **New Project** → **Deploy from GitHub** → pilih repo.
3. Railway otomatis mendeteksi Node.js.
4. **New Database → PostgreSQL**, lalu link ke project.
5. Di tab Variables: tambah `TOKEN_SECRET` (string acak) dan `PUBLIC_URL`.
6. Railway otomatis menyuntik `DATABASE_URL` dari Postgres yang terhubung.
7. Generate domain: **Deployments → Generate Domain**.

## Catatan penting

- **SQLite hanya untuk lokal.** Di Render/Railway disk bersifat sementara,
  jadi selalu pakai `DATABASE_URL` PostgreSQL biar riwayat chat tidak hilang.
- Ganti `TOKEN_SECRET` dengan nilai acak yang panjang dan jangan dibagikan.
