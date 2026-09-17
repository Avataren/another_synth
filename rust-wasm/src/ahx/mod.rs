//! AHX/HVL reference decoder (P0: format decode only, no audio rendering).
//!
//! See `.ai/ahx/verdict.md` and `.ai/ahx/ahx-requirements.md` for the
//! architectural context this module implements against, and
//! `.ai/p0-report.md` for exactly which `[VERIFY]` items this decode logic
//! resolves and how, against the vendored `hvl_replay.c` reference.

pub mod format;
