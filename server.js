const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID, randomBytes } = require("crypto");

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

/**
 * token is the secret a phone got when it joined as this player; null means
 * nobody has claimed the player yet (added by the host), so the next person to
 * join with that name takes it over.
 * @type {{ id: string, name: string, score: number, token: string | null }[]}
 */
let players = [];
let version = 0;
/**
 * Every score change, in order. delta is what it did to the score.
 * @type {{ id: number, playerId: string, kind: "round" | "edit", points: number, flip7: boolean, delta: number, prev: number, at: number }[]}
 */
let log = [];
/** Table-wide moments every phone shows (bust, flip7, big, win, comeback, collapse). */
let events = [];
/** Set when someone presses End Game: { names, score, at }. Cleared by reset / new game. */
let gameOver = null;
let seq = 0;
/** Taunts sent phone to phone. Kept in memory only; the latest few ride along with state. */
let taunts = [];
const MAX_TAUNTS = 30;
const TAUNT_LIMIT = 3;
const TAUNT_WINDOW_MS = 60_000;
/** sender key → times of their taunts in the last minute */
const tauntTimes = new Map();

/** How many taunts this sender has left, and when the next one frees up. */
function tauntAllowance(senderKey, now = Date.now()) {
  const recent = (tauntTimes.get(senderKey) || []).filter((t) => now - t < TAUNT_WINDOW_MS);
  tauntTimes.set(senderKey, recent);
  const left = Math.max(0, TAUNT_LIMIT - recent.length);
  const resetIn = recent.length ? TAUNT_WINDOW_MS - (now - recent[0]) : 0;
  return { left, resetIn };
}

/** Avatars a player can pick. Must match AVATARS in app.js. */
const AVATARS = [
  "🦊", "🐸", "🐼", "🐨", "🐯", "🦁", "🐵", "🐙", "🦄", "🐲", "🐢", "🦖",
  "👽", "🤖", "👻", "🎃", "🤠", "🥸", "😎", "🤓", "🍕", "🌮", "🍩", "🔥",
];
function randomAvatar() {
  const used = new Set(players.map((p) => p.avatar));
  const free = AVATARS.filter((a) => !used.has(a));
  const pool = free.length ? free : AVATARS;
  return pool[Math.floor(Math.random() * pool.length)];
}
function cleanAvatar(raw) {
  return AVATARS.includes(raw) ? raw : null;
}

/*
 * Rounds & bets. A round is done once every player has entered a score.
 * Bets ("who busts this round?") are open only before anyone has entered a
 * score for the round, then lock, then pay out when the round completes.
 */
let round = 1;
/** player id → { logId, bust } for scores entered this round */
let roundEntries = {};
/** bettor id → target player id, or "nobody" */
let bets = {};
const NOBODY = "nobody";

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
      ).map((p) => ({
        ...p,
        token: typeof p.token === "string" ? p.token : null,
        fortune: typeof p.fortune === "number" ? p.fortune : 0,
      }));
      players.forEach((p) => {
        if (!cleanAvatar(p.avatar)) p.avatar = randomAvatar();
      });
    }
    version = typeof data.version === "number" ? data.version : 0;
    log = Array.isArray(data.log) ? data.log : [];
    events = Array.isArray(data.events) ? data.events : [];
    seq = typeof data.seq === "number" ? data.seq : 0;
    gameOver = data.gameOver && Array.isArray(data.gameOver.names) ? data.gameOver : null;
    round = typeof data.round === "number" ? data.round : 1;
    roundEntries = data.roundEntries && typeof data.roundEntries === "object" ? data.roundEntries : {};
    bets = data.bets && typeof data.bets === "object" ? data.bets : {};
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
    JSON.stringify({ players, version, log, events, seq, gameOver, round, roundEntries, bets }, null, 2),
    "utf8"
  );
}

const APP_FILES = ["index.html", "app.js", "styles.css", "roasts.js"];
let buildCache = { at: 0, id: "" };
/** Changes whenever the app's files change, so open phones know to reload. */
function buildId() {
  const now = Date.now();
  if (now - buildCache.at < 2000) return buildCache.id;
  let newest = 0;
  for (const f of APP_FILES) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs);
    } catch {
      /* missing file: ignore */
    }
  }
  buildCache = { at: now, id: String(Math.round(newest)) };
  return buildCache.id;
}

function getState() {
  // Never send tokens to phones.
  return {
    players: players.map(({ id, name, score, token, avatar, fortune }) => ({
      id,
      name,
      score,
      avatar,
      fortune: fortune || 0,
      claimed: Boolean(token),
    })),
    // Who has bet is public; who they bet on stays secret until the round pays out.
    betting: {
      round,
      open: Object.keys(roundEntries).length === 0,
      bettors: Object.keys(bets),
      entered: Object.keys(roundEntries),
    },
    version,
    log,
    events,
    taunts,
    gameOver,
    build: buildId(),
  };
}

