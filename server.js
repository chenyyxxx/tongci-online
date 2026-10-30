const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROUND_MS = 30_000;
const REVEAL_MS = 3_500;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();

function makeId(bytes = 18) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate room code");
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeWord(word) {
  return word.trim().replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function publicState(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  const opponent = room.players.find((item) => item.id !== playerId);
  return {
    roomCode: room.code,
    playerNumber: player ? room.players.indexOf(player) + 1 : null,
    playerCount: room.players.length,
    opponentConnected: Boolean(opponent?.connected),
    round: room.round,
    score: room.score,
    history: room.history,
    phase: room.phase,
    deadline: room.deadline,
    submitted: player ? room.submissions.has(player.id) : false,
    opponentSubmitted: opponent ? room.submissions.has(opponent.id) : false,
    result: room.phase === "reveal" || room.phase === "finished" ? room.result : null
  };
}

function sendEvent(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room) {
  room.updatedAt = Date.now();
  for (const player of room.players) {
    const client = room.clients.get(player.id);
    if (client) sendEvent(client, "state", publicState(room, player.id));
  }
}

function startRound(room) {
  if (room.players.length < 2) return;
  room.round += 1;
  room.phase = "playing";
  room.deadline = Date.now() + ROUND_MS;
  room.submissions.clear();
  room.result = null;
  broadcast(room);
}

function finishRound(room, timedOut = false) {
  if (room.phase !== "playing") return;
  const words = room.players.map((player) => room.submissions.get(player.id) || "");
  const matched =
    words.every(Boolean) &&
    normalizeWord(words[0]) === normalizeWord(words[1]);

  if (matched) room.score += 1;
  room.history.push({
    round: room.round,
    words,
    matched,
    timedOut
  });
  room.phase = matched ? "finished" : "reveal";
  room.deadline = null;
  room.result = { matched, timedOut, words };
  broadcast(room);

  clearTimeout(room.nextRoundTimer);
  if (matched) return;
  room.nextRoundTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    startRound(room);
  }, REVEAL_MS);
}

function createRoom() {
  const code = makeRoomCode();
  const playerId = makeId();
  const now = Date.now();
  const room = {
    code,
    players: [{ id: playerId, connected: false }],
    clients: new Map(),
    submissions: new Map(),
    round: 0,
    score: 0,
    history: [],
    phase: "waiting",
    deadline: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    nextRoundTimer: null
  };
  rooms.set(code, room);
  return { room, playerId };
}

function joinRoom(room) {
  if (room.players.length >= 2) return null;
  const playerId = makeId();
  room.players.push({ id: playerId, connected: false });
  room.updatedAt = Date.now();
  startRound(room);
  return playerId;
}

function connectEvents(req, res, room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) {
    json(res, 403, { error: "无效的玩家身份" });
    return;
  }

  const previous = room.clients.get(playerId);
  if (previous) previous.res.end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  const client = { res };
  room.clients.set(playerId, client);
  player.connected = true;
  sendEvent(client, "state", publicState(room, playerId));
  broadcast(room);

  req.on("close", () => {
    if (room.clients.get(playerId) !== client) return;
    room.clients.delete(playerId);
    player.connected = false;
    broadcast(room);
  });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      json(res, 404, { error: "Not found" });
      return;
    }
    const extension = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (req.method === "POST" && pathname === "/api/rooms") {
      const { room, playerId } = createRoom();
      json(res, 201, { roomCode: room.code, playerId });
      return;
    }

    const joinMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/);
    if (req.method === "POST" && joinMatch) {
      const room = rooms.get(joinMatch[1]);
      if (!room) return json(res, 404, { error: "房间不存在或已过期" });
      const playerId = joinRoom(room);
      if (!playerId) return json(res, 409, { error: "房间已经满员" });
      json(res, 200, { roomCode: room.code, playerId });
      return;
    }

    const submitMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/submit$/);
    if (req.method === "POST" && submitMatch) {
      const room = rooms.get(submitMatch[1]);
      if (!room) return json(res, 404, { error: "房间不存在或已过期" });
      const body = await readJson(req);
      const player = room.players.find((item) => item.id === body.playerId);
      if (!player) return json(res, 403, { error: "无效的玩家身份" });
      if (room.phase !== "playing") return json(res, 409, { error: "当前不能提交" });
      if (room.submissions.has(player.id)) return json(res, 409, { error: "本轮已经提交" });

      const word = String(body.word || "").trim().slice(0, 12);
      if (!word) return json(res, 400, { error: "请输入一个词" });
      room.submissions.set(player.id, word);
      broadcast(room);
      json(res, 200, { ok: true });
      if (room.submissions.size === 2) finishRound(room, false);
      return;
    }

    if (req.method === "GET" && pathname === "/events") {
      const room = rooms.get(String(url.searchParams.get("room") || "").toUpperCase());
      const playerId = url.searchParams.get("player");
      if (!room) return json(res, 404, { error: "房间不存在或已过期" });
      connectEvents(req, res, room, playerId);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: "服务器发生错误" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.phase === "playing" && room.deadline && now >= room.deadline) {
      finishRound(room, true);
    }
    if (now - room.updatedAt > ROOM_TTL_MS) {
      clearTimeout(room.nextRoundTimer);
      for (const client of room.clients.values()) client.res.end();
      rooms.delete(code);
    }
  }
}, 500);

setInterval(() => {
  for (const room of rooms.values()) {
    for (const client of room.clients.values()) {
      client.res.write(": heartbeat\n\n");
    }
  }
}, 20_000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`同词相遇已启动：http://localhost:${PORT}`);
});
