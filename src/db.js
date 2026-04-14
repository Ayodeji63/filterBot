/**
 * db.js — Lightweight JSON database using lowdb
 *
 * Stores:
 *   users[]        — registered user profiles
 *   opportunities[] — filtered + saved opportunities
 *   processedMsgs[] — message IDs already seen (dedup)
 */

import { JSONFilePreset } from "lowdb/node";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../data/db.json");

const DEFAULT_DATA = {
  users: [],
  opportunities: [],
  processedMsgs: [],
};

let db;

export async function initDb() {
  db = await JSONFilePreset(DB_PATH, DEFAULT_DATA);
  await db.write();
  console.log("📦 Database ready");
  return db;
}

export function getDb() {
  if (!db) throw new Error("DB not initialised — call initDb() first");
  return db;
}

// ── User helpers ────────────────────────────────────────

export async function upsertUser(phone, profileData) {
  const existing = db.data.users.find((u) => u.phone === phone);
  if (existing) {
    Object.assign(existing, profileData, { updatedAt: new Date().toISOString() });
  } else {
    db.data.users.push({
      id: `user_${Date.now()}`,
      phone,
      ...profileData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  await db.write();
  return db.data.users.find((u) => u.phone === phone);
}

export function getUser(phone) {
  return db.data.users.find((u) => u.phone === phone) || null;
}

export function getAllUsers() {
  return db.data.users;
}

// ── Opportunity helpers ─────────────────────────────────

export async function saveOpportunity(opportunity) {
  db.data.opportunities.push({
    id: `opp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...opportunity,
    createdAt: new Date().toISOString(),
    addedToCalendar: false,
  });
  await db.write();
}

export function getOpportunitiesForUser(phone) {
  return db.data.opportunities
    .filter((o) => o.notifiedUsers?.includes(phone))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function markCalendarAdded(oppId, phone) {
  const opp = db.data.opportunities.find((o) => o.id === oppId);
  if (opp) {
    opp.addedToCalendar = true;
    opp.calendarAddedBy = opp.calendarAddedBy || [];
    if (!opp.calendarAddedBy.includes(phone)) opp.calendarAddedBy.push(phone);
    await db.write();
  }
}

// ── Monitored group helpers ─────────────────────────────

export async function addMonitoredGroup(phone, group) {
  const user = db.data.users.find((u) => u.phone === phone);
  if (!user) return false;
  user.monitoredGroups = user.monitoredGroups || [];
  if (user.monitoredGroups.find((g) => g.id === group.id)) return false;
  user.monitoredGroups.push(group);
  await db.write();
  return true;
}

export async function removeMonitoredGroup(phone, groupId) {
  const user = db.data.users.find((u) => u.phone === phone);
  if (!user) return null;
  const idx = (user.monitoredGroups || []).findIndex((g) => g.id === groupId);
  if (idx === -1) return null;
  const [removed] = user.monitoredGroups.splice(idx, 1);
  await db.write();
  return removed;
}

export function getUserMonitoredGroups(phone) {
  const user = db.data.users.find((u) => u.phone === phone);
  return user?.monitoredGroups || [];
}

export function getUsersMonitoringGroup(groupId) {
  return db.data.users.filter((u) =>
    (u.monitoredGroups || []).some((g) => g.id === groupId)
  );
}

// ── Google Calendar token helpers ──────────────────────

export async function saveGoogleTokens(phone, tokens) {
  const user = db.data.users.find((u) => u.phone === phone);
  if (!user) throw new Error(`User ${phone} not found — register profile first`);
  user.googleTokens = tokens;
  user.googleConnectedAt = new Date().toISOString();
  await db.write();
}

export function getGoogleTokens(phone) {
  const user = db.data.users.find((u) => u.phone === phone);
  return user?.googleTokens || null;
}

export function hasGoogleConnected(phone) {
  return !!getGoogleTokens(phone);
}

// ── Dedup helpers ───────────────────────────────────────

export async function markMessageSeen(msgId) {
  if (!db.data.processedMsgs.includes(msgId)) {
    db.data.processedMsgs.push(msgId);
    // Keep last 2000 only to avoid unbounded growth
    if (db.data.processedMsgs.length > 2000) {
      db.data.processedMsgs = db.data.processedMsgs.slice(-2000);
    }
    await db.write();
  }
}

export function isMessageSeen(msgId) {
  return db.data.processedMsgs.includes(msgId);
}