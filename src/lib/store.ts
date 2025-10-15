// src/lib/store.ts
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import { nanoid } from "nanoid";

/* ---------- Paths & bootstrap ---------- */
const DATA_DIR = path.join(process.cwd(), "data");
const USERS_DIR = path.join(DATA_DIR, "users");

function ensureDirs() {
  for (const dir of [DATA_DIR, USERS_DIR]) {
    if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

/* ---------- Tipos principais (MVP) ---------- */
export type CardType =
  | "MCQ_SINGLE"
  | "MCQ_MULTI"
  | "TRUE_FALSE"
  | "MATCH_LINES"
  | "MATCH_BUCKETS"
  | "TEXT";

export interface Card {
  id: string;
  type: CardType;
  prompt_md: string;
  data_json: unknown;
  time_limit_sec?: number;
  hint?: string;
}

// Permitir cards sem id no input (será gerado no upsert)
export type CardInput = Omit<Card, "id"> & { id?: string };

// Deck de entrada: cards podem vir sem id
export type DeckInput = Omit<Deck, "id" | "createdAt" | "updatedAt" | "cards"> & {
  id?: string;
  cards: CardInput[];
};

export interface TopicPath {
  theme: string;
  subtheme?: string;
  subsubtheme?: string;
}

export type Visibility = "PUBLIC" | "PRIVATE";

export interface Deck {
  id: string;
  title: string;
  topic: TopicPath;
  visibility: Visibility;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  cards: Card[];
}

export type Rating = "VERY_HARD" | "HARD" | "MEDIUM" | "EASY";

export interface ProgressEntry {
  lastAnswerAt?: string;     // ISO
  nextReviewAt?: string;     // ISO (modo solo manual -> quando o user escolhe)
  lastRating?: Rating;
  timesAnswered: number;
  timesCorrect: number;
}

export interface Transaction {
  id: string;
  ts: string;                // ISO
  type: "EARN" | "SPEND";
  amount: number;            // ZAPPs (inteiro para MVP)
  reason?: string;           // p.ex. "battle_win" / "solo_correct"
  ref?: string;              // id de battle/deck/etc.
}

export interface UserFile {
  id: string;                // nanoid
  username: string;          // único no MVP
  createdAt: string;         // ISO
  updatedAt: string;         // ISO

  profile: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
    privacy: Visibility;     // controla visibilidade do perfil
  };

  prefs: {
    language: string;        // "pt-PT" por defeito
    theme: "light" | "dark" | "system";
    notifications: { email: boolean; push: boolean };
    solo: {
      intervals: {           // segundos (manual & configurável)
        VERY_HARD: number;   // 30s
        HARD: number;        // 3m
        MEDIUM: number;      // 1h
        EASY: number;        // 1d
      };
    };
  };

  wallet: {
    balance: number;         // saldo atual em ZAPPs
    transactions: Transaction[];
  };

  decks: Deck[];             // decks do próprio utilizador

  progress: Record<string, ProgressEntry>; // por cardId (qualquer deck estudado)

  friends: { accepted: string[]; pending: string[] };

  stats: { answersTotal: number; correctTotal: number; streakBest: number };

  auth: {
    deviceSecrets: string[];          // login antigo (continua a existir)
    // --- novos campos para contas por email/senha ---
    email?: string;
    passwordHash?: string;
    emailVerified?: boolean;
    verifyToken?: string;
    verifyTokenExpires?: string;      // ISO
    resetToken?: string;
    resetTokenExpires?: string;       // ISO
  };
}

/* ---------- Helpers privados ---------- */
function userFilePath(userId: string) {
  return path.join(USERS_DIR, `${userId}.json`);
}

async function writeJSONAtomic(filePath: string, data: unknown) {
  const tmp = `${filePath}.tmp-${nanoid(6)}`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, filePath);
}

function nowISO() {
  return new Date().toISOString();
}

/** Lê e faz parse do JSON, devolve null se estiver corrompido (sem rebentar scans). */
async function safeReadUser(filePath: string): Promise<UserFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const u = JSON.parse(raw) as UserFile;
    // guarda mínima
    if (!u || typeof u !== "object" || typeof u.id !== "string" || typeof u.username !== "string") {
      if (process.env.LOG_LEVEL === "debug") {
        console.warn(`[store] invalid shape in ${path.basename(filePath)}`);
      }
      return null;
    }
    return u;
  } catch (e: any) {
    if (process.env.LOG_LEVEL === "debug") {
      console.warn(`[store] skip unreadable ${path.basename(filePath)}:`, e?.message || e);
    }
    return null;
  }
}

/* ---------- Defaults ---------- */
export function defaultUser(username: string): UserFile {
  const ts = nowISO();
  return {
    id: nanoid(12),
    username,
    createdAt: ts,
    updatedAt: ts,
    profile: { privacy: "PUBLIC" },
    prefs: {
      language: "pt-PT",
      theme: "system",
      notifications: { email: false, push: false },
      solo: {
        intervals: {
          VERY_HARD: 30,
          HARD: 3 * 60,
          MEDIUM: 60 * 60,
          EASY: 24 * 60 * 60
        }
      }
    },
    wallet: { balance: 0, transactions: [] },
    decks: [],
    progress: {},
    friends: { accepted: [], pending: [] },
    stats: { answersTotal: 0, correctTotal: 0, streakBest: 0 },
    auth: { deviceSecrets: [], emailVerified: false }
  };
}

