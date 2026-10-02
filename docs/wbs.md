# art-project-backend — WBS (Work Breakdown Structure)

> Source of truth for who-does-what, in-what-order, with-what-priority.
> Updated 2026-10-02 after the playstyle analysis (29 `FightType`s, 306 Ctrl subdomains,
> 1872 protocol DTOs, 432 registered MessageIDs, 7 implemented TCP handlers).
> **Goal: get the game playable, not just "the backend can handshake".**

---

## 0. Top-level milestones

| # | Milestone | Definition of done | Blockers |
|---|---|---|---|
| **M0** | Foundation (already done) | Repo scaffolded, HTTP 8 endpoints, TCP handshake, 432 protocols registered, audit report, 11 GitHub issues created | — |
| **M1** | Core battle loop (最小可玩) | Client can: login → enter game → start battle → get RandomSeed → simulate → report result → receive rewards | M0 |
| **M2** | Daily play loop | Client can: do maze/dungeon/tower/daily-activity/sign-in/check-in without errors and rewards stick | M1 |
| **M3** | Social & competition | Guild + Arena + Union 9 subsystems + chat moderation | M2 |
| **M4** | Commerce & ops | Real Pay SDK integration + GM admin + rate limit + push scheduler | M3 |
| **M5** | Production hardening | TLS, /health, /metrics, file logs, tests, migrations runner | M4 |

---

## 1. Task tree

### 1.1 Backend service modules (new)

Each module = a TypeScript file in `services/<name>/src/main.ts` OR a library imported by existing services.

| ID | Module | Owner | Priority | Effort | M-blocker |
|---|---|---|---|---|---|
| **M1-BAT** | `lib/battle-arbitrator.ts` — RandomSeed table + power-snapshot + Replay validator | TBD | **P0** | 5d | M1 |
| **M1-RES** | `lib/rewards.ts` — single source of truth for "give items / currency / hero / exp" | TBD | **P0** | 2d | M1 |
| **M2-DUN** | `lib/dungeon-engine.ts` — Stage cfg loader + reward formula + drop tables | TBD | P1 | 4d | M2 |
| **M2-MAZ** | `lib/maze-engine.ts` — maze generation + grid reveal + tile events | TBD | P1 | 3d | M2 |
| **M2-ROG** | `lib/rogue-engine.ts` — Rogue/Copy state machine + fog + relic pickup | TBD | P1 | 4d | M2 |
| **M2-TOW** | `lib/tower-engine.ts` — Tower infinite levels + rank calculation | TBD | P1 | 2d | M2 |
| **M2-ACT** | `lib/activity-engine.ts` — open-calendar table + per-activity state + cross-server ranking stub | TBD | P1 | 5d | M2 |
| **M3-GLD** | `lib/guild-engine.ts` — guild CRUD + positions + apply flow | TBD | P1 | 3d | M3 |
| **M3-ARN** | `lib/arena-engine.ts` — 4 sub-modes (system/highOrder/Pinnacle/Valor) + season refresh + matchmaker | TBD | P1 | 5d | M3 |
| **M3-UNI** | `lib/union-subsystems.ts` — 5 union mini-modes (BossMain/Curse/Hunting/Screwy/Territory) | TBD | P1 | 4d | M3 |
| **M3-CHT** | `lib/chat-engine.ts` — message persistence + mute + forbidden-word filter | TBD | **P0** | 2d | M3 (regulatory) |
| **M4-PAY** | `lib/pay.ts` — QuickSDK/TianjiSDK/YmnSDK signature verifier + order state machine + delivery | TBD | P1 | 4d | M4 |
| **M4-PUS** | `lib/push-scheduler.ts` — cron-driven Push dispatches (Maze / Arena season / red-dot) | TBD | P1 | 3d | M4 |
| **M4-GM**  | `lib/gm-admin.ts` + admin CLI — handles `ClientHandleGMRequest`, audit log table | TBD | P1 | 2d | M4 |
| **M4-RAT** | `lib/rate-limit.ts` — TCP message frequency cap per role/IP, anti-brute force | TBD | P1 | 1d | M1 |

### 1.2 TCP protocol implementations (handlers in `services/tcp/src/main.ts`)

Group by milestone. **Each handler must implement the contract derived from client code in `\\\\LS220D088\\webaxs\\backupProjects\\art-project-client\\Assets\\GameAssets\\lua\\gameControl\\<subdir>\\*Ctrl.lua`**.

#### M1 — Core battle loop (P0)

