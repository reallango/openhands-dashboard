# OpenHands dashboard

A small self-hosted web app that shows what your [OpenHands Cloud](https://app.all-hands.dev) agents are doing,
and gives Claude (or any script) a cheap way to wait for them instead of polling OpenHands itself.

- **One place for the API key.** The OpenHands key lives only in the container. The browser and API callers never see it.
- **Background sync.** Running conversations are polled every 20 s, the conversation list every minute (every 5 minutes
  when nothing runs). Conversations, steps and status changes are kept in SQLite in a volume.
- **Web UI for the LAN.** A list of conversations (status, repository and branch, PR, last activity) and a live step view
  (messages, commands, file edits, output). Switching between conversations is one click. Alerts appear in the page
  with a sound, plus browser notifications where the browser allows them (see [Notifications](#notifications)).
- **MCP server for Claude.** The same operations as MCP tools at `/mcp` (see [MCP server](#mcp-server)).
- **API for Claude.** A one-line-per-task summary, a long-poll that returns when a task finishes, errors, gets stuck or
  opens a PR, and the step list of one conversation.
- **Access control.** Web login (scrypt-hashed admin password from the environment), a separate bearer token for the API,
  CSRF tokens plus same-origin checks on browser requests that change something, and login throttling.

No npm dependencies: it uses Node's built-in `http`, `crypto` and `node:sqlite`.

## Setup

You need three values:

| Variable | What it is |
| --- | --- |
| `OPENHANDS_API_KEY` | Your OpenHands Cloud API key (app.all-hands.dev > Settings > API keys). |
| `ADMIN_PASSWORD_HASH` | Hash of the web login password (user name `admin`, or set `ADMIN_USER`). |
| `API_TOKEN` | A random token, at least 24 characters, for Claude's API calls. |

Create the password hash and a token with Node 22.13 or newer:

```sh
node scripts/hash-password.js --token
```

It asks for the password (hidden) and prints `ADMIN_PASSWORD_HASH=...` and `API_TOKEN=...`. The hash contains no `$`,
so it can be pasted into `.env` or a compose environment as is. Without Node locally, build the image and run the same
script inside it: `docker run --rm -it openhands-dashboard:local node scripts/hash-password.js --token`.

Each secret can also come from a file, for example a Docker secret: `OPENHANDS_API_KEY_FILE`, `ADMIN_PASSWORD_HASH_FILE`,
`API_TOKEN_FILE`.

Other settings are listed in [.env.example](.env.example).

## Deploy

### As a stack in Bosun

1. In Bosun, open the Docker host and add a stack from **Git**:
   - repository `https://github.com/reallango/openhands-dashboard`, branch `main`, compose file `compose.yaml`;
   - environment: the lines from `.env.example` with your values filled in (at least `OPENHANDS_API_KEY`,
     `ADMIN_PASSWORD_HASH`, `API_TOKEN`; optionally `HOST_PORT`, `DEFAULT_REPO`, `DEFAULT_BRANCH`).
2. Deploy. Bosun builds the image from the repository and starts it. Data stays in the `data` volume across updates.
3. Open `http://<host>:3077` and sign in.

To update, use the stack's **Update from source and redeploy** action: Bosun fetches the branch, rebuilds the image and
restarts it with the stored environment. (Deploying the stack again does not rebuild an image that already exists.)

### With Docker Compose

```sh
git clone https://github.com/reallango/openhands-dashboard && cd openhands-dashboard
cp .env.example .env   # fill in the values
docker compose up -d --build
```

### Without Docker

```sh
OPENHANDS_API_KEY=... ADMIN_PASSWORD_HASH=... API_TOKEN=... DATA_DIR=./data node src/server.js
```

## MCP server

The dashboard is also an MCP server (Streamable HTTP) at `http://<host>:3077/mcp`, so Claude can use it as tools
instead of writing HTTP calls. It takes the same `API_TOKEN` as the HTTP API, as a bearer header.

| Tool | What it does |
| --- | --- |
| `list_tasks` | One line per active or recent task (`all: true` for every conversation). Same as `/api/summary`. |
| `wait_for_tasks` | Blocks until one of `ids` finishes, errors, gets stuck or stalled, waits for input, or opens a PR, or until `timeout_sec` (default 600). Same as `/api/wait`, including `since`. |
| `get_steps` | The steps of one conversation (`id`, optional `since`, `limit` default 50, `full`). |
| `start_task` | Starts a conversation (`brief`, optional `repo`, `branch`, `title`). Spends credits. |

Add it to Claude Code for your user (all projects):

```sh
claude mcp add --transport http --scope user openhands http://192.168.1.161:3077/mcp --header "Authorization: Bearer <API_TOKEN>"
```

Or put the token in an environment variable and reference it from `.mcp.json` or `~/.claude.json`
(`${VAR}` is expanded in headers):

```json
{
  "mcpServers": {
    "openhands": {
      "type": "http",
      "url": "http://192.168.1.161:3077/mcp",
      "headers": { "Authorization": "Bearer ${OPENHANDS_DASHBOARD_TOKEN}" }
    }
  }
}
```

**Long waits.** Claude Code aborts an HTTP tool call that sends nothing for 5 minutes. When the client asks for
progress (it sends a progress token and accepts an event stream), `wait_for_tasks` streams a progress notification
every 25 seconds and can wait the full `timeout_sec`. Otherwise it waits at most 280 seconds; the reply then says so,
and the next call passes the returned `cursor` as `since`.

The endpoint answers with plain JSON (no event stream) and keeps no sessions. It refuses requests without the token,
cross-origin browser requests, and anything but POST.

## API for Claude

Every call needs `Authorization: Bearer <API_TOKEN>`. Replies are short plain text by default; add `format=json` for JSON.
IDs can be a conversation id, a start-task id (from `/api/start`), or the first 8 or more characters of either.

### `GET /api/summary`

One line per active task, plus finished or failed tasks from the last 24 hours (`RECENT_HOURS`). `?all=1` lists everything.

```
50cbebe492564ea7899d24a87d57ff53 running 8s reallango/Bosun@dev "Widgets: looks, sparklines" | $ npx vitest run
5ecf4ec8518241aba523f615a049e23b finished 19m reallango/Bosun@dev PR#47 "Docker: one copy of the rebuild logic"
cursor=12
```

Statuses: `setting up`, `running`, `waiting` (the agent waits for input or confirmation), `stalled` (running but no
activity for 20 minutes, `STALLED_MINUTES`), `stuck`, `error`, `finished`, `paused` (sandbox paused, nothing running).

### `GET /api/wait?ids=<id>,<id>&timeout=600[&since=<cursor>]`

Long-poll. It returns as soon as one of the listed tasks finishes, errors, gets stuck or stalled, starts waiting for input,
or opens a PR; otherwise after `timeout` seconds (max 1800). Leave `ids` empty to wait for any task.

```
changed: 50cbebe492564ea7899d24a87d57ff53 running -> finished "Widgets: looks, sparklines"
cursor=13
50cbebe492564ea7899d24a87d57ff53 finished 0s reallango/Bosun@dev PR#48 "Widgets: looks, sparklines"
```

Without `since`, a listed task that is already finished (or in another alert state) answers at once, so a wait never
hangs on a task that is already done. To keep waiting for the other tasks, pass the `cursor` from the previous reply as
`since`: then only changes after it count. A reply starting with `timeout` means nothing changed.

### `GET /api/conversations/<id>/events[?since=<cursor>][&limit=200][&full=1]`

The conversation's steps, one per line with the first 300 characters of the output (`full=1` for everything). Without
`since` it returns the latest `limit` steps; with `since` only newer ones. Use it when something looks wrong.

### `POST /api/start`

Starts a conversation (this spends OpenHands credits). JSON body:
`{ "repo": "owner/name", "branch": "dev", "title": "...", "brief": "..." }`. `repo` and `branch` default to
`DEFAULT_REPO` and `DEFAULT_BRANCH`. Returns `{ "start_task_id": "...", "status": "WORKING", "conversation_id": null }`;
pass the `start_task_id` to `/api/wait` right away.

### Example (PowerShell)

```powershell
$h = @{ Authorization = "Bearer $env:OPENHANDS_DASHBOARD_TOKEN" }
Invoke-RestMethod "$env:OPENHANDS_DASHBOARD_URL/api/summary" -Headers $h
Invoke-RestMethod "$env:OPENHANDS_DASHBOARD_URL/api/wait?ids=50cbebe4&timeout=900" -Headers $h -TimeoutSec 960
```

## Notifications

Browsers only allow notifications on HTTPS pages (or `localhost`). On plain `http://<lan-ip>:3077` the page still shows
alerts as banners with a sound and a count in the tab title. For real notifications, put the dashboard behind an HTTPS
reverse proxy and set `COOKIE_SECURE=true`.

## Security notes

- The OpenHands key is read from the environment or a file and sent only to `OPENHANDS_API_BASE`. It is never logged or
  returned by any endpoint. Raw OpenHands events are never stored either, because some of them carry the agent's LLM
  key: only short summaries of steps are kept.
- Sessions: a random cookie (`HttpOnly`, `SameSite=Strict`, `Secure` when `COOKIE_SECURE=true`). The database keeps only
  its SHA-256. Requests that change something from the browser need the session's CSRF token and a same-origin `Origin`.
- The API token only works for `/api/*`, and is compared in constant time.
- After 5 failed logins from an address, further attempts wait longer and longer (up to 15 minutes).
- The container runs as the `node` user with a read-only root file system and no Linux capabilities.
- Agent output is shown with `textContent` only, and a strict Content Security Policy blocks inline scripts.
- It is meant for a trusted LAN. Do not expose it to the internet without HTTPS in front of it.

## License

MIT
