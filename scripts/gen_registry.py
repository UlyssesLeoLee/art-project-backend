#!/usr/bin/env python3
"""Generate shared/proto/protocols.json from the Unity client's Lua protocol corpus.

Parses every Assets/GameAssets/lua/Protocol/generated/*.lua file:
  - extracts MessageID + full Name
  - parses the Write() body: parent-class Write call (inheritance) + ordered PutXXX(data.Field...) lines
  - resolves inheritance chains recursively (base-first field order)

Output: protocols.json = { "FullName": { messageId, name, shortName, parent, ownFields[], fields[] } }
where fields[] is the FLATTENED ordered list (parent fields first, then own fields).

Field kinds mirror LuaOutputStream: S32 U8 S64 F32 F64 Bool UTF Enum8 DateTime TimeSpan
  OBJ(ref)  LIST(elemKind,elemRef)  ARRAY(elemKind,elemRef)  MAP(keyKind,keyRef,valKind,valRef)
"""
import os, re, json, sys

GEN = r'\\LS220D088\webaxs\backupProjects\art-project-client\Assets\GameAssets\lua\Protocol\generated'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'shared/proto/protocols.json'

PRIM = {'PutS32':'S32','PutU8':'U8','PutS64':'S64','PutF32':'F32','PutF64':'F64',
        'PutBool':'Bool','PutUTF':'UTF','PutEnum8':'Enum8','PutDateTime':'DateTime',
        'PutTimeSpan':'TimeSpan','PutBytes':'Bytes'}


INLINE_LIST = re.compile(r"function\s*\([^)]*\)\s*output:PutList\(\s*\w+\s*,\s*output\.(Put\w+)\s*(?:,\s*'([^']+)')?\s*\)\s*end")
INLINE_MAP = re.compile(r"function\s*\([^)]*\)\s*output:PutMap\(\s*\w+\s*,\s*output\.(Put\w+)\s*,\s*(?:output\.(Put\w+)|function[^)]*\)\s*output:Put(?:List|Map)\([^)]*\)\s*end)\s*(?:,\s*'([^']*)')?\s*(?:,\s*'([^']*)')?\s*\)\s*end")

def parse_elem(fn_spec, type_str=None):
    """Parse one element serializer: fn like 'output.PutS32' or an inline function,
    plus optional type template string (quoted). Returns dict describing encoding."""
    fn_spec = (fn_spec or '').strip()
    if type_str:
        type_str = type_str.strip().strip("'")
    if fn_spec.startswith('function'):
        m = INLINE_LIST.search(fn_spec)
        if m:
            put, tref = m.group(1), m.group(2)
            if put in ('PutOBJ', 'PutRouteOBJ') and tref:
                return {'kind': 'LIST', 'elemKind': 'OBJ', 'elemRef': tref}
            return {'kind': 'LIST', 'elemKind': PRIM.get(put, 'S32')}
        m = INLINE_MAP.search(fn_spec)
        if m:
            kf, vf, kt, vt = m.group(1), m.group(2), m.group(3), m.group(4)
            out = {'kind': 'MAP'}
            if kf in ('PutOBJ', 'PutRouteOBJ') and kt:
                out['keyKind'] = 'OBJ'; out['keyRef'] = kt
            else:
                out['keyKind'] = PRIM.get(kf, 'S32')
            if vf in ('PutOBJ', 'PutRouteOBJ') and vt:
                out['valKind'] = 'OBJ'; out['valRef'] = vt
            elif vf:
                out['valKind'] = PRIM.get(vf, 'S32')
            else:
                out['valKind'] = 'S32'
            return out
        return {'kind': 'MAP', 'keyKind': 'S32', 'valKind': 'S32', '_inline': fn_spec[:100]}
    m = re.match(r"output\.(Put\w+)$", fn_spec)
    if m:
        put = m.group(1)
        if put in ('PutOBJ', 'PutRouteOBJ'):
            return {'kind': 'OBJ', 'ref': type_str}
        return {'kind': PRIM.get(put, 'S32')}
    return {'kind': 'S32'}

def split_top_args(rest):
    """Split comma-separated args respecting parentheses and quotes."""
    args, depth, cur, inq = [], 0, '', False
    i = 0
    while i < len(rest):
        c = rest[i]
        if c == "'" and (i == 0 or rest[i-1] != '\\'):
            inq = not inq
        if not inq:
            if c == '(': depth += 1
            elif c == ')': depth -= 1
            elif c == ',' and depth == 0:
                args.append(cur.strip()); cur = ''; i += 1; continue
        cur += c
        i += 1
    if cur.strip(): args.append(cur.strip())
    return args

