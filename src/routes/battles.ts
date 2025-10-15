import express from "express";
import { z } from "zod";
import { authRequired, AuthenticatedRequest } from "./auth";
import { battleHub, Lobby } from "../services/battleHub";

export const battlesRouter = express.Router();

/* ---------------- utils ---------------- */

function pub(l: Lobby) {
  return {
    id: l.id,
    deckId: l.deckId,
    deckTitle: l.deckTitle,
    access: l.access,
    createdAt: l.createdAt,
    startedAt: l.startedAt,
    players: l.order.map((uid) => ({
      userId: uid,
      username: l.players[uid].username,
      score: l.players[uid].score,
    })),
    qIndex: l.qIndex,
    total: l.snapshots.length,
    finishedAt: l.finishedAt ?? null,
  };
}

function questionPayload(l: Lobby) {
  if (l.qIndex < 0 || l.qIndex >= l.snapshots.length) return null;
  const q = l.snapshots[l.qIndex];
  return {
    lobbyId: l.id,
    qIndex: l.qIndex,
    total: l.snapshots.length,
    shownAt: l.qShownAt,
    question: {
      id: q.id,
      type: q.type,
      prompt_md: q.prompt_md,
      data_json: q.data_json,
      time_limit_sec: q.time_limit_sec,
      hint: q.hint,
    },
  };
}

/* ---------------- schemas ---------------- */

const CreateLobbySchema = z.object({
  deckId: z.string().min(1),
  count: z.number().int().min(1).max(50),
  access: z.enum(["PUBLIC", "PRIVATE"]),
});

const JoinSchema = z.object({
  lobbyId: z.string().optional(),
  pin: z.string().optional(),
});

const StartSchema = z.object({
  lobbyId: z.string().min(1),
});

const NextSchema = z.object({
  lobbyId: z.string().min(1),
});

const AnswerSchema = z.object({
  lobbyId: z.string().min(1),
  payload: z.any(), // {answer:boolean} | {index:number} | {indices:number[]}
});

/* ---------------- routes ---------------- */

/** POST /battles/lobbies  (criar lobby) */
battlesRouter.post(
  "/lobbies",
  authRequired,
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = CreateLobbySchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });

      const { deckId, count, access } = parsed.data;

      const lobby = await battleHub.createLobby({
        hostId: req.auth!.user.id,
        deckId,
        count,
        access,
      });

      // anexa pin só para o host (se PRIVATE)
      const resp: any = pub(lobby);
      if (lobby.access === "PRIVATE" && lobby.hostId === req.auth!.user.id) {
        resp.pin = lobby.pin;
      }
      return res.json({ lobby: resp });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const map: Record<string, number> = {
        DECK_NOT_FOUND: 404,
        DECK_PRIVATE: 403,
        NO_ELIGIBLE_CARDS: 400,
      };
      return res.status(map[msg] ?? 500).json({ error: msg });
    }
  }
);

/** GET /battles/public (listar lobbies públicos ativos) */
battlesRouter.get("/public", (_req, res) => {
  const list = battleHub.listPublic();
  return res.json({ lobbies: list });
});

/** GET /battles/:lobbyId (estado público do lobby) */
battlesRouter.get("/:lobbyId", (_req, res) => {
  const lob = battleHub.getLobby(String(_req.params.lobbyId));
  if (!lob) return res.status(404).json({ error: "LOBBY_NOT_FOUND" });
  return res.json({ lobby: pub(lob) });
});

/** POST /battles/join  (entrar por lobbyId ou pin) */
battlesRouter.post(
  "/join",
  authRequired,
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = JoinSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });

      const { lobbyId, pin } = parsed.data;
      const lobby = await battleHub.join({
        lobbyId: lobbyId,
        pin: pin,
        userId: req.auth!.user.id,
        username: req.auth!.user.username || "user",
      });

      // (nota: socket join à room será feito no canal socket)
      return res.json({ lobby: pub(lobby) });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const map: Record<string, number> = {
        LOBBY_NOT_FOUND: 404,
        LOBBY_FINISHED: 409,
      };
      return res.status(map[msg] ?? 500).json({ error: msg });
    }
  }
);

