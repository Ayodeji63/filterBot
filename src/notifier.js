/**
 * notifier.js — Formats and sends WhatsApp notifications back to users
 */

/**
 * Build a formatted WhatsApp message for a matched opportunity.
 */
export function buildOpportunityMessage(analysis, user, oppId) {
  const scoreBar = buildScoreBar(analysis.relevanceScore);
  const urgencyEmoji = { high: "🔴", medium: "🟡", low: "🟢" }[analysis.urgency] ?? "⚪";
  const typeEmoji = {
    Hackathon: "🚀", Competition: "🏆", Grant: "💰",
    Job: "💼", Internship: "🎓", Workshop: "🛠",
    Conference: "🎤", Research: "🔬", "Open Source": "💻", Other: "📌",
  }[analysis.type] ?? "📌";

  const lines = [
    `${typeEmoji} *${analysis.title || "New Opportunity"}*`,
    ``,
    `${scoreBar} *${analysis.relevanceScore}% match* for you${user.name ? `, ${user.name.split(" ")[0]}` : ""}`,
    ``,
    `📋 *Summary*`,
    analysis.summary,
    ``,
  ];

  if (analysis.deadline) {
    lines.push(`${urgencyEmoji} *Deadline:* ${analysis.deadline}`);
  }
  if (analysis.prizeOrBenefit) {
    lines.push(`🎁 *Benefit:* ${analysis.prizeOrBenefit}`);
  }
  if (analysis.applyLink) {
    lines.push(`🔗 *Apply:* ${analysis.applyLink}`);
  }

  lines.push(``);
  lines.push(`💡 _${analysis.whyRelevant}_`);
  lines.push(``);
  lines.push(`*Next step:* ${analysis.suggestedAction || "Check it out!"}`);
  lines.push(``);
  lines.push(`─────────────────`);
  lines.push(`Reply with:`);
  lines.push(`*1* — Add to my Google Calendar 📅`);
  lines.push(`*2* — Remind me in 24h ⏰`);
  lines.push(`*3* — Not interested ✗`);
  lines.push(`*(ref: ${oppId})*`);

  return lines.join("\n");
}

/**
 * Build a confirmation message after user replies to an opportunity.
 */
export function buildActionConfirmMessage(action, analysis) {
  switch (action) {
    case "calendar":
      return (
        `✅ *Added to Google Calendar!*\n\n` +
        `📅 *${analysis?.title || "Opportunity"}*\n` +
        (analysis?.deadline ? `⏰ Reminder set for 48h before: ${analysis.deadline}\n` : "") +
        `\nYou'll get a calendar notification when it's time to apply.`
      );
    case "remind":
      return (
        `⏰ *Reminder set!*\n\n` +
        `I'll ping you in 24 hours about:\n` +
        `_${analysis?.title || "this opportunity"}_`
      );
    case "dismiss":
      return `Got it — dismissed. I'll keep filtering for better matches 👍`;
    default:
      return `Done!`;
  }
}

/**
 * Build the welcome message sent to a new user who DMs the bot.
 */
export function buildWelcomeMessage(botName = "FilterBot") {
  return [
    `👋 *Welcome to ${botName}!*`,
    ``,
    `I watch WhatsApp groups and surface only the opportunities that match *your* skills and interests — hackathons, grants, jobs, workshops, and more.`,
    ``,
    `*Step 1 — Tell me about yourself:*`,
    ``,
    `*NAME:* Your Name`,
    `*SKILLS:* React, Python, Design`,
    `*LOOKING FOR:* Hackathon, Grant, Job`,
    `*INTERESTS:* fintech, health, edtech (optional)`,
    ``,
    `After that I'll walk you through choosing which groups to monitor 🎯`,
  ].join("\n");
}

/**
 * Build a profile confirmation message.
 * Clearly tells the user their next step is to subscribe to groups.
 */
export function buildProfileSavedMessage(profile) {
  return [
    `✅ *Profile saved!*`,
    ``,
    `Here's what I'll filter for:`,
    `👤 ${profile.name}`,
    profile.skills?.length    ? `🛠 Skills: ${profile.skills.join(", ")}`         : null,
    profile.eventTypes?.length ? `🎯 Looking for: ${profile.eventTypes.join(", ")}` : null,
    profile.interests?.length  ? `💡 Interests: ${profile.interests.join(", ")}`    : null,
    ``,
    `─────────────────`,
    `*Step 2 — Choose groups to monitor:*`,
    ``,
    `Send *!groups* to see all groups the bot is in, then:`,
    `*!monitor <id>* to subscribe to one`,
    ``,
    `You can subscribe to as many groups as you like. I'll only DM you when something relevant is posted 🔍`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Helpers ──────────────────────────────────────────────

function buildScoreBar(score) {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}