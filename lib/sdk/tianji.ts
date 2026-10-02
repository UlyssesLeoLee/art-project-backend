// Tianji SDK adapter. Signs callback with HMAC-SHA256(body, appKey).

import crypto from 'node:crypto'
import type { PayAdapter } from './pay-adapter.js'

export const TianjiAdapter: PayAdapter = {
  name: 'tianji',
  verifyCallback(payload, signature) {
    const appKey = process.env.TIANJI_APP_KEY || 'dev-tianji-app-key'
    const expected = crypto.createHmac('sha256', appKey).update(payload).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch {
      return false
    }
  },
  parseOrderId(payload) {
    try { return JSON.parse(payload.toString('utf8')).orderId ?? null } catch { return null }
  },
}
