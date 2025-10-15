// src/lib/accountStore.ts
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import { nanoid } from "nanoid";

const DATA_DIR = path.join(process.cwd(), "data");
const ACC_FILE = path.join(DATA_DIR, "accounts.json");

/* ---------- Tipos ---------- */
export interface AccountEntry {
  userId: string;
  email: string;
  emailLower: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  verified: boolean;
  verifyToken?: string | null;
  verifyTokenExpires?: string | null;   // <-- novo
  resetToken?: string | null;
  resetTokenExpires?: string | null;    // <-- novo
  createdAt: string;
  updatedAt: string;
}

interface AccountsDB {
  version: 1;
  accounts: AccountEntry[];
}

/* ---------- Bootstrap ---------- */
function ensureFile() {
  if (!fssync.existsSync(DATA_DIR)) fssync.mkdirSync(DATA_DIR, { recursive: true });
  if (!fssync.existsSync(ACC_FILE)) {
    const init: AccountsDB = { version: 1, accounts: [] };
    fssync.writeFileSync(ACC_FILE, JSON.stringify(init, null, 2), "utf8");
  }
}

async function writeJSONAtomic(filePath: string, data: unknown) {
  const tmp = `${filePath}.tmp-${nanoid(6)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function load(): Promise<AccountsDB> {
  ensureFile();
  let raw = "";
  try {
    raw = await fs.readFile(ACC_FILE, "utf8");
    const db = JSON.parse(raw) as AccountsDB;
    if (!db || typeof db !== "object" || !Array.isArray(db.accounts)) {
      throw new Error("Invalid DB shape");
    }
    return db;
  } catch {
    try {
      const backup = `${ACC_FILE}.corrupt-${Date.now()}`;
      if (raw.trim() !== "") await fs.rename(ACC_FILE, backup);
    } catch {}
    const init: AccountsDB = { version: 1, accounts: [] };
    await writeJSONAtomic(ACC_FILE, init);
    return init;
  }
}

async function save(db: AccountsDB) {
  await writeJSONAtomic(ACC_FILE, db);
}

/* ---------- Queries ---------- */
export async function findByEmail(email: string): Promise<AccountEntry | undefined> {
  const db = await load();
  const key = email.trim().toLowerCase();
  return db.accounts.find(a => a.emailLower === key);
}

export async function findByUsername(username: string): Promise<AccountEntry | undefined> {
  const db = await load();
  const key = username.trim().toLowerCase();
  return db.accounts.find(a => a.usernameLower === key);
}

export async function findByVerifyToken(token: string): Promise<AccountEntry | undefined> {
  const db = await load();
  return db.accounts.find(a => a.verifyToken === token);
}

export async function findByResetToken(token: string): Promise<AccountEntry | undefined> {
  const db = await load();
  return db.accounts.find(a => a.resetToken === token);
}

/** Versões com verificação de expiração (para usares nas rotas) */
export async function findValidVerifyToken(token: string): Promise<AccountEntry | undefined> {
  const a = await findByVerifyToken(token);
  if (!a) return undefined;
  if (a.verifyTokenExpires && new Date(a.verifyTokenExpires).getTime() < Date.now()) return undefined;
  return a;
}
export async function findValidResetToken(token: string): Promise<AccountEntry | undefined> {
  const a = await findByResetToken(token);
  if (!a) return undefined;
  if (a.resetTokenExpires && new Date(a.resetTokenExpires).getTime() < Date.now()) return undefined;
  return a;
}

/* ---------- Mutations ---------- */
export async function insertAccount(a: AccountEntry) {
  const db = await load();
  const emailKey = a.emailLower.trim().toLowerCase();
  const userKey = a.usernameLower.trim().toLowerCase();
  if (db.accounts.some(x => x.emailLower === emailKey || x.usernameLower === userKey)) {
    throw new Error("ACCOUNT_CONFLICT");
  }
  db.accounts.push(a);
  await save(db);
}

export async function updateAccount(a: AccountEntry) {
  const db = await load();
  const i = db.accounts.findIndex(x => x.userId === a.userId);
  if (i < 0) throw new Error("ACCOUNT_NOT_FOUND");
  db.accounts[i] = a;
  await save(db);
}

/* ---------- Helpers para emitir tokens com TTL ---------- */
export function isoInSeconds(secFromNow: number): string {
  return new Date(Date.now() + secFromNow * 1000).toISOString();
}