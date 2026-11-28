const WIN_SCORE = 200;
const SYNC_INTERVAL_MS = 1500;

/** @type {{ id: string, name: string, score: number }[]} */
let players = [];
let version = 0;

/** Every score change from the server, oldest first (history, undo, awards). */
let gameLog = [];
/** Highest table-wide event id this phone has already shown; null until first sync. */
let lastSeenEventId = null;
/** Identifies this phone so it knows which events it caused. */
const CLIENT_ID =
  (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);

/* ---------- Who am I: each phone joins as one player ---------- */

const TOKEN_KEY = "flip7-token";
const HOST_SKIP_KEY = "flip7-host-skip";
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode: you'll just rejoin on reload */ }
}
let myToken = storageGet(TOKEN_KEY) || "";
/** host: this request comes from the computer running the server. */
let me = { host: false, playerId: null, loaded: false };

/** Avatars a player can pick. Must match AVATARS in server.js. */
const AVATARS = [
  "🦊", "🐸", "🐼", "🐨", "🐯", "🦁", "🐵", "🐙", "🦄", "🐲", "🐢", "🦖",
  "👽", "🤖", "👻", "🎃", "🤠", "🥸", "😎", "🤓", "🍕", "🌮", "🍩", "🔥",
];

/** "🦊 Ava" — a player's avatar and name, for text. */
function tag(p) {
  return p ? `${p.avatar ? p.avatar + " " : ""}${p.name}` : "?";
}
function playerById(id) {
  return players.find((p) => p.id === id) || null;
}

function avatarGrid(selected) {
  return `<div class="avatar-grid" role="radiogroup" aria-label="Pick an avatar">${AVATARS.map(
    (a) => `<button type="button" class="avatar-opt" role="radio" data-avatar="${a}" aria-checked="${a === selected}">${a}</button>`
  ).join("")}</div>`;
}
function wireAvatarGrid(root, onPick) {
  root.querySelectorAll(".avatar-opt").forEach((btn) =>
    btn.addEventListener("click", () => {
      root.querySelectorAll(".avatar-opt").forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
      onPick(btn.dataset.avatar);
    })
  );
}

function canEditPlayer(id) {
  return me.host || (me.playerId !== null && me.playerId === id);
}

/** @type {Map<string, { points: string, optimisticScore: number }>} */
const pendingByPlayer = new Map();

const playerListEl = document.getElementById("player-list");
const emptyStateEl = document.getElementById("empty-state");
const addPlayerForm = document.getElementById("add-player-form");
const playerNameInput = document.getElementById("player-name-input");
const addPlayerBtn = document.getElementById("add-player-btn");
const resetScoresBtn = document.getElementById("reset-scores-btn");
const newGameBtn = document.getElementById("new-game-btn");
const resetNamesBtn = document.getElementById("reset-names-btn");
const clearUnusedBtn = document.getElementById("clear-unused-btn");
const syncStatusEl = document.getElementById("sync-status");
const toastEl = document.getElementById("toast");
const roastBannerEl = document.getElementById("roast-banner");
const roastTextEl = document.getElementById("roast-text");
const toneSliderEl = document.getElementById("tone-slider");
const joinBannerEl = document.getElementById("join-banner");
const joinUrlEl = document.getElementById("join-url");
const shareJoinBtn = document.getElementById("share-join-btn");
const copyJoinBtn = document.getElementById("copy-join-btn");

let primaryJoinUrl = "";

const TONE_KEYS = ["rude", "mid", "nice"];
const TONE_LABELS = ["Rude", "Mid", "Nice"];
const ROAST_INTERVAL_MS = 14000;
const ROAST_STORAGE_KEY = "flip7-roast-tone";

let toastTimer = null;
let roastTimer = null;
let roastPlayerCursor = 0;
/** @type {number[]} */
let roastTemplateOrder = [];
let roastTemplateCursor = 0;
/** @type {string} */
let roastPlayersKey = "";
/** @type {string} */
let roastToneKey = "mid";

function getRoastLines() {
  const banks = window.FLIP7_ROASTS || {};
  return banks[roastToneKey] || banks.mid || [];
}

function loadSavedTone() {
  const saved = localStorage.getItem(ROAST_STORAGE_KEY);
  const idx = Number(saved);
  if (Number.isInteger(idx) && idx >= 0 && idx <= 2) {
    toneSliderEl.value = String(idx);
  }
  applyToneFromSlider(false);
}

function applyToneFromSlider(reshuffle = true) {
  const idx = Number(toneSliderEl.value) || 0;
  roastToneKey = TONE_KEYS[idx] || "mid";
  toneSliderEl.setAttribute("aria-valuetext", TONE_LABELS[idx] || "Mid");
  roastBannerEl.dataset.tone = roastToneKey;
  localStorage.setItem(ROAST_STORAGE_KEY, String(idx));

  if (reshuffle) {
    roastTemplateOrder = [];
    roastTemplateCursor = 0;
    if (players.length > 0) {
      const sorted = [...players].sort((a, b) => {
        const scoreA = pendingByPlayer.get(a.id)?.optimisticScore ?? a.score;
        const scoreB = pendingByPlayer.get(b.id)?.optimisticScore ?? b.score;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.name.localeCompare(b.name);
      });
      reshuffleRoastDeck();
      showRoast(nextRoastLine(sorted));
      restartRoastTimer();
    }
  }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function playersKey(sortedPlayers) {
  return sortedPlayers.map((p) => p.id).join("|");
}

function reshuffleRoastDeck() {
  const lines = getRoastLines();
  roastTemplateOrder = shuffleInPlace(
    Array.from({ length: lines.length }, (_, i) => i)
  );
  roastTemplateCursor = 0;
}

function nextRoastLine(sortedPlayers) {
  const lines = getRoastLines();
  if (lines.length === 0) return "…";

  if (roastTemplateCursor >= roastTemplateOrder.length) {
    reshuffleRoastDeck();
  }

  const templateIndex = roastTemplateOrder[roastTemplateCursor++];
  const player = sortedPlayers[roastPlayerCursor % sortedPlayers.length];
  roastPlayerCursor += 1;

  return lines[templateIndex].replaceAll("{name}", player.name);
}

function sortedPlayersSnapshot() {
  return [...players].sort((a, b) => {
    const scoreA = pendingByPlayer.get(a.id)?.optimisticScore ?? a.score;
    const scoreB = pendingByPlayer.get(b.id)?.optimisticScore ?? b.score;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.name.localeCompare(b.name);
  });
}

function restartRoastTimer() {
  clearInterval(roastTimer);
  roastTimer = setInterval(() => {
    if (players.length === 0) return;
    const sorted = sortedPlayersSnapshot();
    if (sorted.length === 0) return;
    showRoast(nextRoastLine(sorted));
  }, ROAST_INTERVAL_MS);
}

function updateRoastBanner(sortedPlayers) {
  if (sortedPlayers.length === 0) {
    roastBannerEl.classList.add("hidden");
    clearInterval(roastTimer);
    roastTimer = null;
    roastPlayersKey = "";
    roastTemplateOrder = [];
    roastTemplateCursor = 0;
    return;
  }

  const key = playersKey(sortedPlayers);
  const playersChanged = key !== roastPlayersKey;
  roastPlayersKey = key;

  if (playersChanged || roastTemplateOrder.length === 0) {
    reshuffleRoastDeck();
    roastPlayerCursor = 0;
  }

  roastBannerEl.classList.remove("hidden");

  if (!roastTimer) {
    showRoast(nextRoastLine(sortedPlayers));
    restartRoastTimer();
  } else if (playersChanged) {
    showRoast(nextRoastLine(sortedPlayers));
  }
}

function showRoast(text) {
  roastTextEl.classList.remove("roast-in");
  void roastTextEl.offsetWidth;
  roastTextEl.textContent = text;
  roastTextEl.classList.add("roast-in");
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
  }, 2600);
}

function isLocalHost() {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

async function loadJoinInfo() {
  if (!isLocalHost()) return;

  try {
    const info = await fetch("/api/join", { cache: "no-store" }).then((r) =>
      r.json()
    );
    const urls = Array.isArray(info.urls) ? info.urls.filter(Boolean) : [];
    if (urls.length === 0) return;

    primaryJoinUrl = urls[0];
    joinUrlEl.href = primaryJoinUrl;
    joinUrlEl.textContent = primaryJoinUrl;
    joinBannerEl.classList.remove("hidden");
  } catch {
    // Host can still share manually if join lookup fails.
  }
}

async function shareJoinLink() {
  if (!primaryJoinUrl) return;

  if (navigator.share) {
    try {
      await navigator.share({
        title: "Flip 7 Score",
        text: "Join our Flip 7 scoreboard:",
        url: primaryJoinUrl,
      });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }

  await copyJoinLink();
}

async function copyJoinLink() {
  if (!primaryJoinUrl) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(primaryJoinUrl);
      showToast("Link copied");
      return;
    }
  } catch {
    // Fall through to manual copy.
  }

  const input = document.createElement("input");
  input.value = primaryJoinUrl;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();
  showToast(copied ? "Link copied" : "Long-press the link to copy");
}

function setSyncStatus(text, kind = "ok") {
  syncStatusEl.textContent = text;
  syncStatusEl.dataset.kind = kind;
}

function capturePendingPoints() {
  const pending = new Map();
  playerListEl.querySelectorAll(".player-card").forEach((card) => {
    const id = card.dataset.playerId;
    const input = card.querySelector(".points-input");
    if (id && input && input.value !== "" && !pendingByPlayer.has(id)) {
      pending.set(id, input.value);
    }
  });
  return pending;
}

