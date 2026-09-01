// ============================================================
//  Quiz Show — servidor multiplayer em tempo real
//  TV (host) exibe o QR; celulares entram como controles.
// ============================================================
const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const QUESTIONS = require("./questions.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

// ---------- utilidades ----------
const CATEGORIES = [...new Set(QUESTIONS.map(q => q.c))];

function lanUrl() {
  // tenta achar um IP de rede local (para celulares no mesmo Wi-Fi)
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return `http://${net.address}:${PORT}`;
      }
    }
  }
  return `http://localhost:${PORT}`;
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I,O,0,1
  let c;
  do { c = Array.from({ length: 4 }, () => chars[Math.random() * chars.length | 0]).join(""); }
  while (rooms.has(c));
  return c;
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function makeDeck(category, count) {
  let pool = category && category !== "Todos" ? QUESTIONS.filter(q => q.c === category) : QUESTIONS;
  pool = shuffle(pool);
  return count > 0 ? pool.slice(0, count) : pool;
}

// ---------- estado ----------
const rooms = new Map();   // code -> room
const socketRoom = new Map(); // socketId -> code (para achar a sala do jogador)

function scoreboard(room) {
  return [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, score: p.score, online: p.online }))
    .sort((a, b) => b.score - a.score);
}

function pushPlayers(room) {
  const list = scoreboard(room);
  io.to(room.code).emit("room:players", { players: list });
  io.to(room.code + ":host").emit("room:players", { players: list });
}

// ---------- ciclo de perguntas ----------
function sendQuestion(room) {
  room.qIndex++;
  if (room.qIndex >= room.deck.length) return endGame(room);

  const q = room.deck[room.qIndex];
  room.current = {
    correct: q.a,
    open: true,
    resolved: false,
    lockedOut: new Set(), // jogadores que já erraram nesta pergunta
  };
  clearTimeout(room.timerHandle);

  const payload = {
    index: room.qIndex + 1,
    total: room.deck.length,
    category: q.c,
    question: q.q,
    options: q.o,
    time: room.settings.time,
  };
  // host recebe também a resposta certa (para revelar), jogadores não
  io.to(room.code + ":host").emit("game:question", { ...payload, correct: q.a });
  io.to(room.code).emit("game:question", payload);

  if (room.settings.time > 0) {
    room.timerHandle = setTimeout(() => onTimeout(room), room.settings.time * 1000 + 400);
  }
}

function onTimeout(room) {
  const cur = room.current;
  if (!cur || cur.resolved) return;
  resolve(room, { awardedTo: null, wrongPlayer: null, timeout: true });
}

function resolve(room, { awardedTo, wrongPlayer, timeout, allWrong }) {
  const cur = room.current;
  if (!cur || cur.resolved) return;
  cur.resolved = true;
  cur.open = false;
  clearTimeout(room.timerHandle);

  io.to(room.code).emit("game:result", {
    correctIndex: cur.correct,
    awardedTo, wrongPlayer, timeout: !!timeout, allWrong: !!allWrong,
    scores: scoreboard(room),
  });
  io.to(room.code + ":host").emit("game:result", {
    correctIndex: cur.correct,
    awardedTo, wrongPlayer, timeout: !!timeout, allWrong: !!allWrong,
    scores: scoreboard(room),
  });

  // avança automaticamente
  room.advanceHandle = setTimeout(() => { if (rooms.has(room.code)) sendQuestion(room); }, 4500);
}

function endGame(room) {
  room.state = "over";
  room.current = null;
  const final = scoreboard(room);
  io.to(room.code).emit("game:over", { scores: final });
  io.to(room.code + ":host").emit("game:over", { scores: final });
}

// ---------- núcleo do buzzer ----------
function handleAnswer(room, player, optionIndex) {
  const cur = room.current;
  if (!cur || !cur.open || cur.resolved) return;      // pergunta fechada
  if (cur.lockedOut.has(player.id)) return;           // já errou esta pergunta

  // >>> O primeiro clique válido fecha para todos <<<
  cur.open = false;
  const correct = optionIndex === cur.correct;

  if (correct) {
    player.score += 1;
    return resolve(room, { awardedTo: { id: player.id, name: player.name }, wrongPlayer: null });
  }

  // errou
  cur.lockedOut.add(player.id);
  const players = [...room.players.values()];

  if (players.length === 2) {
    // ponto vai para o oponente
    const opp = players.find(p => p.id !== player.id);
    if (opp) opp.score += 1;
    return resolve(room, {
      awardedTo: opp ? { id: opp.id, name: opp.name } : null,
      wrongPlayer: { id: player.id, name: player.name },
    });
  }

  if (players.length >= 3) {
    const restantes = players.filter(p => !cur.lockedOut.has(p.id));
    if (restantes.length === 0) {
      // todos erraram
      return resolve(room, { awardedTo: null, wrongPlayer: { id: player.id, name: player.name }, allWrong: true });
    }
    // TV mostra o erro e reabre para os outros
    cur.open = true;
    const evt = {
      wrongPlayer: { id: player.id, name: player.name },
      lockedOut: [...cur.lockedOut],
    };
    io.to(room.code).emit("game:reopen", evt);
    io.to(room.code + ":host").emit("game:reopen", evt);
    return;
  }

  // 1 jogador: sem oponente, apenas revela
  return resolve(room, { awardedTo: null, wrongPlayer: { id: player.id, name: player.name }, allWrong: true });
}

