/**
 * whatsapp.js — WhatsApp client lifecycle manager
 */

import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { filterForAllUsers } from "./filter.js";
import {
  buildOpportunityMessage,
  buildActionConfirmMessage,
  buildWelcomeMessage,
  buildProfileSavedMessage,
} from "./notifier.js";
import {
  getUser,
  upsertUser,
  saveOpportunity,
  markMessageSeen,
  isMessageSeen,
  markCalendarAdded,
  getUserMonitoredGroups,
  addMonitoredGroup,
  removeMonitoredGroup,
  getUsersMonitoringGroup,
} from "./db.js";
import { hasCalendarConnected, getAuthUrl, createCalendarEvent } from "./calendar.js";
let whatsappClient = null;
const lastOppSent = new Map(); // groupId → timestamp of last sent opportunity (for rate-limiting)

// ── Initialise ───────────────────────────────────────────

import { existsSync } from "fs";

function getChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/brave-browser",
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined; // let Puppeteer use its own downloaded Chrome
}

export async function initWhatsApp() {
  console.log("🟡 Initialising WhatsApp client…");

  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./data/.wwebjs_auth" }),
    puppeteer: {
      headless: true,
      executablePath: getChromePath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  whatsappClient.on("qr", (qr) => {
    console.log("\n📱 Scan this QR code with WhatsApp to log in:\n");
    qrcode.generate(qr, { small: true });
    console.log("\n⚠️  Keep this terminal open until you see 'WhatsApp ready'\n");
  });

  whatsappClient.on("authenticated", () => {
    console.log("🔐 WhatsApp authenticated — session saved");
  });

  whatsappClient.on("ready", () => {
    console.log("✅ WhatsApp ready — watching for messages");
  });

  whatsappClient.on("disconnected", (reason) => {
    console.warn("⚠️  WhatsApp disconnected:", reason);
    console.log("🔄 Attempting reconnect in 10s…");
    setTimeout(() => {
      whatsappClient.initialize().catch(console.error);
    }, 10_000);
  });

  whatsappClient.on("message", handleIncomingMessage);

  whatsappClient.initialize().catch((err) => {
    console.error("❌ WhatsApp init failed:", err.message);
    process.exit(1);
  });

  return whatsappClient;
}

export function getWhatsAppClient() {
  return whatsappClient;
}

// ── Message router ───────────────────────────────────────

async function handleIncomingMessage(msg) {
  try {
    if (msg.fromMe) return;
    if (msg.from === "status@broadcast") return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;

    console.log(`📩 [${isGroup ? "GROUP" : "DM"}] from: ${msg.from} | chat: ${chat.name || "DM"} | type: ${msg.type} | body: "${msg.body?.slice(0, 80)}"`);

    if (isGroup) {
      await handleGroupMessage(msg, chat);
      return;
    }

    // For DMs: resolve the real phone number via the contact
    // msg.from may be a LID like "44268479590594@lid" — getContact() gives us the real number
    let senderPhone = msg.from.replace(/@c\.us$/, "").replace(/@lid$/, "");
    try {
      const contact = await msg.getContact();
      if (contact?.number) {
        senderPhone = contact.number; // real international phone e.g. "2348012345678"
        console.log(`   👤 Resolved real phone: ${senderPhone}`);
      }
    } catch {
      console.log(`   ⚠️  Could not resolve contact, using: ${senderPhone}`);
    }

    await handleDirectMessage(msg, senderPhone);
  } catch (err) {
    console.error("Error handling message:", err.message);
  }
}
// ── Group message handler ────────────────────────────────

async function handleGroupMessage(msg, chat) {
  const groupId = chat.id._serialized;
  const groupName = chat.name || groupId;

  if (msg.type !== "chat") return;

  if (isMessageSeen(msg.id._serialized)) {
    console.log(`   ⏭  Already processed — skipping duplicate`);
    return;
  }
  await markMessageSeen(msg.id._serialized);

  const messageText = msg.body;
  if (!messageText || messageText.length < 20) return;

  // Only fetch users who have subscribed to THIS group
  const interestedUsers = getUsersMonitoringGroup(groupId);

  if (!interestedUsers.length) {
    console.log(`   ⏭  No users monitoring "${groupName}" — skipping`);
    return;
  }

  console.log(
    `\n💬 "${groupName}" | ${interestedUsers.length} subscriber(s) | "${messageText.slice(0, 80)}…"`
  );
  console.log(`   🤖 Running Claude filter…`);

  const matches = await filterForAllUsers(messageText, interestedUsers, 50);

  if (!matches.length) {
    console.log(`   ✗ Not relevant for any subscriber`);
    return;
  }

  console.log(`   ✓ Relevant for ${matches.length} user(s) — notifying`);

  const oppId = `opp_${Date.now()}`;
  await saveOpportunity({
    id: oppId,
    originalMessage: messageText,
    groupName,
    notifiedUsers: matches.map((m) => m.user.phone),
    topAnalysis: matches[0].analysis,
  });

  // Send personalised DMs
  for (const { user, analysis } of matches) {
    try {
      const notifMessage = buildOpportunityMessage(analysis, user, oppId);

      // Use getNumberId() to resolve the correct LID/c.us format automatically
      const numberId = await whatsappClient.getNumberId(user.phone);
      if (!numberId) {
        console.error(`   ❌ Could not resolve WhatsApp ID for ${user.phone} — are they on WhatsApp?`);
        continue;
      }

      await whatsappClient.sendMessage(numberId._serialized, notifMessage);
      lastOppSent.set(user.phone, oppId);
      console.log(`   📨 Notified ${user.name || user.phone} → ${numberId._serialized} (score: ${analysis.relevanceScore}%)`);
      await sleep(1500);
    } catch (sendErr) {
      console.error(`   ❌ Failed to notify ${user.phone}:`, sendErr.message);
    }
  }
}

// ── Direct message handler ────────────────────────────────

async function handleDirectMessage(msg, senderPhone) {
  const text = msg.body.trim();

  // ── Group management commands ──
  if (text.startsWith("!")) {
    await handleGroupCommand(msg, senderPhone, text);
    return;
  }

  // ── Action replies (1 / 2 / 3 with ref) ──
  // ── Action replies (1 / 2 / 3 with ref) ──
  // ── Action replies ──
  // Support both "1" alone (uses last sent opp) and "1 (ref: opp_123)" explicit
  const explicitMatch = text.match(/^([123])\s*[\(\[]?ref:\s*(opp_\d+)[^\)]*[\)\]]?/i);
  const simpleMatch = text.match(/^([123])$/);

  if (explicitMatch) {
    await handleActionReply(msg, senderPhone, explicitMatch[1], explicitMatch[2]);
    return;
  }

  if (simpleMatch) {
    const oppId = lastOppSent.get(senderPhone);
    if (!oppId) {
      await msg.reply(
        `I don't have a recent opportunity on file for you.\n\n` +
        `Wait for the next group message, or send *!mygroups* to check your subscriptions.`
      );
      return;
    }
    await handleActionReply(msg, senderPhone, simpleMatch[1], oppId);
    return;
  }

  // ── Profile setup ──
  if (
    text.toUpperCase().includes("NAME:") ||
    text.toUpperCase().includes("SKILLS:")
  ) {
    await handleProfileSetup(msg, senderPhone, text);
    return;
  }

  // ── Greeting / help ──
  if (
    text.toLowerCase().includes("hi") ||
    text.toLowerCase().includes("hello") ||
    text.toLowerCase().includes("start") ||
    text.toLowerCase().includes("help") ||
    text.length < 15 && !/^[123]$/.test(text)
  ) {
    const existing = getUser(senderPhone);
    if (existing) {
      const groups = getUserMonitoredGroups(senderPhone);
      const groupList = groups.length
        ? groups.map((g) => `   • ${g.name}`).join("\n")
        : "   None yet — send *!groups* to add some";

      await msg.reply(
        `👋 Hey ${existing.name?.split(" ")[0] || "there"}!\n\n` +
        `*Your profile:*\n` +
        `🛠 Skills: ${existing.skills?.join(", ") || "Not set"}\n` +
        `🎯 Looking for: ${existing.eventTypes?.join(", ") || "Not set"}\n\n` +
        `*Groups you're monitoring (${groups.length}):*\n${groupList}\n\n` +
        `*Commands:*\n` +
        `!groups — see all groups the bot is in\n` +
        `!monitor <id> — start monitoring a group\n` +
        `!unmonitor <id> — stop monitoring a group\n` +
        `!mygroups — see your subscribed groups\n\n` +
        `To update your profile, resend:\n_NAME: ... SKILLS: ... LOOKING FOR: ..._`
      );
    } else {
      await msg.reply(buildWelcomeMessage());
    }
    return;
  }

  await msg.reply(
    `I didn't quite get that. Send *HELP* to see options, or set up your profile:\n\n` +
    `*NAME:* Your Name\n*SKILLS:* React, Python\n*LOOKING FOR:* Hackathon, Grant\n*INTERESTS:* fintech, health`
  );
}

