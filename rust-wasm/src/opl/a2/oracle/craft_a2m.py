#!/usr/bin/env python3
"""Builds synthetic .a2m modules for probing AdPlug's A2M player as a black box
(plan-opl.md, O7). Offsets are techinfo.htm's, as corrected by the O6 parser.

Versions 4 and 8 are stored (no packer). Version 11 is written as an aPLib
stream of literals only, which any aPLib depacker reads; versions 12-14 as
AT2's LZH (ar002 with wider fields, see lzh.rs) using literals only: each
block declares a one-symbol code-length code, all 256 literals at length 8
(so a literal is its own byte) and a one-symbol distance code.

    craft_a2m.py spec.py out.a2m

`spec.py` is Python that defines SPEC = dict(...); see `build` for the keys.
"""
import struct
import sys

SONGDATA_LEN = {4: 0x2dc4, 8: 0x2dc5, 11: 0x115a1e, 12: 0x115e9f, 13: 0x115e9f, 14: 0x115ea2}


def aplib_literals(data: bytes) -> bytes:
    """aPLib stream: first byte raw, then '0'+byte per literal, then the
    '110' + 0x00 end marker. Tag bits are MSB first, in bytes placed in the
    stream when the depacker would fetch them."""
    out = bytearray([data[0]])
    tag_at = None
    bits = 0

    def bit(b):
        nonlocal tag_at, bits
        if bits == 0:
            tag_at = len(out)
            out.append(0)
            bits = 8
        bits -= 1
        if b:
            out[tag_at] |= 1 << bits

    for byte in data[1:]:
        bit(0)
        out.append(byte)
    bit(1)
    bit(1)
    bit(0)
    out.append(0)
    return bytes(out)


def lzh_literals(data: bytes) -> bytes:
    bits = []

    def put(value, n):
        for i in range(n - 1, -1, -1):
            bits.append((value >> i) & 1)

    at = 0
    while at < len(data):
        block = data[at:at + 0xffff]
        put(len(block), 16)
        put(0, 15)          # code-length code: n = 0 ...
        put(10, 15)         # ... one symbol, 10 = "length 8"
        put(256, 16)        # 256 literal/length code lengths, all 8
        put(0, 14)          # distance code: n = 0 ...
        put(0, 14)          # ... one symbol
        for b in block:
            put(b, 8)
        at += len(block)
    while len(bits) % 8:
        bits.append(0)
    out = bytearray([0]) + len(data).to_bytes(4, 'little')
    for i in range(0, len(bits), 8):
        v = 0
        for b in bits[i:i + 8]:
            v = v << 1 | b
        out.append(v)
    return bytes(out)


def pascal(s: bytes, room: int) -> bytes:
    return bytes([len(s)]) + s + bytes(room - len(s))


