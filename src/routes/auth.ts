// src/routes/auth.ts
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createUser, addDeviceSecret, findUserByUsername, loadUser, saveUser } from "../lib/store";
import type { UserFile } from "../lib/store";

export const authRouter = express.Router();

/* ---- Body parser local ao router (garante req.body) ---- */
authRouter.use(express.json({ limit: "1mb" }));

/* -------- Helpers -------- */
function sanitizeUser(u: UserFile) {
  // não expor segredos
  const { auth: _auth, ...rest } = u as any;
  return rest;
}

export interface AuthenticatedRequest extends Request {
  auth?: { user: UserFile; deviceSecret: string };
}

/* -------- Middleware: authRequired --------
   Lê X-User-Id e X-Device-Secret dos headers (ou query como fallback). */
export async function authRequired(
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
) {
  const q = req.query as Record<string, unknown>;

  const userId =
    (req.header("x-user-id") as string | undefined) ??
    (typeof q.userId === "string" ? q.userId : undefined) ??
    (typeof q.uid === "string" ? q.uid : undefined);

  const deviceSecret =
    (req.header("x-device-secret") as string | undefined) ??
    (typeof q.deviceSecret === "string" ? q.deviceSecret : undefined) ??
    (typeof q.ds === "string" ? q.ds : undefined);

  if (!userId || !deviceSecret) {
    return res.status(401).json({ error: "NO_AUTH" });
  }

  const user = await loadUser(String(userId));
  if (!user) return res.status(401).json({ error: "USER_NOT_FOUND" });
  if (!user.auth.deviceSecrets.includes(String(deviceSecret))) {
    return res.status(401).json({ error: "INVALID_DEVICE_SECRET" });
  }

  req.auth = { user, deviceSecret: String(deviceSecret) };
  next();
}

/* -------- Schemas -------- */
const UsernameOnly = z.object({
  username: z.string().min(3, "username must be at least 3 chars"),
});

/* -------- POST /auth/register --------
   body: { username } -> cria utilizador + emite deviceSecret */
authRouter.post("/register", async (req, res, next) => {
  try {
    const { username } = UsernameOnly.parse(req.body ?? {});
    const exists = await findUserByUsername(username.trim());
    if (exists) return res.status(409).json({ error: "USERNAME_TAKEN" });

    const user = await createUser(username.trim());
    const deviceSecret = await addDeviceSecret(user.id);
    return res.status(201).json({
      ok: true,
      userId: user.id,
      username: user.username,
      deviceSecret,
      user: sanitizeUser(user),
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(422).json({ error: "VALIDATION_ERROR", issues: e.issues });
    }
    return next(e);
  }
});

/* -------- POST /auth/login --------
   body: { username } -> emite novo deviceSecret para esse utilizador */
authRouter.post("/login", async (req, res, next) => {
  try {
    const { username } = UsernameOnly.parse(req.body ?? {});
    const user = await findUserByUsername(username.trim());
    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });

    const deviceSecret = await addDeviceSecret(user.id);
    return res.json({
      ok: true,
      userId: user.id,
      username: user.username,
      deviceSecret,
      user: sanitizeUser(user),
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(422).json({ error: "VALIDATION_ERROR", issues: e.issues });
    }
    return next(e);
  }
});

/* -------- GET /auth/me (autenticado) -------- */
authRouter.get("/me", authRequired, async (req: AuthenticatedRequest, res) => {
  return res.json({ ok: true, user: sanitizeUser(req.auth!.user) });
});

/* -------- POST /auth/logout (autenticado) --------
   Remove o deviceSecret atual da lista do utilizador */
authRouter.post("/logout", authRequired, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { user, deviceSecret } = req.auth!;
    user.auth.deviceSecrets = user.auth.deviceSecrets.filter((s) => s !== deviceSecret);
    await saveUser(user);
    return res.json({ ok: true });
  } catch (e: any) {
    return next(e);
  }
});

/* ---- Error handler local do router: garante JSON em 500 ---- */
authRouter.use((err: any, _req: express.Request, res: express.Response, _next: NextFunction) => {
  console.error("[AUTH] Unhandled error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err?.message || "Unknown error" });
});

export default authRouter;
