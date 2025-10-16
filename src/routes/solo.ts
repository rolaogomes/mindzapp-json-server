import express from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { loadUser, saveUser, appendTransaction, listUserIds } from "../lib/store";
import type { UserFile, Deck } from "../lib/store";
import { authRequired } from "./auth";
import type { AuthenticatedRequest } from "./auth";

export const soloRouter = express.Router();

/* ---------- helpers ---------- */

async function findDeckAnywhere(deckId: string): Promise<{ deck: Deck; owner: UserFile } | null> {
  const userIds = await listUserIds();
  for (const uid of userIds) {
    const u = await loadUser(uid);
    if (!u) continue;
    const d = u.decks.find((x) => x.id === deckId);
    if (d) return { deck: d, owner: u };
  }
  return null;
}

function dueCards(user: UserFile, deck: Deck, now: Date) {
  return deck.cards.filter((c) => {
    const p = user.progress[c.id];
    if (!p) return true;
    if (!p.nextReviewAt) return true;
    const dueMs = Date.parse(String(p.nextReviewAt));
    return dueMs <= now.getTime();
  });
}

function gradeAnswer(deck: Deck, cardId: string, payload: any): boolean {
  const card = deck.cards.find((c) => c.id === cardId);
  if (!card) return false;

  const t = card.type;
  const data: any = card.data_json ?? {};

  if (t === "TRUE_FALSE") {
    // payload: { answer: true|false }
    return Boolean(payload?.answer) === Boolean(data?.correct);
  }

  if (t === "MCQ_SINGLE") {
    // payload: { index: number }
    const options: any[] = Array.isArray(data?.options) ? data.options : [];
    const correctIndex = options.findIndex((o) => o?.correct === true);
    return Number(payload?.index) === correctIndex;
  }

if (t === "MCQ_MULTI") {
  // payload: { indices: number[] }
  const options: any[] = Array.isArray(data?.options) ? data.options : [];

  // conjunto de índices corretos (numéricos)
  const correct = new Set<number>(
    options
      .map((o: any, i: number) => (o?.correct ? i : -1))
      .filter((i: number) => i >= 0)
  );

  // normaliza respostas do cliente para number[]
  const indices: number[] = Array.isArray(payload?.indices)
    ? (payload.indices as any[]).map((n: any) => Number(n))
    : [];

  const ans = new Set<number>(indices);

  if (ans.size !== correct.size) return false;
  for (const i of ans.values()) {
    if (!correct.has(i)) return false;
  }
  return true;
}

  // Outros tipos (MATCH/TEXT) não são avaliados no MVP
  return false;
}

const Rating = z.enum(["VERY_HARD", "HARD", "MEDIUM", "EASY"]);
type RatingType = z.infer<typeof Rating>;

/** devolve o intervalo (segundos) para um dado rating, 100% tipado */
function intervalFor(user: UserFile, rating: RatingType): number {
  const ints = user.prefs.solo.intervals;
  switch (rating) {
    case "VERY_HARD": return ints.VERY_HARD;
    case "HARD":      return ints.HARD;
    case "MEDIUM":    return ints.MEDIUM;
    case "EASY":      return ints.EASY;
    default: {
      const _never: never = rating;
      return ints.EASY;
    }
  }
}

/* ---------- rotas ---------- */

/** GET /solo/queue?deckId=...&limit=10
 * Devolve as próximas cartas (vencidas + sem progress).
 */
soloRouter.get("/queue", authRequired, async (req: AuthenticatedRequest, res) => {
  // req.query é ParsedQs; vamos ler de forma segura/typada
  const q = req.query as Record<string, unknown>;
  const deckId = typeof q.deckId === "string" ? q.deckId : "";
  const limitRaw = typeof q.limit === "string" ? q.limit : undefined;
  const limitNum = Number(limitRaw ?? "10");
  const limit = Math.max(1, Math.min(100, isNaN(limitNum) ? 10 : limitNum));

  if (!deckId) return res.status(400).json({ error: "DECK_ID_REQUIRED" });

  const found = await findDeckAnywhere(deckId);
  if (!found) return res.status(404).json({ error: "DECK_NOT_FOUND" });

  // se o deck for PRIVADO e não for do próprio, bloqueia
  if (found.deck.visibility !== "PUBLIC" && found.owner.id !== req.auth!.user.id) {
    return res.status(403).json({ error: "DECK_PRIVATE" });
  }

  const now = new Date();
  const items = dueCards(req.auth!.user, found.deck, now)
    .slice(0, limit)
    .map((c) => ({
      deckId: found.deck.id,
      card: {
        id: c.id,
        type: c.type,
        prompt_md: c.prompt_md,
        data_json: c.data_json,
        time_limit_sec: c.time_limit_sec,
        hint: c.hint,
      },
    }));

  return res.json({ deck: { id: found.deck.id, title: found.deck.title }, items });
});

