// Pay engine: order state machine + SDK callback verification + reward delivery.

import { QuickAdapter } from './sdk/quick.js'
import { TianjiAdapter } from './sdk/tianji.js'
import { YmnAdapter } from './sdk/ymn.js'
import type { PayAdapter } from './sdk/pay-adapter.js'
import { dispatchRewards, type RewardItem } from './rewards.js'
import type { DatabaseSync } from 'node:sqlite'

const ADAPTERS: Record<string, PayAdapter> = {
  [QuickAdapter.name]: QuickAdapter,
  [TianjiAdapter.name]: TianjiAdapter,
  [YmnAdapter.name]: YmnAdapter,
}

export interface Order {
  roleUuid: string
  goodsId: string
  amount: number
  status: 0 | 1 | 2   // 0=pending 1=paid 2=failed
  sdkName?: string
  sdkOrderId?: string
  createdAt: number
}

const orders = new Map<string, Order>()

export function placeOrder(roleUuid: string, goodsId: string, amount: number) {
  const orderId = 'O' + Math.floor(Date.now()).toString(36) + Math.floor(Math.random() * 1e6).toString(36)
  orders.set(orderId, {
    roleUuid, goodsId, amount, status: 0,
    createdAt: Math.floor(Date.now() / 1000),
  })
  return { s2c_orderId: orderId }
}

export async function handleSdkCallback(
  db: DatabaseSync, sdkName: string, payload: Buffer, signature: string
) {
  const adapter = ADAPTERS[sdkName]
  if (!adapter) return { ok: false, reason: 'UNKNOWN_SDK' }
  if (!adapter.verifyCallback(payload, signature)) return { ok: false, reason: 'BAD_SIGNATURE' }
  const sdkOrderId = adapter.parseOrderId(payload)
  if (!sdkOrderId) return { ok: false, reason: 'NO_ORDER_ID' }
  const order = orders.get(sdkOrderId)
  if (!order) return { ok: false, reason: 'ORDER_NOT_FOUND' }
  order.status = 1
  order.sdkName = sdkName
  order.sdkOrderId = sdkOrderId
  const rewards: RewardItem[] = [
    { type: 'diamond', qty: Math.max(1, Math.floor(order.amount / 100)) },
  ]
  await dispatchRewards(db, order.roleUuid, rewards, `pay_${sdkOrderId}`)
  return { ok: true, orderId: sdkOrderId }
}

export function checkOrder(orderId: string) {
  const order = orders.get(orderId)
  return { s2c_status: order?.status ?? -1, s2c_orderId: orderId }
}

export function syncOrder(orderId: string, status: 0 | 1 | 2) {
  const order = orders.get(orderId)
  if (order) order.status = status
  return { s2c_code: 200 }
}

export function _orderCount(): number { return orders.size }
