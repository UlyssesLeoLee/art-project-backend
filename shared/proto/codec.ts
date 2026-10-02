// DeepCore binary protocol codec — faithful reimplementation of the client's
// DeepCore.IO.OutputStream/InputStream (verified against decompiled DeepCore.dll).
//
// Primitive wire formats (USE_VLQ=false, factory=null on the Lua runtime path):
//   Bool     1 byte (0/1)
//   U8/Enum8 1 byte
//   S16      2 bytes LE          U16  2 bytes LE
//   S32      4 bytes LE          U32  4 bytes LE
//   S64      8 bytes LE          U64  8 bytes LE (BigInt)
//   F32      4 bytes LE IEEE754  F64  8 bytes LE IEEE754
//   UTF      S16 charCount + UTF-16LE bytes  (-1 = null, 0 = empty)
//   VS32/VS64/VU32/VU64          identical to S32/S64/U32/U64 when USE_VLQ=false
//   DateTime VS64(DateTime.ToBinary())       TimeSpan VU64(TotalMilliseconds)
//   Bytes    S32 length + raw bytes          (-1 = null)
//   OBJ      S32 messageID + object fields   (-1 = null)
//   LIST/ARRAY  S32 count + elements         (-1 = null)
//   MAP      S32 count + (key,val) pairs     (-1 = null)
//
// Frame (Pomelo binary, IProtocol):
//   [head byte: pkgType | mask<<4][length 3 bytes LE = bytes after this 4-byte head]
//   PKG_MESSAGE body: [msgType u8][sendId u32 LE (unless NOTIFY)][route s32 LE][payload]
//   Payload = protocol fields flattened (parent-class fields first).
//
// PackageType: 1=HANDSHAKE 2=HANDSHAKE_ACK 3=HEARTBEAT 4=MESSAGE 5=KICK
// MessageType: 0=NOTIFY 1=REQUEST_C2S 2=RESPONSE_S2C 3=RPC_REQUEST 4=RPC_RESPONSE

export type FieldKind =
  | 'S32' | 'S64' | 'U8' | 'Enum8' | 'F32' | 'F64' | 'Bool' | 'UTF'
  | 'DateTime' | 'TimeSpan' | 'OBJ' | 'LIST' | 'ARRAY' | 'MAP'

export interface Field {
  name: string
  kind: FieldKind
  ref?: string | null          // OBJ type name
  elemKind?: FieldKind          // LIST/ARRAY element
  elemRef?: string | null       // LIST/ARRAY OBJ element type
  elem?: Field                  // LIST/ARRAY nested LIST/MAP element
  keyKind?: FieldKind
  keyRef?: string | null
  valKind?: FieldKind
  valRef?: string | null
  valElem?: Field               // MAP nested LIST/MAP value
}

export interface Protocol {
  messageId: number
  name: string
  shortName: string
  parent: string | null
  fields: Field[]
}

export const PackageType = {
  PKG_HANDSHAKE: 1,
  PKG_HANDSHAKE_ACK: 2,
  PKG_HEARTBEAT: 3,
  PKG_MESSAGE: 4,
  PKG_KICK: 5,
} as const

export const MessageType = {
  MSG_NOTIFY: 0,
  MSG_REQUEST_C2S: 1,
  MSG_RESPONSE_S2C: 2,
  MSG_RPC_REQUEST_S2C: 3,
  MSG_RPC_RESPONSE_C2S: 4,
} as const

export const NULL_MESSAGE_CODE = -1

// ---------------- BinaryReader (mirrors DeepCore.IO.InputStream) ----------------

export class BinaryReader {
  private p = 0
  constructor(public readonly buf: Buffer) {}
  get position() { return this.p }
  remaining() { return this.buf.length - this.p }
  getBool(): boolean { return this.buf[this.p++] !== 0 }
  getU8(): number { return this.buf[this.p++] }
  getS16(): number { const v = this.buf.readInt16LE(this.p); this.p += 2; return v }
  getU16(): number { const v = this.buf.readUInt16LE(this.p); this.p += 2; return v }
  getS32(): number { const v = this.buf.readInt32LE(this.p); this.p += 4; return v }
  getU32(): number { const v = this.buf.readUInt32LE(this.p); this.p += 4; return v }
  getS64(): bigint { const v = this.buf.readBigInt64LE(this.p); this.p += 8; return v }
  getF32(): number { const v = this.buf.readFloatLE(this.p); this.p += 4; return v }
  getF64(): number { const v = this.buf.readDoubleLE(this.p); this.p += 8; return v }
  getUTF(): string | null {
    const n = this.getS16()
    if (n < 0) return null
    if (n === 0) return ''
    const s = this.buf.toString('utf16le', this.p, this.p + n * 2)
    this.p += n * 2
    return s
  }
  getBytes(): Buffer | null {
    const n = this.getS32()
    if (n < 0) return null
    const b = this.buf.subarray(this.p, this.p + n)
    this.p += n
    return Buffer.from(b)
  }
}

