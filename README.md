# BetZone - Fantasy Betting Website

Portföy projesi olarak geliştirilmiş fantezi bahis sitesi.
Fantasy betting website developed as a portfolio project.

## 🚀 Kurulum / Setup

```bash
# 1. Bağımlılıkları yükle / Install dependencies
cd betsite
npm install

# 2. API anahtarını ayarla / Set your API key
cp .env.example .env
# .env dosyasını düzenle ve API_FOOTBALL_KEY değerini gir
# Edit .env and enter your API_FOOTBALL_KEY

# 3. Sunucuyu başlat / Start the server
npm start
```

Tarayıcıda `http://localhost:8000` adresine gidin.

> **API anahtarı olmadan da çalışır!** Mock veri ile başlar, API bağlanınca gerçek veriye geçer.
> **Works without an API key!** Starts with mock data, switches to real data once API is connected.

## 🔑 API Anahtarı / API Key

1. https://dashboard.api-football.com/ adresinden ücretsiz hesap oluştur
2. API anahtarını kopyala
3. `.env` dosyasına yapıştır:
   ```
   API_FOOTBALL_KEY=buraya_anahtarini_yaz
   ```

**⚠️ `.env` dosyası `.gitignore` ile korunmaktadır — asla Git'e pushlanmaz.**

## ⏰ Veri Güncelleme Takvimi / Fetch Schedule

| Zaman | İşlem | Günlük API Çağrısı (tahmini) |
|-------|-------|------------------------------|
| 00:00, 12:00 | Fikstür + Oran (tam yenileme) | ~12 |
| 04:00, 08:00, 16:00, 20:00 | Sadece oran güncellemesi | ~30 |
| Her saat (:30) | Biten maç skorları | ~10 |
| **Toplam** | | **~50/gün** |

Ücretsiz plan limiti: 100 istek/gün — rahatça yeterli.

## 👥 Kullanıcılar / Users

`public/js/config.js` dosyasında tanımlıdır:

| Kullanıcı | Şifre | İsim |
|-----------|-------|------|
| ali | ali123 | Ali Yılmaz |
| mehmet | mehmet123 | Mehmet Demir |
| ayse | ayse123 | Ayşe Kaya |
| emre | emre123 | Emre Çelik |
| zeynep | zeynep123 | Zeynep Arslan |

Yeni kullanıcı eklemek için `USERS` dizisine giriş ekleyin.

## 🔑 Admin Paneli

- URL: `/admin.html`
- Kullanıcı: `admin`
- Şifre: `admin2024`

Kredi ekleme ve kullanıcı yönetimi buradan yapılır.

## 📁 Dosya Yapısı

```
betsite/
├── .env                    # API anahtarı (GIT'E EKLEME!)
├── .env.example            # Şablon
├── .gitignore
├── package.json
├── server.js               # Express sunucu + zamanlayıcı
├── fetch-data.js           # API-Football veri çekici
├── data/
│   └── matches.json        # Önbelleklenmiş maç verisi (otomatik)
├── public/                 # Frontend dosyaları
│   ├── index.html          # Giriş sayfası
│   ├── app.html            # Ana bahis sayfası
│   ├── admin.html          # Yönetici paneli
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── config.js       # Kullanıcılar ve ayarlar
│       ├── i18n.js         # Dil dosyaları (TR/EN/DE)
│       └── matches.js      # Veri yükleyici (API + mock fallback)
└── README.md
```

## 🛠 Manuel Komutlar / Manual Commands

```bash
# Tek seferlik tam yenileme
node fetch-data.js --once

# Sadece oranları güncelle
node fetch-data.js --odds

# Sadece skorları kontrol et
node fetch-data.js --scores
```

## 🌐 Canlıya Alma / Deployment

Herhangi bir Node.js hosting platformunda çalışır:

1. **Railway / Render / Fly.io** (önerilen):
   - Repo'yu bağla
   - Environment variable olarak `API_FOOTBALL_KEY` ekle
   - Start command: `npm start`

2. **VPS (DigitalOcean, Hetzner vs.)**:
   ```bash
   git clone <repo>
   cd betsite
   npm install
   cp .env.example .env  # anahtarı düzenle
   npm start
   ```
   PM2 ile arka planda çalıştır: `pm2 start server.js --name betzone`

## 💡 Notlar

- Kullanıcı verileri tarayıcının localStorage'ında saklanır
- Gerçek para kullanılmaz, tamamen fantezi/eğitim amaçlıdır
- Kullanıcılar 0 kredi ile başlar, admin tarafından kredi verilir
- API anahtarı sunucu tarafında kalır, frontend'e asla sızmaz
