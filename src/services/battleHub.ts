import { Server as SocketIOServer } from "socket.io";
import { nanoid } from "nanoid";
import { loadUser, saveUser, appendTransaction, listUserIds } from "../lib/store";
import type { Deck, UserFile } from "../lib/store";

/** Tipos suportados em battles */
const ELIGIBLE_TYPES = new Set<Deck["cards"][number]["type"]>([
  "TRUE_FALSE",
  "MCQ_SINGLE",
  "MCQ_MULTI",
]);

export type AccessMode = "PUBLIC" | "PRIVATE";

export type QuestionSnapshot = {
  id: string;               // id do card original
  type: "TRUE_FALSE" | "MCQ_SINGLE" | "MCQ_MULTI";
  prompt_md: string;
  data_json: any;           // snapshot de opções/correto (imutável durante a battle)
  time_limit_sec?: number;
  hint?: string;
};

export type PlayerState = {
  userId: string;
  username: string;
  score: number;
  answers: Record<string, { correct: boolean; ms: number }>; // por questionId
};

export type Lobby = {
  id: string;
  hostId: string;
  deckId: string;
  deckTitle: string;
  access: AccessMode;
  pin?: string;                  // se PRIVATE, 6 dígitos
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;

  players: Record<string, PlayerState>; // key = userId
  order: string[];                       // ordem de players
  snapshots: QuestionSnapshot[];         // perguntas da battle
  qIndex: number;                        // índice atual
  qShownAt?: number;                     // ms epoch quando a pergunta atual foi emitida
};

function nowISO() { return new Date().toISOString(); }
function nowMs()  { return Date.now(); }