// ---------------- BinaryWriter (mirrors DeepCore.IO.OutputStream) ----------------

export class BinaryWriter {
  private chunks: Buffer[] = []
  writeBool(v: boolean) { this.chunks.push(Buffer.from([v ? 1 : 0])) }
  writeU8(v: number) { const b = Buffer.alloc(1); b[0] = v & 0xff; this.chunks.push(b) }
  writeS16(v: number) { const b = Buffer.alloc(2); b.writeInt16LE(v | 0, 0); this.chunks.push(b) }
  writeS32(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); this.chunks.push(b) }
  writeU32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); this.chunks.push(b) }
  writeS64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v, 0); this.chunks.push(b) }
  writeF32(v: number) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); this.chunks.push(b) }
  writeF64(v: number) { const b = Buffer.alloc(8); b.writeDoubleLE(v, 0); this.chunks.push(b) }
  writeUTF(s: string | null | undefined) {
    if (s == null) { this.writeS16(-1); return }
    this.writeS16(s.length)
    if (s.length) this.chunks.push(Buffer.from(s, 'utf16le'))
  }
  writeRaw(b: Buffer) { this.chunks.push(b) }
  getBuffer(): Buffer { return Buffer.concat(this.chunks) }
  get length(): number { return this.chunks.reduce((n, c) => n + c.length, 0) }
}

// ---------------- Registry ----------------

const BY_ID = new Map<number, Protocol>()
const BY_NAME = new Map<string, Protocol>()
const BY_SHORT = new Map<string, Protocol>()

export function registerProtocol(p: Protocol) {
  if (p.messageId !== 0) BY_ID.set(p.messageId, p)
  BY_NAME.set(p.name, p)
  if (!BY_SHORT.has(p.shortName)) BY_SHORT.set(p.shortName, p)
}

export function getProtocolById(id: number): Protocol | undefined { return BY_ID.get(id) }
export function getProtocolByName(n: string): Protocol | undefined { return BY_NAME.get(n) }
export function getProtocolByShort(n: string): Protocol | undefined { return BY_SHORT.get(n) }
export function allProtocols(): IterableIterator<Protocol> { return BY_NAME.values() }
export function protocolCount(): number { return BY_NAME.size }

// Request -> Response pairing: XxxRequest -> XxxResponse (short-name convention)
const RESP_OF = new Map<number, number>()
export function buildResponseMap() {
  for (const p of BY_NAME.values()) {
    if (!p.shortName.endsWith('Request')) continue
    const resp = BY_SHORT.get(p.shortName.slice(0, -7) + 'Response')
    if (resp) RESP_OF.set(p.messageId, resp.messageId)
  }
}
export function responseIdFor(reqId: number): number | undefined { return RESP_OF.get(reqId) }

// ---------------- Field-level encode/decode ----------------

function readScalar(r: BinaryReader, kind: FieldKind): unknown {
  switch (kind) {
    case 'S32': return r.getS32()
    case 'U8': case 'Enum8': return r.getU8()
    case 'Bool': return r.getBool()
    case 'UTF': return r.getUTF()
    case 'S64': return r.getS64()
    case 'F32': return r.getF32()
    case 'F64': return r.getF64()
    case 'DateTime': return r.getS64()   // VS64 ToBinary, USE_VLQ=false
    case 'TimeSpan': return r.getS64()   // VU64 ms
    default: throw new Error(`readScalar: unsupported ${kind}`)
  }
}

function writeScalar(w: BinaryWriter, kind: FieldKind, v: unknown) {
  switch (kind) {
    case 'S32': w.writeS32(Number(v ?? 0)); break
    case 'U8': case 'Enum8': w.writeU8(Number(v ?? 0)); break
    case 'Bool': w.writeBool(Boolean(v)); break
    case 'UTF': w.writeUTF(v == null ? null : String(v)); break
    case 'S64': w.writeS64(typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v ?? 0)))); break
    case 'F32': w.writeF32(Number(v ?? 0)); break
    case 'F64': w.writeF64(Number(v ?? 0)); break
    case 'DateTime': w.writeS64(typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v ?? 0)))); break
    case 'TimeSpan': w.writeS64(typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v ?? 0)))); break
    default: throw new Error(`writeScalar: unsupported ${kind}`)
  }
}

function isScalar(k: FieldKind): boolean {
  return k !== 'OBJ' && k !== 'LIST' && k !== 'ARRAY' && k !== 'MAP'
}

