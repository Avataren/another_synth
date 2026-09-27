//! Adlib Tracker II's "own LZH" (modules, versions 12–14).
//!
//! It is Haruhiko Okumura's public-domain ar002 (the LHA `-lh5-` family:
//! blocks of static canonical Huffman codes over literals, match lengths and
//! distance classes), with wider header fields and a shorter minimum match:
//!
//! | ar002 | stock | AT2 |
//! |---|---|---|
//! | `DICBIT` (distance classes = DICBIT + 1) | 13 | 14 |
//! | `THRESHOLD` (shortest match) | 3 | 2 |
//! | `CBIT` (bits of the literal/length count) | 9 | 16 |
//! | `PBIT` (bits of the distance-class count) | 4 | 14 |
//! | `TBIT` (bits of the code-length count) | 5 | 15 |
//!
//! The five values, and the meaning of the flag byte below, come from AdPlug's
//! `unlzh.c` (LGPL, read under plan decision D6). Only those facts were used:
//! this decoder ports a Python ar002 reader written from scratch before that
//! file was opened. The corpus checks them: every v12–14 block decodes byte for
//! byte like AdPlug's, and its last code ends in the block's last byte. See
//! `.ai/plan-opl.md`, O6.
//!
//! Container (MEASURED): one flag byte (bit 0 set = "ultra", never seen), the
//! unpacked size as a little-endian u32, then the bitstream.

use super::DepackError;

const DICBIT: usize = 14;
const THRESHOLD: usize = 2;
const MAXMATCH: usize = 256;
const NC: usize = 255 + MAXMATCH + 2 - THRESHOLD;
const CBIT: u32 = 16;
const NP: usize = DICBIT + 1;
const PBIT: u32 = 14;
const NT: usize = 16 + 3;
const TBIT: u32 = 15;
const MAX_CODE_LEN: usize = 16;

struct Bits<'a> {
    src: &'a [u8],
    bit: usize,
}

impl<'a> Bits<'a> {
    fn get(&mut self, n: u32) -> Result<u32, DepackError> {
        let mut v = 0u32;
        for _ in 0..n {
            let byte = *self.src.get(self.bit >> 3).ok_or(DepackError::InputEnded)?;
            v = (v << 1) | ((byte >> (7 - (self.bit & 7))) & 1) as u32;
            self.bit += 1;
        }
        Ok(v)
    }
}

/// A canonical Huffman code: shorter codes first, equal lengths by symbol.
/// `Single` is the "one symbol, zero bits" form a table header can declare.
enum Code {
    Single(usize),
    Canonical {
        /// Number of codes of each length 1..=16.
        count: [u16; MAX_CODE_LEN + 1],
        /// Symbols in code order.
        symbols: Vec<u16>,
    },
}

impl Code {
    fn from_lengths(lens: &[u8], what: &'static str) -> Result<Code, DepackError> {
        let mut count = [0u16; MAX_CODE_LEN + 1];
        for &l in lens {
            if l as usize > MAX_CODE_LEN {
                return Err(DepackError::Corrupt(what));
            }
            count[l as usize] += 1;
        }
        count[0] = 0;
        // Kraft sum must be exactly 1: an incomplete or oversubscribed table is
        // a corrupt stream (ar002 prints "Bad table" and carries on).
        let mut room: i64 = 1;
        for &c in count.iter().skip(1) {
            room = room * 2 - c as i64;
            if room < 0 {
                return Err(DepackError::Corrupt(what));
            }
        }
        if room != 0 {
            return Err(DepackError::Corrupt(what));
        }
        let mut symbols = Vec::new();
        for len in 1..=MAX_CODE_LEN as u8 {
            for (sym, &l) in lens.iter().enumerate() {
                if l == len {
                    symbols.push(sym as u16);
                }
            }
        }
        Ok(Code::Canonical { count, symbols })
    }

    fn decode(&self, bits: &mut Bits) -> Result<usize, DepackError> {
        match self {
            Code::Single(sym) => Ok(*sym),
            Code::Canonical { count, symbols } => {
                let mut code: u32 = 0;
                let mut first: u32 = 0;
                let mut index: u32 = 0;
                for &n in &count[1..] {
                    code |= bits.get(1)?;
                    let n = n as u32;
                    if code < first + n {
                        return Ok(symbols[(index + code - first) as usize] as usize);
                    }
                    index += n;
                    first = (first + n) << 1;
                    code <<= 1;
                }
                Err(DepackError::Corrupt("Huffman code longer than 16 bits"))
            }
        }
    }
}