// ── Group command handler (per-user, no admin restriction) ──

async function handleGroupCommand(msg, senderPhone, text) {
  // All commands require a registered profile first
  const user = getUser(senderPhone);
  if (!user) {
    await msg.reply(
      `👋 You need to set up your profile before managing groups.\n\n` +
      `Send:\n*NAME:* Your Name\n*SKILLS:* React, Python\n*LOOKING FOR:* Hackathon, Grant`
    );
    return;
  }

  const [command, ...args] = text.trim().split(/\s+/);

  // !groups — list all groups the bot is in + this user's subscription status
  if (command === "!groups") {
    const chats = await whatsappClient.getChats();
    const groupChats = chats.filter((c) => c.isGroup);

    if (!groupChats.length) {
      await msg.reply("🤷 The bot isn't in any WhatsApp groups yet.");
      return;
    }

    const myGroupIds = new Set(getUserMonitoredGroups(senderPhone).map((g) => g.id));

    const lines = groupChats.map((g, i) => {
      const status = myGroupIds.has(g.id._serialized) ? "✅" : "⬜";
      return `${status} ${i + 1}. ${g.name}\n   \`${g.id._serialized}\``;
    });

    await msg.reply(
      `📋 *Available groups:*\n\n${lines.join("\n\n")}\n\n` +
      `✅ = you're monitoring  ⬜ = not monitoring\n\n` +
      `*!monitor <id>* — subscribe to a group\n` +
      `*!unmonitor <id>* — unsubscribe from a group`
    );
    return;
  }

  // !mygroups — list only this user's subscribed groups
  if (command === "!mygroups") {
    const groups = getUserMonitoredGroups(senderPhone);

    if (!groups.length) {
      await msg.reply(
        `You're not monitoring any groups yet.\n\nSend *!groups* to see what's available.`
      );
      return;
    }

    const lines = groups.map((g, i) => `${i + 1}. ${g.name}\n   \`${g.id}\``);
    await msg.reply(
      `📋 *Your monitored groups (${groups.length}):*\n\n${lines.join("\n\n")}\n\n` +
      `Send *!unmonitor <id>* to remove one.`
    );
    return;
  }

  // !monitor <group-id>
  if (command === "!monitor") {
    const groupId = args[0];
    if (!groupId) {
      await msg.reply(`Usage: *!monitor <group-id>*\n\nSend *!groups* to see available IDs.`);
      return;
    }

    // Verify the bot is actually in that group
    const chats = await whatsappClient.getChats();
    const target = chats.find((c) => c.id._serialized === groupId && c.isGroup);

    if (!target) {
      await msg.reply(
        `❌ Group not found. The bot must be a member of the group first.\n\nSend *!groups* to see valid IDs.`
      );
      return;
    }

    const added = await addMonitoredGroup(senderPhone, {
      id: groupId,
      name: target.name,
    });

    if (!added) {
      await msg.reply(`ℹ️ You're already monitoring *${target.name}*`);
      return;
    }

    console.log(`📌 ${senderPhone} subscribed to "${target.name}" (${groupId})`);
    await msg.reply(
      `✅ Now monitoring *${target.name}*\n\n` +
      `I'll DM you whenever a relevant opportunity is posted there.`
    );
    return;
  }

  // !unmonitor <group-id>
  if (command === "!unmonitor") {
    const groupId = args[0];
    if (!groupId) {
      await msg.reply(
        `Usage: *!unmonitor <group-id>*\n\nSend *!mygroups* to see your subscribed IDs.`
      );
      return;
    }

    const removed = await removeMonitoredGroup(senderPhone, groupId);

    if (!removed) {
      await msg.reply(`ℹ️ You weren't monitoring that group.`);
      return;
    }

    console.log(`📌 ${senderPhone} unsubscribed from "${removed.name}" (${groupId})`);
    await msg.reply(`🛑 Stopped monitoring *${removed.name}*`);
    return;
  }

  // !calendar — connect or reconnect Google Calendar
  if (command === "!calendar") {
    if (hasCalendarConnected(senderPhone)) {
      await msg.reply(
        `✅ Your Google Calendar is already connected!\n\n` +
        `To reconnect with a different account, tap:\n${getAuthUrl(senderPhone)}`
      );
    } else {
      const authUrl = getAuthUrl(senderPhone);
      await msg.reply(
        `📅 *Connect Google Calendar*\n\n` +
        `Tap this link and sign in with Google:\n\n` +
        `${authUrl}\n\n` +
        `Once done, come back here and reply *1* to any opportunity to add it to your calendar.`
      );
    }
    return;
  }

  // Unknown command
  await msg.reply(
    `Unknown command: *${command}*\n\n` +
    `Available commands:\n` +
    `*!groups* — list all available groups\n` +
    `*!mygroups* — list your subscribed groups\n` +
    `*!monitor <id>* — subscribe to a group\n` +
    `*!unmonitor <id>* — unsubscribe from a group\n` +
    `*!calendar* — connect or manage Google Calendar integration`
  );
}