function readElem(r: BinaryReader, kind: FieldKind, ref?: string | null, nested?: Field): unknown {
  if (isScalar(kind)) return readScalar(r, kind)
  if (kind === 'OBJ') {
    const id = r.getS32()
    if (id === NULL_MESSAGE_CODE) return null
    const p = BY_ID.get(id) || (ref ? BY_NAME.get(ref) : undefined)
    if (!p) throw new Error(`readElem OBJ: unknown typeId ${id} ref=${ref}`)
    return readFields(r, p)
  }
  if (kind === 'LIST' || kind === 'ARRAY') {
    const n = r.getS32()
    if (n < 0) return null
    const out: unknown[] = []
    const ek = nested?.elemKind ?? (nested as any)?.kind ?? 'S32'
    const eref = nested?.elemRef ?? null
    const einner = nested?.elem
    for (let i = 0; i < n; i++) out.push(readElem(r, ek as FieldKind, eref, einner))
    return out
  }
  if (kind === 'MAP') {
    const n = r.getS32()
    if (n < 0) return null
    const out: Record<string, unknown> = {}
    const kk = nested?.keyKind ?? 'S32'
    const vk = nested?.valKind ?? 'S32'
    for (let i = 0; i < n; i++) {
      const key = readElem(r, kk as FieldKind, nested?.keyRef)
      const val = readElem(r, vk as FieldKind, nested?.valRef, nested?.valElem)
      out[String(key)] = val
    }
    return out
  }
  throw new Error(`readElem: unsupported ${kind}`)
}

function writeElem(w: BinaryWriter, kind: FieldKind, v: unknown, ref?: string | null, nested?: Field) {
  if (isScalar(kind)) { writeScalar(w, kind, v); return }
  if (kind === 'OBJ') {
    if (v == null) { w.writeS32(NULL_MESSAGE_CODE); return }
    const p = ref ? BY_NAME.get(ref) : undefined
    const proto = p || (typeof v === 'object' && '__proto_id' in (v as any) ? BY_ID.get((v as any).__proto_id) : undefined)
    if (!proto) { w.writeS32(NULL_MESSAGE_CODE); return }
    w.writeS32(proto.messageId)
    writeFields(w, proto, v as Record<string, unknown>)
    return
  }
  if (kind === 'LIST' || kind === 'ARRAY') {
    if (!Array.isArray(v)) { w.writeS32(NULL_MESSAGE_CODE); return }
    w.writeS32(v.length)
    const ek = nested?.elemKind ?? (nested as any)?.kind ?? 'S32'
    const eref = nested?.elemRef ?? null
    const einner = nested?.elem
    for (const item of v) writeElem(w, ek as FieldKind, item, eref, einner)
    return
  }
  if (kind === 'MAP') {
    if (v == null || typeof v !== 'object') { w.writeS32(NULL_MESSAGE_CODE); return }
    const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as Record<string, unknown>)
    w.writeS32(entries.length)
    const kk = nested?.keyKind ?? 'S32'
    const vk = nested?.valKind ?? 'S32'
    for (const [key, val] of entries) {
      writeElem(w, kk as FieldKind, coerceKey(kk as FieldKind, key), nested?.keyRef)
      writeElem(w, vk as FieldKind, val, nested?.valRef, nested?.valElem)
    }
    return
  }
  throw new Error(`writeElem: unsupported ${kind}`)
}

function coerceKey(kind: FieldKind, key: string): unknown {
  if (kind === 'S32' || kind === 'S64') return Number(key)
  return key
}

export function readFields(r: BinaryReader, p: Protocol): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of p.fields) {
    out[f.name] = readElem(r, f.kind, f.ref ?? f.elemRef ?? null, f.elem ?? f.valElem ?? (f as any))
  }
  return out
}

export function writeFields(w: BinaryWriter, p: Protocol, obj: Record<string, unknown>) {
  for (const f of p.fields) {
    writeElem(w, f.kind, obj[f.name], f.ref ?? null, (f as any))
  }
}

export function decodeBody(p: Protocol, payload: Buffer): Record<string, unknown> {
  return readFields(new BinaryReader(payload), p)
}

export function encodeBody(p: Protocol, obj: Record<string, unknown>): Buffer {
  const w = new BinaryWriter()
  writeFields(w, p, obj)
  return w.getBuffer()
}

// ---------------- Frame (de)serialization ----------------

export interface Frame {
  pkgType: number
  mask: number
  msgType: number       // only for PKG_MESSAGE
  sendId: number        // only for non-NOTIFY messages
  route: number         // MessageID (only for PKG_MESSAGE)
  payload: Buffer       // protocol body
  system?: Record<string, unknown> // decoded SystemMessage for handshake/heartbeat/kick
}

export function decodeHead(buf: Buffer): { pkgType: number; mask: number; length: number } | null {
  if (buf.length < 4) return null
  const b0 = buf[0]
  return {
    pkgType: b0 & 0xf,
    mask: (b0 >> 4) & 0xf,
    length: buf[1] | (buf[2] << 8) | (buf[3] << 16),
  }
}