/** POST /battles/start  (apenas host) */
battlesRouter.post(
  "/start",
  authRequired,
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = StartSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });

      const { lobbyId } = parsed.data;
      const lob = battleHub.getLobby(lobbyId);
      if (!lob) return res.status(404).json({ error: "LOBBY_NOT_FOUND" });
      if (lob.hostId !== req.auth!.user.id)
        return res.status(403).json({ error: "ONLY_HOST_CAN_START" });

      battleHub.start(lobbyId);
      const after = battleHub.getLobby(lobbyId)!;
      return res.json({ lobby: pub(after), current: questionPayload(after) });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const map: Record<string, number> = {
        ALREADY_STARTED: 409,
        LOBBY_NOT_FOUND: 404,
      };
      return res.status(map[msg] ?? 500).json({ error: msg });
    }
  }
);

/** POST /battles/next  (apenas host) */
battlesRouter.post(
  "/next",
  authRequired,
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = NextSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });

      const { lobbyId } = parsed.data;
      const lob = battleHub.getLobby(lobbyId);
      if (!lob) return res.status(404).json({ error: "LOBBY_NOT_FOUND" });
      if (lob.hostId !== req.auth!.user.id)
        return res.status(403).json({ error: "ONLY_HOST_CAN_NEXT" });

      battleHub.next(lobbyId);
      const after = battleHub.getLobby(lobbyId)!;
      if (after.finishedAt) {
        return res.json({ lobby: pub(after), finished: true });
      }
      return res.json({ lobby: pub(after), current: questionPayload(after) });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const map: Record<string, number> = {
        NOT_STARTED: 409,
        LOBBY_NOT_FOUND: 404,
      };
      return res.status(map[msg] ?? 500).json({ error: msg });
    }
  }
);

/** POST /battles/answer (submeter resposta da pergunta atual) */
battlesRouter.post(
  "/answer",
  authRequired,
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = AnswerSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });

      const { lobbyId, payload } = parsed.data;
      const lob = battleHub.getLobby(lobbyId);
      if (!lob) return res.status(404).json({ error: "LOBBY_NOT_FOUND" });
      if (!lob.players[req.auth!.user.id])
        return res.status(403).json({ error: "NOT_IN_LOBBY" });

      const { correct, delta, elapsed } = battleHub.submitAnswer({
        lobbyId,
        userId: req.auth!.user.id,
        payload,
      });

      const player = lob.players[req.auth!.user.id];
      return res.json({
        correct,
        delta,
        elapsed,
        score: player.score,
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const map: Record<string, number> = {
        LOBBY_NOT_FOUND: 404,
        NO_ACTIVE_QUESTION: 409,
        PLAYER_NOT_IN_LOBBY: 403,
      };
      return res.status(map[msg] ?? 500).json({ error: msg });
    }
  }
);

/** POST /battles/finish (terminar cedo — opcional, só host) */
battlesRouter.post(
  "/finish",
  authRequired,
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = StartSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });

      const { lobbyId } = parsed.data;
      const lob = battleHub.getLobby(lobbyId);
      if (!lob) return res.status(404).json({ error: "LOBBY_NOT_FOUND" });
      if (lob.hostId !== req.auth!.user.id)
        return res.status(403).json({ error: "ONLY_HOST_CAN_FINISH" });

      await battleHub.finish(lobbyId);
      const after = battleHub.getLobby(lobbyId)!;
      return res.json({ lobby: pub(after), finished: true });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const map: Record<string, number> = {
        LOBBY_NOT_FOUND: 404,
      };
      return res.status(map[msg] ?? 500).json({ error: msg });
    }
  }
);
