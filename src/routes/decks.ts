import express from "express";
import { z } from "zod";
import type { UserFile, Deck } from "../lib/store";
import { /* ...as mesmas funções que já tinhas... */ } from "../lib/store";
import type { DeckInput, CardInput } from "../lib/store";
import { authRequired } from "./auth";
import type { AuthenticatedRequest } from "./auth";

export const decksRouter = express.Router();

/* ----------------- schemas ----------------- */

const TopicPath = z.object({
  theme: z.string().min(1),
  subtheme: z.string().optional(),
  subsubtheme: z.string().optional(),
});

const Card = z.object({
  id: z.string().optional(), // se vier, ignoramos no upsert (servidor recria)
  type: z.enum([
    "MCQ_SINGLE",
    "MCQ_MULTI",
    "TRUE_FALSE",
    "MATCH_LINES",
    "MATCH_BUCKETS",
    "TEXT",
  ]),
  prompt_md: z.string().min(1),
  data_json: z.any(), // requerido no DeckInput -> garantimos abaixo (fallback {})
  time_limit_sec: z.number().int().positive().optional(),
  hint: z.string().optional(),
});

const DeckUpsert = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  topic: TopicPath,
  visibility: z.enum(["PUBLIC", "PRIVATE"]),
  tags: z.array(z.string()).optional(),
  cards: z.array(Card).default([]),
});

type CardZ = z.infer<typeof Card>;
type DeckUpsertZ = z.infer<typeof DeckUpsert>;

/* ----------------- helpers ----------------- */

function sanitizeDeck(d: Deck) {
  // nada sensível no deck em si para o MVP
  return d;
}

async function findDeckAcrossCommunity(deckId: string): Promise<{ deck: Deck; owner: UserFile } | null> {
  const userIds = await listUserIds();
  for (const uid of userIds) {
    const u = await loadUser(uid);
    if (!u) continue;
    const deck = u.decks.find(d => d.id === deckId);
    if (deck) return { deck, owner: u };
  }
  return null;
}

/** Converte payload do Zod -> DeckInput (o que o store/upsertDeck espera) */
function toDeckInput(src: DeckUpsertZ): DeckInput {
  const cards: CardInput[] = (src.cards ?? []).map((c: CardZ) => {
    const { id: _omit, type, prompt_md, data_json, time_limit_sec, hint } = c;
    return {
      type,
      prompt_md,
      data_json: data_json ?? {}, // garantir requerido
      time_limit_sec,
      hint,
    } as CardInput;
  });

  return {
    id: src.id,
    title: src.title,
    topic: src.topic,
    visibility: src.visibility,
    tags: src.tags ?? [],
    cards,
  };
}

/* ----------------- rotas ----------------- */

/** POST /decks/upsert  (autenticado)
 * body: DeckUpsert -> cria/atualiza deck do próprio utilizador
 */
decksRouter.post("/upsert", authRequired, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = DeckUpsert.parse(req.body);
    const input: DeckInput = toDeckInput(parsed);
    const deck = await upsertDeck(req.auth!.user.id, input);
    return res.status(parsed.id ? 200 : 201).json({ deck: sanitizeDeck(deck) });
  } catch (e: any) {
    if (e?.issues) return res.status(400).json({ error: "INVALID_DECK", issues: e.issues });
    return res.status(500).json({ error: "UPSERT_FAILED", details: String(e?.message || e) });
  }
});

/** GET /decks/mine  (autenticado) */
decksRouter.get("/mine", authRequired, async (req: AuthenticatedRequest, res) => {
  const user = req.auth!.user;
  return res.json({ decks: user.decks.map(sanitizeDeck) });
});

/** GET /decks/public  (aberto) — lista decks públicos com autor */
decksRouter.get("/public", async (_req, res) => {
  const rows = await listPublicDecks();
  return res.json({
    decks: rows.map(r => ({
      deck: sanitizeDeck(r.deck),
      owner: r.owner, // { userId, username }
    })),
  });
});

