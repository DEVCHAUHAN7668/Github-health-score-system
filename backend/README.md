# GitHub Repository Health Analyzer — Phases 1–4

An Express backend that validates a public GitHub repository URL, retrieves repository information from the official GitHub REST API, and calculates an explainable heuristic health score. The React frontend saves successful report snapshots in the browser's localStorage.

## Requirements and setup

- Node.js 18 or newer
- npm

From this `backend` directory:

```sh
npm install
Copy-Item .env.example .env
npm start
```

The copy command is for PowerShell. On macOS/Linux use `cp .env.example .env`. A backend `.env` is optional unless configuring a GitHub token. GitHub tokens are optional for public repositories and must remain private.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5000` | Express listening port |
| `GITHUB_TOKEN` | empty | Optional token for authenticated GitHub API rate limits |
| `GITHUB_TIMEOUT_MS` | `15000` | Per-request timeout, bounded to 1000–30000 ms |
| `GITHUB_RETRIES` | `1` | Bounded retry count (maximum 1) for transient network/5xx errors |
| `GITHUB_CACHE_TTL_MS` | `60000` | In-memory cache lifetime for successful GitHub GET responses (bounded to 0–300000 ms) |
| `HEALTH_STALE_AFTER_DAYS` | `730` | Push-age threshold used by the maintenance heuristic (bounded to 1–3650 days) |
| `HEALTH_MEANINGFUL_README_CHARACTERS` | `200` | README size threshold for the documentation heuristic (bounded to 1–10000 characters) |

Do not commit `.env` or put a GitHub token in frontend code. `.env.example` contains placeholders only.

## Run and test

```sh
npm start
npm test
```

The test suite uses mocked GitHub responses and does not need internet access. For development with automatic restart, run `npm run dev`.

## Run the full application locally

Start the backend and frontend in separate PowerShell terminals from the project root:

**Terminal 1 — backend**

```powershell
cd backend
npm start
```

**Terminal 2 — frontend**

```powershell
cd frontend
npm install
npm run dev
```

The backend listens on `127.0.0.1:5000` by default. The Vite `/api` proxy targets that address. If you set a custom backend `PORT`, set the same port as `VITE_BACKEND_PORT` in `frontend/.env` (or the frontend process environment). `GITHUB_TOKEN` is optional for public repositories; without it, GitHub's unauthenticated rate limit applies. No MongoDB service is used.

## API

### `GET /api/health`

Returns HTTP 200 with a small backend status object.

### `POST /api/repository/analyze`

Request JSON:

```json
{ "url": "https://github.com/facebook/react" }
```

The response retains the `{ "success": true, "data": ... }` envelope. `data` contains collected repository data, `health`, and `metadata`. The backend does not persist analysis history; after a successful response, the frontend stores a report snapshot in browser localStorage. GitHub credentials remain on the backend.

Example request with curl:

```sh
curl -X POST http://localhost:5000/api/repository/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/facebook/react"}'
```

In Postman, choose **POST**, enter `http://localhost:5000/api/repository/analyze`, select **Body → raw → JSON**, and send the request body above.

Analysis History is browser-local and is not provided by a backend history endpoint. The page can open a saved report, delete individual entries, or clear all entries. History is limited to the current browser's localStorage and is not shared across browsers or devices.

## Phase 2 scoring methodology

The deterministic score is the sum of five weighted categories (maximum exactly 100):

| Category | Maximum | Evidence |
| --- | ---: | --- |
| Documentation Quality | 25 | README presence/content (15), repository description (5), and license (5). Confirmed missing resources earn zero for that criterion; failed retrieval is marked unavailable. |
| Maintenance | 25 | Latest push date; an old date is a heuristic, not proof of poor quality. High stars/forks are recorded as a stability signal. |
| Repository Organization | 20 | Count/variety of root entries, directories, and common project configuration; no specific framework layout is required. |
| Issue Management | 15 | Up to 100 issues sorted by recent update, excluding pull requests. Points combine sample presence (5), closed share (5), and updates within 180 days (5). An empty issue sample receives a neutral 12/15 because no triage history can be assessed. A high open count alone does not lower the score. |
| Development Activity | 15 | Up to five commits. Sample size contributes up to 8 points; latest committer date contributes up to 7 based on recency. One recent commit cannot earn the category maximum. |

Each category also returns a `calculation` list with its criteria, possible and earned points, evidence, and scored/confirmed-missing/unavailable status. Confirmed missing data may support a recommendation; failed retrieval is marked unavailable and does not generate a missing-resource recommendation. The overall score remains on a 0–100 scale and is marked `partial` when optional evidence could not be retrieved. Status labels: 80–100 Healthy, 60–79 Moderate, 40–59 Needs Improvement, 0–39 Poor. These labels are heuristic and are not an official GitHub rating.

Recommendations contain the observed issue, why it matters, suggested action, priority, and supporting evidence. Identical input data and clock/threshold settings produce the same score. Thresholds for stale activity (730 days) and meaningful README content (200 non-whitespace characters) can be configured through the listed environment variables or scoring service options.

## Known limitations

- GitHub API rate limits apply. Configure `GITHUB_TOKEN` in `backend/.env` for the authenticated quota; the backend loads this file even when started from the project root. Rate-limit errors include GitHub's reset/retry details and are not saved as successful history.
- Successful GitHub GET responses are cached in memory for up to one minute by default, and concurrent analysis requests for the same repository share their in-flight requests. Restarting the backend clears this cache and cooldown state.
- Issue metrics reflect only the latest-updated issue sample (up to 100) and should not be interpreted as repository-wide open/closed totals. GitHub's repository-level `open_issues_count` can include pull requests and is not used as an issue-only count in scoring.
- The score is a transparent heuristic; popularity is only a weak stability signal, and repository context still matters.
- When optional endpoints fail, the response is partial and names unavailable evidence rather than estimating it.