function pick<T>(arr: T[], n: number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Procura deck por todos os utilizadores (público ou owner) */
export async function findDeckAnywhere(deckId: string): Promise<{ deck: Deck; owner: UserFile } | null> {
  const userIds = await listUserIds();
  for (const uid of userIds) {
    const u = await loadUser(uid);
    if (!u) continue;
    const d = u.decks.find(x => x.id === deckId);
    if (d) return { deck: d, owner: u };
  }
  return null;
}

/** Avaliação server-side (igual ao solo) */
function gradeAnswer(snapshot: QuestionSnapshot, payload: any): boolean {
  const t = snapshot.type;
  const data: any = snapshot.data_json ?? {};

  if (t === "TRUE_FALSE") {
    return Boolean(payload?.answer) === Boolean(data?.correct);
  }
  if (t === "MCQ_SINGLE") {
    const options: any[] = Array.isArray(data?.options) ? data.options : [];
    const correctIndex = options.findIndex(o => o?.correct === true);
    return Number(payload?.index) === correctIndex;
  }
  if (t === "MCQ_MULTI") {
    const options: any[] = Array.isArray(data?.options) ? data.options : [];
    const correct = new Set<number>(
      options.map((o: any, i: number) => (o?.correct ? i : -1)).filter((i: number) => i >= 0)
    );
    const indices: number[] = Array.isArray(payload?.indices)
      ? (payload.indices as any[]).map((n: any) => Number(n))
      : [];
    const ans = new Set<number>(indices);
    if (ans.size !== correct.size) return false;
    for (const i of ans.values()) if (!correct.has(i)) return false;
    return true;
  }
  return false;
}

export class BattleHub {
  private io?: SocketIOServer;
  private lobbies = new Map<string, Lobby>();
  private pinIndex = new Map<string, string>(); // pin -> lobbyId

  attachIO(io: SocketIOServer) { this.io = io; }

  /** Cria lobby e pré-seleciona N perguntas do deck (apenas tipos elegíveis) */
  async createLobby(opts: {
    hostId: string;
    deckId: string;
    count: number;
    access: AccessMode;
  }): Promise<Lobby> {
    const found = await findDeckAnywhere(opts.deckId);
    if (!found) throw new Error("DECK_NOT_FOUND");
    const { deck, owner } = found;

    if (deck.visibility !== "PUBLIC" && owner.id !== opts.hostId) {
      throw new Error("DECK_PRIVATE");
    }

    const eligibles = deck.cards.filter(c => ELIGIBLE_TYPES.has(c.type as any));
    if (eligibles.length === 0) throw new Error("NO_ELIGIBLE_CARDS");

    const shots: QuestionSnapshot[] = pick(eligibles, Math.min(opts.count, eligibles.length)).map(c => ({
      id: c.id,
      type: c.type as QuestionSnapshot["type"],
      prompt_md: c.prompt_md,
      data_json: c.data_json,
      time_limit_sec: c.time_limit_sec,
      hint: c.hint,
    }));

    const lobbyId = nanoid(8);
    const pin = opts.access === "PRIVATE" ? String(Math.floor(100000 + Math.random() * 900000)) : undefined;

    const lobby: Lobby = {
      id: lobbyId,
      hostId: opts.hostId,
      deckId: deck.id,
      deckTitle: deck.title,
      access: opts.access,
      pin,
      createdAt: nowISO(),
      players: {},
      order: [],
      snapshots: shots,
      qIndex: -1,
    };

    this.lobbies.set(lobbyId, lobby);
    if (pin) this.pinIndex.set(pin, lobbyId);

    return lobby;
  }

  /** Join por lobbyId ou PIN; devolve estado resumido */
  async join(opts: { lobbyId?: string; pin?: string; userId: string; username: string }): Promise<Lobby> {
    let id = opts.lobbyId;
    if (!id && opts.pin) id = this.pinIndex.get(opts.pin);
    if (!id) throw new Error("LOBBY_NOT_FOUND");

    const lobby = this.lobbies.get(id!);
    if (!lobby) throw new Error("LOBBY_NOT_FOUND");
    if (lobby.finishedAt) throw new Error("LOBBY_FINISHED");

    if (!lobby.players[opts.userId]) {
      lobby.players[opts.userId] = { userId: opts.userId, username: opts.username, score: 0, answers: {} };
      lobby.order.push(opts.userId);
    }

    // notificar via socket (se ligado)
    this.io?.to(lobby.id).emit("lobby:update", this.publicLobby(lobby));
    return lobby;
  }

  /** Arranca a battle: avança para a Q0 e emite via socket */
  start(lobbyId: string) {
    const lobby = this.requireLobby(lobbyId);
    if (lobby.startedAt) throw new Error("ALREADY_STARTED");
    lobby.startedAt = nowISO();
    lobby.qIndex = 0;
    lobby.qShownAt = nowMs();
    this.emitQuestion(lobby);
  }

  /** Avança para próxima pergunta */
  next(lobbyId: string) {
    const lobby = this.requireLobby(lobbyId);
    if (!lobby.startedAt) throw new Error("NOT_STARTED");
    lobby.qIndex += 1;
    if (lobby.qIndex >= lobby.snapshots.length) {
      this.finish(lobbyId);
      return;
    }
    lobby.qShownAt = nowMs();
    this.emitQuestion(lobby);
  }

  /** Submissão de resposta de um player */
  submitAnswer(opts: { lobbyId: string; userId: string; payload: any }) {
    const lobby = this.requireLobby(opts.lobbyId);
    if (lobby.qIndex < 0 || lobby.qIndex >= lobby.snapshots.length) throw new Error("NO_ACTIVE_QUESTION");

    const q = lobby.snapshots[lobby.qIndex];
    const elapsed = Math.max(0, nowMs() - (lobby.qShownAt ?? nowMs())); // ms
    const correct = gradeAnswer(q, opts.payload);

    // scoring simples: 100 se correto, + bónus de velocidade (até 50) nos primeiros 5s
    let delta = 0;
    if (correct) {
      const speedBonus = Math.max(0, 5000 - elapsed); // 0..5000
      delta = 100 + Math.round(50 * (speedBonus / 5000));
    }

    const player = lobby.players[opts.userId];
    if (!player) throw new Error("PLAYER_NOT_IN_LOBBY");

    // Evitar múltiplas submissões: se já respondeu à mesma id, ignora
    const key = `${q.id}:${lobby.qIndex}`;
    if (!player.answers[key]) {
      player.answers[key] = { correct, ms: elapsed };
      player.score += delta;
    }

    this.io?.to(lobby.id).emit("lobby:scores", {
      lobbyId: lobby.id,
      scores: lobby.order.map(uid => ({ userId: uid, username: lobby.players[uid].username, score: lobby.players[uid].score })),
    });

    return { correct, delta, elapsed };
  }

  /** Termina a battle e distribui ZAPPs (simples) */
  async finish(lobbyId: string) {
    const lobby = this.requireLobby(lobbyId);
    if (lobby.finishedAt) return;
    lobby.finishedAt = nowISO();

    // top 3 recebem 30/20/10 ZAPPs
    const ranking = lobby.order
      .map(uid => ({ userId: uid, username: lobby.players[uid].username, score: lobby.players[uid].score }))
      .sort((a, b) => b.score - a.score);

    const prizes = [30, 20, 10];
    const awards = ranking.slice(0, 3).map((r, i) => ({ ...r, zapps: prizes[i] }));

    for (const a of awards) {
      const u = await loadUser(a.userId);
      if (!u) continue;
      await appendTransaction(u.id, {
        id: nanoid(12),
        ts: nowISO(),
        type: "EARN",
        amount: a.zapps,
        reason: "battle_prize",
        ref: lobby.id,
      });
      await saveUser(u);
    }

    this.io?.to(lobby.id).emit("lobby:finished", { lobbyId: lobby.id, ranking });
  }

  /** Utilidades */
  getLobby(lobbyId: string) { return this.lobbies.get(lobbyId) ?? null; }

  listPublic() {
    return Array.from(this.lobbies.values())
      .filter(l => l.access === "PUBLIC" && !l.finishedAt)
      .map(l => this.publicLobby(l));
  }

  publicLobby(l: Lobby) {
    return {
      id: l.id,
      deckId: l.deckId,
      deckTitle: l.deckTitle,
      access: l.access,
      createdAt: l.createdAt,
      startedAt: l.startedAt,
      players: l.order.map(uid => ({ userId: uid, username: l.players[uid].username, score: l.players[uid].score })),
      qIndex: l.qIndex,
      total: l.snapshots.length,
    };
  }

  private requireLobby(lobbyId: string): Lobby {
    const l = this.lobbies.get(lobbyId);
    if (!l) throw new Error("LOBBY_NOT_FOUND");
    return l;
  }

  private emitQuestion(lobby: Lobby) {
    const q = lobby.snapshots[lobby.qIndex];
    // Nunca enviamos info de correção extra — só snapshot (server corrige)
    this.io?.to(lobby.id).emit("lobby:question", {
      lobbyId: lobby.id,
      qIndex: lobby.qIndex,
      total: lobby.snapshots.length,
      shownAt: lobby.qShownAt,
      question: {
        id: q.id,
        type: q.type,
        prompt_md: q.prompt_md,
        data_json: q.data_json,
        time_limit_sec: q.time_limit_sec,
        hint: q.hint,
      },
    });
  }
}

export const battleHub = new BattleHub();