// ── Profile parser ────────────────────────────────────────

async function handleProfileSetup(msg, phone, text) {
  const extract = (key) => {
    const regex = new RegExp(`${key}:\\s*([^\\n]+)`, "i");
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  };

  const name = extract("NAME");
  const skillsRaw = extract("SKILLS");
  const lookingForRaw = extract("LOOKING FOR") || extract("LOOKING");
  const interestsRaw = extract("INTERESTS");

  const profile = {
    name: name || "",
    skills: skillsRaw
      ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    eventTypes: lookingForRaw
      ? lookingForRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    interests: interestsRaw
      ? interestsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };

  if (!profile.name && !profile.skills.length) {
    await msg.reply(
      `Hmm, I couldn't parse your profile. Please use this format:\n\n` +
      `*NAME:* Your Name\n*SKILLS:* React, Python\n*LOOKING FOR:* Hackathon, Grant\n*INTERESTS:* fintech, health`
    );
    return;
  }

  await upsertUser(phone, profile);
  await msg.reply(buildProfileSavedMessage(profile));
  console.log(`👤 Profile saved/updated for ${phone}: ${JSON.stringify(profile)}`);
}

// ── Action reply handler ──────────────────────────────────

async function handleActionReply(msg, phone, action, oppId) {
  const actionMap = { "1": "calendar", "2": "remind", "3": "dismiss" };
  const actionKey = actionMap[action];

  if (actionKey === "calendar") {
    // Check if Google Calendar is connected
    if (!hasCalendarConnected(phone)) {
      const authUrl = getAuthUrl(phone);
      await msg.reply(
        `📅 *Connect Google Calendar first*\n\n` +
        `Tap this link to connect your Google Calendar — it only takes 30 seconds:\n\n` +
        `${authUrl}\n\n` +
        `Once connected, reply *1* again to add this opportunity.`
      );
      return;
    }

    // Fetch the opportunity analysis from DB
    const { getDb } = await import("./db.js");
    const db = getDb();
    const opp = db.data.opportunities.find((o) => o.id === oppId);
    const analysis = opp?.topAnalysis || {};

    try {
      await msg.reply(`⏳ Adding to your Google Calendar…`);
      const { eventLink } = await createCalendarEvent(phone, analysis, oppId);
      await markCalendarAdded(oppId, phone);
      await msg.reply(
        `✅ *Added to Google Calendar!*\n\n` +
        `📅 *${analysis.title || "Opportunity"}*\n` +
        (analysis.deadline ? `⏰ Deadline: ${analysis.deadline}\n` : "") +
        `\n🔔 Reminders set for 48h and 24h before the deadline.\n\n` +
        `View event: ${eventLink}`
      );
    } catch (err) {
      console.error("Calendar create error:", err.message);
      await msg.reply(
        `❌ Could not add to calendar: ${err.message}\n\n` +
        `Try reconnecting: send *!calendar*`
      );
    }

  } else if (actionKey === "remind") {
    scheduleReminder(phone, oppId, 24 * 60 * 60 * 1000);
    await msg.reply(buildActionConfirmMessage("remind"));
  } else if (actionKey === "dismiss") {
    await msg.reply(buildActionConfirmMessage("dismiss"));
  }
}

// ── Simple in-memory reminder ─────────────────────────────

const pendingReminders = new Map();

function scheduleReminder(phone, oppId, delayMs) {
  const key = `${phone}_${oppId}`;
  if (pendingReminders.has(key)) return;

  const timer = setTimeout(async () => {
    try {
      const numberId = await whatsappClient.getNumberId(phone);
      if (numberId) await whatsappClient.sendMessage(numberId._serialized, `⏰ *24h Reminder!*\n\nHey, you asked me to remind you about opportunity ref: ${oppId}\n\nHave you applied yet? 👆`);
      pendingReminders.delete(key);
    } catch (err) {
      console.error("Reminder send failed:", err.message);
    }
  }, delayMs);

  pendingReminders.set(key, timer);
}

// ── Utility ───────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));