function restorePendingPoints(pending) {
  pending.forEach((value, id) => {
    const card = playerListEl.querySelector(`[data-player-id="${id}"]`);
    const input = card?.querySelector(".points-input");
    if (input) input.value = value;
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function render() {
  const pendingInputs = capturePendingPoints();
  playerListEl.innerHTML = "";

  const hasPlayers = players.length > 0;
  emptyStateEl.classList.toggle("hidden", hasPlayers);
  document.querySelector(".add-player").classList.toggle("hidden", !me.host);
  resetScoresBtn.classList.toggle("hidden", !me.host);
  newGameBtn.classList.toggle("hidden", !me.host);
  resetNamesBtn.classList.toggle("hidden", !me.host);
  resetNamesBtn.disabled = !hasPlayers;
  clearUnusedBtn.classList.toggle("hidden", !me.host);
  clearUnusedBtn.disabled = !players.some((p) => !p.claimed);
  resetScoresBtn.disabled = !hasPlayers || pendingByPlayer.size > 0;
  newGameBtn.disabled = !hasPlayers || pendingByPlayer.size > 0;

  const sortedPlayers = [...players].sort((a, b) => {
    const scoreA = pendingByPlayer.get(a.id)?.optimisticScore ?? a.score;
    const scoreB = pendingByPlayer.get(b.id)?.optimisticScore ?? b.score;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.name.localeCompare(b.name);
  });

  const topScore =
    sortedPlayers.length > 0
      ? pendingByPlayer.get(sortedPlayers[0].id)?.optimisticScore ??
        sortedPlayers[0].score
      : null;

  const bottomScore =
    sortedPlayers.length > 0
      ? pendingByPlayer.get(sortedPlayers[sortedPlayers.length - 1].id)
          ?.optimisticScore ?? sortedPlayers[sortedPlayers.length - 1].score
      : null;

  const lastPlaceTaunts = [
    "Skill issue detected ☹️",
    "Currently embarrassing everyone ☹️",
    "The floor called — it wants its score back ☹️",
    "Last but not least… wait, least ☹️",
    "Someone check if they're still awake ☹️",
    "Carrying the team… downward ☹️",
    "Participation trophy pending ☹️",
  ];

  const waitingOn = bettingState
    ? players.filter((p) => !bettingState.entered.includes(p.id))
    : [];

  sortedPlayers.forEach((player, index) => {
    const pending = pendingByPlayer.get(player.id);
    const displayScore = pending ? pending.optimisticScore : player.score;
    const isSaving = Boolean(pending);
    const isWinner = displayScore >= WIN_SCORE;
    const isFirstPlace =
      index === 0 && topScore !== null && topScore > 0 && players.length > 1;
    const isLastPlace =
      index === sortedPlayers.length - 1 &&
      players.length > 1 &&
      bottomScore !== null &&
      topScore !== null &&
      bottomScore < topScore;

    if (index > 0) {
      const arrow = document.createElement("div");
      arrow.className = "rank-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.innerHTML = `
        <span class="rank-arrow-line"></span>
        <span class="rank-arrow-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V5"/>
            <path d="M5 12l7-7 7 7"/>
          </svg>
        </span>
        <span class="rank-arrow-line"></span>
      `;
      playerListEl.appendChild(arrow);
    }

    const taunt =
      lastPlaceTaunts[
        Math.abs(
          [...player.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
        ) % lastPlaceTaunts.length
      ];

    const history = gameLog.filter((e) => e.playerId === player.id);
    const HISTORY_SHOWN = 8;
    const historyChips = history
      .slice(-HISTORY_SHOWN)
      .map((e) => {
        if (e.kind === "edit")
          return `<span class="chip chip-edit" title="Score edited">✏️ ${e.points}</span>`;
        if (e.flip7) return `<span class="chip chip-flip7">🎉 ${e.delta}</span>`;
        if (e.delta === 0) return `<span class="chip chip-bust">💥 0</span>`;
        const big = !e.flip7 && e.points > CHEAT_THRESHOLD;
        return `<span class="chip${big ? " chip-big" : ""}">${e.delta > 0 ? "+" : ""}${e.delta}</span>`;
      })
      .join("");

    const editable = canEditPlayer(player.id);
    const scoredThisRound = Boolean(bettingState && bettingState.entered.includes(player.id));
    const isMe = player.id === me.playerId;

    const card = document.createElement("article");
    card.className =
      "player-card" +
      (isMe ? " is-me" : "") +
      (editable ? "" : " read-only") +
      (isWinner ? " winner" : "") +
      (isSaving ? " saving" : "") +
      (isFirstPlace ? " first-place" : "") +
      (isLastPlace ? " last-place" : "");
    card.dataset.playerId = player.id;
    const bustedAt = bustedUntil.get(player.id);
    if (bustedAt && bustedAt > Date.now()) card.classList.add("busted");

    card.innerHTML = `
      <div class="player-card-header">
        <span class="player-name">${isFirstPlace ? '<span class="crown" aria-hidden="true">👑</span>' : ""}${
          isMe
            ? `<button type="button" class="avatar avatar-btn" aria-label="Change your avatar" title="Change your avatar">${player.avatar || "🙂"}</button>`
            : `<span class="avatar" aria-hidden="true">${player.avatar || ""}</span>`
        }${escapeHtml(player.name)}${player.fortune ? `<span class="fortune-chip" title="Correct bust predictions">🔮${player.fortune}</span>` : ""}${isLastPlace ? '<span class="clown" aria-hidden="true">🤡</span>' : ""}${isMe ? '<span class="you-tag">You</span>' : ""}</span>
        ${isFirstPlace && !isSaving ? '<span class="first-place-badge">1st</span>' : ""}
        ${isLastPlace && !isSaving ? '<span class="last-place-badge">Clown 🤡</span>' : ""}
        ${isWinner && !isSaving ? '<span class="winner-badge">200+</span>' : ""}
        ${me.host && player.claimed && !isMe ? `<button type="button" class="btn btn-icon unlock-player" aria-label="Unlock ${escapeHtml(player.name)} so they can rejoin from another phone" title="Let them rejoin from another phone">🔓</button>` : ""}
        ${!editable && !player.claimed ? `<button type="button" class="btn btn-icon remove-player" aria-label="Remove ${escapeHtml(player.name)} — nobody is playing as them" title="Nobody is playing as this name">×</button>` : ""}
        ${editable ? `<button type="button" class="btn btn-icon remove-player" aria-label="${isMe ? "Leave the game" : `Remove ${escapeHtml(player.name)}`}" ${isSaving ? "disabled" : ""}>×</button>` : ""}
      </div>
      ${
        isLastPlace && !isSaving
          ? `<p class="last-place-taunt">${escapeHtml(taunt)}</p>`
          : ""
      }
      <div class="player-score-row">
        <div class="player-score-wrap">
          <span class="player-score">${displayScore}</span>
          ${editable ? `<button type="button" class="btn btn-icon edit-score" aria-label="Edit score for ${escapeHtml(player.name)}" ${isSaving ? "disabled" : ""}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>` : ""}
          <span class="player-score-label">total</span>
        </div>
        ${
          isSaving
            ? `<span class="save-status"><span class="save-spinner" aria-hidden="true"></span>Saving…</span>`
            : ""
        }
      </div>
      <span class="busted-stamp" aria-hidden="true">BUSTED</span>
      ${
        history.length
          ? `<div class="history-row">
        <div class="history-chips" aria-label="Round history">
          ${history.length > HISTORY_SHOWN ? `<span class="chip chip-more">+${history.length - HISTORY_SHOWN} more</span>` : ""}
          ${historyChips}
        </div>
        ${editable ? `<button type="button" class="btn-undo" aria-label="Undo ${escapeHtml(player.name)}'s last entry" ${isSaving ? "disabled" : ""}>↶ Undo</button>` : ""}
      </div>`
          : ""
      }
      ${editable && scoredThisRound ? `<div class="scored-row">✓ Scored round ${bettingState.round}${
        waitingOn.length ? ` · waiting on ${escapeHtml(waitingOn.map((p) => p.name).join(", "))}` : ""
      }</div>` : ""}
      ${editable && !scoredThisRound ? `<div class="add-points-row">
        <input
          class="points-input"
          type="number"
          inputmode="numeric"
          pattern="[0-9-]*"
          placeholder="Points this round"
          enterkeyhint="done"
          aria-label="Points to add for ${escapeHtml(player.name)}"
          ${isSaving ? "disabled" : ""}
        />
        <button type="button" class="btn btn-add add-points-btn" ${isSaving ? "disabled" : ""}>
          ${isSaving ? "…" : "Add"}
        </button>
        <button type="button" class="btn btn-flip7 flip7-btn" aria-label="Flip 7: add the card total plus a ${FLIP7_BONUS} point bonus for ${escapeHtml(player.name)}" ${isSaving ? "disabled" : ""}>
          Flip 7<span class="flip7-bonus">+${FLIP7_BONUS}</span>
        </button>
      </div>` : ""}
    `;

    card.querySelector(".avatar-btn")?.addEventListener("click", () => {
      openAvatarPicker();
    });

    card.querySelector(".unlock-player")?.addEventListener("click", () => {
      unlockPlayer(player.id);
    });

    if (!editable && !player.claimed) {
      card.querySelector(".remove-player")?.addEventListener("click", () => {
        removePlayer(player.id);
      });
    }

    if (!isSaving && editable) {
      card.querySelector(".remove-player").addEventListener("click", () => {
        removePlayer(player.id);
      });

      card.querySelector(".edit-score").addEventListener("click", () => {
        editScore(player.id, displayScore);
      });

      card.querySelector(".btn-undo")?.addEventListener("click", () => {
        undoLast(player.id);
      });

      // The score box is gone once this player has scored the round.
      const pointsInput = card.querySelector(".points-input");
      const addPointsBtn = card.querySelector(".add-points-btn");
      if (pointsInput && addPointsBtn) {
        const submitPoints = () => {
          addPoints(player.id, pointsInput.value);
        };
        addPointsBtn.addEventListener("click", submitPoints);
        card.querySelector(".flip7-btn").addEventListener("click", () => {
          addPoints(player.id, pointsInput.value, true);
        });
        pointsInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitPoints();
          }
        });
      }
    }

    playerListEl.appendChild(card);
  });

  updateRoastBanner(sortedPlayers);
  updateFinalBanner(sortedPlayers);
  updateBetBanner();
  updateWhoAmI();
  updateTauntFab();

  restorePendingPoints(pendingInputs);
}

/* ---------- Bust: sad trombone, screen shake, BUSTED stamp ---------- */

const BUST_STAMP_MS = 4000;
/** @type {Map<string, number>} player id → time the stamp should disappear */
const bustedUntil = new Map();
/* ---------- Sound engine (all synthesized, no audio files) ---------- */

const SOUND_KEY = "flip7-sound";
let soundOn = localStorage.getItem(SOUND_KEY) !== "off";
let audioCtx = null;
let masterGain = null;

function getAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.7;
    masterGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

// Phones (iOS especially) only let audio start from a tap, and can suspend the
// context again later. Re-unlock on every tap so sounds keep working all night.
function unlockAudio() {
  const ctx = getAudio();
  if (!ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* ignore */
  }
}
["pointerdown", "touchend", "keydown"].forEach((ev) =>
  document.addEventListener(ev, unlockAudio, { passive: true, capture: true })
);

async function withAudio(play) {
  if (!soundOn) return;
  const ctx = getAudio();
  if (!ctx) return;
  try {
    if (ctx.state !== "running") await ctx.resume();
  } catch {
    /* ignore */
  }
  if (ctx.state !== "running") return;
  try {
    play(ctx, ctx.currentTime + 0.03);
  } catch {
    /* no audio — the visuals still sell it */
  }
}

function tone(ctx, { freq, at, dur, type = "square", vol = 0.2, to, wobble, cutoff = 2400, out }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
  if (wobble) {
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = wobble.rate;
    lfoGain.gain.value = wobble.depth;
    lfo.connect(lfoGain).connect(osc.frequency);
    lfo.start(at);
    lfo.stop(at + dur);
  }
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(vol, at + Math.min(0.03, dur / 4));
  gain.gain.setValueAtTime(vol, at + Math.max(dur - 0.08, dur * 0.6));
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(filter).connect(gain).connect(out || masterGain);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function noiseBurst(ctx, { at, dur, vol = 0.2, from = 3000, to = 300 }) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter).connect(gain).connect(masterGain);
  src.start(at);
}

let sirenGain = null;

const sfx = {
  // wah... wah... wah... waaaaah
  trombone: () =>
    withAudio((ctx, t) => {
      [311, 294, 277].forEach((f, i) =>
        tone(ctx, { freq: f, at: t + i * 0.5, dur: 0.45, type: "sawtooth", vol: 0.25, cutoff: 1200 })
      );
      tone(ctx, {
        freq: 262, to: 245, at: t + 1.5, dur: 1.4, type: "sawtooth", vol: 0.25,
        cutoff: 1200, wobble: { rate: 6, depth: 8 },
      });
    }),
  // ka-ching for a normal score
  coin: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 988, at: t, dur: 0.08, vol: 0.15 });
      tone(ctx, { freq: 1319, at: t + 0.08, dur: 0.3, vol: 0.15 });
    }),
  // ta-da-da-DAAA for a new leader
  fanfare: () =>
    withAudio((ctx, t) => {
      [523, 659, 784].forEach((f, i) =>
        tone(ctx, { freq: f, at: t + i * 0.12, dur: 0.12, type: "triangle", vol: 0.25 })
      );
      [1047, 784, 659].forEach((f) =>
        tone(ctx, { freq: f, at: t + 0.36, dur: 0.7, type: "square", vol: 0.08, cutoff: 3000 })
      );
    }),
  // big victory fanfare for crossing 200
  victory: () =>
    withAudio((ctx, t) => {
      const notes = [523, 523, 523, 698, 880, 784, 698, 1047];
      const times = [0, 0.13, 0.26, 0.4, 0.62, 0.84, 1.0, 1.2];
      notes.forEach((f, i) =>
        tone(ctx, { freq: f, at: t + times[i], dur: i === 7 ? 1.2 : 0.14, type: "square", vol: 0.14, cutoff: 3500 })
      );
      [523, 659, 784].forEach((f) =>
        tone(ctx, { freq: f, at: t + 1.2, dur: 1.2, type: "triangle", vol: 0.12 })
      );
    }),
  // honk honk — someone new is the clown
  honk: () =>
    withAudio((ctx, t) => {
      [0, 0.28].forEach((d) => {
        tone(ctx, { freq: 420, to: 330, at: t + d, dur: 0.22, type: "sawtooth", vol: 0.3, cutoff: 1600 });
        tone(ctx, { freq: 560, to: 440, at: t + d, dur: 0.22, type: "square", vol: 0.1, cutoff: 1600 });
      });
    }),
  // bloop for a new player
  pop: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 300, to: 900, at: t, dur: 0.12, type: "sine", vol: 0.35 });
    }),
  // down the drain for a removed player
  flush: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 700, to: 60, at: t, dur: 0.9, type: "sine", vol: 0.35, wobble: { rate: 14, depth: 40 } });
      noiseBurst(ctx, { at: t, dur: 0.9, vol: 0.12, from: 2500, to: 200 });
    }),
  // nee-naw siren while the cheat scan runs
  siren: (seconds) =>
    withAudio((ctx, t) => {
      sirenGain = ctx.createGain();
      sirenGain.gain.value = 1;
      sirenGain.connect(masterGain);
      for (let i = 0; i * 0.45 < seconds; i++) {
        tone(ctx, { freq: i % 2 ? 660 : 880, at: t + i * 0.45, dur: 0.42, type: "square", vol: 0.07, cutoff: 2000, out: sirenGain });
      }
    }),
  stopSiren: () => {
    if (sirenGain && audioCtx) {
      sirenGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.02);
      sirenGain = null;
    }
  },
  // bright "all clear" chime when the cheat scan finishes
  allClear: () =>
    withAudio((ctx, t) => {
      [880, 1109, 1319, 1760].forEach((f, i) =>
        tone(ctx, { freq: f, at: t + i * 0.07, dur: 0.35, type: "sine", vol: 0.2 })
      );
    }),
  // BWAAP BWAAP BWAAAAAP for a Flip 7
  airhorn: () =>
    withAudio((ctx, t) => {
      [
        [0, 0.18],
        [0.24, 0.18],
        [0.48, 0.75],
      ].forEach(([d, len]) => {
        [466, 587, 698, 932].forEach((f) =>
          tone(ctx, { freq: f * 1.03, to: f, at: t + d, dur: len, type: "sawtooth", vol: 0.09, cutoff: 3200 })
        );
      });
    }),
  // wrong-answer buzzer for a confession
  buzzer: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 110, at: t, dur: 0.6, type: "sawtooth", vol: 0.3, cutoff: 900 });
      tone(ctx, { freq: 116, at: t, dur: 0.6, type: "sawtooth", vol: 0.3, cutoff: 900 });
    }),
  // boing + raspberry for an incoming taunt
  boing: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 180, to: 520, at: t, dur: 0.18, type: "sine", vol: 0.35 });
      tone(ctx, { freq: 520, to: 160, at: t + 0.18, dur: 0.3, type: "sine", vol: 0.3, wobble: { rate: 18, depth: 30 } });
      tone(ctx, { freq: 90, at: t + 0.5, dur: 0.35, type: "sawtooth", vol: 0.2, cutoff: 700, wobble: { rate: 30, depth: 25 } });
    }),
  // pffbbbt
  fart: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 95, to: 60, at: t, dur: 0.75, type: "sawtooth", vol: 0.35, cutoff: 500, wobble: { rate: 28, depth: 22 } });
      noiseBurst(ctx, { at: t, dur: 0.6, vol: 0.15, from: 400, to: 120 });
    }),
  // quack quack
  quack: () =>
    withAudio((ctx, t) => {
      [0, 0.24].forEach((d) => {
        tone(ctx, { freq: 620, to: 380, at: t + d, dur: 0.16, type: "sawtooth", vol: 0.25, cutoff: 1400, wobble: { rate: 40, depth: 30 } });
      });
    }),
  // bawk bawk bawwwk
  chicken: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 720, to: 880, at: t, dur: 0.1, type: "square", vol: 0.13, cutoff: 2200 });
      tone(ctx, { freq: 720, to: 880, at: t + 0.16, dur: 0.1, type: "square", vol: 0.13, cutoff: 2200 });
      tone(ctx, { freq: 950, to: 520, at: t + 0.34, dur: 0.45, type: "square", vol: 0.14, cutoff: 2200, wobble: { rate: 12, depth: 40 } });
    }),
  // mmmm-OOOOOO
  moo: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 115, to: 150, at: t, dur: 0.3, type: "sawtooth", vol: 0.3, cutoff: 380 });
      tone(ctx, { freq: 150, to: 98, at: t + 0.28, dur: 1.1, type: "sawtooth", vol: 0.34, cutoff: 750, wobble: { rate: 5, depth: 4 } });
      // a second voice an octave up gives it that nasal "oo"
      tone(ctx, { freq: 300, to: 196, at: t + 0.28, dur: 1.1, type: "triangle", vol: 0.08, cutoff: 1200 });
    }),
  // ba-dum-tss
  rimshot: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 200, to: 110, at: t, dur: 0.14, type: "sine", vol: 0.45 });
      tone(ctx, { freq: 150, to: 80, at: t + 0.16, dur: 0.16, type: "sine", vol: 0.45 });
      noiseBurst(ctx, { at: t + 0.36, dur: 0.7, vol: 0.18, from: 9000, to: 6000 });
    }),
  // zzz... snort
  snore: () =>
    withAudio((ctx, t) => {
      noiseBurst(ctx, { at: t, dur: 0.9, vol: 0.22, from: 250, to: 500 });
      tone(ctx, { freq: 70, at: t + 0.1, dur: 0.8, type: "sawtooth", vol: 0.25, cutoff: 400, wobble: { rate: 22, depth: 15 } });
      noiseBurst(ctx, { at: t + 1.1, dur: 0.6, vol: 0.12, from: 900, to: 300 });
    }),
  // chirp chirp... chirp chirp
  crickets: () =>
    withAudio((ctx, t) => {
      for (let n = 0; n < 4; n++) {
        for (let c = 0; c < 3; c++) {
          tone(ctx, { freq: 4400, at: t + n * 0.55 + c * 0.05, dur: 0.035, type: "sine", vol: 0.12, cutoff: 8000 });
        }
      }
    }),
  // mwah
  kiss: () =>
    withAudio((ctx, t) => {
      noiseBurst(ctx, { at: t, dur: 0.05, vol: 0.3, from: 3000, to: 1500 });
      tone(ctx, { freq: 380, to: 760, at: t + 0.04, dur: 0.28, type: "sine", vol: 0.3 });
    }),
  // clap.......clap.....clap...clap..clap
  slowClap: () =>
    withAudio((ctx, t) => {
      [0, 0.75, 1.35, 1.8, 2.15, 2.42].forEach((d) =>
        noiseBurst(ctx, { at: t + d, dur: 0.09, vol: 0.4, from: 2200, to: 1000 })
      );
    }),
  // a few bars of a bouncy dance beat for the 200 mascot
  danceBeat: () =>
    withAudio((ctx, t) => {
      const beat = 0.24;
      const bass = [131, 131, 196, 175, 131, 131, 233, 196];
      const lead = [523, 659, 784, 659, 698, 880, 784, 1047];
      for (let bar = 0; bar < 3; bar++) {
        for (let i = 0; i < 8; i++) {
          const at = t + (bar * 8 + i) * beat;
          // kick on the beat, hi-hat on the off-beat
          if (i % 2 === 0) tone(ctx, { freq: 150, to: 45, at, dur: 0.16, type: "sine", vol: 0.5 });
          noiseBurst(ctx, { at: at + beat / 2, dur: 0.05, vol: 0.08, from: 9000, to: 7000 });
          tone(ctx, { freq: bass[i], at, dur: beat * 0.9, type: "square", vol: 0.09, cutoff: 700 });
          if (bar > 0) tone(ctx, { freq: lead[(i + bar) % 8], at, dur: beat * 0.8, type: "triangle", vol: 0.1 });
        }
      }
      [523, 659, 784, 1047].forEach((f) =>
        tone(ctx, { freq: f, at: t + 24 * beat, dur: 0.9, type: "triangle", vol: 0.1 })
      );
    }),
  // descending slide whistle for reset / new game
  slide: () =>
    withAudio((ctx, t) => {
      tone(ctx, { freq: 1800, to: 250, at: t, dur: 0.7, type: "sine", vol: 0.3 });
    }),
};

function standings(list) {
  if (list.length < 2) return { leaderId: null, clownId: null };
  const sorted = [...list].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  return {
    leaderId: top.score > 0 ? top.id : null,
    clownId: bottom.score < top.score ? bottom.id : null,
  };
}

function setSound(on, announce = true) {
  soundOn = on;
  localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  const btn = document.getElementById("sound-toggle");
  if (btn) {
    btn.textContent = on ? "🔊" : "🔇";
    btn.setAttribute("aria-label", on ? "Mute sounds" : "Unmute sounds");
    btn.setAttribute("aria-pressed", String(!on));
  }
  if (on && announce) sfx.pop();
}

/* ---------- Confirm dialog ---------- */

function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", confirmClass = "btn-danger" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <p id="confirm-title" class="confirm-title">${escapeHtml(title)}</p>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button type="button" class="btn btn-ghost confirm-cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn ${confirmClass} confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const close = (ok) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.querySelector(".confirm-cancel").addEventListener("click", () => close(false));
    overlay.querySelector(".confirm-ok").addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector(".confirm-cancel").focus();
  });
}

function celebrateBust(id) {
  bustedUntil.set(id, Date.now() + BUST_STAMP_MS);
  render();
  if (navigator.vibrate) navigator.vibrate([120, 80, 120, 80, 400]);
  document.body.classList.remove("shake");
  void document.body.offsetWidth; // restart the animation
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 700);
  setTimeout(render, BUST_STAMP_MS + 50);
}

/* ---------- Table-wide moments (shown on every phone) ---------- */

const MOMENT_MS = 2800;
const momentQueue = [];
let momentShowing = false;

const MOMENTS = {
  bust: (e) => ({ icon: "💥", title: "BUSTED", text: `${e.name} flipped a duplicate. Zero points.`, tone: "bad" }),
  flip7: (e) => ({ icon: "🎉", title: "FLIP 7!", text: `${e.name} flipped 7 — ${e.points} points with the bonus`, tone: "party", confetti: true }),
  big: (e) => ({ icon: "😳", title: "HUGE ROUND", text: `${e.name} just put up ${e.points}`, tone: "good" }),
  win: (e) => ({ icon: "🏁", title: "FINAL ROUND!", text: `${e.name} hit ${WIN_SCORE}. Finish this round, then tap End Game.`, tone: "good" }),
  comeback: (e) => ({ icon: "🚀", title: "THE COMEBACK", text: `${e.name} went from last to first in one round`, tone: "party", confetti: true }),
  bets: (e) => {
    const won = e.results.filter((r) => r.outcome === "won");
    const skippedNote = e.skipped && e.skipped.length ? ` (${e.skipped.join(", ")} sat out)` : "";
    const bust = e.busted.length ? `${e.busted.join(", ")} busted.` : "Nobody busted!";
    return {
      icon: "🔮",
      title: won.length ? "CALLED IT!" : "NOBODY CALLED IT",
      text: won.length
        ? `${bust} ${won.map((r) => `${r.avatar || ""} ${r.bettor}`.trim()).join(", ")} +1 🔮${skippedNote}`
        : `${bust} Every prediction missed 🙈${skippedNote}`,
      tone: won.length ? "party" : "bad",
      confetti: won.length > 0,
    };
  },
  collapse: (e) => ({ icon: "📉", title: "FROM HERO TO ZERO", text: `${e.name} fell from first to dead last`, tone: "bad" }),
};

function processEvents(events) {
  const maxId = events.reduce((m, e) => Math.max(m, e.id), 0);
  if (lastSeenEventId === null) {
    // First load: don't replay old moments to someone who just joined.
    lastSeenEventId = maxId;
    return;
  }
  const fresh = events.filter((e) => e.id > lastSeenEventId).sort((a, b) => a.id - b.id);
  if (!fresh.length) return;
  lastSeenEventId = maxId;
  // Show the big ones first: win, comeback, flip7, collapse, big, bust
  const order = ["win", "comeback", "flip7", "collapse", "big", "bust", "bets"];
  fresh.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  fresh.forEach((e) => {
    if (e.type === "bust") celebrateBust(e.playerId);
    // Bets on skipped players don't count; with nothing left, just say the round is done.
    if (e.type === "bets" && !(e.results || []).some((r) => r.outcome !== "void")) {
      showToast(`✅ Round ${e.round} done. Bets are open for round ${e.round + 1} 🔮`);
      return;
    }
    if (MOMENTS[e.type]) momentQueue.push(e);
  });
  // The party only starts when someone presses End Game, not when 200 is crossed.
  const over = fresh.find((e) => e.type === "gameover");
  if (over) {
    momentQueue.push({ type: "__dance", names: over.names || [over.name], score: over.score });
    momentQueue.push({ type: "__awards" });
  }
  showNextMoment();
}

function showNextMoment() {
  if (momentShowing) return;
  const e = momentQueue.shift();
  if (!e) return;
  if (e.type === "__dance") {
    momentShowing = true;
    showDanceParty(e, () => {
      momentShowing = false;
      showNextMoment();
    });
    return;
  }
  if (e.type === "__awards") {
    openAwards(true);
    showNextMoment();
    return;
  }
  const m = MOMENTS[e.type](e);
  momentShowing = true;
  const el = document.createElement("div");
  el.className = `moment moment-${m.tone}`;
  el.setAttribute("role", "status");
  el.innerHTML = `
    <div class="moment-icon" aria-hidden="true">${m.icon}</div>
    <div class="moment-title">${escapeHtml(m.title)}</div>
    <div class="moment-text">${escapeHtml(m.text)}</div>
  `;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => {
      el.remove();
      momentShowing = false;
      showNextMoment();
    }, 250);
  };
  el.addEventListener("click", dismiss);
  document.body.appendChild(el);
  if (m.confetti) launchConfetti();
  setTimeout(dismiss, MOMENT_MS);
}

/* ---------- Bets: who busts this round? ---------- */

const betBannerEl = document.getElementById("bet-banner");
const betTitleEl = document.getElementById("bet-title");
const betSubEl = document.getElementById("bet-sub");
const betBtnEl = document.getElementById("bet-btn");

async function loadMyBet() {
  try {
    const res = await fetch("/api/me", {
      cache: "no-store",
      headers: myToken ? { "X-Player-Token": myToken } : {},
    }).then((r) => r.json());
    myBet = res.myBet || null;
    updateBetBanner();
  } catch {
    /* banner just won't show your pick */
  }
}

function betLabel(target) {
  if (target === "nobody") return "😇 Nobody busts";
  const p = playerById(target);
  return p ? tag(p) : "?";
}

function updateBetBanner() {
  const b = bettingState;
  if (!b || players.length < 2 || gameOverState) {
    betBannerEl.classList.add("hidden");
    return;
  }
  const count = b.bettors.length;
  const iBet = me.playerId && b.bettors.includes(me.playerId);
  const tally = `${count} of ${players.length} bet${players.length === 1 ? "" : "s"} in`;
  betBannerEl.classList.remove("hidden");
  betBannerEl.dataset.state = b.open ? "open" : "locked";
  if (b.open) {
    betTitleEl.textContent = `🔮 Round ${b.round}: who's going to bust?`;
    betSubEl.textContent = iBet && myBet ? `You picked ${betLabel(myBet)} · ${tally}` : `Bet before anyone scores · ${tally}`;
    betBtnEl.textContent = iBet ? "Change" : "Place bet";
    betBtnEl.classList.toggle("hidden", !me.playerId);
  } else {
    const waiting = players.filter((p) => !b.entered.includes(p.id));
    betTitleEl.textContent = `🎲 Round ${b.round} in progress · bets locked`;
    betSubEl.textContent = `${iBet && myBet ? `You picked ${betLabel(myBet)} · ` : ""}${count ? `${count} bet${count === 1 ? "" : "s"} riding · ` : ""}waiting on ${waiting.map(tag).join(", ")}`;
    betBtnEl.textContent = "End round";
    betBtnEl.classList.toggle("hidden", !(me.playerId || me.host));
  }
}

function openBetPicker() {
  if (!bettingState?.open || !me.playerId || document.querySelector(".bet-overlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "taunt-overlay bet-overlay";
  overlay.innerHTML = `
    <div class="taunt-sheet" role="dialog" aria-modal="true" aria-labelledby="bet-sheet-title">
      <p id="bet-sheet-title" class="taunt-title">🔮 Who busts in round ${bettingState.round}?</p>
      <p class="taunt-sub">Secret until the round ends. Call it right for +1 🔮.</p>
      <div class="bet-grid">
        ${players
          .map(
            (p) => `<button type="button" class="taunt-option bet-option" data-target="${p.id}" aria-pressed="${myBet === p.id}">
            <span class="taunt-option-emoji" aria-hidden="true">${p.avatar || "🙂"}</span>
            <span class="taunt-option-text">${escapeHtml(p.name)}${p.id === me.playerId ? " (you!)" : ""}</span>
          </button>`
          )
          .join("")}
        <button type="button" class="taunt-option bet-option bet-nobody" data-target="nobody" aria-pressed="${myBet === "nobody"}">
          <span class="taunt-option-emoji" aria-hidden="true">😇</span>
          <span class="taunt-option-text">Nobody busts</span>
        </button>
      </div>
      <button type="button" class="btn btn-ghost taunt-cancel">Close</button>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".taunt-cancel").addEventListener("click", close);
  overlay.querySelectorAll(".bet-option").forEach((btn) =>
    btn.addEventListener("click", async () => {
      close();
      try {
        const result = await api("/api/bet", {
          method: "POST",
          body: JSON.stringify({ target: btn.dataset.target }),
        });
        myBet = result.myBet;
        myBetRound = result.state?.betting?.round ?? myBetRound;
        if (result.state && result.state.version > version) {
          ingestState(result.state);
        }
        render();
        sfx.coin();
        showToast(`🔮 You bet on ${betLabel(myBet)}`);
      } catch (err) {
        showToast(err.message || "Couldn't place that bet");
      }
    })
  );
  document.body.appendChild(overlay);
}
async function endRoundEarly() {
  const b = bettingState;
  if (!b || b.open) return;
  const waiting = players.filter((p) => !b.entered.includes(p.id));
  const ok = await confirmDialog({
    title: `End round ${b.round}?`,
    message: `${waiting.map((p) => p.name).join(", ")} haven't scored. They get nothing this round, and bets on them don't count. Use this if they're sitting out.`,
    confirmLabel: "End round",
    cancelLabel: "Wait",
    confirmClass: "btn-primary",
  });
  if (!ok) return;
  await mutate(() => api("/api/end-round", { method: "POST", body: "{}" }));
}

betBtnEl.addEventListener("click", () => {
  if (bettingState?.open) openBetPicker();
  else endRoundEarly();
});

/* ---------- Final round & End Game ---------- */

const finalBannerEl = document.getElementById("final-banner");
const finalTextEl = document.getElementById("final-text");
const finalBtnEl = document.getElementById("final-btn");
const playAgainBtnEl = document.getElementById("play-again-btn");

function updateFinalBanner(sorted) {
  const top = sorted.length ? sorted[0].score : 0;
  const canAct = Boolean(me.playerId || me.host);
  if (gameOverState) {
    const names = gameOverState.names;
    finalBannerEl.dataset.state = "over";
    finalTextEl.textContent = `🏆 Game over! ${names.join(" & ")} ${names.length > 1 ? "tie" : "wins"} with ${gameOverState.score}.`;
    finalBtnEl.textContent = "See results";
    finalBtnEl.classList.remove("hidden");
    playAgainBtnEl.classList.toggle("hidden", !canAct);
    finalBannerEl.classList.remove("hidden");
  } else if (top >= WIN_SCORE) {
    const at200 = sorted.filter((p) => p.score >= WIN_SCORE).map((p) => p.name);
    finalBannerEl.dataset.state = "final";
    finalTextEl.textContent = `🏁 Final round! ${at200.join(", ")} hit ${WIN_SCORE}. Finish the round, then end the game.`;
    finalBtnEl.textContent = "End Game";
    finalBtnEl.classList.toggle("hidden", !canAct);
    playAgainBtnEl.classList.add("hidden");
    finalBannerEl.classList.remove("hidden");
  } else {
    finalBannerEl.classList.add("hidden");
  }
}

async function onFinalButton() {
  if (gameOverState) {
    openAwards(true);
    return;
  }
  const sorted = sortedPlayersSnapshot();
  const top = sorted[0];
  if (!top) return;
  const leaders = sorted.filter((p) => p.score === top.score).map((p) => p.name);
  const ok = await confirmDialog({
    title: "End the game?",
    message: `Make sure everyone has finished this round. Highest score wins: ${leaders.join(" & ")} with ${top.score}.`,
    confirmLabel: "End game",
    cancelLabel: "Not yet",
    confirmClass: "btn-primary",
  });
  if (!ok) return;
  const done = await mutate(() => api("/api/end-game", { method: "POST", body: "{}" }));
  if (done) sfx.victory();
}
finalBtnEl.addEventListener("click", onFinalButton);

async function playAgain() {
  const ok = await confirmDialog({
    title: "Play again?",
    message: "Everyone goes back to 0 and keeps their name. This clears the scores for every phone.",
    confirmLabel: "Play again",
    cancelLabel: "Not yet",
    confirmClass: "btn-primary",
  });
  if (!ok) return;
  const done = await mutate(() => api("/api/reset", { method: "POST", body: "{}" }));
  if (done) {
    sfx.slide();
    showToast("New game! Everyone's back to 0");
  }
}
playAgainBtnEl.addEventListener("click", playAgain);

/* ---------- Dance party: the card mascot celebrates the winner ---------- */

const DANCE_MS = 7000;

// An original mascot: a playing card with a 7, shades, noodle arms and legs.
const MASCOT_SVG = `
<svg class="mascot" viewBox="0 0 200 260" aria-hidden="true">
  <g class="mascot-leg mascot-leg-l"><path d="M80 196 L70 236" /><ellipse cx="64" cy="240" rx="14" ry="7" /></g>
  <g class="mascot-leg mascot-leg-r"><path d="M120 196 L130 236" /><ellipse cx="136" cy="240" rx="14" ry="7" /></g>
  <g class="mascot-arm mascot-arm-l"><path d="M54 110 Q26 96 20 64" /><circle cx="20" cy="60" r="9" /></g>
  <g class="mascot-arm mascot-arm-r"><path d="M146 110 Q174 96 180 64" /><circle cx="180" cy="60" r="9" /></g>
  <g class="mascot-body">
    <rect x="50" y="40" width="100" height="160" rx="14" class="mascot-card" />
    <text x="62" y="68" class="mascot-pip">7</text>
    <text x="138" y="188" class="mascot-pip mascot-pip-flip">7</text>
    <g class="mascot-shades">
      <rect x="64" y="96" width="30" height="18" rx="6" />
      <rect x="106" y="96" width="30" height="18" rx="6" />
      <path d="M94 103 H106" />
      <path d="M70 100 L80 100" class="mascot-glint" />
    </g>
    <path d="M78 134 Q100 158 122 134 Q100 146 78 134 Z" class="mascot-mouth" />
    <circle cx="70" cy="132" r="6" class="mascot-blush" />
    <circle cx="130" cy="132" r="6" class="mascot-blush" />
  </g>
</svg>`;

function showDanceParty(e, done) {
  const el = document.createElement("div");
  el.className = "dance-party";
  el.setAttribute("role", "status");
  el.innerHTML = `
    <div class="dance-lights" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="dance-ball" aria-hidden="true">🪩</div>
    <div class="dance-floor">
      <div class="dance-notes" aria-hidden="true"><span>♪</span><span>♫</span><span>♪</span><span>♬</span></div>
      ${MASCOT_SVG}
    </div>
    <p class="dance-title">${escapeHtml(e.names.length > 1 ? `${e.names.join(" & ")} tie!` : `${e.names[0]} wins!`)}</p>
    <p class="dance-sub">${e.score ? `${e.score} points · ` : ""}tap to continue</p>
  `;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.classList.add("leaving");
    setTimeout(() => {
      el.remove();
      done();
    }, 300);
  };
  el.addEventListener("click", finish);
  document.body.appendChild(el);
  launchConfetti(160);
  sfx.danceBeat();
  if (navigator.vibrate) navigator.vibrate([100, 100, 100, 100, 100, 100, 300]);
  setTimeout(finish, DANCE_MS);
}

function launchConfetti(count = 140) {
  const colors = ["#ffc857", "#ff6b4a", "#5eead4", "#a78bfa", "#f472b6", "#60a5fa"];
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 220}px`);
    piece.style.setProperty("--spin", `${(Math.random() - 0.5) * 1440}deg`);
    piece.style.animationDelay = `${Math.random() * 0.5}s`;
    piece.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    if (i % 3 === 0) piece.style.borderRadius = "50%";
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 4600);
}

/* ---------- End-of-game awards ---------- */

function computeAwards() {
  const ids = new Set(players.map((p) => p.id));
  const entries = gameLog.filter((e) => ids.has(e.playerId));
  const name = (id) => tag(players.find((p) => p.id === id));

  // Replay the game. Scores from before the log existed become the starting point.
  const logged = new Map(players.map((p) => [p.id, 0]));
  entries.forEach((e) => logged.set(e.playerId, logged.get(e.playerId) + e.delta));
  const running = new Map(players.map((p) => [p.id, p.score - logged.get(p.id)]));

  const maxLead = new Map(players.map((p) => [p.id, 0]));
  const lastCount = new Map(players.map((p) => [p.id, 0]));
  const rounds = entries.filter((e) => e.kind === "round");

  entries.forEach((e) => {
    running.set(e.playerId, running.get(e.playerId) + e.delta);
    if (e.kind !== "round" || players.length < 2) return;
    const sorted = players
      .map((p) => ({ id: p.id, score: running.get(p.id) }))
      .sort((a, b) => b.score - a.score);
    const lead = sorted[0].score - sorted[1].score;
    if (lead > maxLead.get(sorted[0].id)) maxLead.set(sorted[0].id, lead);
    const bottom = sorted[sorted.length - 1];
    if (bottom.score < sorted[0].score) lastCount.set(bottom.id, lastCount.get(bottom.id) + 1);
  });

  const count = (pred) => {
    const m = new Map();
    rounds.filter(pred).forEach((e) => m.set(e.playerId, (m.get(e.playerId) || 0) + 1));
    return m;
  };
  const top = (m) => {
    let best = null;
    m.forEach((v, id) => {
      if (v > 0 && (!best || v > best.v)) best = { id, v };
    });
    return best;
  };

  const champion = [...players].sort((a, b) => b.score - a.score)[0];
  const awards = [];
  if (champion) awards.push({ icon: "🏆", title: "Champion", who: tag(champion), detail: `${champion.score} points` });

  const bestCalls = Math.max(0, ...players.map((p) => p.fortune || 0));
  if (bestCalls > 0) {
    const seers = players.filter((p) => (p.fortune || 0) === bestCalls);
    awards.push({
      icon: "🔮",
      title: "Fortune Teller",
      who: seers.map(tag).join(" & "),
      detail: `called ${bestCalls} round${bestCalls === 1 ? "" : "s"} right`,
    });
  }

  const biggest = rounds.reduce((b, e) => (!b || e.delta > b.delta ? e : b), null);
  if (biggest && biggest.delta > 0)
    awards.push({ icon: "💪", title: "Biggest Round", who: name(biggest.playerId), detail: `${biggest.delta} in one round${biggest.flip7 ? " (Flip 7!)" : ""}` });

  const flips = top(count((e) => e.flip7));
  if (flips) awards.push({ icon: "🎉", title: "Flip 7 Master", who: name(flips.id), detail: `${flips.v} Flip 7${flips.v === 1 ? "" : "s"}` });

  const busts = top(count((e) => e.delta === 0 && !e.flip7));
  if (busts) awards.push({ icon: "💥", title: "Most Busts", who: name(busts.id), detail: `${busts.v} bust${busts.v === 1 ? "" : "s"}` });

  const sus = top(count((e) => !e.flip7 && e.points > CHEAT_THRESHOLD));
  if (sus) awards.push({ icon: "🕵️", title: "Most Suspicious", who: name(sus.id), detail: `${sus.v} round${sus.v === 1 ? "" : "s"} over ${CHEAT_THRESHOLD}` });

  const chokes = new Map(maxLead);
  if (champion) chokes.delete(champion.id);
  const choke = top(chokes);
  if (choke) awards.push({ icon: "😬", title: "Biggest Choke", who: name(choke.id), detail: `led by ${choke.v} and still lost` });

  const clown = top(lastCount);
  if (clown) awards.push({ icon: "🤡", title: "Clown of the Night", who: name(clown.id), detail: `in last place after ${clown.v} round${clown.v === 1 ? "" : "s"}` });

  return awards;
}

function openAwards(auto = false) {
  if (document.querySelector(".awards-overlay")) return;
  if (!players.length) {
    showToast("Add some players first");
    return;
  }
  const awards = computeAwards();
  const overlay = document.createElement("div");
  overlay.className = "awards-overlay";
  overlay.innerHTML = `
    <div class="awards-modal" role="dialog" aria-modal="true" aria-labelledby="awards-title">
      <p id="awards-title" class="awards-title">${auto || gameOverState ? "🏁 Game over!" : "🏆 Awards so far"}</p>
      <div class="race-slot"></div>
      <ul class="awards-list">
        ${awards
          .map(
            (a, i) => `
          <li class="award" style="animation-delay:${i * 0.12}s">
            <span class="award-icon" aria-hidden="true">${a.icon}</span>
            <span class="award-body">
              <span class="award-title">${escapeHtml(a.title)}</span>
              <span class="award-who">${escapeHtml(a.who)}</span>
              <span class="award-detail">${escapeHtml(a.detail)}</span>
            </span>
          </li>`
          )
          .join("")}
      </ul>
      ${awards.length <= 1 ? '<p class="awards-empty">Play a few rounds and the awards fill in.</p>' : ""}
      ${gameOverState && (me.playerId || me.host) ? '<button type="button" class="btn btn-flip7 awards-again">🔁 Play again</button>' : ""}
      <button type="button" class="btn btn-primary awards-close">Close</button>
    </div>
  `;
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".awards-close").addEventListener("click", close);
  overlay.querySelector(".awards-again")?.addEventListener("click", () => {
    close();
    playAgain();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  mountRaceChart(overlay.querySelector(".race-slot"));
}

/* ---------- Score race: animated line chart of the whole game ---------- */

const SERIES_COLORS = 8;

/**
 * One line per player: their score before their first entry, then after each
 * entry. x is "that player's nth turn", which lines up with rounds because
 * everyone enters once per round.
 */
function buildRace() {
  const series = players.map((p, i) => {
    const entries = gameLog.filter((e) => e.playerId === p.id);
    const logged = entries.reduce((sum, e) => sum + e.delta, 0);
    const points = [p.score - logged];
    entries.forEach((e) => points.push(points[points.length - 1] + e.delta));
    // Color follows the player (join order), never their rank.
    const color = i < SERIES_COLORS ? `var(--series-${i + 1})` : "var(--text-muted)";
    return { id: p.id, name: tag(p), points, color };
  });
  const rounds = Math.max(0, ...series.map((s) => s.points.length - 1));
  return { series, rounds };
}

function niceMax(v) {
  if (v <= 0) return 10;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

function mountRaceChart(slot) {
  if (!slot) return;
  const { series, rounds } = buildRace();
  if (rounds < 1 || series.length === 0) {
    slot.innerHTML = '<p class="race-empty">📈 The score race shows up after the first round.</p>';
    return;
  }

  const W = 340, H = 210;
  const pad = { l: 34, r: series.length <= 4 ? 64 : 14, t: 12, b: 24 };
  const all = series.flatMap((s) => s.points);
  const yMin = Math.min(0, ...all);
  const yMax = niceMax(Math.max(...all, 10));
  const x = (i) => pad.l + (i / rounds) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  // Split the axis into steps that land on whole numbers (50 → 0,10,20…, not 12.5).
  const span = yMax - yMin;
  const segs = [4, 5, 2].find((n) => Number.isInteger(span / n)) || 4;
  const ticks = Array.from({ length: segs + 1 }, (_, i) => Math.round(yMin + (i / segs) * span));
  const xEvery = Math.ceil(rounds / 6);
  const direct = series.length <= 4;

  slot.innerHTML = `
    <div class="race">
      <div class="race-head">
        <span class="race-title">📈 Score race</span>
        <button type="button" class="link-btn race-replay">↻ Replay</button>
      </div>
      <div class="race-plot">
        <svg class="race-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart of each player's score after every round">
          <g class="race-grid">
            ${ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`).join("")}
            ${yMax >= WIN_SCORE && yMin <= WIN_SCORE ? `<line class="race-goal" x1="${pad.l}" x2="${W - pad.r}" y1="${y(WIN_SCORE)}" y2="${y(WIN_SCORE)}"/>` : ""}
            ${Array.from({ length: rounds + 1 }, (_, i) => i)
              .filter((i) => i > 0 && (i % xEvery === 0 || i === rounds))
              .map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">R${i}</text>`).join("")}
          </g>
          <g class="race-lines">
            ${series.map((s) => `<path data-id="${s.id}" stroke="${s.color}"/>`).join("")}
          </g>
          <line class="race-cross hidden" y1="${pad.t}" y2="${H - pad.b}"/>
          <g class="race-heads">
            ${series.map((s) => `<g data-id="${s.id}"><circle r="4.5" fill="${s.color}"/>${direct ? `<text dx="8" dy="4">${escapeHtml(s.name)}</text>` : ""}</g>`).join("")}
          </g>
          <rect class="race-hit" x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}"/>
        </svg>
        <div class="race-tip hidden" role="status"></div>
      </div>
      <ul class="race-legend">
        ${series.map((s) => `<li><span class="race-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)} <strong data-score="${s.id}"></strong></li>`).join("")}
      </ul>
      <details class="race-table">
        <summary>Show as table</summary>
        <div class="race-table-scroll">
          <table>
            <thead><tr><th>Player</th><th>Start</th>${Array.from({ length: rounds }, (_, i) => `<th>R${i + 1}</th>`).join("")}</tr></thead>
            <tbody>${series.map((s) => `<tr><th>${escapeHtml(s.name)}</th>${Array.from({ length: rounds + 1 }, (_, i) => `<td>${s.points[i] ?? "–"}</td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        </div>
      </details>
    </div>
  `;

  const svg = slot.querySelector(".race-svg");
  const valueAt = (s, p) => {
    const last = s.points.length - 1;
    if (p >= last) return { v: s.points[last], at: last };
    const i = Math.floor(p);
    const f = p - i;
    return { v: s.points[i] + (s.points[i + 1] - s.points[i]) * f, at: p };
  };

  function draw(p) {
    series.forEach((s) => {
      const head = valueAt(s, p);
      const pts = [];
      for (let i = 0; i <= Math.min(Math.floor(p), s.points.length - 1); i++) pts.push([x(i), y(s.points[i])]);
      if (head.at > Math.floor(p) || pts.length === 0) pts.push([x(head.at), y(head.v)]);
      svg.querySelector(`.race-lines path[data-id="${s.id}"]`).setAttribute(
        "d",
        pts.map((pt, i) => `${i ? "L" : "M"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join("")
      );
      svg.querySelector(`.race-heads g[data-id="${s.id}"]`).setAttribute(
        "transform",
        `translate(${x(head.at).toFixed(1)},${y(head.v).toFixed(1)})`
      );
      const scoreEl = slot.querySelector(`[data-score="${s.id}"]`);
      if (scoreEl) scoreEl.textContent = Math.round(head.v);
    });
    if (direct) spreadLabels(p);
  }

  // Push end labels apart vertically so close scores don't print on top of each other.
  function spreadLabels(p) {
    const GAP = 11;
    const heads = series
      .map((s) => ({ s, y: y(valueAt(s, p).v) }))
      .sort((a, b) => a.y - b.y);
    const placed = [];
    heads.forEach((h, i) => {
      placed[i] = i === 0 ? h.y : Math.max(h.y, placed[i - 1] + GAP);
    });
    // If we pushed past the bottom, shift the stack back up.
    const overflow = placed[placed.length - 1] - (H - pad.b);
    if (overflow > 0) for (let i = placed.length - 1; i >= 0; i--) {
      placed[i] -= overflow;
      if (i > 0 && placed[i - 1] <= placed[i] - GAP) break;
    }
    heads.forEach((h, i) => {
      svg.querySelector(`.race-heads g[data-id="${h.s.id}"] text`)?.setAttribute("dy", (placed[i] - h.y + 4).toFixed(1));
    });
  }

  let raf = null;
  function play() {
    cancelAnimationFrame(raf);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const duration = reduce ? 0 : Math.min(7000, 650 * rounds + 400);
    const start = performance.now();
    const step = (now) => {
      if (!slot.isConnected) return;
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const eased = t < 1 ? 1 - Math.pow(1 - t, 2) : 1;
      draw(eased * rounds);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  slot.querySelector(".race-replay").addEventListener("click", play);
  play();

  // Hover / touch: crosshair snaps to a round and lists everyone's score there.
  const cross = svg.querySelector(".race-cross");
  const tip = slot.querySelector(".race-tip");
  const hit = svg.querySelector(".race-hit");
  const showAt = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(rounds, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * rounds)));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.classList.remove("hidden");
    const rows = series
      .map((s) => ({ s, v: s.points[Math.min(i, s.points.length - 1)] }))
      .sort((a, b) => b.v - a.v);
    tip.innerHTML = `<div class="race-tip-head">${i === 0 ? "Start" : `After round ${i}`}</div>${rows
      .map((r) => `<div class="race-tip-row"><span class="race-swatch" style="background:${r.s.color}"></span>${escapeHtml(r.s.name)}<strong>${r.v}</strong></div>`)
      .join("")}`;
    tip.classList.remove("hidden");
    const leftPct = (x(i) / W) * 100;
    tip.style.left = leftPct > 55 ? "" : `calc(${leftPct}% + 10px)`;
    tip.style.right = leftPct > 55 ? `calc(${100 - leftPct}% + 10px)` : "";
  };
  const hide = () => {
    cross.classList.add("hidden");
    tip.classList.add("hidden");
  };
  hit.addEventListener("pointermove", showAt);
  hit.addEventListener("pointerdown", showAt);
  hit.addEventListener("pointerleave", hide);
}

