#!/usr/bin/env python3
"""Dump IL bodies of DeepCore.dll methods (dnfile 0.18 API).
Usage: python il_dump2.py TypeFilter [MethodFilter...]
"""
import dnfile, sys, struct

DLL = r'\\LS220D088\webaxs\backupProjects\art-project-client\Assets\Plugins\Import\DeepCore.dll'
pe = dnfile.dnPE(DLL)
mdt = pe.net.mdtables

def s(x): return str(x) if x is not None else ''

typedefs = mdt.TypeDef.rows
methods = mdt.MethodDef.rows
memberref = mdt.MemberRef.rows
typeref = mdt.TypeRef.rows
fields = mdt.Field.rows

ranges = []
for i, td in enumerate(typedefs):
    ml = td.MethodList
    start = ml[0].row_index - 1 if ml else 0
    if i + 1 < len(typedefs):
        nml = typedefs[i+1].MethodList
        end = nml[0].row_index - 1 if nml else len(methods)
    else:
        end = len(methods)
    ranges.append((s(td.TypeName), s(td.TypeNamespace), start, end))

data = pe.__data__
sections = [(sec.VirtualAddress, sec.Misc_VirtualSize, sec.PointerToRawData) for sec in pe.sections]

def rva2off(rva):
    for va, size, ptr in sections:
        if va <= rva < va + max(size, 0x1000000):
            return ptr + (rva - va)
    return None

def read_body(rva):
    if rva == 0: return None
    off = rva2off(rva)
    if off is None: return None
    b0 = data[off]
    if (b0 & 3) == 2:
        size = b0 >> 2
        return data[off+1:off+1+size]
    flags_size = struct.unpack('<H', data[off:off+2])[0]
    header_size = (flags_size >> 12) * 4
    code_size = struct.unpack('<I', data[off+4:off+8])[0]
    return data[off+header_size:off+header_size+code_size]

def token_name(tok):
    table = (tok >> 24) & 0xFF
    idx = (tok & 0xFFFFFF) - 1
    try:
        if table == 0x0A:
            mr = memberref[idx]
            cls = mr.Class
            cname = ''
            if cls is not None:
                tt = s(getattr(cls, 'table', ''))
                try:
                    if 'TypeRef' in tt: cname = s(typeref[cls.row_index-1].TypeName)
                    elif 'TypeDef' in tt: cname = s(typedefs[cls.row_index-1].TypeName)
                    else: cname = tt
                except Exception: cname = tt
            return f'{cname}::{s(mr.Name)}'
        if table == 0x06: return s(methods[idx].Name)
        if table == 0x02: return s(typedefs[idx].TypeName)
        if table == 0x01: return s(typeref[idx].TypeName)
        if table == 0x04: return f'fld:{s(fields[idx].Name)}'
        return f'tbl{table:02X}[{idx}]'
    except Exception:
        return f'tok{tok:08X}'

def user_string(tok):
    # #US heap: compressed-length prefix + UTF-16LE bytes + trailing flag byte
    try:
        off = tok & 0xFFFFFF
        base = pe.net.user_strings.get_file_offset(off) if hasattr(pe.net.user_strings, 'get_file_offset') else None
        if base is None:
            base = pe.net.user_strings.file_offset + off
        b0 = data[base]
        if b0 & 0x80 == 0:
            ln, hsz = b0, 1
        elif b0 & 0xC0 == 0x80:
            ln, hsz = ((b0 & 0x3F) << 8) | data[base+1], 2
        else:
            ln, hsz = ((b0 & 0x1F) << 24) | (data[base+1] << 16) | (data[base+2] << 8) | data[base+3], 4
        if ln == 0:
            return ''
        body = data[base+hsz:base+hsz+ln]
        if len(body) and body[-1:] in (b'\x00', b'\x01'):
            body = body[:-1]
        return body.decode('utf-16-le', errors='replace')
    except Exception:
        return f'us({tok & 0xFFFFFF})'

