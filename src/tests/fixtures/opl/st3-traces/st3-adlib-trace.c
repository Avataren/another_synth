// ST3 AdLib register-trace oracle for src/tests/s3m-adlib-st3-trace.test.ts:
// st3play's replayer (BSD-3, Olav Sorensen, a C port of ST3.21) with its OPL2
// emulator replaced by a logger. Built by regen.sh. One line per register
// write, in ST3's own order:
//   <tick> <reg hex> <val hex>
// Tick -1 is initadlib (zplaysong); tick n is the n-th dorow()+updateregs().
// A "T <tick> <speed> <bpm> <next order> <next row>" line follows any tick
// after which the position or tempo changed: a row starts on each tick whose
// next-row changed, which is how a comparison puts its own times on ticks.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include "dig.h"
#include "digread.h"
#include "digdata.h"

static int32_t g_tick = -1;
bool renderToWavFlag;

void OPL2_Init(int32_t f) { (void)f; }
void OPL2_WritePort(uint16_t reg, uint8_t val) { printf("%d %02X %02X\n", g_tick, reg, val); }
void OPL2_RenderSamples(float *l, float *r, int32_t n) { (void)l; (void)r; (void)n; }

void lockMixer(void) {}
void unlockMixer(void) {}
bool openMixer(int32_t f, int32_t b) { (void)f; (void)b; return true; }
void closeMixer(void) {}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s file.s3m ticks\n", argv[0]); return 2; }
    renderToWavFlag = true;
    if (!initMusic(44100, 4096)) { fprintf(stderr, "initMusic failed\n"); return 1; }
    if (!load_st3(argv[1], SOUNDCARD_SBPRO)) { fprintf(stderr, "load failed\n"); return 1; }
    if (!zplaysong(0)) { fprintf(stderr, "play failed\n"); return 1; }
    int ticks = atoi(argv[2]);
    int lastBpm = -1, lastOrd = -1, lastRow = -1;
    for (g_tick = 0; g_tick < ticks; g_tick++) {
        dorow();
        updateregs();
        // ST3 keeps samples-per-tick, not the BPM: recover it from its table.
        int bpm = 0;
        for (int i = 255; i > 0; i--)
            if (audio.bpm2SamplesPerTickInt[i] == audio.samplesPerTickInt &&
                audio.bpm2SamplesPerTickFrac[i] == audio.samplesPerTickFrac) { bpm = i; break; }
        if (bpm != lastBpm || song.np_ord != lastOrd || song.np_row != lastRow)
            printf("T %d %d %d %d %d\n", g_tick, song.musicmax, bpm, song.np_ord, song.np_row);
        lastBpm = bpm; lastOrd = song.np_ord; lastRow = song.np_row;
    }
    return 0;
}