/* ---------- API do storage (usada pelas rotas) ---------- */
export async function createUser(username: string): Promise<UserFile> {
  const existing = await findUserByUsername(username);
  if (existing) throw new Error("USERNAME_TAKEN");
  const user = defaultUser(username);
  await saveUser(user);
  return user;
}

export async function addDeviceSecret(userId: string): Promise<string> {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  const secret = nanoid(32);
  user.auth.deviceSecrets.push(secret);
  user.updatedAt = nowISO();
  await saveUser(user);
  return secret;
}

export async function loadUser(userId: string): Promise<UserFile | null> {
  try {
    const raw = await fs.readFile(userFilePath(userId), "utf8");
    return JSON.parse(raw) as UserFile;
  } catch {
    return null;
  }
}

export async function saveUser(user: UserFile): Promise<void> {
  user.updatedAt = nowISO();
  await writeJSONAtomic(userFilePath(user.id), user);
}

export async function listUserIds(): Promise<string[]> {
  const files = await fs.readdir(USERS_DIR);
  return files
    .filter(f => f.endsWith(".json"))
    .map(f => path.basename(f, ".json"));
}

export async function findUserByUsername(username: string): Promise<UserFile | null> {
  const files = await fs.readdir(USERS_DIR);
  const target = username.toLowerCase();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const u = await safeReadUser(path.join(USERS_DIR, f));
    if (!u) continue;
    if (u.username.toLowerCase() === target) return u;
  }
  return null;
}

export async function findUserByEmail(email: string): Promise<UserFile | null> {
  const files = await fs.readdir(USERS_DIR);
  const target = email.trim().toLowerCase();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const u = await safeReadUser(path.join(USERS_DIR, f));
    if (!u) continue;
    const e = u.auth?.email?.toLowerCase();
    if (e && e === target) return u;
  }
  return null;
}

export async function upsertDeck(
  userId: string,
  deck: DeckInput
): Promise<Deck> {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  const now = nowISO();
  const normCards: Card[] = (deck.cards ?? []).map((c) => ({
    id: c.id ?? nanoid(10),
    type: c.type,
    prompt_md: c.prompt_md,
    data_json: c.data_json,
    time_limit_sec: c.time_limit_sec,
    hint: c.hint,
  }));

  if (!deck.id) {
    const newDeck: Deck = {
      ...deck,
      id: nanoid(10),
      createdAt: now,
      updatedAt: now,
      cards: normCards,
    };
    user.decks.push(newDeck);
    await saveUser(user);
    return newDeck;
  } else {
    const idx = user.decks.findIndex((d) => d.id === deck.id);
    if (idx === -1) throw new Error("DECK_NOT_FOUND");
    const merged: Deck = {
      ...user.decks[idx],
      ...deck,
      cards: normCards,
      updatedAt: now,
    };
    user.decks[idx] = merged;
    await saveUser(user);
    return merged;
  }
}

export async function listPublicDecks(): Promise<Array<{ deck: Deck; owner: { userId: string; username: string } }>> {
  const out: Array<{ deck: Deck; owner: { userId: string; username: string } }> = [];
  const files = await fs.readdir(USERS_DIR);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const u = await safeReadUser(path.join(USERS_DIR, f));
    if (!u) continue;
    for (const d of u.decks) {
      if (d.visibility === "PUBLIC") out.push({ deck: d, owner: { userId: u.id, username: u.username } });
    }
  }
  return out;
}

export async function appendTransaction(userId: string, trx: Transaction): Promise<void> {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  user.wallet.transactions.push(trx);
  user.wallet.balance += trx.type === "EARN" ? trx.amount : -trx.amount;
  user.updatedAt = nowISO();
  await saveUser(user);
}

export function getUsersDir() {
  return USERS_DIR;
}

/* ---------- Helpers para contas (email/password) ---------- */
export async function setPasswordHash(userId: string, hash: string) {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  user.auth.passwordHash = hash;
  user.updatedAt = nowISO();
  await saveUser(user);
}

export async function setEmail(userId: string, email: string) {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  user.auth.email = email;
  user.updatedAt = nowISO();
  await saveUser(user);
}

export async function setVerifyToken(userId: string, token: string, expiresISO: string) {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  user.auth.verifyToken = token;
  user.auth.verifyTokenExpires = expiresISO;
  await saveUser(user);
}

export async function verifyEmailWithToken(userId: string, token: string): Promise<boolean> {
  const user = await loadUser(userId);
  if (!user) return false;
  const ok = !!user.auth.verifyToken
    && user.auth.verifyToken === token
    && (!user.auth.verifyTokenExpires || new Date(user.auth.verifyTokenExpires).getTime() >= Date.now());
  if (!ok) return false;
  user.auth.emailVerified = true;
  user.auth.verifyToken = undefined;
  user.auth.verifyTokenExpires = undefined;
  await saveUser(user);
  return true;
}

export async function setResetToken(userId: string, token: string, expiresISO: string) {
  const user = await loadUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  user.auth.resetToken = token;
  user.auth.resetTokenExpires = expiresISO;
  await saveUser(user);
}

export async function useResetTokenAndSetPassword(userId: string, token: string, newHash: string): Promise<boolean> {
  const user = await loadUser(userId);
  if (!user) return false;
  const ok = !!user.auth.resetToken
    && user.auth.resetToken === token
    && (!!user.auth.resetTokenExpires && new Date(user.auth.resetTokenExpires).getTime() >= Date.now());
  if (!ok) return false;
  user.auth.passwordHash = newHash;
  user.auth.resetToken = undefined;
  user.auth.resetTokenExpires = undefined;
  await saveUser(user);
  return true;
}