/* ---------- Undo ---------- */

function describeEntry(e) {
  if (e.kind === "edit") return `the score edit (${e.prev} → ${e.points})`;
  if (e.flip7) return `their Flip 7 (+${e.delta})`;
  if (e.delta === 0) return "their bust (0)";
  return `their last round (${e.delta > 0 ? "+" : ""}${e.delta})`;
}

async function undoLast(id) {
  if (pendingByPlayer.has(id)) return;
  const player = players.find((p) => p.id === id);
  const entry = [...gameLog].reverse().find((e) => e.playerId === id);
  if (!player || !entry) return;
  const ok = await confirmDialog({
    title: `Undo for ${player.name}?`,
    message: `This takes back ${describeEntry(entry)}. Their score goes from ${player.score} to ${player.score - entry.delta}.`,
    confirmLabel: "Undo",
    cancelLabel: "Never mind",
  });
  if (!ok) return;
  const done = await mutate(() =>
    api(`/api/players/${encodeURIComponent(id)}/undo`, { method: "POST", body: "{}" })
  );
  if (done) sfx.slide();
}

/* ---------- Cheat detector for suspiciously big rounds ---------- */

const CHEAT_THRESHOLD = 40;
const FLIP7_BONUS = 15;

function runCheatScan(name, points) {
  const steps = [
    `Scanning ${name}'s sleeves…`,
    "Checking under the table…",
    "Cross-referencing with the deck…",
    `Asking ${name}'s mom…`,
    "Consulting the Flip 7 Integrity Council…",
    "Running facial lie detection…",
  ];
  const verdicts = [
    "Verdict: probably fine. We're watching you. 👀",
    "Verdict: no cheating found… this time. 🧐",
    "Verdict: suspicious, but legal. 🤨",
    "Verdict: clean. Annoyingly clean. 😒",
  ];

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "cheat-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.innerHTML = `
      <div class="cheat-modal">
        <p class="cheat-title">⚠️ SUSPICIOUS ACTIVITY DETECTED ⚠️</p>
        <p class="cheat-sub">${escapeHtml(name)} is claiming <strong>${points}</strong> points in one round.</p>
        <div class="cheat-bar"><div class="cheat-bar-fill"></div></div>
        <p class="cheat-step"></p>
        <button type="button" class="btn btn-ghost cheat-confess">I confess (cancel)</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const fill = overlay.querySelector(".cheat-bar-fill");
    const stepEl = overlay.querySelector(".cheat-step");
    const order = shuffleInPlace([...steps]).slice(0, 3);
    let i = 0;
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      overlay.remove();
      resolve(ok);
    };

    stepEl.textContent = order[0];
    requestAnimationFrame(() => fill.classList.add("go"));
    sfx.siren(2.7);
    const timer = setInterval(() => {
      i += 1;
      if (i < order.length) {
        stepEl.textContent = order[i];
      } else if (i === order.length) {
        stepEl.textContent = verdicts[Math.floor(Math.random() * verdicts.length)];
        overlay.classList.add("cleared");
        sfx.stopSiren();
        sfx.allClear();
      } else {
        finish(true);
      }
    }, 900);

    overlay.querySelector(".cheat-confess").addEventListener("click", () => {
      finish(false);
      sfx.stopSiren();
      sfx.buzzer();
      showToast(`${name} confessed. Shameful. 😔`);
    });
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(myToken ? { "X-Player-Token": myToken } : {}),
    },
    cache: "no-store",
    ...options,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

