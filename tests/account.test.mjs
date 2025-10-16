import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
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

let app;
let mails = [];
let config;
let defaultBaseUrl;
const origLog = console.log;

// intercepta logs do mailer ([DEV-MAIL])
function hookMailerLogs() {
  console.log = ((...args) => {
    try {
      if (args[0] === "[DEV-MAIL]" && typeof args[1] === "object" && args[1]) {
        const { to, subject, text, html } = args[1];
        mails.push({ to, subject, text, html });
      }
    } catch {
      /* ignore */
    }
    // comenta a linha abaixo se quiseres silenciar logs durante os testes
    return origLog.apply(console, args);
  });
}
function unhookMailerLogs() {
  console.log = origLog;
}

function extractFirstUrl(s) {
  if (!s) return null;
  const m = s.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

before(async () => {
  // criar diretório temporário e forçar CWD para isolar o data/
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindzapp-test-"));
  process.chdir(tmp);

  hookMailerLogs();

  // importa routers *depois* de mudar cwd/env
  const { accountsRouter } = await import("../src/routes/accounts.ts");
  ({ default: config } = await import("../src/config.ts"));
  defaultBaseUrl = config?.baseUrl;

  // monta um app só com o necessário para os testes
  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/accounts", accountsRouter);
});

after(() => {
  unhookMailerLogs();
});

beforeEach(() => {
  mails = [];
  if (config) config.baseUrl = defaultBaseUrl;
});

describe("Accounts API flow", () => {
  it(
    "should register, verify email, reject wrong login, accept correct login, reset password, and login with new password",
    async () => {
      const rnd = Math.random().toString(36).slice(2, 8);
      const email = `user.${rnd}@example.com`;
      const username = `tester_${rnd}`;
      const password = "passw0rd!";

      // 1) Register
      const reg = await request(app)
        .post("/accounts/register")
        .send({ email, username, password });
      assert.strictEqual(reg.status, 201);
      assert.strictEqual(reg.body?.ok, true);
      assert.strictEqual(typeof reg.body?.userId, "string");
      const userId = reg.body.userId;

      // apanha o e-mail de verificação do logger e extrai URL
      const mailVerify = mails.reverse().find(m => m.subject?.includes("Confirmar conta"));
      assert.ok(mailVerify, "verification mail not captured");
      const verifyUrl = extractFirstUrl(mailVerify?.text);
      assert.ok(verifyUrl, "verification link not found");

      // 2) Verify
      const v = new URL(verifyUrl);
      const verify = await request(app).get(`${v.pathname}${v.search}`);
      assert.strictEqual(verify.status, 200);
      mails.reverse(); // repor ordem original se for preciso

      // 3) Login com password errada -> 400 INVALID_CREDENTIALS
      const badLogin = await request(app)
        .post("/accounts/login")
        .send({ email, password: "wrong-xyz" });
      assert.strictEqual(badLogin.status, 400);
      assert.strictEqual(badLogin.body?.error, "INVALID_CREDENTIALS");

      // 4) Login correto -> 200, ok, deviceSecret
      const goodLogin = await request(app)
        .post("/accounts/login")
        .send({ email, password });
      assert.strictEqual(goodLogin.status, 200);
      assert.strictEqual(goodLogin.body?.ok, true);
      assert.strictEqual(goodLogin.body?.userId, userId);
      assert.strictEqual(typeof goodLogin.body?.deviceSecret, "string");

      // 5) Reset initiate -> captura resetUrl
      const initReset = await request(app)
        .post("/accounts/reset/initiate")
        .send({ email });
      assert.strictEqual(initReset.status, 200);

      const mailReset = mails.reverse().find(m => m.subject?.includes("Repor password"));
      assert.ok(mailReset, "reset mail not captured");
      const resetUrl = extractFirstUrl(mailReset?.text);
      assert.ok(resetUrl, "reset link not found");

      // 6) GET /reset (HTML)
      const r = new URL(resetUrl);
      const resetForm = await request(app).get(`${r.pathname}${r.search}`);
      assert.strictEqual(resetForm.status, 200);
      assert.ok(resetForm.text.includes("Repor password"));

      // 7) POST /reset/complete
      const newPass = "newPass123!";
      const params = new URLSearchParams(r.search);
      const token = params.get("token") || "";
      const uid = params.get("uid") || "";
      assert.strictEqual(uid, userId);

      const complete = await request(app)
        .post("/accounts/reset/complete")
        .type("form")
        .send({ uid, token, password: newPass });
      assert.strictEqual(complete.status, 200);
      assert.ok(complete.text.includes("Password atualizada"));

      // 8) Login com antiga password -> deve falhar
      const oldLogin = await request(app)
        .post("/accounts/login")
        .send({ email, password });
      assert.strictEqual(oldLogin.status, 400);
      assert.strictEqual(oldLogin.body?.error, "INVALID_CREDENTIALS");

      // 9) Login com nova password -> ok
      const newLogin = await request(app)
        .post("/accounts/login")
        .send({ email, password: newPass });
      assert.strictEqual(newLogin.status, 200);
      assert.strictEqual(newLogin.body?.ok, true);
      assert.strictEqual(typeof newLogin.body?.deviceSecret, "string");
    }
  );

  it("should reject duplicate email/username on register", async () => {
    const rnd = Math.random().toString(36).slice(2, 8);
    const email = `dup.${rnd}@example.com`;
    const username = `dupuser_${rnd}`;
    const password = "p@ssword1";

    const first = await request(app)
      .post("/accounts/register")
      .send({ email, username, password });
    assert.strictEqual(first.status, 201);

    const dupEmail = await request(app)
      .post("/accounts/register")
      .send({ email, username: username + "_x", password });
    assert.strictEqual(dupEmail.status, 409);
    assert.strictEqual(dupEmail.body?.error, "EMAIL_TAKEN");

    const dupUser = await request(app)
      .post("/accounts/register")
      .send({ email: `other.${rnd}@example.com`, username, password });
    assert.strictEqual(dupUser.status, 409);
    assert.strictEqual(dupUser.body?.error, "USERNAME_TAKEN");
  });

  it("should avoid duplicate slashes when PUBLIC_BASE_URL has trailing slash", async () => {
    assert.ok(config, "config not loaded");
    config.baseUrl = "https://app.example.com/app/";

    const rnd = Math.random().toString(36).slice(2, 8);
    const email = `slash.${rnd}@example.com`;
    const username = `slash_user_${rnd}`;
    const password = "slashPass1!";

    const reg = await request(app)
      .post("/accounts/register")
      .send({ email, username, password });
    assert.strictEqual(reg.status, 201);

    const mailVerify = mails.find(m => m.subject?.includes("Confirmar conta"));
    assert.ok(mailVerify, "verification mail not captured");
    const verifyUrl = extractFirstUrl(mailVerify?.text);
    assert.ok(verifyUrl, "verification link not found");
    const verifyParsed = new URL(verifyUrl);
    assert.strictEqual(verifyParsed.pathname, "/app/accounts/verify");

    const initReset = await request(app)
      .post("/accounts/reset/initiate")
      .send({ email });
    assert.strictEqual(initReset.status, 200);

    const mailReset = mails.find(m => m.subject?.includes("Repor password"));
    assert.ok(mailReset, "reset mail not captured");
    const resetUrl = extractFirstUrl(mailReset?.text);
    assert.ok(resetUrl, "reset link not found");
    const resetParsed = new URL(resetUrl);
    assert.strictEqual(resetParsed.pathname, "/app/accounts/reset");
  });
});