def parse_file(path):
    t = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r"local _M = \{MessageID = (0x[0-9a-fA-F]+),\s*Name = '([^']+)'\}", t)
    if not m:
        return None
    mid = int(m.group(1), 16)
    name = m.group(2)
    # Write body
    wm = re.search(r"function _M\.Write\(output,data\)(.*?)\nend", t, re.DOTALL)
    body = wm.group(1) if wm else ''
    # Parent call
    pm = re.search(r"Protocol\.Serializer\.StringDefined\['([^']+)'\]\.Write\(output,\s*data\)", body)
    parent = pm.group(1) if pm else None
    fields = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith('--'):
            continue
        # primitive: output:PutS32(data.Field)
        pm2 = re.match(r"output:(Put\w+)\(data\.(\w+)\s*(?:,\s*(.*))?\)$", line)
        if not pm2:
            # PutList/Map with function refs: output:PutList(data.f, output.PutOBJ,'Type')
            pm2 = re.match(r"output:(Put\w+)\(data\.(\w+),\s*(.*)\)$", line)
            if not pm2:
                if line and 'PutNull' not in line and 'PutRouteOBJ' not in line and 'StringDefined' not in line:
                    fields.append({'_unparsed': line})
                continue
        put, fname, rest = pm2.group(1), pm2.group(2), pm2.group(3)
        if put in PRIM:
            fields.append({'name': fname, 'kind': PRIM[put]})
        elif put == 'PutOBJ' or put == 'PutRouteOBJ':
            tm = re.match(r"'([^']+)'", rest or '')
            fields.append({'name': fname, 'kind': 'OBJ', 'ref': tm.group(1) if tm else None})
        elif put in ('PutList', 'PutArray'):
            args = split_top_args(rest or '')
            es = parse_elem(args[0] if args else '', args[1] if len(args) > 1 else None)
            kind = 'LIST' if put == 'PutList' else 'ARRAY'
            ek = es.get('kind', 'S32')
            if ek == 'OBJ':
                f = {'name': fname, 'kind': kind, 'elemKind': 'OBJ', 'elemRef': es.get('ref')}
            elif ek in ('LIST', 'MAP'):
                f = {'name': fname, 'kind': kind, 'elemKind': ek, 'elem': es}
            else:
                f = {'name': fname, 'kind': kind, 'elemKind': ek}
            fields.append(f)
        elif put == 'PutMap':
            # Lua: PutMap(map, keyfn, valfn, keyTypeStr, valTypeStr)
            args = split_top_args(rest or '')
            ks = parse_elem(args[0] if len(args) > 0 else '', args[2] if len(args) > 2 else None)
            vs = parse_elem(args[1] if len(args) > 1 else '', args[3] if len(args) > 3 else None)
            f = {'name': fname, 'kind': 'MAP'}
            if ks.get('kind') == 'OBJ':
                f['keyKind'] = 'OBJ'; f['keyRef'] = ks.get('ref')
            else:
                f['keyKind'] = ks.get('kind', 'S32')
            if vs.get('kind') == 'OBJ':
                f['valKind'] = 'OBJ'; f['valRef'] = vs.get('ref')
            elif vs.get('kind') in ('LIST', 'MAP'):
                f['valKind'] = vs.get('kind'); f['valElem'] = vs
            else:
                f['valKind'] = vs.get('kind', 'S32')
            fields.append(f)
        elif put in ('PutUnicode',):
            fields.append({'name': fname, 'kind': 'Bool'})  # client bug: PutUnicode writes PutBool
        elif put in ('PutEnum32', 'PutS8', 'PutS16', 'PutU16', 'PutU32', 'PutU64'):
            fields.append({'name': fname, 'kind': 'S32' if put in ('PutEnum32','PutS32') else 'S64' if put=='PutU64' else 'S32'})
    return {'messageId': mid, 'name': name, 'parent': parent, 'ownFields': fields}