/** The app version this page loaded with; a different one means reload. */
let loadedBuild = null;

function checkForUpdate(build) {
  if (!build) return;
  if (loadedBuild === null) {
    loadedBuild = build;
    return;
  }
  if (build === loadedBuild) return;
  // Don't yank the page out from under someone mid-entry.
  const busy =
    pendingByPlayer.size > 0 ||
    document.querySelector(".confirm-overlay, .cheat-overlay, .taunt-overlay, .join-overlay") ||
    [...document.querySelectorAll(".points-input")].some((i) => i.value !== "");
  if (!busy) location.reload();
}

/** { names, score, at } once someone pressed End Game; null while playing. */
let gameOverState = null;
/** { round, open, bettors, entered } from the server. */
let bettingState = null;
/** Who this phone bet on this round ("nobody", a player id, or null). Secret, so it comes from /api/me. */
let myBet = null;
let myBetRound = null;

function ingestState(state) {
  checkForUpdate(state.build);
  gameOverState = state.gameOver || null;
  bettingState = state.betting || null;
  if (bettingState && bettingState.round !== myBetRound) {
    myBetRound = bettingState.round;
    myBet = null;
    if (me.playerId && bettingState.bettors.includes(me.playerId)) loadMyBet();
  }
  players = state.players;
  version = state.version;
  checkStillJoined();
  gameLog = Array.isArray(state.log) ? state.log : [];
  processEvents(Array.isArray(state.events) ? state.events : []);
  processTaunts(Array.isArray(state.taunts) ? state.taunts : []);
}

