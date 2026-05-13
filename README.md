# SN Meta Auto

Chrome Extension (Manifest V3) untuk **batch prompt automation** di [Meta AI](https://www.meta.ai/). Mendukung mode **Image**, **Video**, dan **Image to Video**, lengkap dengan tool untuk scan media hasil dan download massal dengan pola nama kustom.

> SN Meta Auto bekerja dengan akun Meta AI kamu yang sudah login di browser. Extension ini tidak bypass limit, tidak spam, dan tidak memakai API ilegal — semua otomasi dilakukan lewat UI Meta AI secara stabil.

---

## Fitur Utama

- **Prompt queue**: tulis manual (1 baris = 1 prompt) atau upload `.txt`.
- **Tiga mode**: `IMAGE`, `VIDEO`, `IMAGE TO VIDEO` (upload banyak gambar, batch default 10).
- **Start / Stop / Resume / Reset** queue. Resume melanjutkan dari item belum selesai.
- **Robust DOM detection**: `findPromptInput()` + `findGenerateButton()` menangani `textarea`, `contenteditable`, `role=textbox`, Shadow DOM, dsb.
- **MutationObserver completion detection** — tidak mengandalkan fixed wait.
- **Scan Media** + **Download Selected / All / All Videos** dengan pola `sn_meta_{type}_{index}_{date}` ke subfolder `SN_Meta_Auto/`. Video preview yang disajikan Meta AI sebagai `blob:` URL pun bisa di-download — extension fetch blob lewat content script lalu kirim sebagai data URL ke background untuk disimpan.
- **Queue table** dengan per-item: Retry, Skip, Copy prompt, Remove.
- **Log panel** (maks 50 log terakhir) + **History** batch.
- **Error handling**: page not detected, prompt field not found, timeout, download failed, dsb. Toggle *Stop on error* atau lanjut otomatis (tandai `failed`).
- **Persistent state** via `chrome.storage.local` — prompt dan progress tetap ada saat popup ditutup.
- **Anti double-click**: semua tombol lock saat proses berjalan.

---

## Install (Load Unpacked)

1. Clone / download repo ini, atau unzip ke folder, misal `~/sn-meta-auto`.
2. Buka Chrome → `chrome://extensions`.
3. Aktifkan **Developer mode** (kanan atas).
4. Klik **Load unpacked** → pilih folder repo ini.
5. Pin extension **SN Meta Auto** dari ikon puzzle di toolbar.

### Generate icons (opsional)

Repo sudah menyertakan ikon PNG default. Jika ingin regenerate:

```bash
python3 tools/generate_icons.py
```

---

## Cara Pakai

1. Buka `https://www.meta.ai/` dan login. Biarkan tab tetap aktif.
2. Klik ikon **SN Meta Auto** → popup terbuka.
3. **Prompt Queue** — paste prompt (1 baris = 1 prompt) atau klik **Upload .TXT**.
4. Pilih **Generate Mode**:
   - **IMAGE** → prompt dikirim + tombol generate image diklik.
   - **VIDEO** → prompt dikirim + tombol generate video diklik.
   - **IMAGE TO VIDEO** → upload gambar (bulk, banyak file sekaligus) di panel `I2V`; tiap gambar jadi item queue. Prompt di textarea **opsional** — kalau kosong, tiap item pakai default `imagine it`. Kalau cuma satu baris prompt, dipakai untuk semua gambar; kalau banyak baris, dipasangkan posisional dengan urutan gambar.
5. Atur **Settings**:
   - `Delay per task` (default 3 detik)
   - `Max batch` untuk I2V (default 10)
   - `Timeout per task` (default 180 detik)
   - `Filename pattern` — token: `{type}`, `{index}`, `{date}`, `{time}`, `{ts}`, `{ext}`
   - `Download subfolder` (default `SN_Meta_Auto`)
   - `Stop on error` — kalau off, item gagal ditandai `failed` dan queue lanjut.
   - `Auto-download` — download media baru setelah tiap task.
6. Klik **Start**. Pantau progress di **Queue** dan **Logs**.
7. Kalau ingin berhenti sementara → **Stop**. Resume → lanjut dari item berikutnya.
8. Klik **Reset Queue** untuk mulai dari nol.
9. **Tools Tambahan** → **Scan Media** untuk mengumpulkan semua image/video yang terlihat di halaman, lalu **Download Selected** / **Download All** / **Download All Videos**. Tombol **Download All Videos** otomatis scan + filter ke type video saja (cocok untuk batch save semua hasil VIDEO atau IMAGE TO VIDEO).

### Catatan tentang video preview

Meta AI menyajikan video hasil generasi pada `<video src="blob:...">`. URL blob ini scoped ke document Meta AI (bukan ke service worker extension), jadi extension melakukan ini secara internal:

1. Content script (yang berjalan di tab Meta AI) menerima request `FETCH_BLOB_AS_DATA_URL`.
2. Content script `fetch(blob)` untuk mendapatkan bytes-nya, lalu encode jadi base64 data URL.
3. Background service worker menerima data URL dan memanggil `chrome.downloads.download` dengan filename pattern + subfolder seperti biasa.

Untuk video yang disajikan via **MediaSource (MSE/HLS)**, langkah 2 akan mengembalikan blob kosong — dalam kasus ini download akan gagal dengan pesan jelas, dan user perlu menggunakan video tersebut dari halaman Meta AI secara manual.

### Filename pattern

Default: `sn_meta_{type}_{index}_{date}`

Contoh hasil:
- `SN_Meta_Auto/sn_meta_image_001_20260428.png`
- `SN_Meta_Auto/sn_meta_video_001_20260428.mp4`

Token tersedia: `{type}`, `{index}` (3 digit, zero-padded), `{date}` (`YYYYMMDD`), `{time}` (`HHMMSS`), `{ts}` (unix ms), `{ext}`.

---

## Struktur File

```
sn-meta-auto/
├─ manifest.json
├─ popup.html
├─ popup.css
├─ popup.js
├─ content.js
├─ background.js
├─ utils/
│  ├─ domScanner.js   # findPromptInput, findGenerateButton, waitForCompletion, dll
│  ├─ queueManager.js # helpers untuk queue state
│  ├─ downloader.js   # filename pattern + chrome.downloads wrapper
│  └─ storage.js      # chrome.storage.local wrapper + defaults
├─ icons/             # icon16 / 48 / 128
└─ README.md
```

---

## Catatan Teknis

- **Upload gambar untuk I2V**: extension mencari `input[type=file]` di halaman Meta AI lalu mengatur `FileList` via `DataTransfer`. Jika Meta AI memblokir injection tersebut (CSP atau framework tertentu), extension menampilkan instruksi manual dan **tidak crash** — upload manual lalu tekan **Resume**.
- **Shadow DOM**: `domScanner.js` traversal via `walkAll()` mencakup `shadowRoot` yang terbuka.
- **Completion detection**: kombinasi `MutationObserver` + polling 1.2s + timeout konfigurabel (default 180s). Baseline media ditangkap sebelum klik generate; media baru dianggap hasil.
- **Service worker eviction**: loop orchestrator hidup di `background.js`. Selama queue berjalan, message rutin keluar-masuk sehingga service worker tetap aktif.
- **No page refresh**: extension tidak pernah me-reload halaman otomatis.

---

## Troubleshooting

| Problem | Solusi |
|---|---|
| "Meta AI tab not found" | Buka `https://www.meta.ai/` terlebih dahulu di tab yang sama dengan window extension. |
| "Prompt field not found" | Scroll ke bagian chat/prompt di Meta AI, pastikan input prompt kelihatan. Lalu klik **Retry** item. |
| "Generate button not found" | Tombol kemungkinan disabled karena prompt kosong atau halaman berubah. Periksa manual lalu Retry. |
| "Timeout waiting for result" | Naikkan `Timeout per task` di Settings. Prompt kompleks atau video butuh waktu lebih lama. |
| "File input not found" | Upload gambar secara manual di Meta AI, lalu tekan **Resume**. |
| Download gagal | Cek permission `Downloads` di `chrome://extensions`. Pastikan pola nama valid (hindari karakter aneh). |

---

## Lisensi

MIT — silakan gunakan dan modifikasi.
