const http = require("http");
const fs = require("fs");
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
  } catch {
    players = [];
    version = 0;
  }
}

function saveState() {
  version += 1;
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ players, version }, null, 2),
    "utf8"
  );
}

function getState() {
  return { players, version };
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
  saveState();
  return { ok: true, state: getState() };
}

function addPoints(id, rawPoints) {
  const points = Number(rawPoints);
  if (rawPoints === "" || Number.isNaN(points)) {
    return { error: "Enter a valid number" };
  }
  const player = players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };
  player.score += points;
  saveState();
  return { ok: true, state: getState() };
}

function resetScores() {
  players.forEach((p) => {
    p.score = 0;
  });
  saveState();
  return { ok: true, state: getState() };
}

function newGame() {
  players = [];
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
    sendJson(res, 200, addPoints(pointsMatch[1], body.points));
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
  console.log(`Flip 7 score server running at http://0.0.0.0:${PORT}`);
});
