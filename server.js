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

const fs = require("fs");
const PORT = process.env.PORT || 3000;

// Procura as páginas em public/ OU na raiz (caso o upload tenha "achatado" a estrutura)
const CANDIDATE_DIRS = [path.join(__dirname, "public"), __dirname];
function findPage(name) {
  for (const d of CANDIDATE_DIRS) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// arquivos estáticos (se a pasta public existir)
app.use(express.static(path.join(__dirname, "public")));

// rotas explícitas das páginas — funcionam esteja o html em public/ ou na raiz
app.get(["/", "/index.html"], (req, res, next) => { const f = findPage("index.html"); f ? res.sendFile(f) : next(); });
app.get("/host.html", (req, res, next) => { const f = findPage("host.html"); f ? res.sendFile(f) : next(); });
app.get("/player.html", (req, res, next) => { const f = findPage("player.html"); f ? res.sendFile(f) : next(); });

// mensagem clara se nada for encontrado (ajuda a diagnosticar no Railway)
app.use((req, res) => {
  if (findPage("index.html")) return res.status(404).send("404 — página não encontrada: " + req.path);
  res.status(500).send(
    "<h2>Arquivos do site não encontrados.</h2>" +
    "<p>O servidor subiu, mas não achou <b>index.html</b>/<b>host.html</b>/<b>player.html</b>.</p>" +
    "<p>No GitHub, confirme que estes arquivos estão no repositório (na raiz ou dentro de uma pasta <b>public/</b>), " +
    "junto com o <b>server.js</b> e o <b>package.json</b>.</p>"
  );
});

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

const ANSWER_TIME = 10; // segundos para responder depois de apertar o botão
const MAX_READING = 30; // segurança: libera o buzz no máximo após esse tempo de leitura
const P = p => ({ id: p.id, name: p.name, team: p.team || null });

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// embaralha as 4 alternativas e recalcula o índice da correta
function shuffleOptions(q) {
  const idx = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[idx[i], idx[j]] = [idx[j], idx[i]]; }
  return { c: q.c, q: q.q, o: idx.map(k => q.o[k]), a: idx.indexOf(q.a) };
}

function makeDeck(category, count) {
  let pool = category && category !== "Todos" ? QUESTIONS.filter(q => q.c === category) : QUESTIONS;
  pool = shuffle(pool);
  const deck = count > 0 ? pool.slice(0, count) : pool;
  return deck.map(shuffleOptions); // a posição da resposta certa varia em cada pergunta
}

// ---------- estado ----------
const rooms = new Map();   // code -> room
const socketRoom = new Map(); // socketId -> code (para achar a sala do jogador)

function scoreboard(room) {
  return [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, score: p.score, online: p.online, team: p.team || null }))
    .sort((a, b) => b.score - a.score);
}

function teamTotals(room) {
  let blue = 0, red = 0;
  for (const p of room.players.values()) {
    if (p.team === "blue") blue += p.score;
    else if (p.team === "red") red += p.score;
  }
  return { blue, red };
}

function balanceTeams(room) {
  const players = [...room.players.values()];
  const count = t => players.filter(p => p.team === t).length;
  // preenche quem não escolheu, sempre no time menor
  for (const p of players) {
    if (p.team !== "blue" && p.team !== "red") {
      p.team = count("blue") <= count("red") ? "blue" : "red";
    }
  }
  // se um time ficou vazio, divide todo mundo de forma alternada
  if ((count("blue") === 0 || count("red") === 0) && players.length >= 2) {
    players.forEach((p, i) => { p.team = i % 2 ? "red" : "blue"; });
  }
}

function pushPlayers(room) {
  const payload = { players: scoreboard(room), mode: room.mode };
  io.to(room.code).emit("room:players", payload);
  io.to(room.code + ":host").emit("room:players", payload);
}

// ---------- ciclo de perguntas ----------
function sendQuestion(room) {
  room.qIndex++;
  if (room.qIndex >= room.deck.length) return endGame(room);

  const q = room.deck[room.qIndex];
  room.current = {
    correct: q.a,
    phase: "reading",     // "reading" = TV lendo; "buzz" = pode apertar; "answer" = respondendo
    responder: null,
    resolved: false,
    lockedOut: new Set(), // quem já errou/estourou o tempo nesta pergunta
  };
  clearTimeout(room.buzzTimer);
  clearTimeout(room.answerTimer);
  clearTimeout(room.readingTimer);

  const payload = {
    index: room.qIndex + 1,
    total: room.deck.length,
    category: q.c,
    question: q.q,
    options: q.o,
    time: room.settings.time,   // janela para apertar o botão
    answerTime: ANSWER_TIME,    // tempo para responder após apertar
  };
  io.to(room.code + ":host").emit("game:question", { ...payload, correct: q.a });
  io.to(room.code).emit("game:question", payload);

  // o buzz só abre quando o host termina de ler (host:readingDone) — ou por segurança após MAX_READING
  room.readingTimer = setTimeout(() => openBuzz(room), MAX_READING * 1000);
}