/// Code lengths of the code-length code (`nn`=NT, with the 2-bit zero run after
/// the third entry) and of the distance classes (`nn`=NP, no run).
fn read_pt(
    bits: &mut Bits,
    nn: usize,
    nbit: u32,
    special: Option<usize>,
    what: &'static str,
) -> Result<Code, DepackError> {
    let n = bits.get(nbit)? as usize;
    if n == 0 {
        let sym = bits.get(nbit)? as usize;
        if sym >= nn {
            return Err(DepackError::Corrupt(what));
        }
        return Ok(Code::Single(sym));
    }
    if n > nn {
        return Err(DepackError::Corrupt(what));
    }
    let mut lens = vec![0u8; nn];
    let mut i = 0;
    while i < n {
        let mut c = bits.get(3)?;
        if c == 7 {
            while bits.get(1)? == 1 {
                c += 1;
                if c as usize > MAX_CODE_LEN {
                    return Err(DepackError::Corrupt(what));
                }
            }
        }
        lens[i] = c as u8;
        i += 1;
        if Some(i) == special {
            for _ in 0..bits.get(2)? {
                if i >= nn {
                    return Err(DepackError::Corrupt(what));
                }
                lens[i] = 0;
                i += 1;
            }
        }
    }
    Code::from_lengths(&lens, what)
}

/// Code lengths of the literal/length alphabet, themselves coded with `pt`.
fn read_c(bits: &mut Bits, pt: &Code) -> Result<Code, DepackError> {
    const WHAT: &str = "bad literal/length table";
    let n = bits.get(CBIT)? as usize;
    if n == 0 {
        let sym = bits.get(CBIT)? as usize;
        if sym >= NC {
            return Err(DepackError::Corrupt(WHAT));
        }
        return Ok(Code::Single(sym));
    }
    if n > NC {
        return Err(DepackError::Corrupt(WHAT));
    }
    let mut lens = vec![0u8; NC];
    let mut i = 0;
    while i < n {
        let c = pt.decode(bits)?;
        let zeros = match c {
            0 => 1,
            1 => bits.get(4)? as usize + 3,
            2 => bits.get(CBIT)? as usize + 20,
            _ => {
                lens[i] = (c - 2) as u8;
                i += 1;
                continue;
            }
        };
        if i + zeros > NC {
            return Err(DepackError::Corrupt(WHAT));
        }
        i += zeros;
    }
    Code::from_lengths(&lens, WHAT)
}

/// Decompresses one AT2 LZH block (flag byte, u32 size, bitstream). Returns
/// the output and the number of input bytes the bitstream used.
pub fn depack(src: &[u8], max_out: usize) -> Result<(Vec<u8>, usize), DepackError> {
    if src.len() < 5 {
        return Err(DepackError::InputEnded);
    }
    if src[0] & 1 != 0 {
        return Err(DepackError::Unsupported(
            "LZH 'ultra' mode (flag bit 0), which no corpus file uses",
        ));
    }
    let size = u32::from_le_bytes([src[1], src[2], src[3], src[4]]) as usize;
    if size > max_out {
        return Err(DepackError::TooLong { limit: max_out });
    }
    let mut bits = Bits {
        src: &src[5..],
        bit: 0,
    };
    let mut out: Vec<u8> = Vec::with_capacity(size);
    while out.len() < size {
        let block = bits.get(16)? as usize;
        if block == 0 {
            return Err(DepackError::Corrupt(
                "LZH stream ended before its stated size",
            ));
        }
        let pt = read_pt(&mut bits, NT, TBIT, Some(3), "bad code-length table")?;
        let ct = read_c(&mut bits, &pt)?;
        let dt = read_pt(&mut bits, NP, PBIT, None, "bad distance table")?;
        for _ in 0..block {
            let c = ct.decode(&mut bits)?;
            if c < 256 {
                out.push(c as u8);
            } else {
                let len = c - 256 + THRESHOLD;
                let class = dt.decode(&mut bits)?;
                let dist = if class == 0 {
                    0
                } else {
                    (1usize << (class - 1)) + bits.get(class as u32 - 1)? as usize
                };
                if dist >= out.len() {
                    return Err(DepackError::Corrupt(
                        "match distance before the start of the output",
                    ));
                }
                let start = out.len() - dist - 1;
                for i in 0..len {
                    let b = out[start + i];
                    out.push(b);
                }
            }
            if out.len() >= size {
                break;
            }
        }
    }
    if out.len() != size {
        return Err(DepackError::Corrupt("LZH match ran past the stated size"));
    }
    Ok((out, 5 + bits.bit.div_ceil(8)))
}
