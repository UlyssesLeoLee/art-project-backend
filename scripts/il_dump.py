#!/usr/bin/env python3
"""Decompile-free inspection of DeepCore.dll: dump IL bodies of
OutputStream.Put*/Get*, BinaryMessage.FromBuffer/ToArray, MemoryStream helpers.

Uses dnfile to read the .NET metadata + #US heap + method bodies.
"""
import dnfile, sys, struct

DLL = r'\\LS220D088\webaxs\backupProjects\art-project-client\Assets\Plugins\Import\DeepCore.dll'

pe = dnfile.dnPE(DLL)
pe.parse()

mdtables = pe.net.mdtables

def rows(t):
    tb = getattr(mdtables, t, None)
    return tb.rows if tb else []

# Build string heaps
strings = mdtables.StringsHeap
us = mdtables.USHeap

# TypeDef -> name map
typedefs = rows('TypeDef')
methods = rows('MethodDef')

# Map method RVA -> (typedef name, method name)
type_method_ranges = []
for i, td in enumerate(typedefs):
    start = td.MethodList.row_index - 1 if td.MethodList else 0
    end = (typedefs[i+1].MethodList.row_index - 1) if i+1 < len(typedefs) and typedefs[i+1].MethodList else len(methods)
    type_method_ranges.append((td.TypeName, start, end))

def find_method(type_name, method_name):
    for tn, s, e in type_method_ranges:
        if tn == type_name:
            for mi in range(s, e):
                if methods[mi].Name == method_name:
                    return methods[mi]
    return None

# Read IL body at RVA
data = pe.__data__
sections = [(sec.VirtualAddress, sec.SizeOfRawData, sec.PointerToRawData) for sec in pe.sections]
def rva2off(rva):
    for va, size, ptr in sections:
        if va <= rva < va + size:
            return ptr + (rva - va)
    return None

def read_body(rva):
    off = rva2off(rva)
    if off is None: return None
    b0 = data[off]
    if (b0 & 3) == 2:  # tiny
        size = b0 >> 2
        return data[off+1:off+1+size], []
    else:  # fat
        flags_size = struct.unpack('<H', data[off:off+2])[0]
        header_size = (flags_size >> 12) * 4
        max_stack = struct.unpack('<H', data[off+2:off+4])[0]
        code_size = struct.unpack('<I', data[off+4:off+8])[0]
        body = data[off+header_size:off+header_size+code_size]
        # extra sections (data clauses)
        extra = []
        if flags_size & 0x8:
            sec_off = off + header_size + code_size
            sec_off = (sec_off + 3) & ~3
            while sec_off < len(data):
                kind = data[sec_off]
                dsize = struct.unpack('<I', data[sec_off:sec_off+4])[0] & 0xFFFFFF
                if dsize == 0: break
                extra.append(data[sec_off:sec_off+dsize])
                if not (kind & 0x80): break
                sec_off += dsize
                sec_off = (sec_off + 3) & ~3
        return body, extra

OPCODES = {
 0x00:'nop',0x01:'break',0x02:'ldarg.0',0x03:'ldarg.1',0x04:'ldarg.2',0x05:'ldarg.3',
 0x06:'ldloc.0',0x07:'ldloc.1',0x08:'ldloc.2',0x09:'ldloc.3',0x0A:'stloc.0',0x0B:'stloc.1',
 0x0C:'stloc.2',0x0D:'stloc.3',0x0E:'ldarg.s',0x0F:'ldarga.s',0x10:'starg.s',0x11:'ldloc.s',
 0x12:'ldloca.s',0x13:'stloc.s',0x14:'ldnull',0x15:'ldc.i4.m1',0x16:'ldc.i4.0',0x17:'ldc.i4.1',
 0x18:'ldc.i4.2',0x19:'ldc.i4.3',0x1A:'ldc.i4.4',0x1B:'ldc.i4.5',0x1C:'ldc.i4.6',0x1D:'ldc.i4.7',
 0x1E:'ldc.i4.8',0x1F:'ldc.i4.s',0x20:'ldc.i4',0x21:'ldc.i8',0x22:'ldc.r4',0x23:'ldc.r8',
 0x25:'dup',0x26:'pop',0x27:'jmp',0x28:'call',0x29:'calli',0x2A:'ret',0x2B:'br.s',0x2C:'brfalse.s',
 0x2D:'brtrue.s',0x2E:'beq.s',0x2F:'bge.s',0x30:'bgt.s',0x31:'ble.s',0x32:'blt.s',0x33:'bne.un.s',
 0x38:'br',0x39:'brfalse',0x3A:'brtrue',0x58:'add',0x59:'sub',0x5A:'mul',0x60:'and',0x61:'or',
 0x67:'conv.i8',0x68:'conv.r4',0x69:'conv.r8',0x6A:'callvirt',0x6B:'cpobj',0x6C:'ldobj',
 0x6D:'ldstr',0x6E:'newobj',0x6F:'castclass',0x70:'isinst',0x71:'conv.r.un',0x72:'unbox',
 0x73:'throw',0x74:'ldfld',0x75:'ldflda',0x76:'stfld',0x77:'ldsfld',0x79:'stsfld',0x7A:'stobj',
 0x7B:'conv.ovf.i1.un',0x8C:'box',0x8D:'newarr',0x8E:'ldlen',0x91:'ldelem.u1',0x92:'ldelem.i2',
 0x94:'ldelem.i4',0x96:'ldelem.i8',0x9C:'ldelem.r4',0x9D:'ldelem.r8',0x9E:'ldelem.ref',
 0xA0:'stelem.i',0xA1:'stelem.i1',0xA2:'stelem.i2',0xA3:'stelem.i4',0xA5:'stelem.r4',0xA7:'stelem.ref',
 0xD0:'ldtoken',0xD1:'conv.u2',0xD2:'conv.u1',0xD3:'conv.i',0xD4:'conv.ovf.i',0xFE:None,
}
FE = {0x01:'ceq',0x09:'ldarg',0x0A:'ldarga',0x0C:'initobj',0x15:'initblk'}