def main():
    protos = {}
    unparsed_files = []
    files = [f for f in os.listdir(GEN) if f.endswith('.lua')]
    for f in sorted(files):
        r = parse_file(os.path.join(GEN, f))
        if r:
            protos[r['name']] = r
            if any('_unparsed' in fl for fl in r['ownFields']):
                unparsed_files.append((f, [fl for fl in r['ownFields'] if '_unparsed' in fl]))
    # Resolve inheritance: flatten fields
    def flatten(name, seen=None):
        if seen is None: seen = set()
        if name in seen: return []
        seen.add(name)
        p = protos.get(name)
        if not p: return []
        out = []
        if p['parent']:
            out += flatten(p['parent'], seen)
        out += [fl for fl in p['ownFields'] if '_unparsed' not in fl]
        return out
    result = {}
    id_collisions = {}
    names_all = set(protos.keys())
    # primitive type-name -> field kind (used for OBJ/LIST/MAP refs that are C# primitives)
    PRIMITIVE_TYPES = {
        'int': 'S32', 'Int32': 'S32', 'System.Int32': 'S32',
        'string': 'UTF', 'String': 'UTF', 'System.String': 'UTF',
        'bool': 'Bool', 'Boolean': 'Bool', 'System.Boolean': 'Bool',
        'double': 'F64', 'Double': 'F64', 'System.Double': 'F64',
        'float': 'F32', 'Single': 'F32', 'System.Single': 'F32',
        'long': 'S64', 'Int64': 'S64', 'System.Int64': 'S64',
        'System.DateTime': 'DateTime', 'byte': 'U8', 'Byte': 'U8',
    }

    def resolve_ref(ref):
        """Return (kind, is_primitive) for an OBJ/elem/key/val ref string.
        Primitives collapse to their scalar kind; garbage inline-function refs are flagged."""
        if ref is None:
            return None, False
        if ref in PRIMITIVE_TYPES:
            return PRIMITIVE_TYPES[ref], True
        if ref in names_all:
            return 'OBJ', False
        # unparsable (inline function bodies captured as 'ref')
        return None, False

    def normalize_field(f):
        """Collapse primitive refs and flag fields whose refs can't be resolved."""
        k = f.get('kind')
        if k == 'OBJ':
            kind2, prim = resolve_ref(f.get('ref'))
            if prim:
                return {'name': f['name'], 'kind': kind2}
            if kind2 is None:
                return {'name': f['name'], 'kind': 'OBJ', 'ref': f.get('ref'), 'unparsed': True}
            return f
        if k in ('LIST', 'ARRAY'):
            if f.get('elemKind') == 'OBJ':
                kind2, prim = resolve_ref(f.get('elemRef'))
                if prim:
                    return {'name': f['name'], 'kind': k, 'elemKind': kind2}
                if kind2 is None:
                    return {'name': f['name'], 'kind': k, 'elemKind': 'OBJ', 'elemRef': f.get('elemRef'), 'unparsed': True}
            if f.get('elemKind') in ('LIST', 'MAP') and isinstance(f.get('elem'), dict):
                inner = normalize_field({**f['elem'], 'name': '_elem'})
                inner.pop('name', None)
                return {'name': f['name'], 'kind': k, 'elemKind': f['elemKind'], 'elem': inner}
            return f
        if k == 'MAP':
            out = {'name': f['name'], 'kind': 'MAP'}
            bad = False
            for side in ('key', 'val'):
                ref = f.get(side + 'Ref')
                kk = f.get(side + 'Kind')
                if kk in ('LIST', 'MAP') and isinstance(f.get(side + 'Elem'), dict):
                    inner = normalize_field({**f[side + 'Elem'], 'name': '_e'})
                    inner.pop('name', None)
                    out[side + 'Kind'] = kk; out[side + 'Elem'] = inner
                    continue
                if ref is None:
                    out[side + 'Kind'] = kk or 'S32'
                    continue
                kind2, prim = resolve_ref(ref)
                if prim:
                    out[side + 'Kind'] = kind2
                elif kind2 == 'OBJ':
                    out[side + 'Kind'] = 'OBJ'; out[side + 'Ref'] = ref
                else:
                    out[side + 'Kind'] = 'OBJ'; out[side + 'Ref'] = ref; bad = True
            if bad: out['unparsed'] = True
            return out
        return f

    for name, p in protos.items():
        short = name.rsplit('.', 1)[-1]
        fields = [normalize_field(fl) for fl in flatten(name)]
        result[name] = {
            'messageId': p['messageId'], 'name': name, 'shortName': short,
            'parent': p['parent'], 'fields': fields,
        }
        id_collisions.setdefault(p['messageId'], []).append(name)
    # count unparsed
    unparsed_count = sum(1 for p in result.values() for f in p['fields'] if f.get('unparsed'))
    protos_with_unparsed = sum(1 for p in result.values() if any(f.get('unparsed') for f in p['fields']))
    dupes = {hex(k): v for k, v in id_collisions.items() if len(v) > 1 and k != 0}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fp:
        json.dump(result, fp, separators=(',', ':'))
    print(f'parsed {len(result)} protocols -> {OUT}')
    print(f'fields flagged unparsed: {unparsed_count} in {protos_with_unparsed} protocols')
    print(f'unparsed raw lines in {len(unparsed_files)} files')
    for f, lines in unparsed_files[:10]:
        print(f'  {f}: {lines[:2]}')
    print(f'MessageID collisions (non-zero): {len(dupes)}')
    for k, v in list(dupes.items())[:10]:
        print(f'  {k}: {v}')
    # sanity: well-known protocols
    for n in ['OpenCards.Core.Protocol.Client.ClientFightRandomSeedRequest',
              'OpenCards.Core.Protocol.Client.ClientFightRandomSeedResponse',
              'OpenCards.Core.Protocol.Client.ClientEnterServerRequest',
              'OpenCards.Core.Protocol.Client.ClientEnterGameRequest',
              'OpenCards.Core.Protocol.Client.ClientEnterGameResponse']:
        if n in result:
            print(f'\n{n}  id=0x{result[n]["messageId"]:08X}')
            for fl in result[n]['fields']:
                print('   ', fl)

if __name__ == '__main__':
    main()