function applyState(state) {
  if (state.version <= version) return false;
  ingestState(state);
  render();
  return true;
}

async function syncState() {
  if (pendingByPlayer.size > 0) return;

  try {
    const state = await fetch("/api/state", { cache: "no-store" }).then((r) =>
      r.json()
    );
    if (!me.loaded) await loadMe();
    applyState(state);
    setSyncStatus("Live · synced");
  } catch {
    setSyncStatus("Offline · retrying", "error");
  }
}

async function mutate(request) {
  try {
    const result = await request();
    if (result.state && result.state.version > version) {
      ingestState(result.state);
      render();
    }
    setSyncStatus("Live · synced");
    return true;
  } catch (err) {
    showToast(err.message || "Something went wrong");
    setSyncStatus("Sync error", "error");
    return false;
  }
}

function handleAddPlayer() {
  const name = playerNameInput.value;
  mutate(() =>
    api("/api/players", {
      method: "POST",
      body: JSON.stringify({ name }),
    })
  ).then((ok) => {
    if (ok) {
      sfx.pop();
      playerNameInput.value = "";
      playerNameInput.blur();
    }
  });
}

async function removePlayer(id) {
  if (pendingByPlayer.has(id)) return;
  const player = players.find((p) => p.id === id);
  if (!player) return;
  const self = id === me.playerId;
  const leftover = !player.claimed && !canEditPlayer(id);
  const ok = await confirmDialog(
    leftover
      ? {
          title: `Remove ${player.name}?`,
          message: "Nobody has joined as this name. It's probably left over from an old game.",
          confirmLabel: "Remove",
          cancelLabel: "Keep",
        }
      : self
      ? {
          title: "Leave the game?",
          message: `Your ${player.score} point${player.score === 1 ? "" : "s"} go with you. This can't be undone.`,
          confirmLabel: "Leave",
          cancelLabel: "Stay",
        }
      : {
          title: `Remove ${player.name}?`,
          message: `Their ${player.score} point${player.score === 1 ? "" : "s"} go with them. This can't be undone.`,
          confirmLabel: "Remove",
          cancelLabel: "Keep them",
        }
  );
  if (!ok || pendingByPlayer.has(id)) return;
  sfx.flush();
  mutate(() =>
    api(`/api/players/${encodeURIComponent(id)}`, { method: "DELETE" })
  );
}

