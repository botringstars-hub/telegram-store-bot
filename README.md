# Ringstars Telegram Store

Bot toko Telegram untuk menjual produk digital yang Anda miliki atau memiliki izin resmi untuk mendistribusikannya.

Fitur:

- Katalog dan checkout Telegram
- Pengiriman stok otomatis setelah pembayaran
- Kode promo
- Panel admin web
- Program reseller/referral
- Notifikasi transaksi
- Midtrans Sandbox
- Mode pembayaran demo

## Deploy ke Railway

1. Hubungkan repository ini ke Railway.
2. Tambahkan environment variables dari `.env.example`.
3. Isi `TELEGRAM_BOT_TOKEN` hanya di Railway, jangan di GitHub.
4. Biarkan `DEMO_MODE=true` selama pengujian.
5. Setelah domain Railway dibuat, isi `PUBLIC_BASE_URL` dengan domain tersebut.
6. Buka `https://domain-railway/admin` untuk panel admin.

Bot menggunakan long polling. Endpoint notifikasi Midtrans:

`POST /payments/midtrans/notification`

Data disimpan ke `DATA_PATH`. Untuk produksi, pasang Railway Volume pada `/app/data` agar data tidak hilang ketika redeploy.

## Penting

Jangan menjual APK, akun, atau lisensi tanpa izin pemilik layanan. Mode demo tidak memproses uang nyata.
