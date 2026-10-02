// QuickGame SDK adapter. Signs callback with HMAC-MD5(body, appKey).

import crypto from 'node:crypto'
import type { PayAdapter } from './pay-adapter.js'

export const QuickAdapter: PayAdapter = {
  name: 'quick',
  verifyCallback(payload, signature) {
    const appKey = process.env.QUICK_APP_KEY || 'dev-quick-app-key'
    const expected = crypto.createHmac('md5', appKey).update(payload).digest('hex')
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