function playScoreSound(id, before, scoreBefore) {
  const after = standings(players);
  const me = players.find((p) => p.id === id);
  if (me && scoreBefore < WIN_SCORE && me.score >= WIN_SCORE) {
    sfx.victory();
  } else if (after.leaderId === id && before.leaderId !== id) {
    sfx.fanfare();
  } else {
    sfx.coin();
  }
  // Someone got knocked into last place: honk honk
  if (after.clownId && after.clownId !== before.clownId && after.clownId !== id) {
    setTimeout(sfx.honk, 450);
  }
}

async function addPoints(id, rawValue, flip7 = false) {
  let trimmed = String(rawValue).trim();
  // Flip 7 with an empty box is just the +15 bonus.
  if (flip7 && trimmed === "") trimmed = "0";
  if (trimmed === "" || Number.isNaN(Number(trimmed))) {
    showToast("Enter a valid number");
    return;
  }

  let player = players.find((p) => p.id === id);
  if (!player || pendingByPlayer.has(id)) return;

  const points = Number(trimmed);

  const total = points + (flip7 ? FLIP7_BONUS : 0);

  if (flip7) {
    const ok = await confirmDialog({
      title: `Flip 7 for ${player.name}? 🎉`,
      message:
        points === 0
          ? `Adds the ${FLIP7_BONUS}-point bonus: ${player.score} → ${player.score + total}.`
          : `Adds their ${points} plus the ${FLIP7_BONUS}-point bonus (${total} total): ${player.score} → ${player.score + total}.`,
      confirmLabel: `Yes, +${total}`,
      cancelLabel: "Cancel",
      confirmClass: "btn-flip7",
    });
    if (!ok) return;
    player = players.find((p) => p.id === id);
    if (!player || pendingByPlayer.has(id)) return;
  }

  // A Flip 7 is a celebration, not a crime — skip the cheat scan for it.
  if (!flip7 && points > CHEAT_THRESHOLD) {
    const cleared = await runCheatScan(player.name, points);
    if (!cleared) return;
    if (pendingByPlayer.has(id)) return;
  }

  const before = standings(players);
  const scoreBefore = player.score;

  pendingByPlayer.set(id, {
    points: trimmed,
    optimisticScore: player.score + total,
  });
  render();
  setSyncStatus("Saving…", "pending");

  try {
    const result = await api(
      `/api/players/${encodeURIComponent(id)}/points`,
      {
        method: "POST",
        body: JSON.stringify({ points: trimmed, flip7, by: CLIENT_ID }),
      }
    );

    if (result.state && result.state.version > version) {
      ingestState(result.state);
    }

    pendingByPlayer.delete(id);
    render();
    setSyncStatus("Live · synced");
    // Visuals come from the table-wide events (every phone shows them);
    // sounds only play here, on the phone that entered the score.
    if (flip7) {
      sfx.airhorn();
      const me = players.find((p) => p.id === id);
      if (me && scoreBefore < WIN_SCORE && me.score >= WIN_SCORE) {
        setTimeout(sfx.victory, 1300);
      }
    } else if (total === 0) {
      sfx.trombone();
    } else {
      playScoreSound(id, before, scoreBefore);
    }
  } catch (err) {
    pendingByPlayer.delete(id);
    render();
    showToast(err.message || "Save failed — try again");

    const card = playerListEl.querySelector(`[data-player-id="${id}"]`);
    const input = card?.querySelector(".points-input");
    if (input) input.value = trimmed;

    setSyncStatus("Sync error", "error");
  }
}

