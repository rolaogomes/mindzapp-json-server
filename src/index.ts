// src/index.ts
import "dotenv/config";
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import pinoHttp from "pino-http";
import fs from "fs";
import path from "path";

import { accountsRouter } from "./routes/accounts";
import { authRouter } from "./routes/auth";
import { decksRouter } from "./routes/decks";
import { soloRouter } from "./routes/solo";
import { battlesRouter } from "./routes/battles";
import { battleHub } from "./services/battleHub";
import { attachBattleSockets } from "./sockets/battles";

const PORT = Number(process.env.PORT || 4321);
const DATA_DIR = path.join(process.cwd(), "data");
const USERS_DIR = path.join(DATA_DIR, "users");

/* ---------- FS bootstrap ---------- */
function ensureDirs() {
  for (const dir of [DATA_DIR, USERS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1); // ngrok / proxies / render

// Logger HTTP (redação básica de headers sensíveis)
app.use(
  pinoHttp({
    autoLogging: true,
    redact: {
      paths: ["req.headers.authorization", "req.headers['x-device-secret']"],
      censor: "[redacted]",
    },
  })
);

// Segurança + compressão
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // servir /public para origens diferentes
  })
);
app.use(compression());

// CORS (abre em dev; em prod usa CORS_ORIGIN="https://app.tld,https://admin.tld")
const origins =
  (process.env.CORS_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

app.use(
  cors({
    origin: origins.includes("*")
      ? true
      : (origin, cb) => {
          if (!origin) return cb(null, true); // permite file:// e curl
          cb(null, origins.includes(origin));
        },
    credentials: true,
  })
);

// Body parsers globais (routers também têm os seus - sem problema)
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Estáticos (public/)
app.use(express.static(path.join(process.cwd(), "public")));

// favicon 204 para não poluir logs
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Healthcheck
app.get("/health", (_req, res) => {
  let usersCount = 0;
  try {
    usersCount = fs.readdirSync(USERS_DIR).filter((f) => f.endsWith(".json")).length;
  } catch { /* ignore */ }
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    usersCount,
    env: { node: process.version, port: PORT, mode: process.env.NODE_ENV || "development" },
  });
});

// Debug (eco)
app.post("/__debug/echo", (req, res) => res.json({ headers: req.headers, body: req.body }));

/* ---------- Routers ---------- */
app.use("/accounts", accountsRouter);
app.use("/auth", authRouter);
app.use("/decks", decksRouter);
app.use("/solo", soloRouter);
app.use("/battles", battlesRouter);

/* ---------- 404 & error handlers ---------- */
app.use((req, res) => {
  // 404 padrão em JSON quando aceitável
  if (req.headers.accept?.includes("application/json") || req.path.startsWith("/accounts") || req.path.startsWith("/auth")) {
    return res.status(404).json({ error: "NOT_FOUND", path: req.path });
  }
  return res.status(404).send("Not Found");
});

// Fallback global (routers já têm os seus)
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    req.log?.error({ err }, "Unhandled error");
    if (res.headersSent) return;
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err?.message || "Unknown error" });
  }
);

/* ---------- HTTP + Socket.IO ---------- */
const server = http.createServer(app);

// Ajustes de timeout para evitar slowloris
server.keepAliveTimeout = 61_000;
server.headersTimeout = 65_000;

export const io = new SocketIOServer(server, {
  cors: {
    origin: origins.includes("*") ? true : origins,
    credentials: true,
  },
});

battleHub.attachIO(io);
attachBattleSockets(io);

io.on("connection", (socket) => {
  app.get("logger")?.info?.(`[socket] connected ${socket.id}`);
  socket.on("ping", () => socket.emit("pong"));
  socket.on("disconnect", (reason) => {
    app.get("logger")?.info?.(`[socket] disconnected ${socket.id} (${reason})`);
  });
});

/* ---------- Arranque ---------- */
server.listen(PORT, () => {
  console.log(`MindZapp server on http://localhost:${PORT}`);
});

/* ---------- Shutdown elegante ---------- */
const shutdown = (signal: NodeJS.Signals) => {
  console.log(`[shutdown] received ${signal}, closing...`);
  io.close(() => console.log("[shutdown] socket.io closed"));
  server.close((err) => {
    if (err) {
      console.error("[shutdown] server close error:", err);
      process.exit(1);
    }
    console.log("[shutdown] http server closed");
    process.exit(0);
  });
  // força saída se algo pendurar
  setTimeout(() => {
    console.warn("[shutdown] force exit");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
  // opcional: process.exit(1);
});
