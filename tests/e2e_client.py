#!/usr/bin/env python3
"""E2E integration test: simulates the real Unity client against the live server.

Implements the DeepCore/Pomelo binary protocol exactly as the client does:
  - frame: [type|mask<<4][3-byte LE length][body]
  - PKG_MESSAGE body: [msgType u8][sendId u32 LE][route s32 LE][payload]
  - payload: flattened fields, LE integers, UTF = S16 charcount + UTF-16LE
  - handshake: PKG_HANDSHAKE with user OBJ = S32 messageId + EnterServer fields
  - ack: PKG_HANDSHAKE_ACK with token OBJ = EnterServerResponse fields

Flow: HTTP login -> TCP handshake -> EnterGame -> FightRandomSeed -> FightResult -> verify rewards.
"""
import socket, struct, json, hashlib, base64, time, sys, urllib.request

HOST = '127.0.0.1'
HTTP_PORT = 8080
TCP_PORT = 19821
SECRET = '3dbf6b137a80d10953507929a0216d8b'

# ---------- DeepCore primitives ----------
def w_s32(v): return struct.pack('<i', v)
def w_u32(v): return struct.pack('<I', v)
def w_u8(v): return bytes([v & 0xff])
def w_bool(v): return bytes([1 if v else 0])
def w_utf(s):
    if s is None: return w_s32(-1)[:2]  # PutS16(-1)
    return struct.pack('<h', len(s)) + s.encode('utf-16-le')
def w_obj_null(): return w_s32(-1)
def w_list_empty(): return w_s32(0)

class R:
    def __init__(self, b): self.b = b; self.p = 0
    def u8(self): v = self.b[self.p]; self.p += 1; return v
    def s32(self): v = struct.unpack_from('<i', self.b, self.p)[0]; self.p += 4; return v
    def u32(self): v = struct.unpack_from('<I', self.b, self.p)[0]; self.p += 4; return v
    def s16(self): v = struct.unpack_from('<h', self.b, self.p)[0]; self.p += 2; return v
    def utf(self):
        n = self.s16()
        if n < 0: return None
        s = self.b[self.p:self.p+n*2].decode('utf-16-le'); self.p += n*2; return s
    def rest(self): return self.b[self.p:]

# ---------- frame ----------
def frame(pkg_type, body, msg_type=None, send_id=None, route=None):
    if pkg_type == 4:  # PKG_MESSAGE
        inner = w_u8(msg_type)
        if msg_type != 0:  # not NOTIFY
            inner += w_u32(send_id)
        inner += w_s32(route)
        body = inner + body
    head = bytes([(pkg_type & 0xf)]) + bytes([len(body) & 0xff, (len(body) >> 8) & 0xff, (len(body) >> 16) & 0xff])
    return head + body

def parse_frame(buf):
    pkg = buf[0] & 0xf
    mask = (buf[0] >> 4) & 0xf
    ln = buf[1] | (buf[2] << 8) | (buf[3] << 16)
    return pkg, mask, ln, buf[4:4+ln]

# ---------- HTTP login ----------
def http_login():
    body_dict = {'platform': '0', 'deviceID': 'e2e-dev', 'account': '', 'binVersion': '1.0.0'}
    body_str = json.dumps(body_dict, separators=(',', ':'))
    ts = int(time.time() * 1000)
    sign = hashlib.md5((body_str + SECRET + str(ts)).encode()).hexdigest()
    url = f'http://{HOST}:{HTTP_PORT}/account/login?sign={sign}&timestamp={ts}'
    req = urllib.request.Request(url, data=base64.b64encode(body_str.encode()), method='POST',
                                 headers={'Content-Type': 'application/json'})
    r = urllib.request.urlopen(req, timeout=5)
    return json.loads(r.read().decode())

results = []
def check(name, cond, extra=''):
    results.append((name, cond))
    print(('PASS' if cond else 'FAIL') + f'  {name}' + (f'  [{extra}]' if extra else ''))

print('=== E2E: real DeepCore protocol against live server ===')
login = http_login()
check('HTTP login returns token', 'token' in login, f"accountUUID={login.get('accountUUID','')[:8]}")
token = login['token']; account_uuid = login['accountUUID']; sess_http = login.get('sessionId', 0)

sock = socket.create_connection((HOST, TCP_PORT), timeout=8)
sock.settimeout(8)

def recv_frame():
    head = b''
    while len(head) < 4:
        c = sock.recv(4 - len(head))
        if not c: raise EOFError('closed')
        head += c
    ln = head[1] | (head[2] << 8) | (head[3] << 16)
    body = b''
    while len(body) < ln:
        c = sock.recv(ln - len(body))
        if not c: raise EOFError('closed mid-frame')
        body += c
    return head[0] & 0xf, (head[0] >> 4) & 0xf, body

