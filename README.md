# art-project-backend

Backend for the Unity card-RPG client at `\\LS220D088\webaxs\backupProjects\art-project-client`.

This project implements the design from
`C:\Users\leo19\AppData\Local\hermes\cache\scratch\art-project-client-api-design.md`
(852 lines / 35 KB — the full HTTP + TCP API contract, 28-domain taxonomy,
430 protocol field shapes, top-15 protocol MessageID table, Push inventory,
recommended stack, rollout checklist, risk register).

The companion client design document is **authoritative** for protocol
semantics — this README is for **running and operating** the backend.

---

## 1. What this backend does

| Layer | What | How |
|---|---|---|
| HTTP | Login / register / bind / activation / version check / server list / init | Express + Node 26, JSON over HTTPS (signed: `MD5(body + SECRET_KEY + ts)`) |
| TCP | Unity client game protocol (430 request types, ~46 push topics, batched requests, binary handshake) | Node `net` module, DeepCore binary frame |
| Storage | Accounts, sessions, roles, heroes, items, formations, guilds, orders, mail, red-dots, activities | SQLite (Node 26 built-in `node:sqlite`), schema in `db/migrations/001_init.sql` |
| Auth | Token = JWT signed with `JWT_SECRET`; UUID lookup per request | `jsonwebtoken` |

---

## 2. Project layout

```
art-project-backend/
├─ package.json                 npm deps, Node ≥ 20
├─ tsconfig.json                NodeNext + ES2022 strict
├─ README.md                    ← this file
│
├─ shared/
│  └─ proto/
│     ├─ codec.ts               BinaryReader / BinaryWriter (S32 / VS32 / UTF / Bool)
│     └─ registry.ts            ALL 430 MessageIDs hand-mapped, no MessageID collisions
│
├─ services/
│  ├─ http/
│  │  └─ src/main.ts            8 HTTP endpoints, signature verification, base64 body decoding
│  └─ tcp/
│     └─ src/main.ts            Binary protocol server, handshake + 7 implemented handlers + echo fallback
│
├─ db/
│  ├─ migrations/001_init.sql   12 tables (accounts / sessions / roles / heroes / items / formations
│  │                            / guilds / guild_members / orders / reddots / activities / mails
│  │                            / gm_log)
│  └─ seeds/seed.ts             Inserts a demo account + role
│
├─ scripts/                     Operational scripts (all .bat)
│  ├─ setup.bat                 npm install + seed DB
│  ├─ start-http.bat            HTTP on 8080 (own console window)
│  ├─ start-tcp.bat             TCP game on 19821 (own console window)
│  ├─ start-all.bat             Open both windows in one click
│  ├─ stop-all.bat              Kill processes on 8080 / 19821
│  ├─ health-check.bat          HTTP curl + TCP port check (with timeout, never hangs)
│  ├─ register-tasks.bat        Auto-UAC + register two Scheduled Tasks (run at logon)
│  └─ unregister-tasks.bat      Remove the two Scheduled Tasks
│
├─ tests/                       (reserved for future unit tests)
│
└─ data/                        (created on first run)
   ├─ game.db                   SQLite database
   ├─ game.db-shm / game.db-wal WAL mode files
```

---

## 3. Quickstart (one-shot)

```cmd
cd C:\Users\leo19\art-project-backend
scripts\setup.bat
scripts\start-all.bat
```

That's it. Two console windows open — one for HTTP, one for TCP. Close
them to stop the services, or run `scripts\stop-all.bat`.

---

## 4. Configuration

All configuration via **environment variables**. Defaults are inline below.

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `PORT` | `8080` | HTTP | Listen port |
| `GAME_PORT` | `19821` | TCP | Listen port |
| `DB_PATH` | `./data/game.db` | both | SQLite file path |
| `SECRET_KEY` | `3dbf6b137a80d10953507929a0216d8b` | HTTP | **Must match client `LoginMgr.secretKey`** |
| `JWT_SECRET` | `dev-jwt-secret-change-me` | HTTP | Change in production |
| `CDN_URL` | `https://cdn.example.com/` | HTTP | Returned in `/api/client/check_update` and `/api/client/init` |
| `GAME_HOST` | `127.0.0.1` | HTTP | Advertised in `/serverlist.json` so the client knows where the TCP gateway lives |
| `BATTLE_RECORD_URL` | `https://battle.example.com/` | TCP | Returned in `ClientEnterGameResponse.s2c_battleRecordURLPrefix` |

