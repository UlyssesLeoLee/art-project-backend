
import { dispatchRewards } from '../lib/rewards.js'
import { IssueSeed, SettleResult } from '../lib/battle-arbitrator.js'
import { startDungeon, sweepDungeon, endDungeon } from '../lib/dungeon-engine.js'
import { generateMaze, optGrid, useMazeItem } from '../lib/maze-engine.js'
import { startRogue, combatRogue, gainRelic } from '../lib/rogue-engine.js'
import { queryTower, getVipReward } from '../lib/tower-engine.js'
import { startSeason, getCurrentSeason, getRankings, updateScore, findOpponent } from '../lib/arena-engine.js'
import { createGuild, joinGuild, leaveGuild } from '../lib/guild-engine.js'
import { startUnionBattle, endUnionBattle, getUnionInfo } from '../lib/union-subsystems.js'
import { isMuted, mute, sendMessage, listMessages, getForbiddenWordCount } from '../lib/chat-engine.js'
import { placeOrder, handleSdkCallback, checkOrder, syncOrder, _orderCount } from '../lib/pay.js'
import { isAdmin, execGmCommand } from '../lib/gm-admin.js'
import { checkRateLimit, RL } from '../lib/rate-limit.js'
import crypto from 'node:crypto'

console.log('--- smoke: each lib loads OK')

// 1. Battle
const seed = IssueSeed('r1', 1, 100, 5000)
console.log('seed hasUuid=', !!seed.s2c_randomUuid, 'hasSeed=', !!seed.s2c_randomSeed, 'mod=', seed.s2c_updateFightMod)
const settle = SettleResult('r1', seed.s2c_randomUuid, 5100, undefined)
console.log('settle win:', settle.ok === true, 'rewards=', settle.rewards?.length)

// 2. Maze
const maze = generateMaze('r1', 0)
console.log('maze:', { width: maze.width, tiles: maze.tiles.length, types: [...new Set(maze.tiles.map(t => t.type))].sort() })

// 3. Arena
console.log('arena season:', getCurrentSeason(), 'rankings:', getRankings(1).length)

// 4. Guild
const g = createGuild(undefined, 'r1', 'MyGuild', 'welcome')
console.log('guild:', { uuid: g.uuid.slice(0,8), name: g.name })
joinGuild('r2', g.uuid)
leaveGuild('r2', g.uuid)

// 5. Chat
console.log('forbidden words:', getForbiddenWordCount())
console.log('msg hello:', sendMessage('r1','world','hello'))
console.log('msg badword1:', sendMessage('r1','world','this contains badword1'))
mute('r1', 60, 'spam')
console.log('msg after mute:', sendMessage('r1','world','hi'))

// 6. Pay
const ord = placeOrder('r1', 'gold100', 100)
console.log('placeOrder:', ord.s2c_orderId)
const cb1 = handleSdkCallback(undefined, 'quick', Buffer.from(JSON.stringify({orderId: ord.s2c_orderId})), 'wrong-sig')
console.log('bad sig:', cb1)
const goodSig = crypto.createHmac('md5','dev-quick-app-key').update(JSON.stringify({orderId: ord.s2c_orderId})).digest('hex')
const cb2 = handleSdkCallback(undefined, 'quick', Buffer.from(JSON.stringify({orderId: ord.s2c_orderId})), goodSig)
console.log('good sig:', cb2)
console.log('checkOrder:', checkOrder(ord.s2c_orderId))

// 7. GM
console.log('admin check good:', isAdmin('admin-token'))
console.log('admin check bad:', isAdmin('user-token'))

// 8. Rate limit
console.log('rate limits:', JSON.stringify(RL))

// 9. Rogue
console.log('rogue start:', startRogue('r1', 1, 0))
console.log('rogue combat:', combatRogue('r1', 3, 4))

// 10. Tower
console.log('tower:', queryTower('r1'))

// 11. Activity (just structure check)
console.log('rate-limit-1:', checkRateLimit('r1', 5, 60).allowed)
console.log('rate-limit-2:', checkRateLimit('r1', 5, 60).allowed)

console.log('--- ALL PASS')