| ID | Protocol | MessageID | c2s fields | s2c behavior |
|---|---|---|---|---|
| H-FRS | `ClientFightRandomSeedRequest` | `0x00035201` | `FightMod, StageId` | Issue `RandomUuid` + `RandomSeed` + `DifficultyRank` + `Battle_check_realpwoer` + `NeedFightReplay` + `Stage_dynamic_difficulty`; **store seed in 5-min table** |
| H-FRR | `ClientFightResultRequest` | `0x00035202` | `FightMod, StageId, [isWin, replayLog]` | Verify seed still valid; if `NeedFightReplay==1` re-simulate + compare hash; on success: award rewards, push `ClientCommonNotify`, push `ClientStageRewardClaim` if stage cleared |
| H-FSR | `ClientFightSkipResultRequest` | `0x00035203` | `FightMod, StageId` | Skip-mode reward (only allowed if `IsSkipAllowed(stage, role)`) |
| H-RNG | `ClientArenaValorFightRandomSeedRequest` | `0x39011`-ish | `c2s_FightMod, c2s_OppositeRoleUUID` | Same seed machinery for arena; persist opponent snapshot |
| H-RNH | `ClientArenaHighendFightRandomSeedRequest` | `0x35207` | `c2s_FightMod, c2s_OppositeRoleUUID` | Highend-arena variant |
| H-COP | `ClientStartCopy / EndCopy` | `0x35200-0x35228` | per-copy | Per-dungeon start/finish + reward distribution |
| H-EXP | `ClientExploreCopyMapPoses` | `0x35218`-ish | `c2s_x, c2s_y` | Rogue/Copy map exploration reveal |
| H-PSH | (Push) `ClientCommonNotify` | `0x00035001` | server→client `s2c_gainItemsReason` | Wire to rewards dispatcher |

#### M2 — Daily play loop (P1)

| Domain | Handlers (count) | Notes |
|---|---:|---|
| **Maze** | 6 | `alienMazeCtrl.lua` — maze gen + grid opt + use item + help list/opt; Push `ClientMazeDataNotify` |
| **Rogue/Copy** | 14 | `RogueDataCtrl.lua` — fog, relic, trap, spring, hire, combat, granary, save event |
| **Tower** | 4 | `towerRaceCtrl.lua` — query tower info, request tower level, sweep tower |
| **Dungeon** | 6 | `dungeonStoneWindowCtrl.lua` — 5 resource dungeons +1 sweep |
| **Sign-in / Reward** | 12 | login sign, daily check-in, monthly card, first recharge, 30-day, accumulate |
| **Activity** | 25 | calendar-driven open windows; per-activity state push |
| **Task / Bounty** | 15 | main task + target task + bounty opt + ads info |
| **Tavern / Hero Exchange** | 5 | tavern recommend gift, exchange info |
| **Wish / WishSummon** | 16 | wish list CRUD + 10 wishSummon protocols |
| **VipPrivilege** | 2 | vip rewards |
| **MiniGame** | 2 | `ClientGetMiniGameEndRequest / ClientGetMiniGameRewardRequest` |

#### M3 — Social & competition (P1)

| Domain | Handlers (count) | Notes |
|---|---:|---|
| **Guild** | 14 | `unionHallCtrl.lua` — load/create/apply/handle/exit/kick/notice/position/protector/invite/mail/list/events |
| **Arena** | 40 | 4 sub-modes × ~10 protocols each + season refresh + Pinnacle groups + Valor bet |
| **Union subsystems** | 9 | BossMain/Curse/Hunting/Screwy/Territory + WarriorTreasure |
| **Chat** | 9 | world/private channels + list + add/up/delete + mute state; **must do forbidden-word** |
| **Mail** | 2 | list + operate (claim/expunge) |
| **Friend/Mercenary** | 26 | friend CRUD + black list + apply + lend/borrow + report |
| **Push handlers** | 5 | `ClientGuildChangedNotify / ClientArenaFormationPowerNotify / ClientTempMercenaryHiredNotify / ClientFriendAdd/Remove / ClientChatMessageListNotify` |

#### M4 — Commerce & ops (P1)