async function editScore(id, currentScore) {
  if (pendingByPlayer.has(id)) return;

  const player = players.find((p) => p.id === id);
  if (!player) return;

  const raw = window.prompt(
    `Set ${player.name}'s total score:`,
    String(currentScore)
  );
  if (raw === null) return;

  const trimmed = String(raw).trim();
  if (trimmed === "" || Number.isNaN(Number(trimmed))) {
    showToast("Enter a valid number");
    return;
  }

  const score = Number(trimmed);
  pendingByPlayer.set(id, {
    points: trimmed,
    optimisticScore: score,
  });
  render();
  setSyncStatus("Saving…", "pending");

  try {
    const result = await api(
      `/api/players/${encodeURIComponent(id)}/score`,
      {
        method: "POST",
        body: JSON.stringify({ score: trimmed }),
      }
    );

    if (result.state && result.state.version > version) {
      ingestState(result.state);
    }

    pendingByPlayer.delete(id);
    render();
    setSyncStatus("Live · synced");
  } catch (err) {
    pendingByPlayer.delete(id);
    render();
    showToast(err.message || "Save failed — try again");
    setSyncStatus("Sync error", "error");
  }
}

function resetScores() {
  if (!players.length || pendingByPlayer.size > 0) return;
  confirmDialog({
    title: "Reset all scores?",
    message: "Everyone goes back to zero. Players stay.",
    confirmLabel: "Reset",
  }).then((ok) => {
    if (!ok) return;
    sfx.slide();
    mutate(() => api("/api/reset", { method: "POST", body: "{}" }));
  });
}

function newGame() {
  if (!players.length || pendingByPlayer.size > 0) return;
  confirmDialog({
    title: "Start a new game?",
    message: "This removes every player and their scores.",
    confirmLabel: "New game",
  }).then((ok) => {
    if (!ok) return;
    sfx.slide();
    mutate(() => api("/api/new-game", { method: "POST", body: "{}" }));
  });
}

/* ---------- Taunts: send a funny emoji + sound to someone's phone ---------- */

/** key → emoji, short label, and the sound it plays on their phone. */
const TAUNTS = {
  honk: { emoji: "🤡", label: "Honk", play: () => sfx.honk() },
  fart: { emoji: "💨", label: "Toot", play: () => sfx.fart() },
  quack: { emoji: "🦆", label: "Quack", play: () => sfx.quack() },
  chicken: { emoji: "🐔", label: "Chicken", play: () => sfx.chicken() },
  moo: { emoji: "🐄", label: "Moo", play: () => sfx.moo() },
  rimshot: { emoji: "🥁", label: "Ba-dum-tss", play: () => sfx.rimshot() },
  trombone: { emoji: "🎺", label: "Sad trombone", play: () => sfx.trombone() },
  snore: { emoji: "😴", label: "Snore", play: () => sfx.snore() },
  crickets: { emoji: "🦗", label: "Crickets", play: () => sfx.crickets() },
  kiss: { emoji: "💋", label: "Mwah", play: () => sfx.kiss() },
  clap: { emoji: "👏", label: "Slow clap", play: () => sfx.slowClap() },
  boing: { emoji: "🤪", label: "Boing", play: () => sfx.boing() },
  airhorn: { emoji: "📢", label: "Air horn", play: () => sfx.airhorn() },
};
const TAUNT_TARGET_KEY = "flip7-taunt-target";
const TAUNT_LIMIT = 3;

/** Highest taunt id this phone has handled; null until first sync. */
let lastSeenTauntId = null;

function processTaunts(list) {
  const maxId = list.reduce((m, t) => Math.max(m, t.id), 0);
  if (lastSeenTauntId === null) {
    lastSeenTauntId = maxId; // don't replay old taunts to someone who just joined
    return;
  }
  const fresh = list.filter((t) => t.id > lastSeenTauntId).sort((a, b) => a.id - b.id);
  if (!fresh.length) return;
  lastSeenTauntId = maxId;
  fresh.forEach((t) => {
    if (me.playerId && t.to === me.playerId) {
      tauntQueue.push(t);
    } else if (t.from !== me.playerId) {
      // Everyone else at the table gets a little heads-up.
      const from = playerById(t.from);
      const to = playerById(t.to);
      showToast(`${from ? tag(from) : t.fromName} → ${to ? tag(to) : t.toName} ${t.emoji}`);
    }
  });
  showNextTaunt();
}

const tauntQueue = [];
let tauntShowing = false;

function showNextTaunt() {
  if (tauntShowing) return;
  const t = tauntQueue.shift();
  if (!t) return;
  tauntShowing = true;
  const def = TAUNTS[t.sound];
  const el = document.createElement("div");
  el.className = "taunt-pop";
  el.setAttribute("role", "status");
  el.innerHTML = `
    <div class="taunt-pop-emoji" aria-hidden="true">${escapeHtml(t.emoji)}</div>
    <div class="taunt-pop-body">
      <div class="taunt-pop-from">${escapeHtml(playerById(t.from) ? tag(playerById(t.from)) : t.fromName)}</div>
      <div class="taunt-pop-text">${escapeHtml(t.text || (def ? `sent you a ${def.label.toLowerCase()}` : "is taunting you"))}</div>
    </div>
  `;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => {
      el.remove();
      tauntShowing = false;
      showNextTaunt();
    }, 250);
  };
  el.addEventListener("click", dismiss);
  document.body.appendChild(el);
  emojiRain(t.emoji);
  (def ? def.play : sfx.boing)();
  if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 200]);
  setTimeout(dismiss, 4000);
}

/** A shower of the taunt's emoji across the screen. */
function emojiRain(emoji, count = 26) {
  const layer = document.createElement("div");
  layer.className = "emoji-rain";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) {
    const e = document.createElement("span");
    e.textContent = emoji;
    e.style.left = `${Math.random() * 100}%`;
    e.style.fontSize = `${22 + Math.random() * 26}px`;
    e.style.animationDelay = `${Math.random() * 0.8}s`;
    e.style.animationDuration = `${1.8 + Math.random() * 1.4}s`;
    e.style.setProperty("--spin", `${(Math.random() - 0.5) * 540}deg`);
    layer.appendChild(e);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 3600);
}

/** Ask the server how many taunts this phone has left this minute and show it. */
async function showTauntsLeft(overlay) {
  const el = overlay.querySelector(".taunt-left");
  let info;
  try {
    info = await fetch("/api/me", {
      cache: "no-store",
      headers: myToken ? { "X-Player-Token": myToken } : {},
    }).then((r) => r.json());
  } catch {
    return;
  }
  const deadline = Date.now() + (info.tauntResetIn || 0);
  const out = info.tauntsLeft === 0;
  overlay.querySelectorAll(".taunt-option").forEach((b) => (b.disabled = out));
  const tick = () => {
    if (!el.isConnected) return;
    if (!out) {
      el.textContent = `${"😈".repeat(info.tauntsLeft)}${"⚪".repeat(TAUNT_LIMIT - info.tauntsLeft)}  ${info.tauntsLeft} of ${TAUNT_LIMIT} left this minute`;
      return;
    }
    const secs = Math.ceil((deadline - Date.now()) / 1000);
    if (secs <= 0) {
      showTauntsLeft(overlay);
      return;
    }
    el.textContent = `Out of taunts. Next one in ${secs}s ⏳`;
    setTimeout(tick, 500);
  };
  el.classList.toggle("out", out);
  tick();
}

