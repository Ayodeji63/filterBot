/**
 * index.js — FilterBot server entry point
 *
 * Boot order:
 *   1. Load env vars
 *   2. Initialise database
 *   3. Start Express API server
 *   4. Initialise WhatsApp client (shows QR if not authenticated)
 */

import "dotenv/config";
import express from "express";
import { mkdirSync } from "fs";
import { initDb } from "./db.js";
import { initWhatsApp } from "./whatsapp.js";
import { createApiRouter } from "./api.js";

// ── Ensure data directory exists ─────────────────────────
mkdirSync("./data", { recursive: true });

// ── Validate required env vars ───────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

async function main() {
  console.log("🤖 FilterBot starting up…\n");

  // 1. Database
  await initDb();

  // 2. Express
  const app = express();
  app.use(express.json());

  // CORS for local frontend dev
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // API routes: /api/status, /api/analyze, /api/users, etc.
  app.use("/api", createApiRouter());

  // Google OAuth callback: /auth/google/callback
  // Must match GOOGLE_REDIRECT_URI in .env exactly
  app.use("/auth", createApiRouter());

  // Serve Phase 1 React build (once you run `npm run build` in the frontend)
  app.use(express.static("../frontend/dist"));

  app.listen(PORT, () => {
    console.log(`🌐 API server running at http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/status\n`);
  });

  // 3. WhatsApp
  initWhatsApp();
}

main().catch((err) => {
  console.error("💥 Fatal startup error:", err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully…");
  process.exit(0);
});