# ---------- 1. handshake: user OBJ = ClientEnterServerRequest (0x32001) ----------
# fields: c2s_accountUUID UTF, c2s_token UTF, c2s_debug Bool, c2s_sessionId S32
user_payload = w_s32(0x00032001)  # OBJ header = messageId
user_payload += w_utf(account_uuid) + w_utf(token) + w_bool(False) + w_s32(sess_http)
# SystemHandshake: PutObj(user) + PutUTF(local_info)
hs_body = user_payload + w_utf('e2e-test-client')
sock.sendall(frame(1, hs_body))  # PKG_HANDSHAKE

pkg, mask, ack_body = recv_frame()
check('handshake ack received (PKG_HANDSHAKE_ACK)', pkg == 2, f'pkg={pkg}')
# ack: token OBJ (s32 msgid + EnterServerResponse fields) + UTF remote_info + VS32 heartbeat
ar = R(ack_body)
token_msgid = ar.s32()
check('ack token is EnterServerResponse (0x32002)', token_msgid == 0x00032002, f'id=0x{token_msgid:08X}')
# ClientEnterServerResponse fields: s2c_code S32, s2c_msg UTF, InnerResponse OBJ, s2c_notifys LIST, s2c_sessionId S32
s2c_code = ar.s32(); s2c_msg = ar.utf(); inner = ar.s32(); notifys = ar.s32(); s2c_sess = ar.s32()
check('ack s2c_code == 200', s2c_code == 200, f'code={s2c_code} msg={s2c_msg}')
remote_info = ar.utf(); hb = ar.s32()
check('heartbeat interval announced', hb > 0, f'hb={hb}ms remote={remote_info}')

# ---------- 2. EnterGame (0x33001) ----------
req_id = 1
eg = w_s32(req_id)  # c2s_requestId (parent ClientRequest... wait parent is DeepCore.Request, no requestId)
# ClientEnterGameRequest parent = DeepCore.Protocol.Request -> no c2s_requestId
eg = b''
eg += w_utf(account_uuid) + w_utf('s10001') + w_s32(0) + w_utf('e2e-dev')
eg += w_utf('Windows') + w_utf('10') + w_utf('1.0.0') + w_utf('+08:00')
eg += w_utf('channel') + w_utf('af-0') + w_utf('source') + w_utf('127.0.0.1')
eg += w_utf('1.0.0') + w_utf('com.test.app')
sock.sendall(frame(4, eg, msg_type=1, send_id=101, route=0x00033001))
pkg, mask, body = recv_frame()
mr = R(body)
mt = mr.u8(); sid = mr.u32(); route = mr.s32()
check('EnterGame response frame', pkg == 4 and mt == 2 and sid == 101, f'pkg={pkg} mt={mt} sid={sid}')
check('EnterGame route = 0x33002', route == 0x00033002, f'route=0x{route:08X}')
code = mr.s32(); msg = mr.utf()
check('EnterGame s2c_code == 200', code == 200, f'code={code} msg={msg}')
# skip InnerResponse OBJ + notifys LIST + rest
inner = mr.s32(); notifys = mr.s32()
user_source = mr.utf(); new_role = mr.u8(); waiting = mr.s32()
check('EnterGame decoded fields', user_source == 'server' and waiting == 0, f'src={user_source} newRole={new_role}')

# ---------- 3. FightRandomSeed (0x35201) ----------
# fields: c2s_requestId S32, FightMod S32, StageId S32
seed_req = w_s32(7) + w_s32(1) + w_s32(100)
sock.sendall(frame(4, seed_req, msg_type=1, send_id=102, route=0x00035201))
pkg, mask, body = recv_frame()
mr = R(body)
mt = mr.u8(); sid = mr.u32(); route = mr.s32()
check('FightRandomSeed response route = 0x35202', route == 0x00035202, f'route=0x{route:08X} sid={sid}')
code = mr.s32(); msg = mr.utf(); inner = mr.s32(); notifys = mr.s32()
random_uuid = mr.utf(); upd_mod = mr.s32(); upd_stage = mr.s32()
need_dmg = mr.s32(); need_replay = mr.s32(); random_seed = mr.s32()
diff_rank = mr.s32(); dyn_diff = mr.s32(); check_power = mr.s32()
check('FightRandomSeed s2c_code == 200', code == 200, f'code={code}')
check('seed issued (uuid+seed)', bool(random_uuid) and random_seed >= 0, f'uuid={random_uuid[:8]} seed={random_seed}')