| Domain | Handlers (count) | Notes |
|---|---:|---|
| **Pay** | 4 | `PlaceOrder / Pay / CheckOrder / SyncOrder` + QuickSDK/TianjiSDK/YmnSDK signature verify |
| **GM** | 1 | `ClientHandleGMRequest` (must be admin-only) |
| **Rate limit** | (cross-cutting) | Token bucket per role+messageName; HTTP 5/min per IP on /account/* |
| **Push scheduler** | (cross-cutting) | cron jobs: ArenaSeasonRefresh, MazeGridPush, RedDotFlush, ActivityWindowOpen |

### 1.3 DB schema additions

| ID | Migration | Adds tables/columns | M-blocker |
|---|---|---|---|
| DB-002 | `002_battle_seed.sql` | `battle_seeds(uuid, role_uuid, fight_mod, stage_id, random_seed, difficulty_rank, need_replay, power_snapshot_json, created_at, expires_at)` + index `(role_uuid, expires_at)` | M1 |
| DB-003 | `003_replay_log.sql` | `battle_replays(uuid PK, role_uuid, replay_json, replay_hash, created_at)` (TTL 7d) | M1 |
| DB-004 | `004_drops.sql` | `drop_tables(stage_id, item_id, weight, min_qty, max_qty)` + `drop_history(id, role_uuid, stage_id, item_id, qty, at)` | M1 |
| DB-005 | `005_arena.sql` | `arena_seasons(season_id, start_at, end_at, status)` + `arena_rankings(season_id, role_uuid, score, rank)` | M3 |
| DB-006 | `006_guild.sql` | (extends `guilds` + `guild_members`) add `last_active_at, contribution, auto_accept, weekly_score` | M3 |
| DB-007 | `007_activity.sql` | `activity_calendar(activity_id, open_at, close_at, server_id, params_json)` + extends `activities` | M2 |
| DB-008 | `008_chat.sql` | `chat_messages(id, channel, sender_uuid, text, created_at)` + `chat_mutes(role_uuid, expires_at, reason)` | M3 |
| DB-009 | `009_orders.sql` | extends `orders` add `paid_at, delivered_at, sdk_platform, sdk_txn_id, callback_payload_json` | M4 |
| DB-010 | `010_push_audit.sql` | `push_log(id, role_uuid, push_name, message_id, sent_at)` | M4 |
| DB-011 | `011_gm.sql` | extends `gm_log` add `admin_user, action_taken, ip` | M4 |
| DB-012 | `012_rate_limit.sql` | `rate_buckets(bucket_key PK, count, window_start)` | M4 |
| DB-013 | `013_migrations.sql` | `_migrations(id PK, applied_at)` — version tracking | **pre-M1** (prerequisite) |

### 1.4 Tests

| ID | Test type | Coverage | M-blocker |
|---|---|---|---|
| T-UNIT | Unit tests (Node `node:test`) | codec encode/decode roundtrip for all 432 MessageIDs (must match Lua `Read`/`Write`) | M1 |
| T-HTTP | HTTP integration | signature roundtrip, bad signature 401, all 8 endpoints + new pay/GM endpoints | M1 |
| T-TCP-HANDSHAKE | TCP integration | EnterServer/EnterGame/ExitGame + JWT validation | M1 |
| T-TCP-BATTLE | TCP integration | FightRandomSeed → FightResult → reward write | M1 |
| T-TCP-ARENA | TCP integration | Arena season refresh + matchmaking happy path | M3 |
| T-TCP-CHAT | TCP integration | chat + forbidden-word + mute | M3 |
| T-PUSH | Push scheduler test | cron dispatch sends right Push to right role | M4 |

### 1.5 Infrastructure / DevX

| ID | Item | Description | M-blocker |
|---|---|---|---|
| DX-CFG | Server config files | Extract hardcoded `SECRET_KEY / JWT_SECRET / CDN_URL / GAME_HOST` into `config/{dev,staging,prod}.json` | M1 |
| DX-MIG | Migrations runner | `db/migrations/run.ts` with `_migrations` table tracking; auto-runs at service start | M1 |
| DX-CLI | Admin CLI | `bin/admin.ts` for: GM commands, push replay, account inspection | M4 |
| DX-OBS | Logging | pino/file + rotation 14d; log levels per subsystem | M1 |
| DX-MET | Metrics | `prom-client`, `/metrics`, gauges per protocol | M4 |
| DX-HEA | Health | `/health` liveness + readiness; TCP `HealthPing` MessageID | M4 |
| DX-CI | CI | GitHub Actions: tsc + test on PR; deploy on main | M3 |
| DX-DOC | API doc auto-gen | OpenAPI for HTTP; Markdown for TCP (script reads registry) | M3 |

---

## 2. Team assignment

> "Owner" here = role. Real people / agents to be filled in once team is confirmed.

| Stream | Owner role | Files they will touch |
|---|---|---|
| **Battle + Replay + Rewards** (P0) | Senior Backend Engineer | `services/tcp/src/main.ts` (handlers H-FRS/H-FRR/H-FSR), `lib/battle-arbitrator.ts`, `lib/rewards.ts`, `db/migrations/002/003/004.sql`, tests T-TCP-BATTLE |
| **Activity / Daily loop** (P1) | Mid Backend | `lib/dungeon-engine.ts`, `lib/maze-engine.ts`, `lib/rogue-engine.ts`, `lib/tower-engine.ts`, `lib/activity-engine.ts`, `db/migrations/007.sql`, ~80 protocol handlers in `services/tcp/src/main.ts` |
| **Social / Arena** (P1) | Mid Backend | `lib/guild-engine.ts`, `lib/arena-engine.ts`, `lib/union-subsystems.ts`, `lib/chat-engine.ts`, `db/migrations/005/006/008.sql`, ~75 protocol handlers, push dispatcher |
| **Commerce + GM + Anti-cheat** (P1) | Backend + SecOps | `lib/pay.ts`, `lib/gm-admin.ts`, `lib/rate-limit.ts`, `db/migrations/009/010/011/012.sql`, T-PUSH, T-TCP-CHAT |
| **Infra / DevX / Tests** (cross-cutting) | DevX Engineer | `db/migrations/013.sql` + runner, `bin/admin.ts`, `prom-client`/health/log setup, CI workflow, doc auto-gen, all T-UNIT/T-HTTP/TCP-HANDSHAKE tests |

**Rule of ownership**: each `lib/*` file has exactly one owner. Cross-cutting changes require sign-off from both owners.

---

## 3. Sprint plan (proposed)

Working assumption: 2-week sprints, ~3 engineers.

| Sprint | Focus | Deliverables | Exit gate |
|---|---|---|---|
| **S1 (week 1-2)** | **M1: Core battle loop** | DB-013, M1-RES, M1-BAT, M1-RAT, handlers H-FRS/H-FRR/H-FSR, T-UNIT, T-TCP-BATTLE | Demo: client can do `start battle → get reward` end-to-end |
| **S2 (week 3-4)** | **M2 part 1: daily loop** | M2-DUN, M2-MAZ, M2-TOW, DB-004/007, ~50 handlers for Dungeon/Maze/Tower/Activity | Demo: client can clear 5 dungeons + 1 maze without crash |
| **S3 (week 5-6)** | **M2 part 2 + M3 part 1** | M2-ROG, M2-ACT, M3-CHT, M3-GLD, DB-005/008, Rogue + Activity + Guild + Chat handlers, T-TCP-CHAT | Demo: client can join guild + chat |
| **S4 (week 7-8)** | **M3 part 2 + M4** | M3-ARN, M3-UNI, M4-PAY, M4-GM, M4-PUS, DB-009/010/011/012, T-PUSH | Demo: client can do arena + receive a SDK order |
| **S5 (week 9-10)** | **M5 hardening** | DX-OBS/MET/HEA/CI/DOC, security review, full T- suite | Demo: production-ready |

---

## 4. Critical path

```
DB-013 migrations runner
  → DX-MIG auto-runs
    → DB-002 battle_seeds  (M1 dependency)
      → M1-BAT battle-arbitrator
        → H-FRS / H-FRR / H-FSR
          → T-TCP-BATTLE
            → M1 complete
```

Anything not on this path can be parallelized.

---

## 5. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| RandomSeed table growth under load | DB hot-spot | TTL index on `expires_at`; prune job every 1 min |
| Replay JSON from client could be huge (5-50 KB) | bandwidth | gzip on wire; drop after 7d |
| Push scheduler wakeup vs player count | scalability | per-player subscribed-push cache; channel-based fan-out |
| Forbidden-word list maintenance | regulatory | hot-reload from JSON file; admin can update via GM |
| Pay SDK version drift (Quick/Tianji/Ymn) | payment errors | each SDK in its own module with adapter test fixture |
| 4 SDKs (Quick/Tianji/Ymn + Unity) at once | onboarding | consolidate behind single `pay-sdk-adapter.ts` interface |

---

## 6. Definition of Done per task

A task is **Done** when:
1. Code merged to `dev` (no leftover stubs)
2. Tests pass locally (`npm test`)
3. CI green on PR
4. If it changed a protocol: client `Assets/GameAssets/lua/Protocol/generated/*` was **not** touched (client stays frozen; only server side changes)
5. If it added a DB column/table: migration applied in `001` test fixture, no `IF NOT EXISTS` skipped
6. If it touches money: a logged GM rollback command exists
7. If it touches rate limit: k6/loadtest smoke (1k req/min from 1 IP) doesn't break the service
8. README § API table updated
9. Audit report affected items crossed out

---

## 7. Status

| ID | Status | Owner | Notes |
|---|---|---|---|
| M0 | ✅ Done | Hermes agent | 17 files, 11 issues on GitHub |
| DB-013 | ⬜ Todo | DevX | prerequisite for everything else |
| M1-BAT | ⬜ Todo | Senior Backend | blocks M1 |
| M1-RES | ⬜ Todo | Senior Backend | blocks M1 |
| H-FRS / H-FRR / H-FSR | ⬜ Todo | Senior Backend | depends on M1-BAT + M1-RES |
| (rest) | ⬜ Todo | (assigned above) | |