SIMPLE0 = {
 0x00:'nop',0x01:'break',
 0x02:'ldarg.0',0x03:'ldarg.1',0x04:'ldarg.2',0x05:'ldarg.3',
 0x06:'ldloc.0',0x07:'ldloc.1',0x08:'ldloc.2',0x09:'ldloc.3',
 0x0A:'stloc.0',0x0B:'stloc.1',0x0C:'stloc.2',0x0D:'stloc.3',
 0x14:'ldnull',0x15:'ldc.i4.m1',0x16:'ldc.i4.0',0x17:'ldc.i4.1',0x18:'ldc.i4.2',
 0x19:'ldc.i4.3',0x1A:'ldc.i4.4',0x1B:'ldc.i4.5',0x1C:'ldc.i4.6',0x1D:'ldc.i4.7',
 0x1E:'ldc.i4.8',0x25:'dup',0x26:'pop',0x29:'calli',0x2A:'ret',
 0x46:'ldind.i1',0x47:'ldind.u1',0x48:'ldind.i2',0x49:'ldind.u2',0x4A:'ldind.i4',
 0x4B:'ldind.u4',0x4C:'ldind.i8',0x4D:'ldind.i',0x4E:'ldind.r4',0x4F:'ldind.r8',0x50:'ldind.ref',
 0x51:'stind.ref',0x52:'stind.i1',0x53:'stind.i2',0x54:'stind.i4',0x55:'stind.i8',
 0x56:'stind.r4',0x57:'stind.r8',
 0x58:'add',0x59:'sub',0x5A:'mul',0x5B:'div',0x5C:'div.un',0x5D:'rem',0x5E:'rem.un',
 0x5F:'and',0x60:'or',0x61:'xor',0x62:'shl',0x63:'shr',0x64:'shr.un',0x65:'neg',0x66:'not',
 0x67:'conv.i8',0x68:'conv.r4',0x69:'conv.r8',0x6A:'conv.u4',0x6B:'conv.u8',
 0x71:'castclass',0x72:'isinst',0x73:'conv.r.un',0x75:'throw',
 0x7D:'conv.ovf.i1.un',0x7E:'conv.ovf.u1.un',0x7F:'conv.ovf.i2.un',0x80:'conv.ovf.u2.un',
 0x81:'conv.ovf.i4.un',0x82:'conv.ovf.u4.un',0x83:'conv.ovf.i8.un',0x84:'conv.ovf.u8.un',
 0x85:'refanyval',0x86:'ckfinite',
 0x8A:'ldlen',
 0x8C:'ldelem.i1',0x8D:'ldelem.u1',0x8E:'ldelem.i2',0x8F:'ldelem.u2',
 0x90:'ldelem.i4',0x91:'ldelem.u4',0x92:'ldelem.i8',0x93:'ldelem.u8',
 0x94:'ldelem.i',0x95:'ldelem.r4',0x96:'ldelem.r8',0x97:'ldelem.ref',
 0x9D:'stelem.i',0x9E:'stelem.i1',0x9F:'stelem.i2',0xA0:'stelem.i4',0xA1:'stelem.i8',
 0xA2:'stelem.r4',0xA3:'stelem.r8',0xA4:'stelem.ref',
 0xA9:'conv.ovf.i1',0xAA:'conv.ovf.u1',0xAB:'conv.ovf.i2',0xAC:'conv.ovf.u2',
 0xAD:'conv.ovf.i4',0xAE:'conv.ovf.u4',0xAF:'conv.ovf.i8',0xB0:'conv.ovf.u8',
 0xC2:'refanyval',0xC3:'ckfinite',
 0xD1:'conv.u2',0xD2:'conv.u1',0xD3:'conv.i',0xD4:'conv.ovf.i',0xD5:'conv.ovf.u',
 0xD6:'add.ovf',0xD7:'add.ovf.un',0xD8:'mul.ovf',0xD9:'mul.ovf.un',0xDA:'sub.ovf',0xDB:'sub.ovf.un',
 0xDC:'endfinally',0xDF:'endfilter',
}
TOK4 = {0x27:'jmp',0x28:'call',0x6C:'callvirt',0x6D:'cpobj',0x6E:'ldobj',0x70:'newobj',
 0x74:'unbox',0x76:'ldfld',0x77:'ldflda',0x78:'stfld',0x79:'ldsfld',0x7A:'ldsflda',
 0x7B:'stsfld',0x7C:'stobj',0x88:'box',0x89:'newarr',0x8B:'ldelema',0x9C:'ldelem',
 0xA5:'stelem',0xA6:'ldelem.any',0xA7:'stelem.any',0xA8:'unbox.any',
 0xC0:'mkrefany',0xD0:'ldtoken'}
BR1 = {0x2B:'br.s',0x2C:'brfalse.s',0x2D:'brtrue.s',0x2E:'beq.s',0x2F:'bge.s',0x30:'bgt.s',
 0x31:'ble.s',0x32:'blt.s',0x33:'bne.un.s',0x34:'bge.un.s',0x35:'bgt.un.s',0x36:'ble.un.s',
 0x37:'blt.un.s',0xDE:'leave.s'}
