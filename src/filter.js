/**
 * filter.js — Gemini-powered opportunity filter
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize the Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use gemini-1.5-flash for fast, cost-effective, and structured tasks
const model = genAI.getGenerativeModel({ 
  model: "gemini-3-flash-preview",
  generationConfig: {
    // This enforces that the model returns valid JSON natively
    responseMimeType: "application/json",
  }
});

/**
 * Analyse a single message against a single user profile.
 */
export async function analyzeMessage(messageText, userProfile) {
  const profileSummary = buildProfileSummary(userProfile);

  const prompt = `You are a smart assistant that filters WhatsApp group messages for relevant opportunities.

USER PROFILE:
${profileSummary}

MESSAGE:
"""
${messageText.slice(0, 2000)}
"""

Decide if this message contains an opportunity (hackathon, competition, grant, job, internship, workshop, conference, open-source project, research call, or any other actionable event with a deadline).

Respond ONLY with a valid JSON object matching this schema:
{
  "isOpportunity": true | false,
  "relevanceScore": <integer 0-100>,
  "title": "<short title, or null>",
  "type": "Hackathon" | "Competition" | "Grant" | "Job" | "Internship" | "Workshop" | "Conference" | "Research" | "Open Source" | "Other" | null,
  "deadline": "<deadline string if found, else null>",
  "prizeOrBenefit": "<prize/funding/benefit if mentioned, else null>",
  "applyLink": "<URL if found, else null>",
  "summary": "<2-sentence summary of what the opportunity is>",
  "whyRelevant": "<1 sentence: why this matches or doesn't match the user's profile>",
  "suggestedAction": "<what the user should do next, e.g. 'Register before May 15'>",
  "urgency": "high" | "medium" | "low"
}

Scoring guide:
- 80–100: Directly matches skills + preferred event type + interest area
- 60–79:  Matches 2 of the 3 above
- 40–59:  Loosely relevant, worth knowing about
- 0–39:   Not an opportunity, or completely off-profile`;

  let raw = "";

  try {
    const resultContent = await model.generateContent(prompt);
    raw = resultContent.response.text();

    console.log(`   🧠 Raw Gemini response: ${raw.slice(0, 200)}`);

    // The replace is likely unnecessary now due to responseMimeType, but good as a fallback
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const result = JSON.parse(cleaned);

    console.log(
      `   🧠 Parsed: isOpp=${result.isOpportunity} score=${result.relevanceScore} title="${result.title}"`
    );

    return result;
  } catch (err) {
    console.error(`   ❌ Filter error: ${err.message}`);
    console.error(`   ❌ Raw response was: "${raw}"`);
    return { isOpportunity: false, relevanceScore: 0, error: true };
  }
}

/**
 * Filter a message against a list of users.
 * Returns only users for whom the message is relevant (score >= threshold).
 */
export async function filterForAllUsers(messageText, users, threshold = 50) {
  const results = await Promise.allSettled(
    users.map(async (user) => {
      const analysis = await analyzeMessage(messageText, user);
      return { user, analysis };
    })
  );

  // Log every result so nothing is silent
  results.forEach((r) => {
    if (r.status === "rejected") {
      console.error(`   ❌ Filter promise rejected:`, r.reason);
    } else {
      const { user, analysis } = r.value;
      const pass =
        analysis.isOpportunity && analysis.relevanceScore >= threshold;
      console.log(
        `   ${pass ? "✓" : "✗"} ${user.name || user.phone}: ` +
          `isOpp=${analysis.isOpportunity} score=${analysis.relevanceScore} ` +
          `(threshold=${threshold})${analysis.error ? " [PARSE ERROR]" : ""}`
      );
    }
  });

  return results
    .filter(
      (r) =>
        r.status === "fulfilled" &&
        r.value.analysis.isOpportunity &&
        r.value.analysis.relevanceScore >= threshold
    )
    .map((r) => r.value);
}

// ── Helpers ──────────────────────────────────────────────

function buildProfileSummary(profile) {
  const lines = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.skills?.length) lines.push(`Skills: ${profile.skills.join(", ")}`);
  if (profile.eventTypes?.length) lines.push(`Looking for: ${profile.eventTypes.join(", ")}`);
  if (profile.interests?.length) lines.push(`Interests: ${profile.interests.join(", ")}`);
  if (profile.bio) lines.push(`Bio: ${profile.bio}`);
  if (!lines.length)
    lines.push("No profile set — treat any opportunity as potentially relevant");
  return lines.join("\n");
}