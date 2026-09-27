//! Developer tool for the A2M player (plan-opl.md, O7).
//!   cargo run --example a2m_tool -- dump <file.a2m> [pattern...]
use audio_processor::opl::a2::engine::A2Engine;
use audio_processor::opl::a2::{parse, A2mSong};

/// AdPlug's writes per tick: index 0 is the rewind, then one per update().
fn oracle_trace(file: &str, ticks: usize) -> Vec<Vec<(u16, u8)>> {
    let bin = std::env::var("A2M_ORACLE").unwrap_or_else(|_| "trace-oracle".into());
    let out = std::process::Command::new(bin)
        .args(["trace", file, &ticks.to_string()])
        .env("A2M_PLAYER", "v2")
        .output()
        .expect("run trace-oracle");
    let mut ticks_out: Vec<Vec<(u16, u8)>> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f[0] {
            "T" => ticks_out.push(Vec::new()),
            "W" if f.len() == 4 => {
                let chip: u16 = f[1].parse().unwrap();
                let reg = u16::from_str_radix(f[2], 16).unwrap() | chip << 8;
                let val = u8::from_str_radix(f[3], 16).unwrap();
                ticks_out.last_mut().unwrap().push((reg, val));
            }
            _ => {}
        }
    }
    ticks_out
}

