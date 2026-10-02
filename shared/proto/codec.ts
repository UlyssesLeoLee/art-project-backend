// DeepCore-style binary protocol codec.
// Frame: [MessageID u32 BE] [Length varint] [Payload: c2s_/s2c_ fields]
// Integers: S32 = 4-byte BE signed. Varints (VS32) = zigzag + 7-bit groups.
// Strings (UTF): VS32(len) + bytes (no BOM, no NUL).
// Booleans: 1 byte (0/1).
// Nested DTOs: VS32(typeId, optional) + fields, or PutOBJ with named dispatch.
//
// We do NOT auto-generate from Lua; instead we hand-write a registry that mirrors
// the client's Protocol.Serializer map. Field order is critical — must match
// the Lua Read/Write order exactly (c2s_* in Request, s2c_* in Response/Notify).

export type FieldKind = 'S32' | 'VS32' | 'UTF' | 'Bool' | 'OBJ' | 'LIST<OBJ>'

export interface Field {
  name: string
  kind: FieldKind
  /** only used by OBJ/LIST<OBJ>: protocol key in the registry */
  ref?: string
}

export interface Protocol {
  messageId: number
  name: string
  fields: Field[]
}

const codec = {
  buf: Buffer,
  pos: 0,
}

export class BinaryReader {
  private p = 0
  constructor(public readonly buf: Buffer) {}
  remaining() { return this.buf.length - this.p }
  getS32(): number {
    const v = this.buf.readInt32BE(this.p); this.p += 4; return v
  }
  getVS32(): number {
    let n = 0, shift = 0, b: number
    do { b = this.buf[this.p++]; n |= (b & 0x7f) << shift; shift += 7 } while ((b & 0x80) !== 0)
    return (n >>> 1) ^ -(n & 1) // zigzag
  }
  getBool(): boolean {
    const v = this.buf[this.p]; this.p += 1; return v !== 0
  }
  getUTF(): string {
    const len = this.getVS32()
    const s = this.buf.slice(this.p, this.p + len).toString('utf8')
    this.p += len
    return s
  }
  getBytes(n: number): Buffer {
    const out = this.buf.slice(this.p, this.p + n); this.p += n; return out
  }
}

export class BinaryWriter {
  private chunks: Buffer[] = []
  writeS32(v: number) { this.chunks.push(this.buf4(v)) }
  writeVS32(v: number) {
    const zz = (v << 1) ^ (v >> 31) >>> 0
    let n = zz
    const parts: number[] = []
    do { parts.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7 } while (n > 0)
    this.chunks.push(Buffer.from(parts))
  }
  writeBool(v: boolean) { this.chunks.push(Buffer.from([v ? 1 : 0])) }
  writeUTF(s: string) {
    const b = Buffer.from(s, 'utf8')
    this.writeVS32(b.length)
    this.chunks.push(b)
  }
  getBuffer(): Buffer { return Buffer.concat(this.chunks) }
  private buf4(v: number): Buffer {
    const b = Buffer.alloc(4); b.writeInt32BE(v, 0); return b
  }
}

// ----- Registry -----
const REQ = new Map<number, Protocol>()
const REQ_BY_NAME = new Map<string, Protocol>()

export function registerRequest(p: Protocol) {
  if (REQ.has(p.messageId)) throw new Error(`dup MessageID 0x${p.messageId.toString(16)}`)
  REQ.set(p.messageId, p)
  REQ_BY_NAME.set(p.name, p)
}
export function getRequest(id: number) { return REQ.get(id) }
export function getRequestByName(n: string) { return REQ_BY_NAME.get(n) }

// ----- Helpers -----
export function encodeRequest(p: Protocol, fields: Record<string, unknown>): Buffer {
  const w = new BinaryWriter()
  for (const f of p.fields) {
    const v = fields[f.name]
    switch (f.kind) {
      case 'S32': w.writeS32(Number(v ?? 0)); break
      case 'VS32': w.writeVS32(Number(v ?? 0)); break
      case 'Bool': w.writeBool(Boolean(v)); break
      case 'UTF': w.writeUTF(String(v ?? '')); break
      default: throw new Error(`encodeRequest ${p.name}: cannot encode kind ${f.kind}`)
    }
  }
  return w.getBuffer()
}

export function decodeRequest(p: Protocol, buf: Buffer): Record<string, unknown> {
  const r = new BinaryReader(buf)
  const out: Record<string, unknown> = {}
  for (const f of p.fields) {
    switch (f.kind) {
      case 'S32': out[f.name] = r.getS32(); break
      case 'VS32': out[f.name] = r.getVS32(); break
      case 'Bool': out[f.name] = r.getBool(); break
      case 'UTF': out[f.name] = r.getUTF(); break
      default: throw new Error(`decodeRequest ${p.name}: cannot decode kind ${f.kind}`)
    }
  }
  return out
}
