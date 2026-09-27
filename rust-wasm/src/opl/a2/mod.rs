//! Adlib Tracker II modules (`.a2m`), batch O6 of `.ai/plan-opl.md`: the
//! container, its three packers and the song model the O7 player consumes.
//!
//! The layout comes from the tracker authors' own format description,
//! `techinfo.htm` (adlibtracker.net/files), and is checked against every
//! module in `src/tests/fixtures/opl/a2m`. Where the files disagree with that
//! document, the files win and the difference is noted where it is handled.
//! Adlib Tracker II's source is GPL 3+ and was not read (plan decision D1).
//!
//! E15 discipline: `parse` either returns the whole song or refuses with one
//! true sentence. Nothing is skipped, clamped or guessed silently.

pub mod aplib;
pub mod lzh;
pub mod model;
pub mod sixpack;

pub use model::{parse, unpack, A2mError, A2mSong, Cell, Pattern};

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DepackError {
    /// The packed stream ran out before its end marker or stated size.
    InputEnded,
    /// The stream decodes to more bytes than the block may hold.
    TooLong { limit: usize },
    /// The stream contradicts itself (bad table, match before the start, ...).
    Corrupt(&'static str),
    /// A packer mode the corpus never uses, so it is unverified.
    Unsupported(&'static str),
}

impl fmt::Display for DepackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DepackError::InputEnded => write!(f, "packed data ends early"),
            DepackError::TooLong { limit } => write!(f, "unpacks to more than {limit} bytes"),
            DepackError::Corrupt(why) => write!(f, "{why}"),
            DepackError::Unsupported(what) => write!(f, "uses {what}"),
        }
    }
}

#[cfg(test)]
mod tests;