/** Sounds a phone can send. Must match TAUNTS in app.js. */
const TAUNT_SOUNDS = {
  honk: "🤡", fart: "💨", quack: "🦆", chicken: "🐔", moo: "🐄", rimshot: "🥁", trombone: "🎺",
  snore: "😴", crickets: "🦗", kiss: "💋", clap: "👏", boing: "🤪", airhorn: "📢",
};

/** One player sends a funny emoji + sound to another player's phone. */
function sendTaunt(who, toId, rawSound) {
  if (!who.player && !who.host) return { error: "Join the game first", status: 403 };
  const target = players.find((p) => p.id === toId);
  if (!target) return { error: "Player not found" };
  if (who.player && who.player.id === toId) return { error: "You can't taunt yourself. Well, you can, but not here." };
  const senderKey = who.player ? who.player.id : "host";
  const now = Date.now();
  const allowance = tauntAllowance(senderKey, now);
  if (allowance.left === 0) {
    return {
      error: `Out of taunts. Next one in ${Math.ceil(allowance.resetIn / 1000)}s.`,
      status: 429,
    };
  }
  const sound = String(rawSound || "");
  if (!Object.prototype.hasOwnProperty.call(TAUNT_SOUNDS, sound)) return { error: "Pick a sound" };
  const emoji = TAUNT_SOUNDS[sound];
  tauntTimes.get(senderKey).push(now);
  taunts.push({
    id: nextId(),
    to: target.id,
    toName: target.name,
    from: who.player ? who.player.id : null,
    fromName: who.player ? who.player.name : "The Host",
    emoji,
    sound,
    at: now,
  });
  if (taunts.length > MAX_TAUNTS) taunts = taunts.slice(-MAX_TAUNTS);
  // Bump the version so phones pick it up on their next sync.
  saveState();
  return { ok: true, state: getState(), ...tauntAllowance(senderKey, now) };
}

function newToken() {
  return randomBytes(18).toString("base64url");
}

/** Addresses of this machine: requests from them come from the host. */
function localAddresses() {
  const set = new Set(["127.0.0.1", "::1"]);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) set.add(iface.address);
  }
  return set;
}

function isHostRequest(req) {
  const addr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return localAddresses().has(addr);
}

/** Who is making this request: the host, a joined player, or nobody. */
function whoIs(req) {
  const token = req.headers["x-player-token"];
  const player =
    typeof token === "string" && token
      ? players.find((p) => p.token === token) || null
      : null;
  return { host: isHostRequest(req), player };
}

function canEdit(who, playerId) {
  return who.host || (who.player && who.player.id === playerId);
}

const NOT_YOURS = { error: "You can only change your own score", status: 403 };
const HOST_ONLY = { error: "Only the host can do that", status: 403 };

/**
 * A phone joins as a player by typing its name. A new name creates the
 * player; an unclaimed name (added by the host) is taken over; a name someone
 * else already holds is refused.
 */
function joinAs(name, currentToken, rawAvatar) {
  const avatar = cleanAvatar(rawAvatar);
  const trimmed = String(name || "").trim().slice(0, 24);
  if (!trimmed) return { error: "Type your name" };
  const existing = players.find(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existing) {
    if (existing.token && existing.token === currentToken) {
      if (avatar) existing.avatar = avatar;
      saveState();
      return { ok: true, playerId: existing.id, token: existing.token, state: getState() };
    }
    if (existing.token) {
      return { error: `${existing.name} is already playing on another phone. Pick a different name, or ask the host to unlock it.` };
    }
    existing.token = newToken();
    if (avatar) existing.avatar = avatar;
    saveState();
    return { ok: true, playerId: existing.id, token: existing.token, state: getState() };
  }
  const player = {
    id: randomUUID(),
    name: trimmed,
    score: 0,
    token: newToken(),
    avatar: avatar || randomAvatar(),
    fortune: 0,
  };
  players.push(player);
  saveState();
  return { ok: true, playerId: player.id, token: player.token, state: getState() };
}

function setAvatar(id, raw) {
  const player = players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };
  const avatar = cleanAvatar(raw);
  if (!avatar) return { error: "Pick one of the avatars" };
  player.avatar = avatar;
  saveState();
  return { ok: true, state: getState() };
}

/** A player bets on who busts this round (or "nobody"). Changeable until the round starts. */
function placeBet(who, target) {
  if (!who.player) return { error: "Join the game to bet", status: 403 };
  if (gameOver) return { error: "The game is over" };
  if (Object.keys(roundEntries).length > 0) {
    return { error: "Bets are locked — this round already started. Bet on the next one!" };
  }
  if (target !== NOBODY && !players.some((p) => p.id === target)) {
    return { error: "Pick a player" };
  }
  bets[who.player.id] = target;
  saveState();
  return { ok: true, state: getState(), myBet: target };
}