# ---------- 4. FightResult (0x35203) ----------
# fields: c2s_requestId S32, FightMod S32, StageId S32, RandomUuid UTF, ResultInfo OBJ
res_req = w_s32(8) + w_s32(1) + w_s32(100) + w_utf(random_uuid)
# ResultInfo OBJ: FightResultInfo {Time F64, Result S32, battle_info OBJ, unit_statistics MAP, operation_list LIST}
res_req += w_s32(0x3549BE70)  # FightResultInfo messageId
res_req += struct.pack('<d', 1.0)  # Time F64
res_req += w_s32(1)  # Result = win
res_req += w_obj_null()  # battle_info null
res_req += w_list_empty()  # unit_statistics MAP empty (VS32 count=0)
res_req += w_list_empty()  # operation_list empty
sock.sendall(frame(4, res_req, msg_type=1, send_id=103, route=0x00035203))
# Server may send the ClientCommonNotify push (route 0x35001, MSG_NOTIFY) and the
# FightResult response (route 0x35204, MSG_RESPONSE) in either order. Read frames
# until we've seen both (or timeout).
got_result = False; got_notify = False; result_code = None; result_msg = None
sock.settimeout(3)
deadline = time.time() + 5
while time.time() < deadline and not (got_result and got_notify):
    try:
        pkg, mask, body = recv_frame()
    except (socket.timeout, EOFError):
        break
    if pkg != 4:
        continue
    mr = R(body)
    mt = mr.u8()
    if mt == 0:  # NOTIFY: no sendId
        route = mr.s32()
        if route == 0x00035001:
            got_notify = True
    else:
        sid = mr.u32(); route = mr.s32()
        if route == 0x00035204 and sid == 103:
            got_result = True
            result_code = mr.s32(); result_msg = mr.utf()
check('FightResult response route = 0x35204', got_result, f'code={result_code} msg={result_msg}')
check('FightResult s2c_code == 200', result_code == 200, f'code={result_code}')
check('ClientCommonNotify pushed after battle win', got_notify)
sock.settimeout(8)

# ---------- 5. Tower / Dungeon / Guild / SignIn (new handler wiring) ----------
def rpc(send_id, route, payload, expect_route, label, timeout=4):
    sock.sendall(frame(4, payload, msg_type=1, send_id=send_id, route=route))
    sock.settimeout(timeout)
    deadline = time.time() + timeout + 2
    while time.time() < deadline:
        try:
            pkg, mask, body = recv_frame()
        except (socket.timeout, EOFError):
            check(label, False, 'timeout')
            return None
        if pkg != 4:
            continue
        mr = R(body)
        mt = mr.u8()
        if mt == 0:
            continue  # skip pushes
        sid = mr.u32(); rt = mr.s32()
        if sid == send_id and rt == expect_route:
            code = mr.s32(); msg = mr.utf()
            check(label, code == 200, f'code={code} msg={msg}')
            return mr
    check(label, False, 'no matching response')
    return None

# QueryTowerInfo 0x35601 -> 0x35602
rpc(201, 0x00035601, w_s32(9), 0x00035602, 'QueryTowerInfo 200')
# ChallengeTowerEnd (win) 0x35605 -> 0x35606, fields: reqId, towerID, level, isWin
rpc(202, 0x00035605, w_s32(10) + w_s32(1) + w_s32(5) + w_bool(True), 0x00035606, 'ChallengeTowerEnd win 200')
# GetDungeonOpt 0x38701 -> 0x38702, fields: reqId, type
rpc(203, 0x00038701, w_s32(11) + w_s32(1), 0x00038702, 'GetDungeonOpt 200')
# ChallengeDungeonEnd (win) 0x38705 -> 0x38706
rpc(204, 0x00038705, w_s32(12) + w_s32(1) + w_s32(100) + w_bool(True), 0x00038706, 'ChallengeDungeonEnd win 200')
# RecommendGuildList 0x35902 -> 0x35903 (reqId only)
rpc(205, 0x00035902, w_s32(13), 0x00035903, 'RecommendGuildList 200')
# CreateGuild 0x35908 -> 0x35909: reqId, name, icon
rpc(206, 0x00035908, w_s32(14) + w_utf('E2EGuild') + w_utf(''), 0x00035909, 'CreateGuild 200')
# LoginSignInfo 0x50501 -> 0x50502: reqId, id
rpc(207, 0x00050501, w_s32(15) + w_s32(1), 0x00050502, 'LoginSignInfo 200')
# LoginSignReward 0x50503 -> 0x50504: reqId, id, day
rpc(208, 0x00050503, w_s32(16) + w_s32(1) + w_s32(1), 0x00050504, 'LoginSignReward day1 200')
# ChatMuteState 0x38310 -> 0x38311: reqId only
rpc(209, 0x00038310, w_s32(17), 0x00038311, 'ChatMuteState 200')
# EnterArena 0x39009 -> 0x3900A: reqId only
rpc(210, 0x00039009, w_s32(19), 0x0003900A, 'EnterArena 200')
# Unimplemented protocol -> schema-default 200 (e.g. ClientGetMailListRequest if exists; use a random known one)
# ClientChatWorldChannelList 0x3830B -> 0x3830C (reqId only)
rpc(211, 0x0003830B, w_s32(18), 0x0003830C, 'Unimplemented proto returns schema-default 200')

# ---------- 6. heartbeat ----------
sock.settimeout(5)
sock.sendall(frame(3, b''))  # PKG_HEARTBEAT
pkg, mask, body = recv_frame()
check('heartbeat echoed', pkg == 3, f'pkg={pkg}')

sock.close()
print()
passed = sum(1 for _, c in results if c)
print(f'=== E2E RESULT: {passed}/{len(results)} pass ===')
sys.exit(0 if passed == len(results) else 1)
