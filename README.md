# Flip 7 Score Tracker

A simple, mobile-friendly score tracker for the [Flip 7](https://theop.games/products/flip-7) card game. Run it on one device and everyone on the same WiFi can view and update scores in real time.

## Features

- Shared live scores — all devices see the same totals
- Add players and points each round (including 0 for a bust)
- Leaderboard sorted by highest score
- Per-player saving indicator on slow connections
- Scores persist while the server is running

## Quick start

```bash
git clone https://github.com/Caleb-Hurst/flip7-score.git
cd flip7-score
npm start
```

The server runs on port **3456**.

## Use on your phone

1. Start the server on your Mac or PC.
2. Find your computer's local IP address:
   - **macOS:** `ipconfig getifaddr en0`
   - **Windows:** `ipconfig` (look for IPv4 Address)
3. On your phone (same WiFi), open:

   ```
   http://<your-computer-ip>:3456
   ```

   Example: `http://192.168.0.34:3456`

4. Bookmark the page for easy access during game night.

> **Note:** `localhost` only works on the device running the server. Other devices must use the local IP address.

## How scoring works

- Enter a player's round score and tap **Add** — it adds to their running total.
- No round tracking; just names and cumulative scores.
- Players at **200+** points get a highlight (Flip 7 win condition).
- **Reset Scores** zeros everyone out but keeps players.
- **New Game** removes all players and starts fresh.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later
- No npm dependencies — uses Node built-ins only

## Project structure

| File | Purpose |
|------|---------|
| `server.js` | HTTP server and shared game state API |
| `app.js` | Client UI and sync logic |
| `index.html` | App shell |
| `styles.css` | Mobile-first styles |
| `game-state.json` | Local score data (created at runtime, gitignored) |

## License

MIT