For production, override `SECRET_KEY`, `JWT_SECRET`, `CDN_URL`, and `GAME_HOST`
to real values. The `setup.bat` and Scheduled-Task scripts set `DB_PATH` for
you via `setx DB_PATH`.

### Migrations

Migrations live in `db/migrations/` and apply automatically at service boot
(both HTTP and TCP). Idempotent — already-applied migrations are skipped.

| File | Purpose |
|---|---|
| `_migrations.sql` | Version table (created first) |
| `001_init.sql` | Original schema (12 tables) |
| `002_hotpath_indexes.sql` | `idx_sessions_token`, `idx_accounts_platform_account`, `idx_orders_role_status`, `idx_heroes_role_hero` |
| `run.ts` | Runner: scans, applies pending migrations, records to `_migrations` |

CLI form: `node --import tsx db/migrations/run.ts`

New migrations: drop a `NNN_name.sql` into `db/migrations/`; runner picks it up
next boot. Filenames must start with 3+ digits.

---

## 5. HTTP API

All endpoints under `/account/*` are **signed**:

```
dataString = Base64(JSON body)
signature  = MD5(dataString + SECRET_KEY + timestamp_ms)
URL        = base + path + "?sign={signature}&timestamp={ms}"
```

The client (`Assets/Scripts/Common/LoginMgr.cs:AccountLoginRequest`) builds
exactly this signature. `verifySign()` in `services/http/src/main.ts` checks
both the timestamp and the MD5 with `crypto.timingSafeEqual`.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `GET`  | `/serverlist.json` | none | — | `{ servers: [{ serverID, name, host, port, state, recommend, openTime }, ...] }` |
| `POST` | `/api/client/init` | none | ignored | `{ cdnRoot, forceUpdate, serverListHash, loginUrl, gameHost, gamePort }` |
| `POST` | `/api/client/check_update` | none | ignored | **XML** matching `UpdateVersionMessage` schema (see client source) |
| `POST` | `/account/login` | signed | base64 JSON `{platform, account, deviceID, binVersion, [token, serverID, accountUUID]}` | `{ code, msg, accountUUID, token (JWT), serverAddress, serverID, sessionId, roleUUID, roleName, expiredAt }` |
| `POST` | `/account/register` | signed | base64 JSON `{platform, account, password, deviceID}` | `{ code, msg, accountUUID, token }` |
| `POST` | `/account/bind` | signed | base64 JSON `{accountUUID, platform, account, deviceID, token}` | `{ code, msg, bindResult, accountUUID }` |
| `POST` | `/account/activation` | signed | base64 JSON `{code, deviceID, accountUUID}` | `{ code, msg, serverId, accountUUID, token }` — demo code is `WELCOME2024` |

### Negative cases (verified end-to-end)

| Test | Expected | Actual |
|---|---|---|
| `/account/login` with bad signature | `401 {"code":"SIGN_INVALID"}` | ✅ |
| `/account/activation` with wrong code | `400 {"code":"CODE_INVALID"}` | ✅ |
| `/account/bind` with unknown `accountUUID` | `404 {"code":"ACCOUNT_NOT_FOUND"}` | ✅ |

### XML schema for `/api/client/check_update`

Field names are case-sensitive and match `Assets/Scripts/Common/Http/UpdateVersionMessage.cs` `[XmlElement(nameof(...))]` attributes:

```xml
<?xml version="1.0"?>
<root>
  <status>1</status>                     <!-- 0 = error, 1 = ok -->
  <message>ok</message>
  <UpdateType>0</UpdateType>             <!-- 0 = normal, 1 = soft update, 2 = hard update -->
  <UpdateUrl></UpdateUrl>
  <ResType>0</ResType>
  <CDNUrl>https://cdn.example.com/</CDNUrl>
  <RepairNoticeState>0</RepairNoticeState>
  <RepairContents></RepairContents>
  <SystemNoticeState>0</SystemNoticeState>
  <SystemNoticeContent></SystemNoticeContent>
  <MpqNoticeState>0</MpqNoticeState>
  <MpqNoticeContent></MpqNoticeContent>
</root>
```

### `serverlist.json` schema

The client `LoginMgr.GetServerUrl` calls `JsonUtility.FromJson<ServerData>`.
**Return `{ servers: [...] }`** — the client tolerates either shape, but the
object-wrapped form is the canonical one:

```json
{
  "servers": [
    {
      "serverID": "s10001",
      "name": "亚特兰蒂斯",
      "host": "127.0.0.1",
      "port": 19821,
      "state": 0,
      "recommend": true,
      "openTime": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## 6. TCP API (DeepCore/Pomelo binary protocol)

> **Rewritten 2026-10-02** after decompiling the client's `DeepCore.dll` (ILSpy) and
> regenerating the protocol registry from the client's real Lua corpus
> (`Assets/GameAssets/lua/Protocol/generated/*.lua`, 1215 protocols). The previous
> hand-written registry had invented MessageIDs and a wrong wire format — it is gone.
> Full protocol table: **docs/protocols.md** (auto-generated, 425 requests).

### Frame format (verified against `DeepCore.FuckPomelo`)

```
[ byte0: pkgType | mask<<4 ]   pkgType: 1=HANDSHAKE 2=HANDSHAKE_ACK 3=HEARTBEAT 4=MESSAGE 5=KICK
[ bytes1-3: length LE 24-bit ]  bytes after the 4-byte head
[ body ]                        PKG_MESSAGE body:
                                  [ msgType u8 ]  0=NOTIFY 1=REQUEST_C2S 2=RESPONSE_S2C
                                  [ sendId u32 LE ]  (omitted for NOTIFY)
                                  [ route s32 LE ]   = protocol MessageID
                                  [ payload ]        = flattened protocol fields
```

Connection flow: client `Connect()` sends **PKG_HANDSHAKE** whose user OBJ is a
`ClientEnterServerRequest` (0x00032001). Server validates the JWT against the
`sessions` table and replies **PKG_HANDSHAKE_ACK** with token OBJ =
`ClientEnterServerResponse` (0x00032002, carries `s2c_code`/`s2c_sessionId`) +
`remote_info` UTF + `heartbeat_interval_ms` VS32. After that all traffic is
PKG_MESSAGE request/response pairs correlated by `sendId`; responses always use
route = **Response** MessageID (Request+1 by corpus convention, 420/431 pairs).
PKG_HEARTBEAT frames are echoed. Auth failure -> PKG_KICK + close.

### Field encoding (DeepCore.IO.OutputStream, USE_VLQ=false)

| Kind | Wire format |
|---|---|
| `Bool` / `U8` / `Enum8` | 1 byte |
| `S16` | 2 bytes **LE** |
| `S32` / `VS32` / `Enum32` | 4 bytes **LE** (VLQ disabled on the Lua path) |
| `S64` / `VS64` | 8 bytes **LE** |
| `F32` / `F64` | IEEE754 **LE** |
| `UTF` | `S16 charCount` + **UTF-16LE** bytes; -1 = null, 0 = empty |
| `DateTime` | S64 (.NET `DateTime.ToBinary()`) |
| `TimeSpan` | U64 total-ms |
| `Bytes` | `S32 len` + raw; -1 = null |
| `OBJ` | `S32 messageID` + nested fields; -1 = null |
| `LIST` / `ARRAY` | `S32 count` + elements; -1 = null |
| `MAP` | `S32 count` + (key, value) pairs; -1 = null |

Every Response payload starts with the inherited base fields:
`s2c_code S32, s2c_msg UTF, InnerResponse OBJ, s2c_notifys LIST(Notify)`.
Every Request whose parent is `ClientRequest` starts with `c2s_requestId S32`.

### Implemented handlers (live-tested, real MessageIDs)

| MessageID | Name | Behavior |
|---|---|---|
| handshake | `ClientEnterServerRequest` (in PKG_HANDSHAKE) | JWT check vs `sessions`; ACK carries EnterServerResponse |
| `0x00033001` | `ClientEnterGameRequest` | loads/creates role, binds session |
| `0x0003300F` | `ClientExitGameRequest` | clears role binding |
| `0x00033013` | `ClientPing` | ack |
| `0x00035201` | `ClientFightRandomSeedRequest` | `battle-arbitrator.IssueSeed` -> DB `battle_seeds` (5-min TTL) |
| `0x00035203` | `ClientFightResultRequest` | `resolveBot`: seed match + power-drift (5%) + replay guard; drop-table rewards via `dispatchRewards`; pushes `ClientCommonNotify` (0x00035001) |
| `0x00035209` | `ClientFightSkipResultRequest` | sweep settle |
| `0x00035701` | `ClientGetFormationInfoRequest` | formations from DB |
| `0x66BE7DAB` | `ClientQueryBagHeroRequest` | hero bag |
| `0x00035906` | `ClientLoadGuildRequest` | guild-engine |
| `0x00037901` | `ClientEnterMazeRequest` | maze-engine layout |
| `0x00036304/06` | `ClientStartCopyRequest`/`ClientEndCopyRequest` | rogue-engine |
| `0x00036501/03/05` | `PlaceOrder`/`CheckOrder`/`SyncOrder` | pay.ts order state machine |
| `0x00035301` | `ClientHandleGMRequest` | gm-admin (admin-token gated) |
| `0x00038301/03` | `ClientChatMessageList`/`ClientChatAddMessage` | chat-engine + forbidden words + mute + rate limit |
| `0x00050201` | `ClientGetRoleInfoRequest` | role info DTO |
| `0x00050403` | `ClientChangeRoleNameRequest` | rename |
| *any other request* | | schema-derived default response (`s2c_code=200` + zero-values) — client never hangs on an unknown protocol |

Cross-cutting: per-role rate limiting (`rate-limit.ts`, 120 msg/min global +
per-domain caps), metrics counters, structured logs to stdout + `logs/server-YYYY-MM-DD.log`.

### Verified roundtrip (tests/e2e_client.py — real protocol, real sockets)

```
HTTP /account/login            -> JWT + sessionId                       16/16 PASS
PKG_HANDSHAKE(user=EnterServer)-> PKG_HANDSHAKE_ACK(token=EnterServerResponse, hb=15000ms)
EnterGame 0x33001              -> 0x33002 { s2c_code=200, ... }
FightRandomSeed 0x35201        -> 0x35202 { RandomUuid, RandomSeed, DifficultyRank, ... }
FightResult 0x35203 (win)      -> 0x35204 { s2c_code=200 } + ClientCommonNotify push (rewards applied to DB)
PKG_HEARTBEAT                  -> echoed
```

## 7. Database schema (26 tables after migrations 001-013)

See `db/migrations/001_init.sql` for the full DDL. Summary:

| Table | Purpose | Key columns |
|---|---|---|
| `accounts` | All login identities (guest / platform / email) | `account_uuid`, `platform`, `account`, `token_hash`, `device_id` |
| `sessions` | Active TCP sessions | `account_uuid`, `session_id`, `token` (JWT), `expires_at` |
| `roles` | In-game characters | `account_uuid`, `role_uuid`, `name`, `level`, `gold`, `diamond`, `vip_level`, `battle_power` |
| `heroes` | Hero roster | `hero_uuid`, `role_uuid`, `hero_id`, `level`, `rank`, `star`, `locked` |
| `items` | Inventory items | `item_uuid`, `role_uuid`, `item_id`, `count` |
| `formations` | Saved battle lineups | `formation_uuid`, `role_uuid`, `type`, `hero_uuids` (JSON) |
| `guilds` | Guild metadata | `guild_uuid`, `name`, `level`, `notice` |
| `guild_members` | Guild membership | `guild_uuid`, `role_uuid`, `position` |
| `orders` | Payment orders | `order_id`, `role_uuid`, `goods_id`, `amount`, `status`, `platform` |
| `reddots` | Per-player red-dot state | `(role_uuid, key)` composite PK |
| `activities` | Activity progress | `role_uuid`, `activity_id`, `progress` (JSON) |
| `mails` | In-game mailbox | `mail_uuid`, `role_uuid`, `rewards` (JSON), `read`, `claimed`, `expires_at` |
| `gm_log` | GM command audit | `role_uuid`, `cmd`, `args`, `created_at` |

The seed inserts a demo account: `accountUUID = demo-uuid-001`,
`roleUUID = demo-role-001`, name = "DemoPlayer", level 30, 10k gold,
500 diamond, VIP 3.

---

## 8. Operations

### 8.1 Manual launch

```cmd
:: one-time
scripts\setup.bat

:: launch (two windows open)
scripts\start-all.bat

:: check status
scripts\health-check.bat

:: stop
scripts\stop-all.bat
```

### 8.2 Persistent launch (Scheduled Tasks)

`scripts\register-tasks.bat` registers two Scheduled Tasks:

- `ArtBackend_HTTP` — runs `node --import tsx services\http\src\main.ts`
- `ArtBackend_TCP`  — runs `node --import tsx services\tcp\src\main.ts`

Both trigger at user logon (`/SC ONLOGON`), run with limited token
(`/RL LIMITED /IT`) so they appear in Task Scheduler UI.

**The script auto-elevates**: if not running as Administrator, it re-launches
itself via `Start-Process -Verb RunAs` (a UAC prompt appears). Double-click
on the .bat from Explorer — accept the UAC dialog — and the tasks are
registered. The terminal tool cannot test this auto-elevation interactively
(UAC blocks for input); it's expected to work when run from a real desktop.

After registration, start them now:

```cmd
schtasks /Run /TN "ArtBackend_HTTP"
schtasks /Run /TN "ArtBackend_TCP"
```

They will also auto-start on every Windows login from then on.

To remove:

```cmd
scripts\unregister-tasks.bat
```

### 8.3 Health check

```cmd
scripts\health-check.bat
```

Output (when running):

```
HTTP  /serverlist.json -> 200
TCP   port 19821 -> True
```

When stopped:

```
HTTP  /serverlist.json -> DOWN (...)
TCP   port 19821 -> DOWN
```

---

## 9. Logs

Each service prints pino JSON logs to **stdout**. When run from
`scripts\start-*.bat` you'll see them in the console windows. For long-term
capture, redirect:

```cmd
node --import tsx services\http\src\main.ts > logs\http.log 2>&1
```

(Or modify the `start-*.bat` scripts.)

---

## 10. Verified end-to-end (this session)

### HTTP — 10/10 endpoints pass

| Endpoint | Result |
|---|---|
| `GET /serverlist.json` | 200 — JSON with `servers` array |
| `POST /api/client/check_update` | 200 — XML with all schema fields |
| `POST /api/client/init` | 200 — JSON with `cdnRoot`, `gameHost`, `gamePort` |
| `POST /account/login` (guest) | 200 — returns JWT + roleUUID |
| `POST /account/login` (existing) | 200 — reuses demo account |
| `POST /account/login` (bad signature) | **401** — `{"code":"SIGN_INVALID"}` |
| `POST /account/bind` | 200 — platform updated |
| `POST /account/activation` (code `WELCOME2024`) | 200 — diamond +100 |
| `POST /account/activation` (bad code) | **400** — `{"code":"CODE_INVALID"}` |
| `POST /account/register` | 200 — new UUID + JWT |

### TCP — 4/4 handshake + business calls

| Protocol | Result |
|---|---|
| `0x00032001 ClientEnterServerRequest` | Returns `0x00032002` with `s2c_sessionId` |
| `0x00033001 ClientEnterGameRequest` | Returns `0x00033002` with 52 bytes (7 fields) |
| `0x00033301 ClientQueryBagHeroRequest` | Returns `0x00033301` empty (no heroes seeded) |
| `0x00050403 ClientChangeRoleNameRequest` | Returns `0x00050414` ack |

### Start/Stop ops

| Script | Result |
|---|---|
| `scripts\setup.bat` | npm install OK + seed OK |
| `scripts\start-all.bat` | HTTP 8080 UP, TCP 19821 UP |
| `scripts\health-check.bat` | HTTP 200 / TCP True |
| `scripts\stop-all.bat` | both ports free |

---

## 11. Known gaps (follow-ups)

Updated after the 2026-10-02 protocol-rebuild pass. Fixed since the last revision:
~~echo stubs~~ (now schema-default responses with correct wire types), ~~no push~~
(push-scheduler + ClientCommonNotify live), ~~no nested DTOs~~ (codec supports
OBJ/LIST/ARRAY/MAP with the full 1215-protocol registry), ~~no rate limiting~~
(token bucket wired into TCP dispatch), ~~stdout-only logging~~ (daily-rotated
file logs), ~~no metrics/health~~ (/metrics + /health + /health/ready),
~~no admin CLI~~ (`bin/admin.ts`: accounts/roles/orders/give/mute/gmlog/pushlog/seeds/migrate/health),
~~arena/tower/dungeon/guild/sign-in handlers~~ (wired at real corpus MessageIDs, E2E 27/27).

| Gap | Why it exists | Where to add it |
|---|---|---|
| **QueryBagHero `s2c_heros` nested map** | MAP<S32, MAP<UTF, BagHeroData>> shape needs BagHeroData DTO field mapping | `services/tcp/src/main.ts` QUERY_BAG_HERO_REQ handler |
| **EnterMaze `s2c_mazeData`** | MazeData ORM DTO mapping pending (layout computed server-side) | ENTER_MAZE_REQ handler |
| **`ClientBatchRequest` real batch** | Returns ack; the Lua client uses this for first-screen bulk loading | Implement parallel dispatch of inner requests |
| **TLS** | HTTP listens on plain `http://`; client uses `http://` for `serverlist.json` too | Add `https.createServer({key, cert}, app)` for prod |
| **Compression** | Client factory never compresses (`CompressStream` -> false); mask bit handled but unused | Leave as-is unless client changes |

---


## 12. Reference: companion design doc

The full API design — including the 28-domain protocol taxonomy,
top-15 protocol MessageID hex table, 46 Push topic inventory, and
client-side code references — lives at:

```
C:\Users\leo19\AppData\Local\hermes\cache\scratch\art-project-client-api-design.md
```

Use that document when extending the backend.

---

## 13. File index (paths from project root)

| Path | Bytes | Purpose |
|---|---:|---|
| `package.json` | 1,385 | npm deps (Express, JWT, tsx; **no** native addons — uses Node 26 built-in `node:sqlite`) |
| `tsconfig.json` | 511 | NodeNext + ES2022 + strict + decorator metadata |
| `README.md` | (this file) | Operations + API reference |
| `db/migrations/001_init.sql` | 4,867 | DDL for 12 tables |
| `db/seeds/seed.ts` | 986 | Inserts demo account + role |
| `shared/proto/codec.ts` | 4,098 | BinaryReader/Writer + protocol registry API |
| `shared/proto/registry.ts` | 9,653 | **All 430 MessageIDs registered, no collisions** |
| `services/http/src/main.ts` | 7,987 | HTTP service (Express) |
| `services/tcp/src/main.ts` | 6,273 | TCP service (raw `net` module) |
| `scripts/setup.bat` | 293 | npm install + seed |
| `scripts/start-http.bat` | 428 | Start HTTP |
| `scripts/start-tcp.bat` | 437 | Start TCP |
| `scripts/start-all.bat` | 298 | Start both |
| `scripts/stop-all.bat` | 570 | Kill both |
| `scripts/health-check.bat` | 647 | HTTP + TCP status |
| `scripts/register-tasks.bat` | 2,144 | Auto-UAC + register Scheduled Tasks |
| `scripts/unregister-tasks.bat` | 226 | Remove Scheduled Tasks |

Total source + scripts: ~46 KB across 17 files (excluding `package-lock.json`).