/** GET /decks/:deckId  (aberto) — procura em toda a comunidade (se público) */
decksRouter.get("/:deckId", async (req, res) => {
  const { deckId } = req.params;
  const found = await findDeckAcrossCommunity(deckId);
  if (!found) return res.status(404).json({ error: "DECK_NOT_FOUND" });
  if (found.deck.visibility !== "PUBLIC") {
    // só expomos deck privado ao próprio (via header opcional)
    const uid = String(req.header("x-user-id") || "");
    if (uid !== found.owner.id) return res.status(403).json({ error: "DECK_PRIVATE" });
  }
  return res.json({
    deck: sanitizeDeck(found.deck),
    owner: { userId: found.owner.id, username: found.owner.username },
  });
});

/** DELETE /decks/:deckId  (autenticado) — remove deck do próprio */
decksRouter.delete("/:deckId", authRequired, async (req: AuthenticatedRequest, res) => {
  try {
    const { deckId } = req.params;
    const user = req.auth!.user;
    const before = user.decks.length;
    user.decks = user.decks.filter(d => d.id !== deckId);
    if (user.decks.length === before) return res.status(404).json({ error: "DECK_NOT_FOUND" });
    await saveUser(user);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: "DELETE_FAILED", details: String(e?.message || e) });
  }
});

/** POST /decks/import  (autenticado)
 * Aceita:
 *  - body.jsonDeck: objeto DeckUpsert (sem id)  OU
 *  - body.text: CSV/TSV com colunas: type,prompt_md,data_json,time_limit_sec,hint
 */
decksRouter.post("/import", authRequired, async (req: AuthenticatedRequest, res) => {
  try {
    const { jsonDeck, text, title, topic, visibility = "PRIVATE", tags = [] } = req.body || {};
    let cards: Array<CardZ> = [];

    if (jsonDeck) {
      const parsedDeck = DeckUpsert.parse(jsonDeck);
      cards = parsedDeck.cards ?? [];
    } else if (typeof text === "string") {
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length === 0) return res.status(400).json({ error: "EMPTY_TEXT" });
      const sep = lines[0].includes("\t") ? "\t" : ","; // TSV ou CSV
      const header = lines[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (k: string) => header.indexOf(k);

      const reqCols = ["type", "prompt_md", "data_json"];
      for (const c of reqCols) if (idx(c) === -1) {
        return res.status(400).json({ error: "MISSING_COLUMN", column: c });
      }

      for (const line of lines.slice(1)) {
        const cols = line.split(sep);
        const type = cols[idx("type")]?.trim();
        const prompt_md = cols[idx("prompt_md")]?.trim();
        const dataStr = cols[idx("data_json")]?.trim();
        const timeStr = idx("time_limit_sec") !== -1 ? cols[idx("time_limit_sec")]?.trim() : undefined;
        const hint = idx("hint") !== -1 ? cols[idx("hint")]?.trim() : undefined;

        let data_json: any = undefined;
        try { data_json = dataStr ? JSON.parse(dataStr) : {}; } catch {
          return res.status(400).json({ error: "INVALID_DATA_JSON", line });
        }
        const time_limit_sec = timeStr ? Number(timeStr) : undefined;

        const cParse = Card.safeParse({ type, prompt_md, data_json, time_limit_sec, hint });
        if (!cParse.success) {
          return res.status(400).json({ error: "INVALID_CARD", line, issues: cParse.error.issues });
        }
        cards.push(cParse.data);
      }
    } else {
      return res.status(400).json({ error: "NO_IMPORT_PAYLOAD" });
    }

    const baseParsed = DeckUpsert.parse({
      title: title ?? "Imported Deck",
      topic: topic ?? { theme: "IT" },
      visibility,
      tags,
      cards,
    });

    const input: DeckInput = toDeckInput(baseParsed);
    const deck = await upsertDeck(req.auth!.user.id, input);
    return res.status(201).json({ deck: sanitizeDeck(deck) });
  } catch (e: any) {
    if (e?.issues) return res.status(400).json({ error: "INVALID_IMPORT", issues: e.issues });
    return res.status(500).json({ error: "IMPORT_FAILED", details: String(e?.message || e) });
  }
});
