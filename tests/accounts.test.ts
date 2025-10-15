import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import path from "path";
import os from "os";
import fs from "fs";

// --- ambiente de teste ---
process.env.NODE_ENV = "test";
process.env.VERIFY_TTL_SEC = process.env.VERIFY_TTL_SEC || "86400";
process.env.RESET_TTL_SEC = process.env.RESET_TTL_SEC || "1800";
process.env.BCRYPT_COST = process.env.BCRYPT_COST || "10";

let app: express.Express;
let mails: Array<{ to: string; subject: string; text: string; html?: string }> = [];
const origLog = console.log;

// intercepta logs do mailer ([DEV-MAIL])
function hookMailerLogs() {
  console.log = ((...args: any[]) => {
    try {
      if (args[0] === "[DEV-MAIL]" && typeof args[1] === "object" && args[1]) {
        const { to, subject, text, html } = args[1];
        mails.push({ to, subject, text, html });
      }
    } catch { /* ignore */ }
    // comenta a linha abaixo se quiseres silenciar logs durante os testes
    return origLog.apply(console, args as any);
  }) as any;
}
function unhookMailerLogs() {
  console.log = origLog;
}

function extractFirstUrl(s?: string): string | null {
  if (!s) return null;
  const m = s.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

beforeAll(async () => {
  // criar diretório temporário e forçar CWD para isolar o data/
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindzapp-test-"));
  process.chdir(tmp);

  hookMailerLogs();

  // importa routers *depois* de mudar cwd/env
  const { accountsRouter } = await import("../src/routes/accounts");

  // monta um app só com o necessário para os testes
  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/accounts", accountsRouter);
});

afterAll(() => {
  unhookMailerLogs();
});

describe("Accounts API flow", () => {
  it("should register, verify email, reject wrong login, accept correct login, reset password, and login with new password", async () => {
    const rnd = Math.random().toString(36).slice(2, 8);
    const email = `user.${rnd}@example.com`;
    const username = `tester_${rnd}`;
    const password = "passw0rd!";

    // 1) Register
    const reg = await request(app)
      .post("/accounts/register")
      .send({ email, username, password });
    expect(reg.status).toBe(201);
    expect(reg.body?.ok).toBe(true);
    expect(typeof reg.body?.userId).toBe("string");
    const userId = reg.body.userId as string;

    // apanha o e-mail de verificação do logger e extrai URL
    const mailVerify = mails.reverse().find(m => m.subject?.includes("Confirmar conta"));
    expect(mailVerify, "verification mail not captured").toBeTruthy();
    const verifyUrl = extractFirstUrl(mailVerify?.text);
    expect(verifyUrl, "verification link not found").toBeTruthy();

    // 2) Verify
    const v = new URL(verifyUrl!);
    const verify = await request(app).get(`${v.pathname}${v.search}`);
    expect(verify.status).toBe(200);
    mails.reverse(); // repor ordem original se for preciso

    // 3) Login com password errada -> 400 INVALID_CREDENTIALS
    const badLogin = await request(app)
      .post("/accounts/login")
      .send({ email, password: "wrong-xyz" });
    expect(badLogin.status).toBe(400);
    expect(badLogin.body?.error).toBe("INVALID_CREDENTIALS");

    // 4) Login correto -> 200, ok, deviceSecret
    const goodLogin = await request(app)
      .post("/accounts/login")
      .send({ email, password });
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.body?.ok).toBe(true);
    expect(goodLogin.body?.userId).toBe(userId);
    expect(typeof goodLogin.body?.deviceSecret).toBe("string");

    // 5) Reset initiate -> captura resetUrl
    const initReset = await request(app)
      .post("/accounts/reset/initiate")
      .send({ email });
    expect(initReset.status).toBe(200);

    const mailReset = mails.reverse().find(m => m.subject?.includes("Repor password"));
    expect(mailReset, "reset mail not captured").toBeTruthy();
    const resetUrl = extractFirstUrl(mailReset?.text);
    expect(resetUrl, "reset link not found").toBeTruthy();

    // 6) GET /reset (HTML)
    const r = new URL(resetUrl!);
    const resetForm = await request(app).get(`${r.pathname}${r.search}`);
    expect(resetForm.status).toBe(200);
    expect(resetForm.text).toContain("Repor password");

    // 7) POST /reset/complete
    const newPass = "newPass123!";
    const params = new URLSearchParams(r.search);
    const token = params.get("token") || "";
    const uid = params.get("uid") || "";
    expect(uid).toBe(userId);

    const complete = await request(app)
      .post("/accounts/reset/complete")
      .type("form")
      .send({ uid, token, password: newPass });
    expect(complete.status).toBe(200);
    expect(complete.text).toContain("Password atualizada");

    // 8) Login com antiga password -> deve falhar
    const oldLogin = await request(app)
      .post("/accounts/login")
      .send({ email, password });
    expect(oldLogin.status).toBe(400);
    expect(oldLogin.body?.error).toBe("INVALID_CREDENTIALS");

    // 9) Login com nova password -> ok
    const newLogin = await request(app)
      .post("/accounts/login")
      .send({ email, password: newPass });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body?.ok).toBe(true);
    expect(typeof newLogin.body?.deviceSecret).toBe("string");
  });

  it("should reject duplicate email/username on register", async () => {
    const rnd = Math.random().toString(36).slice(2, 8);
    const email = `dup.${rnd}@example.com`;
    const username = `dupuser_${rnd}`;
    const password = "p@ssword1";

    const first = await request(app)
      .post("/accounts/register")
      .send({ email, username, password });
    expect(first.status).toBe(201);

    const dupEmail = await request(app)
      .post("/accounts/register")
      .send({ email, username: username + "_x", password });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body?.error).toBe("EMAIL_TAKEN");

    const dupUser = await request(app)
      .post("/accounts/register")
      .send({ email: `other.${rnd}@example.com`, username, password });
    expect(dupUser.status).toBe(409);
    expect(dupUser.body?.error).toBe("USERNAME_TAKEN");
  });
});
