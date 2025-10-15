// src/routes/accounts.ts
import express from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

import config from "../config";

import {
  createUser,
  addDeviceSecret,
  loadUser,
  saveUser,
  setEmail,
} from "../lib/store";
import type { AccountEntry } from "../lib/accountStore";
import {
  findByEmail,
  findByUsername,
  findByVerifyToken,
  findByResetToken,
  insertAccount,
  updateAccount,
} from "../lib/accountStore";
import { sendMail } from "../lib/mailer";

// 🔒 Rate-limit
import {
  limitRegisterByIp,
  limitRegisterByEmail,
  limitLoginByIp,
  limitLoginByEmail,
  limitResetByIp,
  limitResetByEmail,
} from "../middleware/rateLimit";

export const accountsRouter = express.Router();

/* ---- Body parsers apenas para este router (garante req.body) ---- */
accountsRouter.use(express.json({ limit: "1mb" }));
accountsRouter.use(express.urlencoded({ extended: true })); // para /reset/complete

/* ---- Config centralizada ---- */
const BCRYPT_COST   = config.security.bcryptCost;
const VERIFY_TTL_SEC = config.security.verifyTtlSec; // 24h por default
const RESET_TTL_SEC  = config.security.resetTtlSec;  // 30m por default

const Register = z.object({
  email: z.string().email().min(5),
  username: z.string().min(3),
  password: z.string().min(6),
});

const Login = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function nowISO() {
  return new Date().toISOString();
}
function baseUrl(req: express.Request) {
  return config.baseUrl ?? `${req.protocol}://${req.get("host")}`;
}

/** POST /accounts/register */
accountsRouter.post(
  "/register",
  limitRegisterByIp,
  limitRegisterByEmail,
  async (req, res, next) => {
    try {
      const p = Register.parse(req.body ?? {});
      const emailLower = p.email.trim().toLowerCase();
      const usernameLower = p.username.trim().toLowerCase();

      if (await findByEmail(emailLower))
        return res.status(409).json({ error: "EMAIL_TAKEN" });
      if (await findByUsername(usernameLower))
        return res.status(409).json({ error: "USERNAME_TAKEN" });

      // 1) cria user.json
      const user = await createUser(p.username);
      await setEmail(user.id, p.email);

      // sincroniza flag no user.json
      const u = await loadUser(user.id);
      if (u) {
        u.auth = u.auth || { deviceSecrets: [] };
        u.auth.emailVerified = false;
        await saveUser(u);
      }

      // 2) cria a conta (email + hash) na accountStore
      const hash = await bcrypt.hash(p.password, BCRYPT_COST);
      const verifyToken = nanoid(32);
      const acc: AccountEntry = {
        userId: user.id,
        email: p.email,
        emailLower,
        username: p.username,
        usernameLower,
        passwordHash: hash,
        verified: false,
        verifyToken,
        verifyTokenExpires: isoInSeconds(VERIFY_TTL_SEC),
        resetToken: null,
        resetTokenExpires: null,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      };
      await insertAccount(acc);

      // 3) envia link de verificação
      const verifyUrl = `${baseUrl(req)}/accounts/verify?uid=${encodeURIComponent(
        user.id
      )}&token=${encodeURIComponent(verifyToken)}`;
      await sendMail(
        p.email,
        "MindZapp — Confirmar conta",
        `Confirma a tua conta: ${verifyUrl}`,
        `<p>Confirma a tua conta:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`
      );

      return res
        .status(201)
        .json({ ok: true, userId: user.id, message: "CHECK_EMAIL_FOR_VERIFICATION_LINK" });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return res.status(422).json({ error: "VALIDATION_ERROR", issues: e.issues });
      }
      return next(e);
    }
  }
);

/** GET /accounts/verify?uid=&token= */
accountsRouter.get("/verify", async (req, res) => {
  try {
    const { uid = "", token = "" } = req.query as Record<string, string>;
    const acc = token ? await findValidVerifyToken(token) : undefined;
    if (!acc || acc.userId !== uid)
      return res.status(400).send("Invalid or expired verification link.");

    // single-use
    acc.verified = true;
    acc.verifyToken = null;
    acc.verifyTokenExpires = null;
    acc.updatedAt = nowISO();
    await updateAccount(acc);

    // sincroniza no user.json
    const u = await loadUser(acc.userId);
    if (u) {
      u.auth = u.auth || { deviceSecrets: [] };
      u.auth.emailVerified = true;
      u.auth.email = u.auth.email ?? acc.email;
      await saveUser(u);
    }

    res.send(
      `<html><body style="font-family:sans-serif"><h3>Conta verificada ✅</h3><p>Podes fechar esta página e fazer login.</p></body></html>`
    );
  } catch (e: any) {
    res.status(500).send("VERIFY_FAILED: " + String(e?.message || e));
  }
});