/** POST /solo/answer
 * body: { deckId, cardId, rating: Rating, answer: any }
 * - calcula corretude no servidor
 * - agenda próxima revisão (manual, com base nas prefs do user)
 * - atribui ZAPPs se acertar
 */
soloRouter.post("/answer", authRequired, async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const q = req.query as Record<string, unknown>;

    let deckId = typeof body.deckId === "string" ? body.deckId : String(body.deckId ?? "");
    let cardId = typeof body.cardId === "string" ? body.cardId : String(body.cardId ?? "");
    let ratingIn: unknown = body.rating ?? q.rating;
    const answer = (body.answer as unknown) ?? (typeof q.ans === "string" ? { answer: q.ans === "true" } : undefined);

    // fallback para querystring
    if (!deckId && typeof q.deckId === "string") deckId = q.deckId;
    if (!cardId && typeof q.cardId === "string") cardId = q.cardId;

    if (!deckId || !cardId) return res.status(400).json({ error: "DECK_AND_CARD_REQUIRED" });

    const r = Rating.safeParse(ratingIn);
    if (!r.success) return res.status(400).json({ error: "INVALID_RATING" });
    const ratingVal: RatingType = r.data;

    const found = await findDeckAnywhere(deckId);
    if (!found) return res.status(404).json({ error: "DECK_NOT_FOUND" });

    if (found.deck.visibility !== "PUBLIC" && found.owner.id !== req.auth!.user.id) {
      return res.status(403).json({ error: "DECK_PRIVATE" });
    }

    const user = req.auth!.user;
    const correct = gradeAnswer(found.deck, cardId, answer as any);

    // progresso
    const now = new Date();
    const secs: number = intervalFor(user, ratingVal);
    const nowMs: number = now.getTime();
    const nextAtMs: number = nowMs + secs * 1000;
    const next = new Date(nextAtMs);

    const p = user.progress[cardId] ?? { timesAnswered: 0, timesCorrect: 0 };
    p.timesAnswered += 1;
    if (correct) p.timesCorrect += 1;
    p.lastAnswerAt = now.toISOString();
    p.nextReviewAt = next.toISOString();
    p.lastRating = ratingVal;
    user.progress[cardId] = p;

    // stats
    user.stats.answersTotal += 1;
    if (correct) user.stats.correctTotal += 1;

    // ZAPPs (simples para MVP)
    const rewardMap: Record<RatingType, number> = {
      VERY_HARD: 15,
      HARD: 12,
      MEDIUM: 8,
      EASY: 5,
    };
    const zapps = correct ? rewardMap[ratingVal] : 0;

    if (zapps > 0) {
      await appendTransaction(user.id, {
        id: nanoid(12),
        ts: now.toISOString(),
        type: "EARN",
        amount: zapps,
        reason: "solo_correct",
        ref: `${deckId}:${cardId}`,
      });
    }

    await saveUser(user);

    return res.json({
      correct,
      zappsEarned: zapps,
      nextReviewAt: p.nextReviewAt,
      stats: user.stats,
      progress: p,
    });
  } catch (e: any) {
    return res.status(500).json({ error: "ANSWER_FAILED", details: String(e?.message || e) });
  }
});

/** GET /solo/progress?deckId=...  (para UI) */
soloRouter.get("/progress", authRequired, async (req: AuthenticatedRequest, res) => {
  const q = req.query as Record<string, unknown>;
  const deckId = typeof q.deckId === "string" ? q.deckId : "";
  if (!deckId) return res.status(400).json({ error: "DECK_ID_REQUIRED" });

  const found = await findDeckAnywhere(deckId);
  if (!found) return res.status(404).json({ error: "DECK_NOT_FOUND" });

  const user = req.auth!.user;
  const items = found.deck.cards.map((c) => ({
    cardId: c.id,
    title: (c.prompt_md || "").slice(0, 60),
    progress: user.progress[c.id] ?? null,
  }));

  return res.json({ deck: { id: found.deck.id, title: found.deck.title }, items });
});
