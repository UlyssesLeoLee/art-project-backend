// Pay SDK adapter interface — every SDK (Quick / Tianji / Ymn) implements this.

export interface PayAdapter {
  name: string
  verifyCallback(payload: Buffer, signature: string): boolean
  parseOrderId(payload: Buffer): string | null
}