# token tables
memberref = rows('MemberRef')
typeref = rows('TypeRef')

def token_name(tok):
    table = (tok >> 24) & 0xFF
    idx = (tok & 0xFFFFFF) - 1
    try:
        if table == 0x0A:  # MemberRef
            mr = memberref[idx]
            cls = mr.Class.row if mr.Class else None
            cname = ''
            if cls is not None:
                tt = cls.table
                if tt == 'TypeRef': cname = typeref[cls.index-1].TypeName if cls.index-1 < len(typeref) else '?'
                elif tt == 'TypeDef': cname = typedefs[cls.index-1].TypeName
                else: cname = tt
            return f'{cname}::{mr.Name}'
        if table == 0x06:  # MethodDef
            return methods[idx].Name
        if table == 0x02:
            return typedefs[idx].TypeName
        if table == 0x01:
            return typeref[idx].TypeName
        if table == 0x04:
            return f'Field:{rows("Field")[idx].Name}'
        if table == 0x70:
            return 'USSTR'
        return f'tbl{table:02X}[{idx}]'
    except Exception:
        return f'tok{tok:08X}'

def us_string(off):
    # #US heap: compressed length + utf16
    try:
        b = us.get_us(off)
        return b.value if hasattr(b,'value') else str(b)
    except Exception:
        return f'us{off}'

def disasm(body):
    out = []
    i = 0
    n = len(body)
    while i < n:
        op = body[i]
        start = i
        i += 1
        if op == 0xFE:
            sub = body[i]; i += 1
            name = FE.get(sub, f'fe{sub:02x}')
            if sub in (0x09,0x0A):
                arg = struct.unpack('<H', body[i:i+2])[0]; i += 2
                out.append(f'{name} {arg}'); continue
            if sub == 0x01 or sub == 0x0C or sub == 0x15:
                tok = struct.unpack('<I', body[i:i+4])[0]; i += 4
                out.append(f'{name} {token_name(tok)}'); continue
            out.append(name); continue
        name = OPCODES.get(op, f'op{op:02x}')
        if name is None:
            out.append(f'op{op:02x}'); continue
        if name in ('ldc.i4','ldc.r4' if False else 'ldc.i4'):
            pass
        # operand sizes
        if name in ('ldarg.s','ldloc.s','stloc.s','ldarga.s','starg.s','ldloca.s','ldc.i4.s'):
            arg = body[i]; i += 1
            out.append(f'{name} {arg}'); continue
        if name in ('ldc.i4','ldc.i8') and False: pass
        if name == 'ldc.i4':
            arg = struct.unpack('<i', body[i:i+4])[0]; i += 4
            out.append(f'{name} {arg}'); continue
        if name == 'ldc.i8':
            arg = struct.unpack('<q', body[i:i+8])[0]; i += 8
            out.append(f'{name} {arg}'); continue
        if name == 'ldc.r8':
            arg = struct.unpack('<d', body[i:i+8])[0]; i += 8
            out.append(f'{name} {arg}'); continue
        if name in ('call','callvirt','newobj','ldfld','stfld','ldsfld','stsfld','ldtoken','box','newarr','castclass','isinst','ldelema' ) or name.startswith('ld') and False:
            tok = struct.unpack('<I', body[i:i+4])[0]; i += 4
            out.append(f'{name} {token_name(tok)}'); continue
        if name in ('br','br.s','brfalse','brfalse.s','brtrue','brtrue.s','beq.s','bge.s','bgt.s','ble.s','blt.s','bne.un.s'):
            if name.endswith('.s'):
                arg = struct.unpack('<b', body[i:i+1])[0]; i += 1
            else:
                arg = struct.unpack('<i', body[i:i+4])[0]; i += 4
            out.append(f'{name} {i+arg}'); continue
        if name == 'ldstr':
            tok = struct.unpack('<I', body[i:i+4])[0]; i += 4
            out.append(f'ldstr "{us_string(tok & 0xFFFFFF)}"'); continue
        out.append(name)
    return out

def dump(type_name, method_names=None):
    for tn, s, e in type_method_ranges:
        if tn != type_name: continue
        for mi in range(s, e):
            m = methods[mi]
            if method_names and m.Name not in method_names: continue
            body = read_body(m.Rva)
            print(f'\n--- {type_name}::{m.Name} (RVA {m.Rva:#x}) ---')
            if not body:
                print('  <no body / extern>')
                continue
            code, extra = body
            for line in disasm(code):
                print('   ', line)
            for ex in extra:
                print('   DATA-CLAUSE', ex[:32].hex())

if __name__ == '__main__':
    targets = sys.argv[1:] or ['OutputStream','InputStream','BinaryMessage']
    for t in targets:
        dump(t)