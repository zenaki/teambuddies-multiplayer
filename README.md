# Team Buddies Web

Menjalankan **Team Buddies (PS1)** di browser, dengan multiplayer online sampai **4 pemain** (sesuai split-screen + multitap game aslinya).

## Cara kerja

```
 Host (browser)                                         Tamu (browser, P2..P4)
 ┌───────────────────────────────┐   video+audio (WebRTC)   ┌─────────────────────┐
 │ EmulatorJS + pcsx_rearmed     │ ───────────────────────▶ │ <video>             │
 │ disc dimuat dari disk lokal   │ ◀─────────────────────── │ keyboard/gamepad/   │
 │ multitap port 1: P1..P4       │   state pad 12 byte      │ tombol sentuh       │
 └──────────────┬────────────────┘   (DataChannel)          └──────────┬──────────┘
                └──────────── server.js (statis + signaling WebSocket) ┘
```

- **Hanya host yang butuh file game.** File dibaca langsung oleh browser host dan tidak pernah di-upload ke server.
- Core `pcsx_rearmed` sudah punya BIOS HLE bawaan, jadi tidak perlu file BIOS Sony.
- Opsi `pcsx_rearmed_multitap = "port 1"` diset otomatis. Host = P1, tamu mendapat P2, P3, P4 sesuai urutan masuk.
- Input tamu dikirim sebagai snapshot state pad: 16 tombol + 4 sumbu analog, plus nomor urut. Kanalnya tidak reliable (latensi rendah), tapi snapshot dikirim ulang tiap 100 ms, jadi paket yang hilang tidak membuat tombol "nyangkut". Kalau tamu putus, host otomatis melepas semua tombolnya.

## Menjalankan

```bash
npm install
npm start            # http://localhost:8080   (PORT=xxxx untuk port lain)
```

1. Host membuka `/host.html` lalu memilih file **`.cue` + semua `.bin`** sekaligus, atau satu arsip `.zip`/`.7z` berisi keduanya.
2. Klik **Mulai game & buka room**. Akan muncul kode room dan link undangan.
3. Teman membuka link tersebut (atau `/` → masukkan kode), lalu klik layar untuk mengaktifkan suara dan kontrol.
4. Di dalam game, masuk ke mode multiplayer. Tiap pemain menekan START di slot multitap masing-masing.

**Tab host harus tetap terlihat.** Browser memperlambat tab di latar belakang, sehingga emulator ikut melambat.

## GitHub Pages (tanpa server)

Aplikasi ini juga bisa di-hosting sebagai situs statis. Di mode ini signaling memakai broker publik **PeerJS** (`0.peerjs.com`), bukan `server.js`.

1. Buat repo GitHub baru, lalu push isi folder ini (file game otomatis diabaikan oleh `.gitignore`).
2. Di repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push ke `main`. Workflow `.github/workflows/pages.yml` akan menjalankan `npm run build:static` lalu men-deploy `dist/`.
4. Buka `https://<username>.github.io/<nama-repo>/`.

Cek build-nya secara lokal: `npm run build:static`, lalu sajikan `dist/` dengan web server statis apa pun.

Opsional (lewat **Settings → Secrets and variables → Actions**):

| Variable / Secret | Fungsi |
|---|---|
| `TURN_URL`, `TURN_USER` (variable), `TURN_PASS` (secret) | TURN server untuk jaringan yang ketat |
| `PEER_HOST` (variable) | memakai PeerServer sendiri (`npx peerjs --port 9000`) kalau broker publik sedang down |

Catatan: broker publik PeerJS gratis tapi tanpa jaminan uptime. Nilai `TURN_PASS` ikut masuk ke `config.json` publik (memang begitu cara kerja WebRTC), jadi gunakan kredensial TURN yang terbatas, bukan password penting.

## Main lewat internet (dengan server.js)

Server harus bisa diakses teman-teman, dan sebaiknya lewat **HTTPS**: Gamepad API dan tombol salin link hanya aktif di secure context, sementara `localhost` dianggap aman.

- **Cepat (dari PC host):** jalankan `npm start`, lalu buka tunnel HTTPS, misalnya `cloudflared tunnel --url http://localhost:8080` atau `ngrok http 8080`. Bagikan URL-nya.
- **Permanen:** deploy ke layanan yang mendukung WebSocket (Render, Fly.io, Railway, VPS) memakai `Dockerfile` yang disediakan.

### NAT / TURN
Video berjalan peer-to-peer. Kebanyakan jaringan rumah cukup dengan STUN (default `stun:stun.l.google.com:19302`). Kalau status tamu `failed` (biasanya di jaringan seluler atau kantor), pasang TURN server (mis. coturn) dan set:

```bash
TURN_URL=turn:turn.example.com:3478 TURN_USER=user TURN_PASS=pass npm start
# opsional: STUN_URLS=stun:a:3478,stun:b:3478
```

## Kontrol (host & tamu sama)

| PS1 | Keyboard | Gamepad (layout standar) |
|---|---|---|
| D-pad | panah | D-pad |
| ✕ ○ □ △ | X Z S A | A B X Y |
| L1 R1 L2 R2 | Q E Tab R | LB RB LT RT |
| Start / Select | Enter / V | Start / Back |
| Analog kiri | T F G H | stik kiri |

Di HP, tamu mendapat tombol sentuh di bawah layar.

## Struktur

| File | Isi |
|---|---|
| `server.js` | server statis + signaling room (kode 5 huruf, maks 4 pemain), `/config.json` (ICE), bundel `emulator.min.js` |
| `public/host.html`, `host.js` | memuat disc, menjalankan EmulatorJS, men-stream kanvas + audio OpenAL, menyuntikkan input tamu |
| `public/play.html`, `play.js` | penerima stream, input keyboard/gamepad/sentuh, ping |
| `public/common.js` | protokol input, mapping tombol, signaling WebSocket/PeerJS, penulis ZIP (STORE) untuk cue+bin lepas |
| `scripts/build-static.js` | build `dist/` untuk GitHub Pages |
| `.github/workflows/pages.yml` | deploy otomatis ke Pages |

## Batasan yang diketahui

- Latensi tamu = latensi jaringan + encode/decode video (biasanya +40–120 ms lewat internet). Game ini bergaya aksi santai, jadi masih nyaman. Pemain di LAN yang sama hampir tanpa jeda.
- Kualitas video tamu menyesuaikan bandwidth (maks 4 Mbps, prioritas framerate).
- Memuat disc butuh RAM sekitar 1.5 GB di browser host (image 520 MB disalin ke memori emulator).
- Save game dan save state tersimpan di browser host (IndexedDB EmulatorJS).

## Legal
Gunakan hanya disc yang kamu miliki sendiri. Jangan menaruh file game di server atau membagikannya. Aplikasi ini sengaja dirancang agar file game tidak pernah keluar dari komputer host.