// libera o buzz para todos (chamado quando a leitura termina)
function openBuzz(room) {
  const cur = room.current;
  if (!cur || cur.resolved || cur.phase !== "reading") return;
  clearTimeout(room.readingTimer);
  cur.phase = "buzz";
  io.to(room.code).emit("game:buzzopen", {});
  io.to(room.code + ":host").emit("game:buzzopen", {});
  startBuzzTimer(room);
}

// janela para alguém apertar o botão (se o host definiu um tempo)
function startBuzzTimer(room) {
  clearTimeout(room.buzzTimer);
  const t = room.settings.time;
  if (t > 0) {
    room.buzzTimer = setTimeout(() => {
      const cur = room.current;
      if (!cur || cur.resolved || cur.phase !== "buzz") return;
      resolve(room, { awardedTo: null, wrongPlayer: null, timeout: true });
    }, t * 1000 + 500);
  }
}

// alguém apertou o botão: trava para os outros e ganha 10s para responder
function handleBuzz(room, player) {
  const cur = room.current;
  if (!cur || cur.resolved || cur.phase !== "buzz") return;
  if (cur.lockedOut.has(player.id)) return;   // já errou nesta pergunta

  cur.phase = "answer";
  cur.responder = player.id;
  clearTimeout(room.buzzTimer);
  clearTimeout(room.answerTimer);
  room.answerTimer = setTimeout(() => onAnswerTimeout(room, player.id), ANSWER_TIME * 1000 + 500);

  const evt = { by: P(player), answerTime: ANSWER_TIME };
  io.to(room.code).emit("game:buzzed", evt);
  io.to(room.code + ":host").emit("game:buzzed", evt);
}

// resposta do jogador que travou
function handleAnswer(room, player, optionIndex) {
  const cur = room.current;
  if (!cur || cur.resolved || cur.phase !== "answer") return;
  if (cur.responder !== player.id) return;    // só quem apertou o botão responde
  clearTimeout(room.answerTimer);

  if (optionIndex === cur.correct) {
    player.score += 1;
    return resolve(room, { awardedTo: P(player), wrongPlayer: null });
  }
  // errou → tranca e libera para os adversários
  cur.lockedOut.add(player.id);
  reopenOrEnd(room, P(player), false);
}

// não respondeu dentro dos 10s
function onAnswerTimeout(room, playerId) {
  const cur = room.current;
  if (!cur || cur.resolved || cur.phase !== "answer" || cur.responder !== playerId) return;
  cur.lockedOut.add(playerId);
  const p = room.players.get(playerId);
  reopenOrEnd(room, p ? P(p) : { id: playerId, name: "Jogador", team: null }, true);
}

// reabre a rodada para quem ainda não errou, ou encerra a pergunta
function reopenOrEnd(room, wrongP, timedOut) {
  const cur = room.current;
  const remaining = [...room.players.values()].filter(p => !cur.lockedOut.has(p.id));
  if (remaining.length === 0) {
    return resolve(room, { awardedTo: null, wrongPlayer: wrongP, allWrong: true });
  }
  cur.phase = "buzz";
  cur.responder = null;
  const evt = { wrongPlayer: wrongP, lockedOut: [...cur.lockedOut], timedOut: !!timedOut };
  io.to(room.code).emit("game:reopen", evt);
  io.to(room.code + ":host").emit("game:reopen", evt);
  startBuzzTimer(room);
}

function resolve(room, { awardedTo, wrongPlayer, timeout, allWrong }) {
  const cur = room.current;
  if (!cur || cur.resolved) return;
  cur.resolved = true;
  cur.phase = "done";
  clearTimeout(room.buzzTimer);
  clearTimeout(room.answerTimer);
  clearTimeout(room.readingTimer);

  const payload = {
    correctIndex: cur.correct,
    awardedTo, wrongPlayer, timeout: !!timeout, allWrong: !!allWrong,
    mode: room.mode, scores: scoreboard(room), teamScores: teamTotals(room),
  };
  io.to(room.code).emit("game:result", payload);
  io.to(room.code + ":host").emit("game:result", payload);

  room.advanceHandle = setTimeout(() => { if (rooms.has(room.code)) sendQuestion(room); }, 4500);
}