def build(spec: dict) -> bytes:
    v = spec.get('version', 11)
    songdata = bytearray(SONGDATA_LEN[v])
    songdata[0:43] = pascal(spec.get('name', b'probe'), 42)
    new = v >= 9
    ins_at, ins_len = (0x2b2b, 14) if new else (0x2090, 13)
    for n, ins in spec.get('instruments', {}).items():
        # ins: dict(fm=[11 bytes], pan=0, fine=0, type=0)
        at = ins_at + (n - 1) * ins_len
        rec = bytearray(ins_len)
        rec[0:11] = bytes(ins['fm'])
        if new:
            rec[11] = ins.get('pan', 0)
            rec[12] = ins.get('fine', 0) & 0xff
            rec[13] = ins.get('type', 0)
        else:
            rec[11] = ins.get('pan', 0)
            rec[12] = ins.get('fine', 0) & 0xff
        songdata[at:at + ins_len] = rec
    if new:
        for n, m in spec.get('fm_macros', {}).items():
            at = 0x391d + (n - 1) * 3831
            songdata[at:at + 6] = bytes([m.get('length', 0), m.get('loop_begin', 0),
                                         m.get('loop_length', 0), m.get('keyoff', 0),
                                         m.get('arp', 0), m.get('vib', 0)])
            for i, step in enumerate(m.get('steps', [])):
                s = at + 6 + i * 15
                rec = bytearray(15)
                rec[0:11] = bytes(step['fm'])
                rec[11:13] = struct.pack('<h', step.get('slide', 0))
                rec[13] = step.get('pan', 0)
                rec[14] = step.get('duration', 0)
                songdata[s:s + 15] = rec
        for n, a in spec.get('arp_macros', {}).items():
            at = 0xf2126 + (n - 1) * 521
            songdata[at:at + 5] = bytes([a.get('length', 0), a.get('speed', 0),
                                         a.get('loop_begin', 0), a.get('loop_length', 0),
                                         a.get('keyoff', 0)])
            d = bytes(a.get('data', []))
            songdata[at + 5:at + 5 + len(d)] = d
        for n, a in spec.get('vib_macros', {}).items():
            at = 0xf2126 + (n - 1) * 521 + 0x104
            songdata[at:at + 6] = bytes([a.get('length', 0), a.get('speed', 0), a.get('delay', 0),
                                         a.get('loop_begin', 0), a.get('loop_length', 0),
                                         a.get('keyoff', 0)])
            d = bytes(x & 0xff for x in a.get('data', []))
            songdata[at + 6:at + 6 + len(d)] = d
        if v >= 11:
            for n, cols in spec.get('disabled', {}).items():
                at = 0x113e3a + (n - 1) * 28
                songdata[at:at + 28] = bytes(cols)
        o = 0x11281d
    else:
        o = 0x2d42
    order = list(spec.get('order', [0, 0x80]))
    order += [0x80] * (128 - len(order))
    songdata[o:o + 128] = bytes(order)
    songdata[o + 0x80] = spec.get('tempo', 50)
    songdata[o + 0x81] = spec.get('speed', 6)
    if v >= 5:
        songdata[o + 0x82] = spec.get('flags', 0)
    if new:
        struct.pack_into('<H', songdata, o + 0x83, spec.get('pattern_len', 64))
        songdata[o + 0x85] = spec.get('tracks', 18)
        struct.pack_into('<H', songdata, o + 0x86, spec.get('speedup', 1))
        songdata[o + 0x88] = spec.get('four_op', 0)
        locks = spec.get('locks', [0] * 20)
        songdata[o + 0x89:o + 0x89 + 20] = bytes(locks)
        if v >= 12:
            pairs = spec.get('four_op_ins', [])
            songdata[0x115a1e] = len(pairs)
            for i, p in enumerate(pairs):
                songdata[0x115a1f + i] = p
        if v >= 14:
            songdata[0x115e9f] = spec.get('rpb', 4)
            struct.pack_into('<h', songdata, 0x115ea0, spec.get('tempo_fine', 0))

    npat = max([p for p in spec.get('patterns', {})] + [0]) + 1
    if new:
        per_block, rows, chans, cb = 8, 256, 20, 6
    elif v >= 5:
        per_block, rows, chans, cb = 8, 64, 18, 4
    else:
        per_block, rows, chans, cb = 16, 64, 9, 4
    nblocks = (npat + per_block - 1) // per_block
    blocks = [bytearray(per_block * rows * chans * cb) for _ in range(nblocks)]
    for p, cells in spec.get('patterns', {}).items():
        blk = blocks[p // per_block]
        base = (p % per_block) * rows * chans * cb
        for cell in cells:
            row, ch = cell[0], cell[1]
            vals = list(cell[2:]) + [0] * (cb - len(cell[2:]))
            if v >= 5:
                at = base + (ch * rows + row) * cb
            else:
                at = base + (row * chans + ch) * cb
            blk[at:at + cb] = bytes(vals[:cb])

    if v in (4, 8):
        packed = [bytes(songdata)] + [bytes(b) for b in blocks]
        nfields = 5 if v == 4 else 9
        hdr = b'_A2module_' + bytes(4) + bytes([v, npat])
        lens = [len(b) for b in packed] + [0] * (nfields - len(packed))
        hdr += struct.pack('<%dH' % nfields, *lens)
    else:
        pack = lzh_literals if v >= 12 else aplib_literals
        packed = [pack(bytes(songdata))] + [pack(bytes(b)) for b in blocks]
        hdr = b'_A2module_' + bytes(4) + bytes([v, npat])
        lens = [len(b) for b in packed] + [0] * (17 - len(packed))
        hdr += struct.pack('<17I', *lens)
    return hdr + b''.join(packed)


if __name__ == '__main__':
    env = {}
    exec(open(sys.argv[1]).read(), env)
    open(sys.argv[2], 'wb').write(build(env['SPEC']))
