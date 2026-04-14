# FilterBot — Phase 2: WhatsApp Backend

A Node.js server that connects to WhatsApp, watches group messages in real time, runs them through Claude AI, and DMs users only the opportunities that match their profile.

---

## Architecture

```
WhatsApp Group
      │
      ▼
whatsapp-web.js (Puppeteer session)
      │  incoming group messages
      ▼
filter.js (Claude Haiku)
      │  score each message vs each user profile
      ▼
notifier.js
      │  build formatted WhatsApp DM
      ▼
User's WhatsApp DM
      │  replies: "1" (calendar) / "2" (remind) / "3" (dismiss)
      ▼
db.js (lowdb JSON)          api.js (Express REST)
                                  │
                                  ▼
                          Phase 1 React frontend
```

---

## Quick Start

### 1. Prerequisites

- Node.js 18+
- A WhatsApp account (the number that will join your target groups)
- An Anthropic API key → [console.anthropic.com](https://console.anthropic.com)

### 2. Install

```bash
cd filterbot
npm install
```

> **Note:** `whatsapp-web.js` uses Puppeteer, which downloads Chromium (~170MB) on first install. This is normal.

### 3. Configure

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 4. Run

```bash
npm run dev
```

On first run, a **QR code** will appear in the terminal.  
Open WhatsApp on your phone → **Linked Devices** → **Link a Device** → scan the QR.

Once you see `✅ WhatsApp ready`, the bot is live.

---

## How Users Register

Anyone can register by DMing the bot's number:

```
NAME: Tunde Okafor
SKILLS: React, Python, Machine Learning
LOOKING FOR: Hackathon, Grant, Competition
INTERESTS: fintech, edtech
```

The bot replies with a confirmation and starts filtering for them immediately.

---

## Monitoring Groups

By default, the bot watches **all groups** the WhatsApp number is in.

To restrict to specific groups, find the group IDs (logged on startup) and add them to `.env`:

```env
MONITORED_GROUPS=120363XXXXXXXXXX@g.us,120363YYYYYYYYYY@g.us
```

---

## API Endpoints

The Express server exposes a REST API for the frontend:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/status` | Bot health, WA connection, user count |
| `POST` | `/api/analyze` | Analyse a message (no auth needed) |
| `POST` | `/api/users` | Register/update a user profile |
| `GET`  | `/api/users/:phone` | Get a user's profile |
| `GET`  | `/api/opportunities/:phone` | List saved opportunities |
| `POST` | `/api/opportunities/:id/calendar` | Mark added to calendar |
| `POST` | `/api/test-send` | (dev only) Send a test DM |

### Example: Register a user via API

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "2348012345678",
    "name": "Tunde Okafor",
    "skills": ["React", "Python"],
    "eventTypes": ["Hackathon", "Grant"],
    "interests": ["fintech"]
  }'
```

### Example: Analyse a message

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "message": "🚀 HackLagos 2025 is open! $10k prize pool. Deadline May 15. Register: https://hacklagos.dev",
    "profile": { "skills": ["React"], "eventTypes": ["Hackathon"] }
  }'
```

---

## Project Structure

```
filterbot/
├── src/
│   ├── index.js       ← Entry point, wires everything together
│   ├── whatsapp.js    ← WhatsApp client, message routing
│   ├── filter.js      ← Claude AI message analysis
│   ├── notifier.js    ← WhatsApp message formatters
│   ├── db.js          ← JSON database (lowdb)
│   └── api.js         ← Express REST API
├── data/
│   ├── db.json        ← Auto-created on first run
│   └── .wwebjs_auth/  ← WhatsApp session (auto-created)
├── .env.example
└── package.json
```

---

## Deployment (Railway / Render)

1. Push this folder to a GitHub repo
2. Connect to [Railway](https://railway.app) or [Render](https://render.com)
3. Set environment variables: `ANTHROPIC_API_KEY`, `PORT`
4. On first deploy, check the logs for the QR code and scan it
5. Session is persisted in `./data/.wwebjs_auth` — mount a volume if needed

---

## Phase 3: What's Next

- [ ] **Google Calendar integration** — wire the "1" reply to actually create calendar events
- [ ] **Cron-based reminders** — replace in-memory timers with `node-cron` for reliability
- [ ] **Multi-group support** — let users subscribe to specific groups
- [ ] **Web dashboard** — connect Phase 1 React app to this backend
- [ ] **Auth** — JWT or Supabase for proper multi-user login
- [ ] **URL scraping** — follow links in messages for richer opportunity details

---

## Cost Estimate

Using Claude Haiku (fastest + cheapest model):
- ~$0.0008 per message analysis
- A group with 50 messages/day, 20 users = ~$0.80/day

Well within free tier for testing, and cheap to scale.
# filterBot
