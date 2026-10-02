// YmnSdk adapter. Signs callback with MD5(body + appKey).

import crypto from 'node:crypto'
import type { PayAdapter } from './pay-adapter.js'

export const YmnAdapter: PayAdapter = {
  name: 'ymn',
  verifyCallback(payload, signature) {
    const appKey = process.env.YMN_APP_KEY || 'dev-ymn-app-key'
    const expected = crypto.createHash('md5').update(payload.toString('utf8') + appKey).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch {
      return false
    }
  },
  parseOrderId(payload) {
    try { return JSON.parse(payload.toString('utf8')).session ?? null } catch { return null }
  },
}
