/**
 * scraper.js — Enriches messages with content from links and images
 *
 * Three strategies:
 *   1. Plain URL in message  → fetch page, extract readable text
 *   2. Image message         → send to Gemini Vision to extract text
 *   3. Text + URL            → fetch URL and append to existing text
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2);

// ── URL scraper ───────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

/**
 * Extract all URLs from a string.
 */
export function extractUrls(text) {
  return [...(text?.matchAll(URL_REGEX) || [])].map((m) => m[0]);
}

/**
 * Fetch a URL and return a cleaned text summary of its content.
 * Returns null if fetch fails or content is not useful.
 */
export async function scrapeUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FilterBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    const html = await res.text();
    return extractTextFromHtml(html);
  } catch (err) {
    console.log(`   ⚠️  Could not scrape ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Strip HTML tags and extract meaningful text.
 * Prioritises meta description, title, and body text.
 */
function extractTextFromHtml(html) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract meta description
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
  );
  const metaDesc = metaMatch ? metaMatch[1].trim() : "";

  // Extract Open Graph description (better for social/event pages)
  const ogDescMatch = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i
  );
  const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : "";

  const ogTitleMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  const ogTitle = ogTitleMatch ? ogTitleMatch[1].trim() : "";

  // Strip all tags from body for raw text
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const bodyText = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000); // cap at 2000 chars

  const parts = [
    ogTitle || title,
    ogDesc || metaDesc,
    bodyText,
  ].filter(Boolean);

  return parts.join("\n\n").slice(0, 3000);
}

// ── Image reader (Gemini Vision) ──────────────────────────

/**
 * Download a WhatsApp image and send it to Gemini Vision
 * to extract any text, deadlines, links, or opportunity details.
 *
 * @param {object} msg — whatsapp-web.js message object
 * @returns {string|null} — extracted text or null
 */
export async function extractTextFromImage(msg) {
  try {
    console.log(`   🖼  Downloading image for vision analysis…`);
    const media = await msg.downloadMedia();
    if (!media?.data) {
      console.log(`   ⚠️  Could not download image`);
      return null;
    }

    const visionModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const result = await visionModel.generateContent([
      {
        inlineData: {
          mimeType: media.mimetype || "image/jpeg",
          data: media.data, // base64
        },
      },
      {
        text: `Look at this image carefully. Extract ALL text visible in the image.
Then check if it contains an opportunity (hackathon, competition, grant, scholarship, job, internship, workshop, etc).

Return a plain text summary including:
- All text you can read from the image
- Event/opportunity name if present
- Deadline or application dates if visible
- Prize, funding, or benefit if mentioned
- Any URLs or contact details visible
- What action someone should take

Be thorough — extract everything useful. If it's not an opportunity, just say what the image contains.`,
      },
    ]);

    const extracted = result.response.text();
    console.log(`   🖼  Vision extracted: "${extracted.slice(0, 100)}…"`);
    return extracted;
  } catch (err) {
    console.error(`   ❌ Image vision error: ${err.message}`);
    return null;
  }
}

// ── Main enrichment function ──────────────────────────────

/**
 * Enrich a raw message with scraped URL content and/or image text.
 * Returns the full enriched text to pass to the AI filter.
 *
 * @param {object} msg        — whatsapp-web.js message object
 * @param {string} bodyText   — msg.body (may be empty for image-only)
 * @returns {string|null}     — enriched text, or null if nothing useful
 */
export async function enrichMessage(msg, bodyText) {
  const parts = [];

  // Always include whatever text exists
  if (bodyText?.trim()) {
    parts.push(bodyText.trim());
  }

  // ── Image: run vision ─────────────────────────────────
  if (msg.type === "image" || msg.type === "sticker") {
    const imageText = await extractTextFromImage(msg);
    if (imageText) parts.push(`[Image content]\n${imageText}`);
  }

  // ── URLs: scrape each one ─────────────────────────────
  const urls = extractUrls(bodyText || "");
  if (urls.length > 0) {
    console.log(`   🔗 Found ${urls.length} URL(s) — scraping…`);
    for (const url of urls.slice(0, 2)) { // max 2 URLs per message
      const scraped = await scrapeUrl(url);
      if (scraped) {
        parts.push(`[From ${url}]\n${scraped}`);
        console.log(`   ✅ Scraped ${url} (${scraped.length} chars)`);
      }
    }
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
}