/** Pay out this round's bets and start the next round. */
function closeRound(created, skipped = []) {
  const busted = players.filter((p) => roundEntries[p.id]?.bust).map((p) => p.id);
  const results = [];
  for (const [bettorId, target] of Object.entries(bets)) {
    const bettor = players.find((p) => p.id === bettorId);
    if (!bettor) continue;
    let outcome;
    if (target === NOBODY) {
      outcome = busted.length === 0 ? "won" : "lost";
    } else if (!roundEntries[target]) {
      outcome = "void"; // they didn't play this round
    } else {
      outcome = roundEntries[target].bust ? "won" : "lost";
    }
    if (outcome === "won") bettor.fortune = (bettor.fortune || 0) + 1;
    const targetName =
      target === NOBODY ? "nobody" : players.find((p) => p.id === target)?.name || "?";
    results.push({ bettor: bettor.name, avatar: bettor.avatar, target: targetName, outcome });
  }
  // Always announce the round ending, so phones know bets are open again.
  created.push(
    pushEvent("bets", { id: null, name: "" }, {
      round,
      results,
      skipped,
      busted: busted.map((id) => players.find((p) => p.id === id)?.name),
    })
  );
  round += 1;
  roundEntries = {};
  bets = {};
}

/** Record a score toward the current round; close the round when everyone's in. */
function trackRound(playerId, logId, bust, created) {
  roundEntries[playerId] = { logId, bust };
  if (players.every((p) => roundEntries[p.id])) closeRound(created);
}

/** Anyone can end the round early, skipping players who are sitting it out. */
function endRound(who) {
  if (!who.player && !who.host) return { error: "Join the game first", status: 403 };
  if (Object.keys(roundEntries).length === 0) return { error: "Nobody has scored this round yet" };
  const skipped = players.filter((p) => !roundEntries[p.id]).map((p) => p.name);
  const created = [];
  closeRound(created, skipped);
  saveState();
  return { ok: true, state: getState(), events: created };
}

/** Host only: delete every player no phone has joined as. */
function clearUnclaimed() {
  const gone = new Set(players.filter((p) => !p.token).map((p) => p.id));
  if (!gone.size) return { error: "Every name is in use" };
  players = players.filter((p) => !gone.has(p.id));
  log = log.filter((e) => !gone.has(e.playerId));
  saveState();
  return { ok: true, state: getState(), removed: gone.size };
}

/** Host only: free every name so all phones have to join again. Scores stay. */
function unlockAll() {
  players.forEach((p) => {
    p.token = null;
  });
  saveState();
  return { ok: true, state: getState() };
}

/** Host only: free a player so whoever joins with that name next gets it. */
function unlockPlayer(id) {
  const player = players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };
  player.token = null;
  saveState();
  return { ok: true, state: getState() };
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
  players.push({ id: randomUUID(), name: trimmed, score: 0, token: null, avatar: randomAvatar(), fortune: 0 });
  saveState();
  return { ok: true, state: getState() };
}

