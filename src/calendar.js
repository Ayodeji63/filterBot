/**
 * calendar.js — Google Calendar integration
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

export function getAuthUrl(phone) {
  const oauth2Client = makeOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: Buffer.from(phone).toString("base64"),
  });
}

export async function saveTokensFromCode(code, phone) {
  const oauth2Client = makeOAuthClient();
  try {
    const { tokens } = await oauth2Client.getToken(code);
    await saveGoogleTokens(phone, tokens);
    console.log(`🗓  Google Calendar connected for ${phone}`);
    return tokens;
  } catch (err) {
    console.error("Token exchange error:", err.message);
    throw new Error(`Could not exchange auth code: ${err.message}`);
  }
}

/**
 * Get an authenticated OAuth2 client for a user.
 * Explicitly refreshes the access token if it's expired or missing.
 */
export async function getAuthedClient(phone) {
  const tokens = getGoogleTokens(phone);
  if (!tokens) return null;

  const oauth2Client = makeOAuthClient();

  // Check if access token is expired
  const isExpired =
    !tokens.access_token ||
    (tokens.expiry_date && Date.now() > tokens.expiry_date - 60_000);

  if (isExpired) {
    if (!tokens.refresh_token) {
      console.warn(`⚠️  No refresh token for ${phone} — user needs to reconnect`);
      return null;
    }
    try {
      console.log(`🔄 Refreshing Google token for ${phone}…`);
      oauth2Client.setCredentials(tokens); // set first so refresh works
      const { credentials } = await oauth2Client.refreshAccessToken();
      const merged = { ...tokens, ...credentials };
      await saveGoogleTokens(phone, merged);
      oauth2Client.setCredentials(merged); // set the fresh credentials
      console.log(`✅ Token refreshed for ${phone}`);
    } catch (err) {
      console.error(`❌ Token refresh failed for ${phone}:`, err.message);
      throw new Error(`Google Calendar session expired. Please reconnect by sending *!calendar*`);
    }
  } else {
    oauth2Client.setCredentials(tokens);
  }

  // Verify credentials are actually attached before returning
  const creds = oauth2Client.credentials;
  if (!creds?.access_token) {
    console.error(`❌ No access token attached for ${phone} after setCredentials`);
    return null;
  }

  console.log(`✅ OAuth client ready for ${phone} (token ends: …${creds.access_token.slice(-6)})`);
  return oauth2Client;
}

export function hasCalendarConnected(phone) {
  return !!getGoogleTokens(phone);
}

export async function createCalendarEvent(phone, analysis, oppId) {
  const authClient = await getAuthedClient(phone);
  if (!authClient) {
    throw new Error("Google Calendar not connected. Send *!calendar* to connect.");
  }

  // Debug: confirm token is present
  console.log(`🔑 Auth client credentials present: ${!!authClient.credentials?.access_token}`);

  const calendar = google.calendar({ version: "v3", auth: authClient });

  const { startDate, endDate } = parseDates(analysis.deadline);

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
    start: { date: startDate },
    end:   { date: endDate },
    colorId: colorForType(analysis.type),
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 48 * 60 },
        { method: "popup", minutes: 24 * 60 },
        { method: "email", minutes: 48 * 60 },
      ],
    },
  };

  try {
    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    const eventLink = response.data.htmlLink;
    const eventId   = response.data.id;
    console.log(`📅 Calendar event created for ${phone}: ${eventLink}`);
    return { eventId, eventLink };
  } catch (err) {
    // Unwrap googleapis error for a cleaner message
    const detail = err?.response?.data?.error_description || err.message;
    console.error(`❌ Calendar insert failed for ${phone}:`, detail);
    throw new Error(detail);
  }
}

// ── Helpers ──────────────────────────────────────────────

function parseDates(deadlineStr) {
  let date = null;

  if (deadlineStr) {
    const parsed = new Date(deadlineStr);
    if (!isNaN(parsed)) {
      date = parsed;
    } else {
      const attempt = new Date(deadlineStr.replace(/(\d+)(st|nd|rd|th)/i, "$1"));
      if (!isNaN(attempt)) date = attempt;
    }
  }

  if (!date || date < new Date()) {
    date = new Date();
    date.setDate(date.getDate() + 30);
  }

  const startDate = date.toISOString().split("T")[0];
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

function colorForType(type) {
  return {
    Hackathon:   "2",
    Competition: "5",
    Grant:       "4",
    Scholarship: "7",
    Job:         "8",
    Internship:  "1",
    Workshop:    "6",
    Conference:  "3",
  }[type] ?? "1";
}