fn fmt_writes(w: &[(u16, u8)]) -> String {
    w.iter()
        .map(|(r, v)| format!("{r:03x}={v:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Compares the engine with the oracle tick by tick. Returns the number of
/// ticks that matched before the first difference.
fn compare(file: &str, ticks: usize, show: usize, state_only: bool) -> usize {
    let song = parse(&std::fs::read(file).unwrap()).unwrap();
    let want = oracle_trace(file, ticks);
    let mut engine = A2Engine::new(song);
    engine.adplug_quirks = true;
    let mut regs_a = [0u8; 512];
    let mut regs_b = [0u8; 512];
    let mut shown = 0;
    let mut first_bad = None;
    for (i, w) in want.iter().enumerate() {
        let mut got: Vec<(u16, u8)> = Vec::new();
        let pos = engine.position();
        if i == 0 {
            engine.reset(&mut got);
        } else {
            engine.update(&mut got);
        }
        for &(r, v) in w {
            regs_a[r as usize & 511] = v;
        }
        for &(r, v) in &got {
            regs_b[r as usize & 511] = v;
        }
        let same = if state_only {
            regs_a == regs_b
        } else {
            *w == got
        };
        if !same {
            first_bad.get_or_insert(i);
            if shown < show {
                println!(
                    "tick {} (order {} pattern {} row {}):",
                    i as i64 - 1,
                    pos.0,
                    pos.1,
                    pos.2
                );
                println!("  want {}", fmt_writes(w));
                println!("  got  {}", fmt_writes(&got));
                shown += 1;
            }
            if state_only {
                regs_b = regs_a;
            }
        }
    }
    let n = first_bad.unwrap_or(want.len());
    println!(
        "{file}: {} of {} ticks match before the first difference",
        n,
        want.len()
    );
    n
}

fn dump(song: &A2mSong, pats: &[usize]) {
    println!(
        "v{} tempo {} speed {} flags {:08b} len {} tracks {} speedup {} 4op {:06b} rpb {:?} tfine {:?}",
        song.version, song.tempo, song.speed, song.flags, song.pattern_len, song.tracks,
        song.macro_speedup, song.four_op_tracks, song.rows_per_beat, song.tempo_finetune
    );
    println!("locks {:02x?}", song.lock_flags);
    println!("order {:02x?}", &song.order);
    for (i, ins) in song.instruments.iter().enumerate() {
        if ins.fm.iter().any(|&b| b != 0) {
            print!(
                "ins {:3} fm {:02x?} pan {} fine {} type {}",
                i + 1,
                ins.fm,
                ins.panning,
                ins.finetune,
                ins.voice_type
            );
            if let Some(m) = song.fm_macros.get(i) {
                print!(
                    " | macro len {} loop {}+{} ko {} arp {} vib {}",
                    m.length,
                    m.loop_begin,
                    m.loop_length,
                    m.keyoff_pos,
                    m.arpeggio_table,
                    m.vibrato_table
                );
            }
            println!();
        }
    }
    for &p in pats {
        let pat = &song.patterns[p];
        println!("pattern {p}");
        for r in 0..pat.rows.min(song.pattern_len as usize) {
            let mut line = format!("{r:3} |");
            for c in 0..pat.channels {
                let cell = pat.cell(r, c);
                if !(cell.note == 0 && cell.instrument == 0 && cell.effects == [(0, 0); 2]) {
                    line += &format!(
                        " c{c}:{:02x} {:02x} {:02x}{:02x} {:02x}{:02x}|",
                        cell.note,
                        cell.instrument,
                        cell.effects[0].0,
                        cell.effects[0].1,
                        cell.effects[1].0,
                        cell.effects[1].1
                    );
                }
            }
            if line.len() > 5 {
                println!("{line}");
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("dump") => {
            let song = parse(&std::fs::read(&args[2]).unwrap()).unwrap();
            let pats: Vec<usize> = args[3..].iter().map(|s| s.parse().unwrap()).collect();
            dump(&song, &pats);
        }
        Some("info") => {
            for f in &args[2..] {
                let song = parse(&std::fs::read(f).unwrap()).unwrap();
                println!(
                    "{}\tv{}\ttempo {}\tspeed {}\tflags {:08b}\tspeedup {}\trpb {:?}\ttfine {:?}",
                    f,
                    song.version,
                    song.tempo,
                    song.speed,
                    song.flags,
                    song.macro_speedup,
                    song.rows_per_beat,
                    song.tempo_finetune
                );
            }
        }
        Some("effects") => {
            // version-group, effect, subnibble for extended -> file count
            let mut counts: std::collections::BTreeMap<(u8, u8, u8), usize> = Default::default();
            for f in &args[2..] {
                let song = parse(&std::fs::read(f).unwrap()).unwrap();
                let group = if song.version < 5 {
                    1
                } else if song.version < 9 {
                    5
                } else {
                    9
                };
                let mut seen = std::collections::BTreeSet::new();
                for &o in song.order.iter() {
                    if (o as usize) < song.patterns.len() {
                        let pat = &song.patterns[o as usize];
                        for cell in &pat.cells {
                            for &(e, d) in &cell.effects {
                                if e == 0 && d == 0 {
                                    continue;
                                }
                                let sub = if group == 9 && matches!(e, 0x23 | 0x24 | 0x29) {
                                    d >> 4
                                } else if group == 5 && e == 0x0e {
                                    d >> 4
                                } else {
                                    0xff
                                };
                                let sub = if group == 9 && e == 0x23 && (sub == 0xe || sub == 0xf) {
                                    d
                                } else {
                                    sub
                                };
                                seen.insert((group, e, sub));
                            }
                        }
                    }
                }
                for k in seen {
                    *counts.entry(k).or_default() += 1;
                }
            }
            for ((g, e, s), n) in counts {
                println!("v{g}+\t{e:02x}\t{s:02x}\t{n}");
            }
        }
        Some("cmp") => {
            let ticks = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(2000);
            let show = args.get(4).map(|s| s.parse().unwrap()).unwrap_or(3);
            let state = std::env::var("A2M_STATE").is_ok();
            compare(&args[2], ticks, show, state);
        }
        Some("macros") => {
            let song = parse(&std::fs::read(&args[2]).unwrap()).unwrap();
            for (i, m) in song.fm_macros.iter().enumerate() {
                if m.length == 0 && m.arpeggio_table == 0 && m.vibrato_table == 0 {
                    continue;
                }
                println!(
                    "ins {} len {} loop {}+{} ko {} arp {} vib {}",
                    i + 1,
                    m.length,
                    m.loop_begin,
                    m.loop_length,
                    m.keyoff_pos,
                    m.arpeggio_table,
                    m.vibrato_table
                );
                for (k, st) in m.steps.iter().enumerate().take(m.length as usize) {
                    println!(
                        "  {:3} fm {:02x?} slide {} pan {} dur {}",
                        k + 1,
                        st.fm,
                        st.freq_slide,
                        st.panning,
                        st.duration
                    );
                }
                if let Some(d) = song.disabled_fm_columns.get(i) {
                    if d.iter().any(|&b| b != 0) {
                        println!("  disabled {:?}", d);
                    }
                }
            }
            for (i, a) in song.arpeggio_macros.iter().enumerate() {
                if a.length != 0 {
                    println!(
                        "arp {} len {} speed {} loop {}+{} ko {} data {:?}",
                        i + 1,
                        a.length,
                        a.speed,
                        a.loop_begin,
                        a.loop_length,
                        a.keyoff_pos,
                        &a.data[..a.length as usize]
                    );
                }
            }
            for (i, a) in song.vibrato_macros.iter().enumerate() {
                if a.length != 0 {
                    println!(
                        "vib {} len {} speed {} delay {} loop {}+{} ko {} data {:?}",
                        i + 1,
                        a.length,
                        a.speed,
                        a.delay,
                        a.loop_begin,
                        a.loop_length,
                        a.keyoff_pos,
                        &a.data[..a.length as usize]
                    );
                }
            }
        }
        Some("macrotl") => {
            // step-1 TL vs instrument TL, for macros whose TL columns are enabled
            for f in &args[2..] {
                let song = parse(&std::fs::read(f).unwrap()).unwrap();
                for (i, m) in song.fm_macros.iter().enumerate() {
                    if m.length == 0 {
                        continue;
                    }
                    let dis = song.disabled_fm_columns.get(i).copied().unwrap_or([0; 28]);
                    let ins = &song.instruments[i];
                    let st = &m.steps[0];
                    if dis[5] == 0 {
                        println!("mod ins {:2} step {:2}", ins.fm[2] & 0x3f, st.fm[2] & 0x3f);
                    }
                    if dis[17] == 0 {
                        println!("car ins {:2} step {:2}", ins.fm[3] & 0x3f, st.fm[3] & 0x3f);
                    }
                }
            }
        }
        _ => eprintln!("usage: a2m_tool dump <file> [pattern...]"),
    }
}