function removePlayer(id) {
  const before = players.length;
  players = players.filter((p) => p.id !== id);
  if (players.length === before) return { error: "Player not found" };
  log = log.filter((e) => e.playerId !== id);
  delete bets[id];
  delete roundEntries[id];
  for (const [bettor, target] of Object.entries(bets)) if (target === id) delete bets[bettor];
  // Everyone left may now have entered this round.
  if (Object.keys(roundEntries).length && players.every((p) => roundEntries[p.id])) closeRound([]);
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
  if (roundEntries[id]) {
    return {
      error: `${player.name} already scored round ${round}. Undo it to fix it, or wait for the next round.`,
      status: 409,
    };
  }

  const before = standings();
  const prev = player.score;
  const delta = points + (flip7 ? FLIP7_BONUS : 0);
  player.score += delta;
  const logId = nextId();
  log.push({
    id: logId,
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

  trackRound(id, logId, !flip7 && delta === 0, created);

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
  // Taking back this round's score takes it out of the round too.
  if (roundEntries[id] && roundEntries[id].logId === entry.id) delete roundEntries[id];
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

/**
 * Flip 7 ends after the round in which someone reaches 200; highest score
 * wins. Anyone at the table can call it once someone is at 200+.
 */
function endGame(who) {
  if (!who.player && !who.host) return { error: "Join the game first", status: 403 };
  if (gameOver) return { error: "The game is already over" };
  const top = Math.max(...players.map((p) => p.score));
  if (!players.length || top < WIN_SCORE) {
    return { error: `Nobody has ${WIN_SCORE} yet. Keep playing!` };
  }
  const winners = players.filter((p) => p.score === top);
  gameOver = { names: winners.map((p) => p.name), score: top, at: Date.now() };
  pushEvent("gameover", winners[0], {
    names: gameOver.names,
    score: top,
    by: who.player ? who.player.name : "The Host",
  });
  saveState();
  return { ok: true, state: getState() };
}

function resetScores() {
  players.forEach((p) => {
    p.score = 0;
  });
  log = [];
  gameOver = null;
  players.forEach((p) => {
    p.fortune = 0;
  });
  round = 1;
  roundEntries = {};
  bets = {};
  saveState();
  return { ok: true, state: getState() };
}

function newGame() {
  players = [];
  log = [];
  gameOver = null;
  round = 1;
  roundEntries = {};
  bets = {};
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
  if (payload && typeof payload.status === "number") {
    status = payload.status;
    payload = { error: payload.error };
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Player-Token",
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
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // Always check for a newer copy, so phones pick up app updates.
      "Cache-Control": "no-cache",
    });
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
      "Access-Control-Allow-Headers": "Content-Type, X-Player-Token",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, getState());
    return;
  }

  const who = whoIs(req);

  if (req.method === "GET" && pathname === "/api/me") {
    const allowance = tauntAllowance(who.player ? who.player.id : who.host ? "host" : "nobody");
    sendJson(res, 200, {
      host: who.host,
      playerId: who.player ? who.player.id : null,
      myBet: who.player ? bets[who.player.id] || null : null,
      tauntsLeft: allowance.left,
      tauntResetIn: allowance.resetIn,
    });
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

  if (req.method === "POST" && pathname === "/api/join-as") {
    sendJson(res, 200, joinAs(body.name, req.headers["x-player-token"], body.avatar));
    return;
  }

  // Host adds players who don't have a phone.
  if (req.method === "POST" && pathname === "/api/players") {
    sendJson(res, 200, who.host ? addPlayer(body.name || "") : HOST_ONLY);
    return;
  }

  const removeMatch = pathname.match(/^\/api\/players\/([^/]+)$/);
  if (req.method === "DELETE" && removeMatch) {
    // Anyone may clear out a leftover name nobody has joined as.
    const target = players.find((p) => p.id === removeMatch[1]);
    const unclaimed = target && !target.token;
    sendJson(res, 200, canEdit(who, removeMatch[1]) || unclaimed ? removePlayer(removeMatch[1]) : NOT_YOURS);
    return;
  }

  const unlockMatch = pathname.match(/^\/api\/players\/([^/]+)\/unlock$/);
  if (req.method === "POST" && unlockMatch) {
    sendJson(res, 200, who.host ? unlockPlayer(unlockMatch[1]) : HOST_ONLY);
    return;
  }

  // Score changes: only your own player, unless you're the host.
  const editMatch = pathname.match(/^\/api\/players\/([^/]+)\/(points|undo|score)$/);
  if (req.method === "POST" && editMatch && !canEdit(who, editMatch[1])) {
    sendJson(res, 200, NOT_YOURS);
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

  const avatarMatch = pathname.match(/^\/api\/players\/([^/]+)\/avatar$/);
  if (req.method === "POST" && avatarMatch) {
    sendJson(res, 200, canEdit(who, avatarMatch[1]) ? setAvatar(avatarMatch[1], body.avatar) : NOT_YOURS);
    return;
  }

  if (req.method === "POST" && pathname === "/api/end-round") {
    sendJson(res, 200, endRound(who));
    return;
  }

  if (req.method === "POST" && pathname === "/api/bet") {
    sendJson(res, 200, placeBet(who, String(body.target || "")));
    return;
  }

  const tauntMatch = pathname.match(/^\/api\/players\/([^/]+)\/taunt$/);
  if (req.method === "POST" && tauntMatch) {
    sendJson(res, 200, sendTaunt(who, tauntMatch[1], body.sound));
    return;
  }

  if (req.method === "POST" && pathname === "/api/end-game") {
    sendJson(res, 200, endGame(who));
    return;
  }

  if (req.method === "POST" && pathname === "/api/clear-unclaimed") {
    sendJson(res, 200, who.host ? clearUnclaimed() : HOST_ONLY);
    return;
  }

  if (req.method === "POST" && pathname === "/api/unlock-all") {
    sendJson(res, 200, who.host ? unlockAll() : HOST_ONLY);
    return;
  }

  if (req.method === "POST" && pathname === "/api/reset") {
    // Players can start the next game once this one is over; the host any time.
    const allowed = who.host || (gameOver && who.player);
    sendJson(
      res,
      200,
      allowed ? resetScores() : { error: "Scores can be reset once the game is over", status: 403 }
    );
    return;
  }

  if (req.method === "POST" && pathname === "/api/new-game") {
    sendJson(res, 200, who.host ? newGame() : HOST_ONLY);
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
