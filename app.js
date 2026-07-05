const WIN_SCORE = 200;
const SYNC_INTERVAL_MS = 1500;

/** @type {{ id: string, name: string, score: number }[]} */
let players = [];
let version = 0;

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

let toastTimer = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
  }, 2600);
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

  sortedPlayers.forEach((player) => {
    const pending = pendingByPlayer.get(player.id);
    const displayScore = pending ? pending.optimisticScore : player.score;
    const isSaving = Boolean(pending);
    const isWinner = displayScore >= WIN_SCORE;

    const card = document.createElement("article");
    card.className =
      "player-card" +
      (isWinner ? " winner" : "") +
      (isSaving ? " saving" : "");
    card.dataset.playerId = player.id;

    card.innerHTML = `
      <div class="player-card-header">
        <span class="player-name">${escapeHtml(player.name)}</span>
        ${isWinner && !isSaving ? '<span class="winner-badge">200+</span>' : ""}
        <button type="button" class="btn btn-icon remove-player" aria-label="Remove ${escapeHtml(player.name)}" ${isSaving ? "disabled" : ""}>×</button>
      </div>
      <div class="player-score-row">
        <div class="player-score-wrap">
          <span class="player-score">${displayScore}</span>
          <span class="player-score-label">total</span>
        </div>
        ${
          isSaving
            ? `<span class="save-status"><span class="save-spinner" aria-hidden="true"></span>Saving…</span>`
            : ""
        }
      </div>
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
      </div>
    `;

    if (!isSaving) {
      card.querySelector(".remove-player").addEventListener("click", () => {
        removePlayer(player.id);
      });

      const pointsInput = card.querySelector(".points-input");
      const addPointsBtn = card.querySelector(".add-points-btn");

      const submitPoints = () => {
        addPoints(player.id, pointsInput.value);
      };

      addPointsBtn.addEventListener("click", submitPoints);
      pointsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitPoints();
        }
      });
    }

    playerListEl.appendChild(card);
  });

  restorePendingPoints(pendingInputs);
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

function applyState(state) {
  if (state.version <= version) return false;
  players = state.players;
  version = state.version;
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
      players = result.state.players;
      version = result.state.version;
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
      playerNameInput.value = "";
      playerNameInput.blur();
    }
  });
}

function removePlayer(id) {
  if (pendingByPlayer.has(id)) return;
  mutate(() =>
    api(`/api/players/${encodeURIComponent(id)}`, { method: "DELETE" })
  );
}

async function addPoints(id, rawValue) {
  const trimmed = String(rawValue).trim();
  if (trimmed === "" || Number.isNaN(Number(trimmed))) {
    showToast("Enter a valid number");
    return;
  }

  const player = players.find((p) => p.id === id);
  if (!player || pendingByPlayer.has(id)) return;

  const points = Number(trimmed);
  pendingByPlayer.set(id, {
    points: trimmed,
    optimisticScore: player.score + points,
  });
  render();
  setSyncStatus("Saving…", "pending");

  try {
    const result = await api(
      `/api/players/${encodeURIComponent(id)}/points`,
      {
        method: "POST",
        body: JSON.stringify({ points: trimmed }),
      }
    );

    if (result.state && result.state.version > version) {
      players = result.state.players;
      version = result.state.version;
    }

    pendingByPlayer.delete(id);
    render();
    setSyncStatus("Live · synced");
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

function resetScores() {
  if (!players.length || pendingByPlayer.size > 0) return;
  if (!confirm("Reset all scores to zero?")) return;
  mutate(() => api("/api/reset", { method: "POST", body: "{}" }));
}

function newGame() {
  if (!players.length || pendingByPlayer.size > 0) return;
  if (!confirm("Remove all players and start a new game?")) return;
  mutate(() => api("/api/new-game", { method: "POST", body: "{}" }));
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

syncState();
setInterval(syncState, SYNC_INTERVAL_MS);
