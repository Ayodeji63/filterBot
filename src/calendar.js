/**
 * calendar.js — Google Calendar integration
 *
 * Handles:
 *   - Generating OAuth URLs per user
 *   - Exchanging auth codes for tokens
 *   - Storing + refreshing tokens per user
 *   - Creating calendar events with reminders
 */

import { google } from "googleapis";
import { saveGoogleTokens, getGoogleTokens } from "./db.js";

// ── OAuth2 client factory ────────────────────────────────

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Generate an OAuth URL for a specific user.
 * We embed the user's phone in the `state` param so we know
 * who to save the token for after the callback.
 *
 * @param {string} phone — user's phone number
 * @returns {string}     — URL to send the user
 */
export function getAuthUrl(phone) {
  const oauth2Client = makeOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",   // get refresh_token so it works long-term
    prompt: "consent",        // force consent screen so refresh_token is always returned
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: Buffer.from(phone).toString("base64"), // encode phone safely in URL
  });
}

/**
 * Exchange a one-time auth code (from OAuth callback) for tokens,
 * then persist them for this user.
 *
 * @param {string} code  — code from ?code= in the callback URL
 * @param {string} phone — user's phone number
 */
export async function saveTokensFromCode(code, phone) {
  const oauth2Client = makeOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  await saveGoogleTokens(phone, tokens);
  console.log(`🗓  Google Calendar connected for ${phone}`);
  return tokens;
}

/**
 * Get an authenticated OAuth2 client for a user.
 * Automatically refreshes the access token if expired.
 *
 * @param {string} phone
 * @returns {OAuth2Client | null}
 */
export async function getAuthedClient(phone) {
  const tokens = getGoogleTokens(phone);
  if (!tokens) return null;

  const oauth2Client = makeOAuthClient();
  oauth2Client.setCredentials(tokens);

  // Auto-save refreshed tokens
  oauth2Client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveGoogleTokens(phone, merged);
    console.log(`🔄 Google tokens refreshed for ${phone}`);
  });

  return oauth2Client;
}

/**
 * Check whether a user has connected Google Calendar.
 * @param {string} phone
 * @returns {boolean}
 */
export function hasCalendarConnected(phone) {
  return !!getGoogleTokens(phone);
}

/**
 * Create a Google Calendar event for an opportunity.
 *
 * @param {string} phone      — user's phone number
 * @param {object} analysis   — the Claude analysis object
 * @param {string} oppId      — opportunity ID (for description link)
 * @returns {{ eventId, eventLink } | null}
 */
export async function createCalendarEvent(phone, analysis, oppId) {
  const authClient = await getAuthedClient(phone);
  if (!authClient) {
    throw new Error("Google Calendar not connected for this user");
  }

  const calendar = google.calendar({ version: "v3", auth: authClient });

  // ── Parse deadline into a usable date ───────────────────
  const { startDate, endDate } = parseDates(analysis.deadline);

  // ── Build event description ──────────────────────────────
  const descLines = [
    analysis.summary || "",
    "",
    analysis.prizeOrBenefit ? `🎁 Prize/Benefit: ${analysis.prizeOrBenefit}` : null,
    analysis.applyLink      ? `🔗 Apply here: ${analysis.applyLink}`          : null,
    "",
    `💡 ${analysis.whyRelevant || ""}`,
    "",
    `─────────────────`,
    `Filtered by FilterBot (ref: ${oppId})`,
  ].filter((l) => l !== null).join("\n");

  const event = {
    summary: `${typeEmoji(analysis.type)} ${analysis.title || "Opportunity"}`,
    description: descLines,
    start: { date: startDate },   // all-day event on the deadline
    end:   { date: endDate },
    colorId: colorForType(analysis.type),
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 48 * 60 },  // 48h before
        { method: "popup", minutes: 24 * 60 },  // 24h before
        { method: "email", minutes: 48 * 60 },  // email 48h before
      ],
    },
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
  });

  const eventLink = response.data.htmlLink;
  const eventId   = response.data.id;

  console.log(`📅 Calendar event created for ${phone}: ${eventLink}`);
  return { eventId, eventLink };
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Try to parse a deadline string into { startDate, endDate }.
 * Falls back to 30 days from now if unparseable.
 */
function parseDates(deadlineStr) {
  let date = null;

  if (deadlineStr) {
    // Try direct Date parse first
    const parsed = new Date(deadlineStr);
    if (!isNaN(parsed)) {
      date = parsed;
    } else {
      // Try to extract something like "May 15" or "15 May 2025"
      const attempt = new Date(deadlineStr.replace(/(\d+)(st|nd|rd|th)/i, "$1"));
      if (!isNaN(attempt)) date = attempt;
    }
  }

  // Default: 30 days from now
  if (!date || date < new Date()) {
    date = new Date();
    date.setDate(date.getDate() + 30);
  }

  const startDate = date.toISOString().split("T")[0]; // YYYY-MM-DD
  // End date = next day (Google Calendar all-day events are exclusive end)
  const endDateObj = new Date(date);
  endDateObj.setDate(endDateObj.getDate() + 1);
  const endDate = endDateObj.toISOString().split("T")[0];

  return { startDate, endDate };
}

function typeEmoji(type) {
  return {
    Hackathon:    "🚀",
    Competition:  "🏆",
    Grant:        "💰",
    Scholarship:  "🎓",
    Job:          "💼",
    Internship:   "🎓",
    Workshop:     "🛠",
    Conference:   "🎤",
    Research:     "🔬",
    "Open Source":"💻",
  }[type] ?? "📌";
}

// Google Calendar event color IDs
function colorForType(type) {
  return {
    Hackathon:   "2",  // Sage green
    Competition: "5",  // Banana yellow
    Grant:       "4",  // Flamingo pink
    Scholarship: "7",  // Peacock blue
    Job:         "8",  // Graphite
    Internship:  "1",  // Lavender
    Workshop:    "6",  // Tangerine
    Conference:  "3",  // Grape purple
  }[type] ?? "1";
}