export function decodeFrame(buf: Buffer): Frame {
  const head = decodeHead(buf)
  if (!head) throw new Error('frame too short')
  const body = buf.subarray(4, 4 + head.length)
  const f: Frame = { pkgType: head.pkgType, mask: head.mask, msgType: 0, sendId: 0, route: 0, payload: Buffer.alloc(0) }
  if (head.pkgType === PackageType.PKG_MESSAGE) {
    const r = new BinaryReader(body)
    f.msgType = r.getU8()
    if (f.msgType !== MessageType.MSG_NOTIFY) f.sendId = r.getU32()
    f.route = r.getS32()
    f.payload = Buffer.from(body.subarray(r.position))
  } else if (head.pkgType === PackageType.PKG_HANDSHAKE) {
    // SystemHandshake: PutObj(user) + PutUTF(local_info)
    const r = new BinaryReader(body)
    const userId = r.getS32()
    const system: Record<string, unknown> = { local_info: null }
    if (userId !== NULL_MESSAGE_CODE) {
      const p = BY_ID.get(userId)
      system.user = p ? readFields(r, p) : null
      system.userMessageId = userId
    } else {
      system.user = null
    }
    system.local_info = r.getUTF()
    f.system = system
  } else if (head.pkgType === PackageType.PKG_HEARTBEAT) {
    const r = new BinaryReader(body)
    f.system = { time: r.remaining() >= 8 ? r.getS64() : 0n }
  } else if (head.pkgType === PackageType.PKG_KICK) {
    const r = new BinaryReader(body)
    f.system = { reason: r.getUTF() }
  }
  return f
}

export function encodeFrame(f: {
  pkgType: number; msgType?: number; sendId?: number; route?: number;
  payload?: Buffer; system?: Record<string, unknown>;
  tokenProto?: Protocol; tokenObj?: Record<string, unknown>
}): Buffer {
  let body: Buffer
  if (f.pkgType === PackageType.PKG_MESSAGE) {
    const w = new BinaryWriter()
    const mt = f.msgType ?? MessageType.MSG_RESPONSE_S2C
    w.writeU8(mt)
    if (mt !== MessageType.MSG_NOTIFY) w.writeU32(f.sendId ?? 0)
    w.writeS32(f.route ?? 0)
    if (f.payload?.length) w.writeRaw(f.payload)
    body = w.getBuffer()
  } else if (f.pkgType === PackageType.PKG_HANDSHAKE_ACK) {
    // SystemHandshakeAck: PutObj(token) + PutUTF(remote_info) + PutVS32(heartbeat_interval_ms)
    const w = new BinaryWriter()
    if (f.tokenProto && f.tokenObj) {
      w.writeS32(f.tokenProto.messageId)
      writeFields(w, f.tokenProto, f.tokenObj)
    } else {
      w.writeS32(NULL_MESSAGE_CODE) // token = null
    }
    w.writeUTF(f.system?.remote_info != null ? String(f.system.remote_info) : '')
    w.writeS32(Number(f.system?.heartbeat_interval_ms ?? 0)) // VS32 fixed (USE_VLQ=false)
    body = w.getBuffer()
  } else if (f.pkgType === PackageType.PKG_HEARTBEAT) {
    const w = new BinaryWriter()
    w.writeS64(typeof f.system?.time === 'bigint' ? f.system.time : BigInt(Number(f.system?.time ?? Date.now()))) // VS64 fixed
    body = w.getBuffer()
  } else if (f.pkgType === PackageType.PKG_KICK) {
    const w = new BinaryWriter()
    w.writeUTF(f.system?.reason != null ? String(f.system.reason) : '')
    body = w.getBuffer()
  } else {
    body = f.payload ?? Buffer.alloc(0)
  }
  const head = Buffer.alloc(4)
  head[0] = (f.pkgType & 0xf) | ((0 & 0xf) << 4) // mask=0 (no compression)
  head[1] = body.length & 0xff
  head[2] = (body.length >> 8) & 0xff
  head[3] = (body.length >> 16) & 0xff
  return Buffer.concat([head, body])
}

// Build a full response frame for a request
export function encodeResponse(reqSendId: number, respRoute: number, respProto: Protocol, obj: Record<string, unknown>): Buffer {
  return encodeFrame({
    pkgType: PackageType.PKG_MESSAGE,
    msgType: MessageType.MSG_RESPONSE_S2C,
    sendId: reqSendId,
    route: respRoute,
    payload: encodeBody(respProto, obj),
  })
}

// Build a server push (notify) frame
export function encodePush(route: number, proto: Protocol, obj: Record<string, unknown>): Buffer {
  return encodeFrame({
    pkgType: PackageType.PKG_MESSAGE,
    msgType: MessageType.MSG_NOTIFY,
    route,
    payload: encodeBody(proto, obj),
  })
}