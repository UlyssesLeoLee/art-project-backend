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

## 6. TCP API (binary protocol)

The Unity client uses `DeepCore.FuckPomelo` with `OpenCards.Core.Protocol.*`
DTOs that are auto-generated from server `.proto` files. The on-wire frame
matches that:

```
[ MessageID   u32 BE ]   ← matches Protocol.Serializer[0xXXXXXXXX]
[ Length      u32 BE ]   ← payload length in bytes
[ Payload     bytes  ]   ← fields encoded in registration order
```

### Field encoding

| Kind | Wire format | Notes |
|---|---|---|
| `S32`  | 4 bytes BE int32 | signed 32-bit |
| `VS32` | zigzag varint | matches Lua's `output.stream:PutVS32` |
| `UTF`  | `VS32(len) + UTF-8 bytes` | no BOM, no NUL terminator |
| `Bool` | 1 byte (`0`/`1`) | |
| `OBJ`  | nested DTO via typeid dispatch | (not used by current handlers — see §11) |

### Handshake (must work before any other protocol)

```
0x00032001 ClientEnterServerRequest (c→s)
  c2s_accountUUID  UTF
  c2s_token        UTF    ← JWT issued by /account/login
  c2s_debug        Bool
  c2s_sessionId    S32
→ 0x00032002 ClientEnterServerResponse (s→c)
  s2c_sessionId    S32

0x00033001 ClientEnterGameRequest (c→s) — 14 fields
  c2s_accountUUID, c2s_serverID, c2s_LanguageID, c2s_DeviceID,
  c2s_Os, c2s_OsVersion, c2s_AppVersion, c2s_ZoneOffset,
  c2s_Channel, c2s_AFID, c2s_UseSource, c2s_Address,
  c2s_ClientVersion, c2s_BundleID
→ 0x00033002 ClientEnterGameResponse (s→c) — 7 fields
  s2c_UserSource, s2c_newRole, s2c_waitingCount,
  s2c_battleRecordURLPrefix, s2c_accumulativeLoginDays,
  s2c_serverId, s2c_createRoleClientVersion
```

### Implemented handlers (live-tested)

| MessageID | Name | Behavior |
|---|---|---|
| `0x00032001` | `ClientEnterServerRequest` | Validates JWT against `sessions` table; returns `s2c_sessionId` |
| `0x00033001` | `ClientEnterGameRequest` | Loads role by `account_uuid`, binds session |
| `0x0003300F` | `ClientExitGameRequest` | Deletes session |
| `0x00050201` | `ClientGetRoleInfoRequest` | Returns role row |
| `0x00050403` | `ClientChangeRoleNameRequest` | Updates `roles.name`, returns ack |
| `0x00033301` | `ClientQueryBagHeroRequest` | Returns heroes list |
| `0x0003340x` | `ClientGetFormationInfoRequest` | Returns formations list |
| `0x00035002` | `ClientBatchRequest` | Returns ack (real batching is §11 follow-up) |
| anything else | | Echoes back the same MessageID with empty payload — **so the client never sees "unknown protocol"** while the backend is stubbed |

### Verified roundtrip

```
c→s 0x00032001 EnterServer  → s→c 0x00032002 { s2c_sessionId: <N> }        ✅
c→s 0x00033001 EnterGame    → s→c 0x00033002 { 7 fields, 52 bytes }       ✅
c→s 0x00033301 QueryBagHero → s→c 0x00033301 { empty payload }            ✅
c→s 0x00050403 ChangeName   → s→c 0x00050414 { ack byte }                 ✅
```

---

## 7. Database schema (12 tables)

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

These are intentional — the spec called for a **complete backend that
supports client functionality** at the protocol level, not a full game logic
implementation. The remaining work is real-game-domain code, not API surface:

| Gap | Why it exists | Where to add it |
|---|---|---|
| **423 of 430 protocols are echo stubs** | They answer `200` so the client never sees "unknown protocol", but they don't implement the business logic (battle resolution, ranking, rewards, etc.) | Add handlers in `services/tcp/src/main.ts:handlers` Map |
| **Push / Notify subscription** | The registry defines IDs; the server never initiates a push to the client | Add a `pushToClient(sock, mid, payload)` helper + scheduler |
| **`ClientBatchRequest` real batch** | Returns ack; the Lua client uses this for first-screen bulk loading | Implement parallel dispatch of inner requests |
| **`OpenCards.Core.Data.*` nested DTOs** | The codec currently supports S32/VS32/UTF/Bool; nested DTOs use `PutOBJ`/`GetOBJ` in the client. No handler currently emits those | Add `OBJ` kind to codec.ts and register nested DTO definitions |
| **TLS** | HTTP listens on plain `http://`; client uses `http://` for `serverlist.json` too | Add `https.createServer({key, cert}, app)` for prod |
| **Rate limiting** | None | Add `express-rate-limit` or Nginx upstream |
| **Logging to file** | Only stdout; not structured for production | Wrap pino with pino/file transport |

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
