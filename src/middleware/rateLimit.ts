// src/middleware/rateLimit.ts
import type { Request, Response, NextFunction } from "express";

/**
 * Rate limiter leve em memória (por processo).
 * - Sliding window por chave (IP por defeito).
 * - Cabeçalhos padrão: X-RateLimit-Limit / -Remaining / -Reset + Retry-After.
 * - Resposta JSON 429: { error: "RATE_LIMITED", message, retryAfterSec }
 *
 * NOTA: Em ambientes multi-instância usa Redis/Upstash/etc. para partilhar estado.
 */

type KeyFn = (req: Request) => string;

export type RateLimitOptions = {
  windowMs: number;                   // janela (ms)
  max: number;                        // nº máximo dentro da janela
  keyGenerator?: KeyFn;               // por defeito: req.ip
  statusCode?: number;                // por defeito: 429
  message?: string;                   // mensagem de erro
  headerPrefix?: string;              // "X-RateLimit" por defeito
};

type Bucket = {
  times: number[];                    // timestamps (ms) de hits dentro da janela
  last: number;                       // último hit (para GC)
};

const store: Map<string, Bucket> = new Map();

/** GC simples para evitar leak (remove chaves inativas fora de todas as janelas). */
const GC_INTERVAL_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of store) {
    if (now - b.last > 10 * GC_INTERVAL_MS) store.delete(key);
  }
}).unref?.();

function prune(bucket: Bucket, windowMs: number, now: number) {
  // remove timestamps fora da janela
  const cutoff = now - windowMs;
  let i = 0;
  const arr = bucket.times;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

export function rateLimit(opts: RateLimitOptions) {
  const {
    windowMs,
    max,
    keyGenerator,
    statusCode = 429,
    message = "Too many requests. Please try again later.",
    headerPrefix = "X-RateLimit",
  } = opts;

  if (!windowMs || !max) {
    throw new Error("rateLimit: windowMs and max are required");
  }

  const keyFn: KeyFn = keyGenerator ?? ((req) => req.ip || req.headers["x-forwarded-for"]?.toString() || "unknown");

  return function limiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = keyFn(req);

    let bucket = store.get(key);
    if (!bucket) {
      bucket = { times: [], last: 0 };
      store.set(key, bucket);
    }

    prune(bucket, windowMs, now);
    const used = bucket.times.length;
    const remaining = Math.max(0, max - used);
    const resetMs = used > 0 ? (bucket.times[0] + windowMs) - now : windowMs;
    const resetUnix = Math.ceil((now + Math.max(0, resetMs)) / 1000);

    // Cabeçalhos informativos
    res.setHeader(`${headerPrefix}-Limit`, String(max));
    res.setHeader(`${headerPrefix}-Remaining`, String(Math.max(0, remaining - 1))); // considera este pedido
    res.setHeader(`${headerPrefix}-Reset`, String(resetUnix));

    if (used >= max) {
      const retryAfterSec = Math.ceil(resetMs / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
      return res.status(statusCode).json({
        error: "RATE_LIMITED",
        message,
        retryAfterSec: Math.max(1, retryAfterSec),
      });
    }

    // regista o hit e segue
    bucket.times.push(now);
    bucket.last = now;
    next();
  };
}

/* ---------- Presets úteis ---------- */

/** Por IP */
export const byIp = (windowMs: number, max: number, message?: string) =>
  rateLimit({ windowMs, max, message });

/** Por email no body (fallback para IP se ausente) */
export const byEmailOrIp = (windowMs: number, max: number, message?: string) =>
  rateLimit({
    windowMs,
    max,
    message,
    keyGenerator: (req) => {
      const email = (req.body?.email || req.query?.email || "").toString().trim().toLowerCase();
      return email ? `email:${email}` : `ip:${req.ip}`;
    },
  });

/** Presets de segurança para auth */
export const limitRegisterByIp   = byIp(60_000, 10, "Too many registrations from this IP. Try again later.");
export const limitRegisterByEmail= byEmailOrIp(60_000, 3, "Too many registrations for this email. Try again later.");

export const limitLoginByIp      = byIp(60_000, 30, "Too many login attempts. Try again later.");
export const limitLoginByEmail   = byEmailOrIp(60_000, 10, "Too many login attempts for this email. Try again later.");

export const limitResetByIp      = byIp(60_000, 20, "Too many reset requests. Try again later.");
export const limitResetByEmail   = byEmailOrIp(60_000, 5, "Too many reset requests for this email. Try again later.");
