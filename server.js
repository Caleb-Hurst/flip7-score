const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = 3456;
const HOST = "0.0.0.0";
const DATA_FILE = path.join(__dirname, "game-state.json");
const PUBLIC_DIR = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** @type {{ id: string, name: string, score: number }[]} */
let players = [];
let version = 0;
/**
 * Every score change, in order. delta is what it did to the score.
 * @type {{ id: number, playerId: string, kind: "round" | "edit", points: number, flip7: boolean, delta: number, prev: number, at: number }[]}
 */
let log = [];
/** Table-wide moments every phone shows (bust, flip7, big, win, comeback, collapse). */
let events = [];
let seq = 0;

const WIN_SCORE = 200;
const FLIP7_BONUS = 15;
const BIG_ROUND = 40;
const MAX_EVENTS = 20;

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (Array.isArray(data.players)) {
      players = data.players.filter(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          typeof p.score === "number"
      );
    }
    version = typeof data.version === "number" ? data.version : 0;
    log = Array.isArray(data.log) ? data.log : [];
    events = Array.isArray(data.events) ? data.events : [];
    seq = typeof data.seq === "number" ? data.seq : 0;
  } catch {
    players = [];
    version = 0;
    log = [];
    events = [];
    seq = 0;
  }
}

function saveState() {
  version += 1;
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ players, version, log, events, seq }, null, 2),
    "utf8"
  );
}

function getState() {
  return { players, version, log, events };
}

function nextId() {
  seq += 1;
  return seq;
}

function standings() {
  if (players.length < 2) return { leaderId: null, lastId: null };
  const sorted = [...players].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name)
  );
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  return {
    leaderId: top.score > 0 ? top.id : null,
    lastId: bottom.score < top.score ? bottom.id : null,
  };
}

function pushEvent(type, player, extra = {}) {
  const ev = {
    id: nextId(),
    type,
    playerId: player.id,
    name: player.name,
    at: Date.now(),
    ...extra,
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  return ev;
}

function getJoinUrls() {
  const urls = new Set();

  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        urls.add(`http://${iface.address}:${PORT}`);
      }
    }
  }

  const hostname = os.hostname().replace(/\.local$/i, "");
  if (hostname) {
    urls.add(`http://${hostname}.local:${PORT}`);
  }

  const scoreUrl = (url) => {
    const host = url.replace(/^https?:\/\//, "").split(":")[0];
    if (host.endsWith(".local")) return 1;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 0;
    return 2;
  };

  return [...urls].sort((a, b) => scoreUrl(a) - scoreUrl(b));
}

function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required" };
  if (
    players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())
  ) {
    return { error: "That name is already taken" };
  }
  players.push({ id: randomUUID(), name: trimmed, score: 0 });
  saveState();
  return { ok: true, state: getState() };
}

function removePlayer(id) {
  const before = players.length;
  players = players.filter((p) => p.id !== id);
  if (players.length === before) return { error: "Player not found" };
  log = log.filter((e) => e.playerId !== id);
  saveState();
  return { ok: true, state: getState() };
}

function addPoints(id, rawPoints, flip7 = false, by = null) {
  const points = Number(rawPoints);
  if (rawPoints === "" || Number.isNaN(points)) {
    return { error: "Enter a valid number" };
  }
  const player = players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };

  const before = standings();
  const prev = player.score;
  const delta = points + (flip7 ? FLIP7_BONUS : 0);
  player.score += delta;
  log.push({
    id: nextId(),
    playerId: id,
    kind: "round",
    points,
    flip7: Boolean(flip7),
    delta,
    prev,
    at: Date.now(),
  });

  const after = standings();
  const created = [];
  const add = (type, who, extra) =>
    created.push(pushEvent(type, who, { by, ...extra }));

  if (prev < WIN_SCORE && player.score >= WIN_SCORE) {
    add("win", player, { score: player.score });
  }
  if (before.lastId === id && after.leaderId === id) {
    add("comeback", player);
  }
  if (flip7) {
    add("flip7", player, { points: delta });
  } else if (delta === 0) {
    add("bust", player);
  } else if (delta > BIG_ROUND) {
    add("big", player, { points: delta });
  }
  if (
    before.leaderId &&
    before.leaderId !== id &&
    after.lastId === before.leaderId
  ) {
    const fallen = players.find((p) => p.id === before.leaderId);
    if (fallen) add("collapse", fallen);
  }

  saveState();
  return { ok: true, state: getState(), events: created };
}

function undoLast(id) {
  const player = players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };
  let idx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].playerId === id) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { error: "Nothing to undo" };
  const [entry] = log.splice(idx, 1);
  player.score -= entry.delta;
  saveState();
  return { ok: true, state: getState(), undone: entry };
}

function setScore(id, rawScore) {
  const score = Number(rawScore);
  if (rawScore === "" || Number.isNaN(score) || !Number.isFinite(score)) {
    return { error: "Enter a valid number" };
  }
  const player = players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };
  if (score !== player.score) {
    log.push({
      id: nextId(),
      playerId: id,
      kind: "edit",
      points: score,
      flip7: false,
      delta: score - player.score,
      prev: player.score,
      at: Date.now(),
    });
  }
  player.score = score;
  saveState();
  return { ok: true, state: getState() };
}

function resetScores() {
  players.forEach((p) => {
    p.score = 0;
  });
  log = [];
  saveState();
  return { ok: true, state: getState() };
}

function newGame() {
  players = [];
  log = [];
  saveState();
  return { ok: true, state: getState() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(
    PUBLIC_DIR,
    path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "")
  );

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, getState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/join") {
    sendJson(res, 200, { urls: getJoinUrls(), port: PORT });
    return;
  }

  let body = {};
  if (req.method === "POST" || req.method === "DELETE") {
    const raw = await readBody(req);
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }
    }
  }

  if (req.method === "POST" && pathname === "/api/players") {
    sendJson(res, 200, addPlayer(body.name || ""));
    return;
  }

  const removeMatch = pathname.match(/^\/api\/players\/([^/]+)$/);
  if (req.method === "DELETE" && removeMatch) {
    sendJson(res, 200, removePlayer(removeMatch[1]));
    return;
  }

  const pointsMatch = pathname.match(/^\/api\/players\/([^/]+)\/points$/);
  if (req.method === "POST" && pointsMatch) {
    sendJson(
      res,
      200,
      addPoints(
        pointsMatch[1],
        body.points,
        body.flip7 === true,
        typeof body.by === "string" ? body.by.slice(0, 64) : null
      )
    );
    return;
  }

  const undoMatch = pathname.match(/^\/api\/players\/([^/]+)\/undo$/);
  if (req.method === "POST" && undoMatch) {
    sendJson(res, 200, undoLast(undoMatch[1]));
    return;
  }

  const scoreMatch = pathname.match(/^\/api\/players\/([^/]+)\/score$/);
  if (req.method === "POST" && scoreMatch) {
    sendJson(res, 200, setScore(scoreMatch[1], body.score));
    return;
  }

  if (req.method === "POST" && pathname === "/api/reset") {
    sendJson(res, 200, resetScores());
    return;
  }

  if (req.method === "POST" && pathname === "/api/new-game") {
    sendJson(res, 200, newGame());
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

loadState();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Flip 7 score server running at http://localhost:${PORT}`);
  const joinUrls = getJoinUrls();
  if (joinUrls.length > 0) {
    console.log("Others on the same WiFi can join at:");
    joinUrls.forEach((url) => console.log(`  ${url}`));
  } else {
    console.log("Connect this Mac to WiFi, then share the join link shown in the app.");
  }
});
