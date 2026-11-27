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

/** @type {Map<string, { points: string, optimisticScore: number }>} */
const pendingByPlayer = new Map();

const playerListEl = document.getElementById("player-list");
const emptyStateEl = document.getElementById("empty-state");
const addPlayerForm = document.getElementById("add-player-form");
const playerNameInput = document.getElementById("player-name-input");
const addPlayerBtn = document.getElementById("add-player-btn");
const resetScoresBtn = document.getElementById("reset-scores-btn");
const newGameBtn = document.getElementById("new-game-btn");
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

    const card = document.createElement("article");
    card.className =
      "player-card" +
      (isWinner ? " winner" : "") +
      (isSaving ? " saving" : "") +
      (isFirstPlace ? " first-place" : "") +
      (isLastPlace ? " last-place" : "");
    card.dataset.playerId = player.id;
    const bustedAt = bustedUntil.get(player.id);
    if (bustedAt && bustedAt > Date.now()) card.classList.add("busted");

    card.innerHTML = `
      <div class="player-card-header">
        <span class="player-name">${isFirstPlace ? '<span class="crown" aria-hidden="true">👑</span>' : ""}${escapeHtml(player.name)}${isLastPlace ? '<span class="clown" aria-hidden="true">🤡</span>' : ""}</span>
        ${isFirstPlace && !isSaving ? '<span class="first-place-badge">1st</span>' : ""}
        ${isLastPlace && !isSaving ? '<span class="last-place-badge">Clown 🤡</span>' : ""}
        ${isWinner && !isSaving ? '<span class="winner-badge">200+</span>' : ""}
        <button type="button" class="btn btn-icon remove-player" aria-label="Remove ${escapeHtml(player.name)}" ${isSaving ? "disabled" : ""}>×</button>
      </div>
      ${
        isLastPlace && !isSaving
          ? `<p class="last-place-taunt">${escapeHtml(taunt)}</p>`
          : ""
      }
      <div class="player-score-row">
        <div class="player-score-wrap">
          <span class="player-score">${displayScore}</span>
          <button type="button" class="btn btn-icon edit-score" aria-label="Edit score for ${escapeHtml(player.name)}" ${isSaving ? "disabled" : ""}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>
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
        <button type="button" class="btn-undo" aria-label="Undo ${escapeHtml(player.name)}'s last entry" ${isSaving ? "disabled" : ""}>↶ Undo</button>
      </div>`
          : ""
      }
      <div class="add-points-row">
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
      </div>
    `;

    if (!isSaving) {
      card.querySelector(".remove-player").addEventListener("click", () => {
        removePlayer(player.id);
      });

      card.querySelector(".edit-score").addEventListener("click", () => {
        editScore(player.id, displayScore);
      });

      const pointsInput = card.querySelector(".points-input");
      const addPointsBtn = card.querySelector(".add-points-btn");

      const submitPoints = () => {
        addPoints(player.id, pointsInput.value);
      };

      addPointsBtn.addEventListener("click", submitPoints);
      card.querySelector(".flip7-btn").addEventListener("click", () => {
        addPoints(player.id, pointsInput.value, true);
      });
      card.querySelector(".btn-undo")?.addEventListener("click", () => {
        undoLast(player.id);
      });
      pointsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitPoints();
        }
      });
    }

    playerListEl.appendChild(card);
  });

  updateRoastBanner(sortedPlayers);

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
  win: (e) => ({ icon: "🏆", title: `${e.name} HITS ${WIN_SCORE}!`, text: `Final score: ${e.score}`, tone: "party", confetti: true }),
  comeback: (e) => ({ icon: "🚀", title: "THE COMEBACK", text: `${e.name} went from last to first in one round`, tone: "party", confetti: true }),
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
  const order = ["win", "comeback", "flip7", "collapse", "big", "bust"];
  fresh.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  fresh.forEach((e) => {
    if (e.type === "bust") celebrateBust(e.playerId);
    if (MOMENTS[e.type]) momentQueue.push(e);
  });
  if (fresh.some((e) => e.type === "win")) momentQueue.push({ type: "__awards" });
  showNextMoment();
}

function showNextMoment() {
  if (momentShowing) return;
  const e = momentQueue.shift();
  if (!e) return;
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
  const name = (id) => players.find((p) => p.id === id)?.name ?? "?";

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
  if (champion) awards.push({ icon: "🏆", title: "Champion", who: champion.name, detail: `${champion.score} points` });

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
      <p id="awards-title" class="awards-title">${auto ? "🏁 Game over!" : "🏆 Awards so far"}</p>
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
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
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
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function ingestState(state) {
  players = state.players;
  version = state.version;
  gameLog = Array.isArray(state.log) ? state.log : [];
  processEvents(Array.isArray(state.events) ? state.events : []);
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
  const ok = await confirmDialog({
    title: `Remove ${player.name}?`,
    message: `Their ${player.score} point${player.score === 1 ? "" : "s"} go with them. This can't be undone.`,
    confirmLabel: "Remove",
    cancelLabel: "Keep them",
  });
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