function endGame(room) {
  room.state = "over";
  room.current = null;
  const payload = { mode: room.mode, scores: scoreboard(room), teamScores: teamTotals(room) };
  io.to(room.code).emit("game:over", payload);
  io.to(room.code + ":host").emit("game:over", payload);
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
      players: new Map(), state: "lobby", mode: "solo",
      deck: [], qIndex: -1, current: null,
      settings: { category: "Todos", count: 10, time: 20 },
      buzzTimer: null, answerTimer: null, readingTimer: null, advanceHandle: null,
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
    if (room.mode === "team") balanceTeams(room);
    io.to(room.code).emit("game:start", { mode: room.mode });
    io.to(room.code + ":host").emit("game:start", { mode: room.mode });
    pushPlayers(room);
    sendQuestion(room);
  });

  // ---- HOST terminou de ler a pergunta em voz alta → libera o buzz ----
  socket.on("host:readingDone", ({ index }) => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room || !room.current || room.current.phase !== "reading") return;
    if (Number(index) !== room.qIndex + 1) return; // ignora avisos de perguntas antigas
    openBuzz(room);
  });

  // ---- HOST pula para a próxima ----
  socket.on("host:next", () => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room || room.state !== "playing") return;
    clearTimeout(room.advanceHandle); clearTimeout(room.buzzTimer); clearTimeout(room.answerTimer); clearTimeout(room.readingTimer);
    sendQuestion(room);
  });

  // ---- HOST reinicia (volta ao lobby) ----
  socket.on("host:restart", () => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room) return;
    clearTimeout(room.advanceHandle); clearTimeout(room.buzzTimer); clearTimeout(room.answerTimer); clearTimeout(room.readingTimer);
    room.state = "lobby"; room.current = null; room.qIndex = -1;
    for (const p of room.players.values()) p.score = 0;
    io.to(room.code).emit("game:lobby", {});
    io.to(room.code + ":host").emit("game:lobby", {});
    pushPlayers(room);
  });

  // ---- HOST alterna modo individual/equipes (no lobby) ----
  socket.on("host:mode", ({ mode }) => {
    const room = rooms.get(socket.data.hostRoom);
    if (!room) return;
    room.mode = mode === "team" ? "team" : "solo";
    io.to(room.code).emit("room:mode", { mode: room.mode });
    io.to(room.code + ":host").emit("room:mode", { mode: room.mode });
    pushPlayers(room);
  });

  // ---- JOGADOR escolhe o time (no lobby, modo equipes) ----
  socket.on("player:team", ({ team }) => {
    const room = rooms.get(socket.data.playerRoom);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (team === "blue" || team === "red") { p.team = team; pushPlayers(room); }
  });

  // ---- JOGADOR entra ----
  socket.on("player:join", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: "Sala não encontrada." });
    name = (name || "").trim().slice(0, 16) || "Jogador";

    const id = socket.id;
    room.players.set(id, { id, socketId: socket.id, name, score: 0, online: true, team: null });
    socket.join(code);
    socket.data.playerRoom = code;
    socketRoom.set(socket.id, code);
    cb && cb({ ok: true, playerId: id, name, state: room.state, mode: room.mode });
    pushPlayers(room);
  });

  // ---- JOGADOR aperta o botão (buzz) ----
  socket.on("player:buzz", () => {
    const room = rooms.get(socket.data.playerRoom);
    if (!room || room.state !== "playing") return;
    const player = room.players.get(socket.id);
    if (!player) return;
    handleBuzz(room, player);
  });

  // ---- JOGADOR responde (só quem travou) ----
  socket.on("player:answer", ({ optionIndex }) => {
    const room = rooms.get(socket.data.playerRoom);
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
      clearTimeout(room.advanceHandle); clearTimeout(room.buzzTimer); clearTimeout(room.answerTimer); clearTimeout(room.readingTimer);
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
  const idx = findPage("index.html");
  console.log("=================================================");
  console.log("  Quiz Show rodando!");
  console.log("  index.html: " + (idx ? "encontrado em " + idx : "*** NAO ENCONTRADO — verifique os arquivos no repositorio ***"));
  console.log("  Neste computador:  http://localhost:" + PORT);
  console.log("  Na rede local (TV / celulares):  " + lanUrl());
  console.log("  Abra a URL acima e clique em 'Sou a TV (Host)'.");
  console.log("=================================================");
});