// ============================================================
//  Sockets
// ============================================================
io.on("connection", (socket) => {

  // ---- HOST (TV) cria a sala ----
  socket.on("host:create", () => {
    const code = roomCode();
    const room = {
      code, hostSocketId: socket.id,
      players: new Map(), state: "lobby",
      deck: [], qIndex: -1, current: null,
      settings: { category: "Todos", count: 10, time: 20 },
      timerHandle: null, advanceHandle: null,
    };
    rooms.set(code, room);
    socket.join(code + ":host");
    socket.data.hostRoom = code;
    socket.emit("host:created", { code, lanUrl: lanUrl(), categories: ["Todos", ...CATEGORIES] });
  });

  // ---- HOST inicia o jogo ----
  socket.on("host:start", (settings = {}) => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room) return;
    room.settings = {
      category: settings.category || "Todos",
      count: Number(settings.count) || 10,
      time: settings.time === undefined ? 20 : Number(settings.time),
    };
    room.deck = makeDeck(room.settings.category, room.settings.count);
    room.qIndex = -1;
    room.state = "playing";
    for (const p of room.players.values()) p.score = 0;
    io.to(room.code).emit("game:start", {});
    io.to(room.code + ":host").emit("game:start", {});
    pushPlayers(room);
    sendQuestion(room);
  });

  // ---- HOST pula para a próxima ----
  socket.on("host:next", () => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room || room.state !== "playing") return;
    clearTimeout(room.advanceHandle); clearTimeout(room.timerHandle);
    sendQuestion(room);
  });

  // ---- HOST reinicia (volta ao lobby) ----
  socket.on("host:restart", () => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room) return;
    clearTimeout(room.advanceHandle); clearTimeout(room.timerHandle);
    room.state = "lobby"; room.current = null; room.qIndex = -1;
    for (const p of room.players.values()) p.score = 0;
    io.to(room.code).emit("game:lobby", {});
    io.to(room.code + ":host").emit("game:lobby", {});
    pushPlayers(room);
  });

  // ---- JOGADOR entra ----
  socket.on("player:join", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: "Sala não encontrada." });
    name = (name || "").trim().slice(0, 16) || "Jogador";

    const id = socket.id;
    room.players.set(id, { id, socketId: socket.id, name, score: 0, online: true });
    socket.join(code);
    socket.data.playerRoom = code;
    socketRoom.set(socket.id, code);
    cb && cb({ ok: true, playerId: id, name, state: room.state });
    pushPlayers(room);
  });

  // ---- JOGADOR responde (isto é o "buzz") ----
  socket.on("player:answer", ({ optionIndex }) => {
    const code = socket.data.playerRoom;
    const room = rooms.get(code);
    if (!room || room.state !== "playing") return;
    const player = room.players.get(socket.id);
    if (!player) return;
    handleAnswer(room, player, Number(optionIndex));
  });

  // ---- desconexão ----
  socket.on("disconnect", () => {
    // host saiu → encerra a sala
    const hostCode = socket.data.hostRoom;
    if (hostCode && rooms.has(hostCode)) {
      const room = rooms.get(hostCode);
      clearTimeout(room.advanceHandle); clearTimeout(room.timerHandle);
      io.to(hostCode).emit("room:closed", {});
      rooms.delete(hostCode);
    }
    // jogador saiu → marca offline (mantém pontuação por alguns minutos)
    const pCode = socket.data.playerRoom;
    if (pCode && rooms.has(pCode)) {
      const room = rooms.get(pCode);
      const p = room.players.get(socket.id);
      if (p) { p.online = false; }
      pushPlayers(room);
    }
  });
});

server.listen(PORT, () => {
  console.log("=================================================");
  console.log("  Quiz Show rodando!");
  console.log("  Neste computador:  http://localhost:" + PORT);
  console.log("  Na rede local (TV / celulares):  " + lanUrl());
  console.log("  Abra a URL acima e clique em 'Sou a TV (Host)'.");
  console.log("=================================================");
});
