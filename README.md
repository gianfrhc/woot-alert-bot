# 🔔 Woot Deal Alert Bot

Real-time deal monitoring dashboard for [Woot.com](https://www.woot.com) with push notifications via **ntfy.sh** and **Discord webhooks**.

![Dashboard](https://img.shields.io/badge/Status-Production-brightgreen) ![Docker](https://img.shields.io/badge/Docker-Ready-blue) ![Node](https://img.shields.io/badge/Node.js-20+-green) ![ARM64](https://img.shields.io/badge/ARM64-Raspberry%20Pi-red)

## ✨ Features

- **📊 Live Dashboard** — Real-time deal grid with discount badges, pricing, and countdown timers
- **🔍 Smart Filters** — Hot (≥60%), Great (≥40%), New, Ending Soon, Warehouse, Favorites
- **🏷️ Keyword Alerts** — Custom keyword buttons for targeted monitoring (OR logic)
- **📱 ntfy.sh Push Notifications** — Mobile alerts via [ntfy.sh](https://ntfy.sh)
- **💬 Discord Webhooks** — Rich embed notifications to Discord channels
- **🔐 Password Auth** — Secure SHA-256 hashed authentication with rate limiting
- **🌙 Quiet Hours** — Configurable notification blackout periods
- **📥 CSV Export** — Export all deals to spreadsheet
- **📱 PWA Ready** — Installable as a mobile app
- **⚡ Zero Dependencies** — Pure Node.js, no npm install needed

## 🐳 Deploy on Raspberry Pi 5 (Docker)

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/woot-alert-bot.git
cd woot-alert-bot
```

### 2. Create data directory

```bash
mkdir -p data
```

### 3. Build and run

```bash
docker compose up -d --build
```

### 4. Access the dashboard

Open `http://YOUR_PI_IP:8080` in your browser.

> **First run:** A random password will be generated and shown in the logs:
> ```bash
> docker compose logs woot-bot
> ```
> Look for: `🔑 First-run password: XXXXXX`

### 5. Configure your API key

1. Login with the generated password
2. Click ⚙️ Settings
3. Paste your [Woot API key](https://developer.woot.com)
4. Configure ntfy.sh topic and/or Discord webhook
5. Click **Save & Apply**

## 🔧 Configuration

All settings are persisted in `./data/` and survive container rebuilds:

| File | Purpose |
|---|---|
| `data/auth.json` | Hashed password |
| `data/settings.json` | API key, keywords, thresholds, notifications |
| `data/sessions.json` | Active login sessions |
| `data/ntfy-logs.json` | Notification history |

## 🛠️ Docker Commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# View logs
docker compose logs -f woot-bot

# Rebuild after updates
git pull
docker compose up -d --build

# Reset password (delete auth file, restart to regenerate)
rm data/auth.json
docker compose restart woot-bot
```

## 💻 Run Without Docker

```bash
node server.js
# Open http://localhost:8080
```

## 📡 Notification Setup

### ntfy.sh (Mobile Push)
1. Install [ntfy app](https://ntfy.sh) on your phone
2. Subscribe to a topic (e.g., `my-woot-deals`)
3. Enter the same topic in Settings → Notifications

### Discord Webhook
1. Server Settings → Integrations → Webhooks → New Webhook
2. Copy the webhook URL
3. Paste in Settings → Notifications → Discord Webhook

## 📝 License

MIT
