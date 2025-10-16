// src/config.ts
import { z } from "zod";

/* ------- Helpers ------- */
function toBool(v: unknown, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return def;
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function splitCsv(v: string | undefined, def: string[] = ["*"]): string[] {
  if (!v || !v.trim()) return def;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function emptyToUndefined<T>(v: T): T | undefined {
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
}

/* ------- Raw env schema (strings/nums) ------- */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).default(4321),
  PUBLIC_BASE_URL: z.string().url().optional(),

  CORS_ORIGIN: z.string().optional().default("*"),

  MAIL_FROM: z.string().optional().default("MindZapp <mindzapp@localhost>"),
  SMTP_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(587)),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().optional().default("false"),
  SMTP_TLS_REJECT_UNAUTHORIZED: z.string().optional().default("1"),

  MAIL_STRICT: z.string().optional().default("0"),
  MAIL_LOG: z.string().optional().default("1"),

  VERIFY_TTL_SEC: z.coerce.number().int().positive().default(86400), // 24h
  RESET_TTL_SEC: z.coerce.number().int().positive().default(1800),   // 30m
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(10),

  LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace","silent"]).default("debug"),
});

const env = EnvSchema.parse(process.env);

/* ------- Derivados ------- */
const isProd = env.NODE_ENV === "production";
const isDev  = !isProd;
const origins = splitCsv(env.CORS_ORIGIN);

/* ------- Config estruturado ------- */
const config = {
  env: env.NODE_ENV,
  isDev,
  isProd,

  port: env.PORT,
  baseUrl: env.PUBLIC_BASE_URL, // opcional

  cors: {
    origins,
    allowAny: origins.includes("*"),
  },

  mail: {
    from: env.MAIL_FROM,
    url: env.SMTP_URL,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    secure: toBool(env.SMTP_SECURE, false) || env.SMTP_PORT === 465,
    tlsRejectUnauthorized: toBool(env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
    strict: toBool(env.MAIL_STRICT, isProd), // <-- sem self-reference
    log: toBool(env.MAIL_LOG, true),
  },

  security: {
    verifyTtlSec: env.VERIFY_TTL_SEC,
    resetTtlSec: env.RESET_TTL_SEC,
    bcryptCost: env.BCRYPT_COST,
  },

  log: {
    level: env.LOG_LEVEL,
  },
} as const;

export type AppConfig = typeof config;
export default config;
