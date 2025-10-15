import { Server as SocketIOServer, Socket } from "socket.io";
import { loadUser } from "../lib/store";
import { battleHub } from "../services/battleHub";

/** Define os campos que queremos no socket.data */
declare module "socket.io" {
  interface SocketData {
    userId: string;
    username: string;
  }
}

/** Middleware de auth por querystring (uid/ds) */
async function authSocket(socket: Socket, next: (err?: Error) => void) {
  try {
    const uid = String(socket.handshake.query.uid || "");
    const ds  = String(socket.handshake.query.ds  || "");
    if (!uid || !ds) return next(new Error("NO_AUTH"));

    const user = await loadUser(uid);
    if (!user) return next(new Error("USER_NOT_FOUND"));
    if (!user.auth.deviceSecrets.includes(ds)) return next(new Error("INVALID_DEVICE_SECRET"));

    // Agora socket.data tem o tipo augmentado (SocketData)
    socket.data.userId = user.id;
    socket.data.username = user.username;
    next();
  } catch (e: any) {
    next(new Error(String(e?.message || e)));
  }
}


export function attachBattleSockets(io: SocketIOServer) {
  io.use(authSocket);

  io.on("connection", (socket) => {
    const u = socket.data;
    console.log(`[ws] ${u.username} (${u.userId}) connected: ${socket.id}`);

    function joinRoom(lobbyId: string) {
      socket.join(lobbyId);
      io.to(lobbyId).emit("lobby:peer", { userId: u.userId, username: u.username, type: "JOIN" });
    }

    socket.on("disconnect", (reason) => {
      console.log(`[ws] ${u.username} disconnected: ${reason}`);
    });

    socket.on("battles:join", async (payload: { lobbyId?: string; pin?: string }, ack?: Function) => {
      try {
        const lobby = await battleHub.join({
          lobbyId: payload?.lobbyId,
          pin: payload?.pin,
          userId: u.userId,
          username: u.username,
        });
        joinRoom(lobby.id);
        // Se não tiveres battleHub.publicLobby, podes enviar `lobby` direto
        ack?.({ ok: true, lobby });
      } catch (e: any) {
        ack?.({ ok: false, error: String(e?.message || e) });
      }
    });

    socket.on("battles:start", (payload: { lobbyId: string }, ack?: Function) => {
      try {
        const lob = battleHub.getLobby(payload.lobbyId);
        if (!lob) throw new Error("LOBBY_NOT_FOUND");
        if (lob.hostId !== u.userId) throw new Error("ONLY_HOST_CAN_START");
        battleHub.start(payload.lobbyId);
        const after = battleHub.getLobby(payload.lobbyId)!;
        ack?.({ ok: true, lobby: after });
      } catch (e: any) {
        ack?.({ ok: false, error: String(e?.message || e) });
      }
    });

    socket.on("battles:next", (payload: { lobbyId: string }, ack?: Function) => {
      try {
        const lob = battleHub.getLobby(payload.lobbyId);
        if (!lob) throw new Error("LOBBY_NOT_FOUND");
        if (lob.hostId !== u.userId) throw new Error("ONLY_HOST_CAN_NEXT");
        battleHub.next(payload.lobbyId);
        const after = battleHub.getLobby(payload.lobbyId)!;
        ack?.({ ok: true, lobby: after, finished: !!after.finishedAt });
      } catch (e: any) {
        ack?.({ ok: false, error: String(e?.message || e) });
      }
    });

    socket.on("battles:answer", (payload: { lobbyId: string; answer: any }, ack?: Function) => {
      try {
        const lob = battleHub.getLobby(payload.lobbyId);
        if (!lob) throw new Error("LOBBY_NOT_FOUND");
        if (!lob.players[u.userId]) throw new Error("NOT_IN_LOBBY");
        const { correct, delta, elapsed } = battleHub.submitAnswer({
          lobbyId: payload.lobbyId,
          userId: u.userId,
          payload: payload.answer,
        });
        const player = lob.players[u.userId];
        ack?.({ ok: true, correct, delta, elapsed, score: player.score });
      } catch (e: any) {
        ack?.({ ok: false, error: String(e?.message || e) });
      }
    });

    socket.on("battles:list", (_: any, ack?: Function) => {
      ack?.({ ok: true, lobbies: battleHub.listPublic() });
    });
  });
}