BR4 = {0x38:'br',0x39:'brfalse',0x3A:'brtrue',0x3B:'beq',0x3C:'bge',0x3D:'bgt',0x3E:'ble',
 0x3F:'blt',0x40:'bne.un',0x41:'bge.un',0x42:'bgt.un',0x43:'ble.un',0x44:'blt.un',0xDD:'leave'}
I1 = {0x0E:'ldarg.s',0x0F:'ldarga.s',0x10:'starg.s',0x11:'ldloc.s',0x12:'ldloca.s',0x13:'stloc.s',0x1F:'ldc.i4.s'}

def disasm(body):
    out = []
    i, n = 0, len(body)
    while i < n:
        op = body[i]; i += 1
        if op in SIMPLE0:
            out.append(SIMPLE0[op])
        elif op in TOK4:
            tok = struct.unpack('<I', body[i:i+4])[0]; i += 4
            out.append(f'{TOK4[op]} {token_name(tok)}')
        elif op == 0x6F:
            tok = struct.unpack('<I', body[i:i+4])[0]; i += 4
            out.append(f'ldstr "{user_string(tok)}"')
        elif op in BR1:
            d = struct.unpack('<b', body[i:i+1])[0]; i += 1
            out.append(f'{BR1[op]} IL_{i+d:04X}')
        elif op in BR4:
            d = struct.unpack('<i', body[i:i+4])[0]; i += 4
            out.append(f'{BR4[op]} IL_{i+d:04X}')
        elif op in I1:
            v = body[i]; i += 1
            out.append(f'{I1[op]} {v}')
        elif op == 0x45:
            cnt = struct.unpack('<I', body[i:i+4])[0]; i += 4
            base = i + cnt*4
            tgts = []
            for j in range(cnt):
                chunk = body[i+j*4:i+j*4+4]
                if len(chunk) < 4: break
                tgts.append(f'IL_{base+struct.unpack("<i", chunk)[0]:04X}')
            i += cnt*4
            out.append('switch ' + ','.join(tgts))
        elif op == 0x20:
            v = struct.unpack('<i', body[i:i+4])[0]; i += 4; out.append(f'ldc.i4 {v}')
        elif op == 0x21:
            v = struct.unpack('<q', body[i:i+8])[0]; i += 8; out.append(f'ldc.i8 {v}')
        elif op == 0x22:
            v = struct.unpack('<f', body[i:i+4])[0]; i += 4; out.append(f'ldc.r4 {v}')
        elif op == 0x23:
            v = struct.unpack('<d', body[i:i+8])[0]; i += 8; out.append(f'ldc.r8 {v}')
        elif op == 0xFE:
            sub = body[i]; i += 1
            fe = {0x00:'arglist',0x01:'ceq',0x02:'cgt',0x03:'cgt.un',0x04:'clt',0x05:'clt.un',
                  0x06:'ldftn',0x07:'ldvirtftn',0x09:'ldarg',0x0A:'ldarga',0x0B:'starg',
                  0x0C:'ldloc',0x0D:'ldloca',0x0E:'stloc',0x0F:'localloc',0x11:'endfilter',
                  0x12:'unaligned.',0x13:'volatile.',0x14:'tail.',0x15:'initobj',
                  0x16:'constrained.',0x17:'cpblk',0x18:'initblk',0x1A:'rethrow',
                  0x1C:'sizeof',0x1D:'refanytype',0x1E:'readonly.'}
            nm = fe.get(sub, f'fe{sub:02X}')
            if sub in (0x09,0x0A,0x0B,0x0C,0x0D,0x0E):
                v = struct.unpack('<H', body[i:i+2])[0]; i += 2
                out.append(f'{nm} {v}')
            elif sub in (0x06,0x07,0x15,0x16,0x1C):
                tok = struct.unpack('<I', body[i:i+4])[0]; i += 4
                out.append(f'{nm} {token_name(tok)}')
            else:
                out.append(nm)
        else:
            out.append(f'??op{op:02X}')
    return out

def dump(type_filter, method_filters=None):
    for tn, tns, sidx, eidx in ranges:
        if type_filter and type_filter.lower() not in tn.lower(): continue
        full = f'{tns}.{tn}' if tns else tn
        for mi in range(sidx, eidx):
            m = methods[mi]
            mn = s(m.Name)
            if method_filters and not any(f.lower() in mn.lower() for f in method_filters): continue
            body = read_body(m.Rva)
            if body is None:
                continue
            try:
                d = disasm(body)
            except Exception as e:
                d = [f'<disasm error: {e}>']
            print(f'\n=== {full}::{mn} ===')
            for line in d:
                print('   ', line)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: il_dump2.py TypeFilter [MethodFilter...]'); sys.exit(1)
    dump(sys.argv[1], sys.argv[2:] or None)