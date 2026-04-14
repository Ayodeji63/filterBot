/**
 * api.js — Express REST API + Google OAuth callback
 */

import express from "express";
import { analyzeMessage } from "./filter.js";
import {
  upsertUser,
  getUser,
  getOpportunitiesForUser,
  markCalendarAdded,
  getAllUsers,
} from "./db.js";
import { getWhatsAppClient } from "./whatsapp.js";
import { saveTokensFromCode, getAuthUrl } from "./calendar.js";

export function createApiRouter() {
  const router = express.Router();

  // ── Health / status ────────────────────────────────────
  router.get("/status", (req, res) => {
    const wa = getWhatsAppClient();
    res.json({
      ok: true,
      whatsapp: wa?.info ? "connected" : "disconnected",
      waNumber: wa?.info?.wid?.user || null,
      users: getAllUsers().length,
      uptime: Math.floor(process.uptime()),
    });
  });

  // ── Google OAuth callback ──────────────────────────────
  // Google redirects here: /auth/google/callback?code=XXX&state=BASE64_PHONE
  router.get("/google/callback", async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.error("Google OAuth error:", error);
      return res.send(buildHtmlPage(
        "Connection failed",
        `Google returned an error: ${error}. Please try again by sending !calendar to the bot.`,
        false
      ));
    }

    if (!code || !state) {
      return res.status(400).send(buildHtmlPage(
        "Invalid request",
        "Missing code or state. Please try the link again.",
        false
      ));
    }

    let phone;
    try {
      phone = Buffer.from(state, "base64").toString("utf8");
    } catch {
      return res.status(400).send(buildHtmlPage(
        "Invalid state",
        "Could not identify your account. Please try again.",
        false
      ));
    }

    try {
      await saveTokensFromCode(code, phone);

      // Send WhatsApp confirmation
      const wa = getWhatsAppClient();
      if (wa?.info) {
        try {
          const numberId = await wa.getNumberId(phone);
          if (numberId) {
            await wa.sendMessage(
              numberId._serialized,
              `*Google Calendar connected!*\n\n` +
              `Your calendar is now linked. Reply *1* to any opportunity to add it straight to your Google Calendar with reminders`
            );
          }
        } catch (waErr) {
          console.error("Could not send WA confirmation:", waErr.message);
        }
      }

      res.send(buildHtmlPage(
        "Google Calendar connected!",
        "You can close this tab and go back to WhatsApp. I have sent you a confirmation message.",
        true
      ));
    } catch (err) {
      console.error("Token exchange error:", err.message);
      res.status(500).send(buildHtmlPage(
        "Something went wrong",
        `Could not connect your calendar: ${err.message}. Please try again.`,
        false
      ));
    }
  });

  // ── Analyse a single message ───────────────────────────
  router.post("/analyze", async (req, res) => {
    const { message, profile } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    try {
      const result = await analyzeMessage(message, profile || {});
      res.json({ ok: true, result });
    } catch (err) {
      console.error("Analyze error:", err);
      res.status(500).json({ error: "Analysis failed", detail: err.message });
    }
  });

  // ── Create / update user profile ───────────────────────
  router.post("/users", async (req, res) => {
    const { phone, name, skills, eventTypes, interests, bio } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });
    try {
      const user = await upsertUser(phone, { name, skills, eventTypes, interests, bio });
      res.json({ ok: true, user });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get user profile ───────────────────────────────────
  router.get("/users/:phone", (req, res) => {
    const user = getUser(req.params.phone);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, user });
  });

  // ── List opportunities for a user ──────────────────────
  router.get("/opportunities/:phone", (req, res) => {
    res.json({ ok: true, opportunities: getOpportunitiesForUser(req.params.phone) });
  });

  // ── Mark opportunity added to calendar (API) ───────────
  router.post("/opportunities/:id/calendar", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });
    await markCalendarAdded(req.params.id, phone);
    res.json({ ok: true, message: "Marked as added to calendar" });
  });

  return router;
}

// ── HTML page served after OAuth ─────────────────────────

function buildHtmlPage(title, message, success) {
  const color = success ? "#22c55e" : "#ef4444";
  const emoji = success ? "success" : "error";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#111;border:1px solid #222;border-radius:16px;padding:40px 32px;max-width:400px;width:100%;text-align:center}
    h1{font-size:22px;font-weight:700;color:${color};margin-bottom:12px}
    p{font-size:15px;color:#9ca3af;line-height:1.6}
    .brand{margin-top:32px;font-size:13px;color:#4b5563}
    .brand span{color:#c8f060}
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="brand">filter<span>.</span>bot</div>
  </div>
</body>
</html>`;
}