/** POST /accounts/login */
accountsRouter.post(
  "/login",
  limitLoginByIp,
  limitLoginByEmail,
  async (req, res, next) => {
    try {
      const p = Login.parse(req.body ?? {});
      const acc = await findByEmail(p.email.trim().toLowerCase());
      if (!acc) return res.status(400).json({ error: "INVALID_CREDENTIALS" });

      const ok = await bcrypt.compare(p.password, acc.passwordHash);
      if (!ok) return res.status(400).json({ error: "INVALID_CREDENTIALS" });

      if (!acc.verified) return res.status(403).json({ error: "EMAIL_NOT_VERIFIED" });

      const deviceSecret = await addDeviceSecret(acc.userId);
      return res.json({
        ok: true,
        userId: acc.userId,
        deviceSecret,
        howToUseHeaders: { "x-user-id": acc.userId, "x-device-secret": deviceSecret },
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return res.status(422).json({ error: "VALIDATION_ERROR", issues: e.issues });
      }
      return next(e);
    }
  }
);

/** POST /accounts/reset/initiate {email} */
accountsRouter.post(
  "/reset/initiate",
  limitResetByIp,
  limitResetByEmail,
  async (req, res, next) => {
    try {
      const email = String((req.body?.email ?? "")).trim().toLowerCase();
      if (!email) return res.status(422).json({ error: "VALIDATION_ERROR", issues: [{ path: ["email"], message: "email required" }] });

      const acc = await findByEmail(email);
      if (!acc) return res.json({ ok: true }); // não revelar

      acc.resetToken = nanoid(32);
      acc.resetTokenExpires = isoInSeconds(RESET_TTL_SEC);
      acc.updatedAt = nowISO();
      await updateAccount(acc);

      const resetUrl = `${baseUrl(req)}/accounts/reset?uid=${encodeURIComponent(
        acc.userId
      )}&token=${encodeURIComponent(acc.resetToken)}`;
      await sendMail(
        acc.email,
        "MindZapp — Repor password",
        `Repor a password: ${resetUrl}`,
        `<p>Repor a password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
      );
      return res.json({ ok: true });
    } catch (e: any) {
      return next(e);
    }
  }
);

/** GET /accounts/reset?uid=&token= */
accountsRouter.get("/reset", async (req, res) => {
  const { uid = "", token = "" } = req.query as Record<string, string>;
  const acc = token ? await findValidResetToken(token) : undefined; // já valida expiração
  if (!acc || acc.userId !== uid)
    return res.status(400).send("Invalid or expired reset link.");
  res.send(`<html><body style="font-family:sans-serif">
    <h3>Repor password</h3>
    <form method="post" action="/accounts/reset/complete">
      <input type="hidden" name="uid" value="${uid}"/>
      <input type="hidden" name="token" value="${token}"/>
      <input type="password" name="password" placeholder="Nova password" />
      <button type="submit">Guardar</button>
    </form>
  </body></html>`);
});

/** POST /accounts/reset/complete */
accountsRouter.post("/reset/complete", async (req, res) => {
  try {
    const { uid = "", token = "", password = "" } = req.body as Record<string, string>;
    const acc = token ? await findValidResetToken(token) : undefined; // valida expiração
    if (!acc || acc.userId !== uid) return res.status(400).send("Invalid reset request.");
    if (!password || password.length < 6) return res.status(400).send("Password too short.");

    acc.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    // single-use
    acc.resetToken = null;
    acc.resetTokenExpires = null;
    acc.updatedAt = nowISO();
    await updateAccount(acc);

    res.send(
      `<html><body style="font-family:sans-serif"><h3>Password atualizada ✅</h3><p>Podes fechar e fazer login.</p></body></html>`
    );
  } catch (e: any) {
    res.status(500).send("RESET_COMPLETE_FAILED: " + String(e?.message || e));
  }
});

/** POST /accounts/resend {email} */
accountsRouter.post(
  "/resend",
  limitResetByIp,     // reutilizamos limites de envio de email
  limitResetByEmail,  // (evita spam de emails de verificação)
  async (req, res, next) => {
    try {
      const email = String((req.body?.email ?? "")).trim().toLowerCase();
      if (!email) return res.status(422).json({ error: "VALIDATION_ERROR", issues: [{ path: ["email"], message: "email required" }] });

      const acc = await findByEmail(email);
      if (!acc) return res.json({ ok: true });
      if (acc.verified) return res.json({ ok: true });

      acc.verifyToken = nanoid(32);
      acc.verifyTokenExpires = isoInSeconds(VERIFY_TTL_SEC);
      acc.updatedAt = nowISO();
      await updateAccount(acc);

      const verifyUrl = `${baseUrl(req)}/accounts/verify?uid=${encodeURIComponent(
        acc.userId
      )}&token=${encodeURIComponent(acc.verifyToken! )}`;
      await sendMail(
        acc.email,
        "MindZapp — Confirmar conta",
        `Confirma a tua conta: ${verifyUrl}`,
        `<p>Confirma a tua conta:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`
      );
      return res.json({ ok: true });
    } catch (e: any) {
      return next(e);
    }
  }
);

/* ---- Error handler local do router: garante JSON em 500 ---- */
accountsRouter.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[ACCOUNTS] Unhandled error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err?.message || "Unknown error" });
});

export default accountsRouter;