/** The floating 😈 button, always on screen for anyone who can taunt. */
function updateTauntFab() {
  let fab = document.getElementById("taunt-fab");
  const targets = players.filter((p) => p.id !== me.playerId);
  const show = (me.playerId || me.host) && targets.length > 0;
  if (!show) {
    fab?.remove();
    return;
  }
  if (!fab) {
    fab = document.createElement("button");
    fab.id = "taunt-fab";
    fab.type = "button";
    fab.className = "taunt-fab";
    fab.setAttribute("aria-label", "Send a taunt");
    fab.innerHTML = '<span aria-hidden="true">😈</span>';
    fab.addEventListener("click", () => openTauntPicker());
    document.body.appendChild(fab);
  }
}

function openTauntPicker() {
  if (document.querySelector(".taunt-overlay")) return;
  const targets = players.filter((p) => p.id !== me.playerId);
  if (!targets.length) return;
  let selected = storageGet(TAUNT_TARGET_KEY);
  if (!targets.some((p) => p.id === selected)) selected = targets[0].id;

  const overlay = document.createElement("div");
  overlay.className = "taunt-overlay";
  overlay.innerHTML = `
    <div class="taunt-sheet" role="dialog" aria-modal="true" aria-labelledby="taunt-title">
      <p id="taunt-title" class="taunt-title">Taunt someone 😈</p>
      <p class="taunt-sub">Pick who, then tap a sound. It plays on their phone.</p>
      <p class="taunt-left" aria-live="polite">&nbsp;</p>
      <div class="taunt-targets" role="radiogroup" aria-label="Who to taunt">
        ${targets
          .map(
            (p) => `<button type="button" class="taunt-target" role="radio" data-id="${p.id}" aria-checked="${p.id === selected}">${escapeHtml(tag(p))}</button>`
          )
          .join("")}
      </div>
      <div class="taunt-grid">
        ${Object.entries(TAUNTS)
          .map(
            ([key, t]) => `<button type="button" class="taunt-option" data-key="${key}">
            <span class="taunt-option-emoji" aria-hidden="true">${t.emoji}</span>
            <span class="taunt-option-text">${escapeHtml(t.label)}</span>
          </button>`
          )
          .join("")}
      </div>
      <button type="button" class="btn btn-ghost taunt-cancel">Close</button>
    </div>
  `;
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".taunt-cancel").addEventListener("click", close);
  overlay.querySelectorAll(".taunt-target").forEach((btn) => {
    btn.addEventListener("click", () => {
      selected = btn.dataset.id;
      storageSet(TAUNT_TARGET_KEY, selected);
      overlay.querySelectorAll(".taunt-target").forEach((b) =>
        b.setAttribute("aria-checked", String(b.dataset.id === selected))
      );
    });
  });
  overlay.querySelectorAll(".taunt-option").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const target = players.find((p) => p.id === selected);
      if (!target) return;
      close();
      try {
        await api(`/api/players/${encodeURIComponent(target.id)}/taunt`, {
          method: "POST",
          body: JSON.stringify({ sound: key }),
        });
        showToast(`${TAUNTS[key].emoji} sent to ${target.name}`);
      } catch (err) {
        showToast(err.message || "Couldn't send that");
      }
    });
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  showTauntsLeft(overlay);
  overlay.querySelector('.taunt-target[aria-checked="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
}

/* ---------- Join screen ---------- */

async function loadMe() {
  try {
    const res = await fetch("/api/me", {
      cache: "no-store",
      headers: myToken ? { "X-Player-Token": myToken } : {},
    }).then((r) => r.json());
    me = { host: Boolean(res.host), playerId: res.playerId || null, loaded: true };
    if (!me.playerId && myToken) {
      myToken = "";
      storageSet(TOKEN_KEY, null);
    }
  } catch {
    return;
  }
  updateWhoAmI();
  render();
  if (!me.playerId && !(me.host && storageGet(HOST_SKIP_KEY) === "1")) {
    openJoinScreen();
  }
}

/** If the host removed, unlocked, or wiped my player, ask for a name again. */
function checkStillJoined() {
  if (!me.loaded || !me.playerId) return;
  const mine = players.find((p) => p.id === me.playerId);
  if (mine && mine.claimed) return;
  me.playerId = null;
  myToken = "";
  storageSet(TOKEN_KEY, null);
  updateWhoAmI();
  if (!me.host || storageGet(HOST_SKIP_KEY) !== "1") {
    setTimeout(() => openJoinScreen(mine ? "The host reset names. Type your name again to keep your score." : "You're not in this game anymore. Join again to play."), 0);
  }
}

function updateWhoAmI() {
  const el = document.getElementById("who-am-i");
  if (!el) return;
  const mine = players.find((p) => p.id === me.playerId);
  const parts = [];
  if (mine) parts.push(`Playing as <strong>${escapeHtml(tag(mine))}</strong>`);
  if (me.host) parts.push('<span class="host-tag">Host</span>');
  if (me.host && !mine) parts.push('<button type="button" class="link-btn" id="host-join-btn">Join as a player</button>');
  el.innerHTML = parts.join(" ");
  el.classList.toggle("hidden", parts.length === 0);
  document.getElementById("host-join-btn")?.addEventListener("click", () => openJoinScreen());
}

let joinAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];

function openAvatarPicker() {
  const mine = playerById(me.playerId);
  if (!mine || document.querySelector(".avatar-overlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "taunt-overlay avatar-overlay";
  overlay.innerHTML = `
    <div class="taunt-sheet" role="dialog" aria-modal="true" aria-labelledby="avatar-title">
      <p id="avatar-title" class="taunt-title">Pick your avatar</p>
      <p class="taunt-sub">Shows on your card, in taunts and on the score race.</p>
      ${avatarGrid(mine.avatar)}
      <button type="button" class="btn btn-ghost taunt-cancel">Close</button>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".taunt-cancel").addEventListener("click", close);
  wireAvatarGrid(overlay, async (a) => {
    close();
    const done = await mutate(() =>
      api(`/api/players/${encodeURIComponent(mine.id)}/avatar`, {
        method: "POST",
        body: JSON.stringify({ avatar: a }),
      })
    );
    if (done) sfx.pop();
  });
  document.body.appendChild(overlay);
}

function openJoinScreen(notice = "") {
  if (document.querySelector(".join-overlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "join-overlay";
  overlay.innerHTML = `
    <form class="join-modal" role="dialog" aria-modal="true" aria-labelledby="join-title">
      <div class="join-cards" aria-hidden="true"><span>7</span><span>3</span><span>12</span></div>
      <p id="join-title" class="join-title">Who's playing?</p>
      <p class="join-sub">${notice ? escapeHtml(notice) : "Type your name. Only this phone can change your score."}</p>
      <input class="join-input" type="text" maxlength="24" autocomplete="off" autocapitalize="words" enterkeyhint="go" placeholder="Your name" aria-label="Your name" />
      <p class="join-pick">Pick your avatar</p>
      ${avatarGrid(joinAvatar)}
      <p class="join-error hidden" role="alert"></p>
      <button type="submit" class="btn btn-primary join-go">Let's play</button>
      ${me.host ? '<button type="button" class="btn btn-ghost join-skip">Just host — I\'m not playing</button>' : ""}
    </form>
  `;
  const form = overlay.querySelector("form");
  const input = overlay.querySelector(".join-input");
  const errorEl = overlay.querySelector(".join-error");
  const goBtn = overlay.querySelector(".join-go");
  wireAvatarGrid(overlay, (a) => {
    joinAvatar = a;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    goBtn.disabled = true;
    errorEl.classList.add("hidden");
    try {
      const result = await api("/api/join-as", {
        method: "POST",
        body: JSON.stringify({ name: input.value, avatar: joinAvatar }),
      });
      myToken = result.token;
      storageSet(TOKEN_KEY, myToken);
      me.playerId = result.playerId;
      if (result.state) {
        players = result.state.players;
        version = result.state.version;
        gameLog = Array.isArray(result.state.log) ? result.state.log : [];
      }
      overlay.remove();
      updateWhoAmI();
      render();
      sfx.pop();
    } catch (err) {
      errorEl.textContent = err.message || "Couldn't join — try again";
      errorEl.classList.remove("hidden");
      goBtn.disabled = false;
    }
  });
  overlay.querySelector(".join-skip")?.addEventListener("click", () => {
    storageSet(HOST_SKIP_KEY, "1");
    overlay.remove();
  });
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);
}

async function unlockPlayer(id) {
  const player = players.find((p) => p.id === id);
  if (!player) return;
  const ok = await confirmDialog({
    title: `Unlock ${player.name}?`,
    message: `Their score stays. The next phone that joins as "${player.name}" takes over their spot. Use this if they switched phones or browsers.`,
    confirmLabel: "Unlock",
    confirmClass: "btn-primary",
  });
  if (!ok) return;
  const done = await mutate(() =>
    api(`/api/players/${encodeURIComponent(id)}/unlock`, { method: "POST", body: "{}" })
  );
  if (done) showToast(`${player.name} can rejoin now`);
}

async function resetNames() {
  if (!me.host || !players.length) return;
  const ok = await confirmDialog({
    title: "Reset all names?",
    message: "Scores stay, but every phone has to type its name again. Whoever types a name first gets that spot.",
    confirmLabel: "Reset names",
  });
  if (!ok) return;
  const done = await mutate(() => api("/api/unlock-all", { method: "POST", body: "{}" }));
  if (done) showToast("Names reset — phones will ask who's playing");
}
resetNamesBtn.addEventListener("click", resetNames);

async function clearUnusedNames() {
  const unused = players.filter((p) => !p.claimed);
  if (!me.host || !unused.length) return;
  const ok = await confirmDialog({
    title: `Remove ${unused.length} unused name${unused.length === 1 ? "" : "s"}?`,
    message: `${unused.map((p) => p.name).join(", ")}. Nobody has joined as ${unused.length === 1 ? "this name" : "these names"}. Their scores go too.`,
    confirmLabel: "Remove",
  });
  if (!ok) return;
  const done = await mutate(() => api("/api/clear-unclaimed", { method: "POST", body: "{}" }));
  if (done) {
    sfx.flush();
    showToast("Old names cleared");
  }
}
clearUnusedBtn.addEventListener("click", clearUnusedNames);

addPlayerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleAddPlayer();
});

addPlayerBtn.addEventListener("click", (e) => {
  e.preventDefault();
  handleAddPlayer();
});

resetScoresBtn.addEventListener("click", resetScores);
newGameBtn.addEventListener("click", newGame);
document.getElementById("awards-btn").addEventListener("click", () => openAwards(false));

toneSliderEl.addEventListener("input", () => applyToneFromSlider(true));
shareJoinBtn.addEventListener("click", shareJoinLink);
copyJoinBtn.addEventListener("click", copyJoinLink);
loadSavedTone();
setSound(soundOn, false);
document.getElementById("sound-toggle")?.addEventListener("click", () => setSound(!soundOn));
loadJoinInfo();

syncState();
setInterval(syncState, SYNC_INTERVAL_MS);
