<template>
  <q-page class="help-page q-pa-xl">
    <div class="help-container">
      <q-tabs
        v-model="tab"
        class="help-tabs"
        active-color="accent"
        indicator-color="accent"
        dense
      >
        <q-tab name="basics" label="Basics" />
        <q-tab name="effects" label="Effects & Macros" />
        <q-tab name="transport" label="Transport" />
        <q-tab name="shortcuts" label="Shortcuts" />
      </q-tabs>

      <q-separator class="help-separator" />

      <q-tab-panels v-model="tab" animated swipeable class="help-panels">
        <q-tab-panel name="basics">
          <section class="help-section">
            <h2>Step layout</h2>
            <div class="pill-row">
              <div class="pill"><span class="pill-label">Note</span><span>C-4 / ###</span></div>
              <div class="pill"><span class="pill-label">Instr</span><span>01</span></div>
              <div class="pill"><span class="pill-label">Vol</span><span>7F</span></div>
              <div class="pill"><span class="pill-label">Effect</span><span>4A8</span></div>
            </div>
            <ul>
              <li><strong>Note</strong>: musical note (e.g., C-4) or ### for note-off.</li>
              <li><strong>Instr</strong>: two-digit instrument slot ID (01..).</li>
              <li><strong>Vol</strong>: hex velocity (00–FF) mapped to 0–127 MIDI velocity.</li>
              <li><strong>Effect</strong>: FT2-style effect command or macro automation using macro letters.</li>
            </ul>
          </section>

          <section class="help-section">
            <h2>Entering notes & instruments</h2>
            <ul>
              <li><strong>Typing</strong>: use the keyboard rows (Z/X/C… and Q/W/E… etc.) just like the patch editor.</li>
              <li><strong>Octave</strong>: adjust base octave in the tracker panel or with Shift+PgUp/PgDn.</li>
              <li><strong>Advance</strong>: notes move the cursor by the step size; Tab/Shift+Tab move tracks.</li>
              <li><strong>Note-off / insert row</strong>: Insert writes ### (note-off) at the current row; Shift+Insert inserts a blank row and shifts steps below down. Delete clears the step.</li>
              <li><strong>Instruments</strong>: slots hold patches; click Edit to open a slot in the patch editor. Typing previews with the active slot if it has a patch.</li>
            </ul>
          </section>
        </q-tab-panel>

        <q-tab-panel name="effects">
          <section class="help-section">
            <h2>Effect commands</h2>
            <p>
              The effect column supports FastTracker 2-style commands. Use macro letters (M/N/O/P) with two hex digits to set macros 0–3.
            </p>

            <div class="effect-table">
              <div class="effect-group">
                <h3>Pitch Effects</h3>
                <div class="effect-row"><code>0xy</code><span>Arpeggio – cycle base note, +x, +y semitones</span></div>
                <div class="effect-row"><code>1xx</code><span>Portamento up – slide pitch up xx units/tick</span></div>
                <div class="effect-row"><code>2xx</code><span>Portamento down – slide pitch down xx units/tick</span></div>
                <div class="effect-row"><code>3xx</code><span>Tone portamento – glide to note at speed xx</span></div>
                <div class="effect-row"><code>4xy</code><span>Vibrato – speed x, depth y</span></div>
                <div class="effect-row"><code>5xy</code><span>Tone porta + vol slide – porta continues, vol x↑ y↓</span></div>
                <div class="effect-row"><code>6xy</code><span>Vibrato + vol slide – vibrato continues, vol x↑ y↓</span></div>
                <div class="effect-row"><code>Uxy</code><span>Fine vibrato – ¼ depth vibrato</span></div>
              </div>

              <div class="effect-group">
                <h3>Volume Effects</h3>
                <div class="effect-row"><code>7xy</code><span>Tremolo – volume oscillation, speed x, depth y</span></div>
                <div class="effect-row"><code>Axy</code><span>Volume slide – x=up, y=down per tick</span></div>
                <div class="effect-row"><code>Cxx</code><span>Set volume – 00–40 (64 = full)</span></div>
                <div class="effect-row"><code>Txy</code><span>Tremor – on x+1 ticks, off y+1 ticks</span></div>
              </div>

              <div class="effect-group">
                <h3>Panning</h3>
                <div class="effect-row"><code>8xx</code><span>Set panning – 00=left, 80=center, FF=right</span></div>
                <div class="effect-row"><code>Pxy</code><span>Panning slide – x=right, y=left per tick</span></div>
              </div>

              <div class="effect-group">
                <h3>Timing &amp; Retrigger</h3>
                <div class="effect-row"><code>9xx</code><span>Sample offset – start sample at xx×256</span></div>
                <div class="effect-row"><code>Kxx</code><span>Key off – release note after xx ticks</span></div>
                <div class="effect-row"><code>Rxy</code><span>Retrigger + vol – retrig every y ticks, vol change x</span></div>
              </div>

              <div class="effect-group">
                <h3>Speed &amp; Tempo</h3>
                <div class="effect-row"><code>F01–F1F</code><span>Set speed – ticks per row (1–31, lower=faster)</span></div>
                <div class="effect-row"><code>F20–FFF</code><span>Set tempo – BPM (32–255)</span></div>
              </div>

              <div class="effect-group">
                <h3>Pattern Control</h3>
                <div class="effect-row"><code>Bxx</code><span>Position jump – jump to sequence position xx</span></div>
                <div class="effect-row"><code>Dxx</code><span>Pattern break – break to row xx of next pattern</span></div>
              </div>

              <div class="effect-group">
                <h3>Global</h3>
                <div class="effect-row"><code>Gxx</code><span>Set global volume – 00–40</span></div>
                <div class="effect-row"><code>Hxy</code><span>Global volume slide – x=up, y=down</span></div>
              </div>

              <div class="effect-group">
                <h3>Extended Effects (Exy)</h3>
                <div class="effect-row"><code>E1x</code><span>Fine porta up – once on tick 0</span></div>
                <div class="effect-row"><code>E2x</code><span>Fine porta down – once on tick 0</span></div>
                <div class="effect-row"><code>E3x</code><span>Glissando control – 0=off, 1=on (semitone slides)</span></div>
                <div class="effect-row"><code>E4x</code><span>Vibrato waveform – 0=sine, 1=ramp, 2=square, 3=random</span></div>
                <div class="effect-row"><code>E5x</code><span>Set finetune – x = finetune value</span></div>
                <div class="effect-row"><code>E6x</code><span>Pattern loop – x=0 set start, x>0 loop x times</span></div>
                <div class="effect-row"><code>E7x</code><span>Tremolo waveform – same as vibrato</span></div>
                <div class="effect-row"><code>E8x</code><span>Set panning (coarse) – 0–F left to right</span></div>
                <div class="effect-row"><code>E9x</code><span>Retrigger – retrigger note every x ticks</span></div>
                <div class="effect-row"><code>EAx</code><span>Fine volume up – add x to volume once</span></div>
                <div class="effect-row"><code>EBx</code><span>Fine volume down – subtract x from volume once</span></div>
                <div class="effect-row"><code>ECx</code><span>Note cut – cut note after x ticks</span></div>
                <div class="effect-row"><code>EDx</code><span>Note delay – delay note by x ticks</span></div>
                <div class="effect-row"><code>EEx</code><span>Pattern delay – delay pattern by x rows</span></div>
              </div>
            </div>
          </section>

          <section class="help-section">
            <h2>Macro automation & interpolation</h2>
            <ul>
              <li><strong>Direct macros</strong>: Use M/N/O/P + two hex digits to set macros 0–3 (00–FF → 0–1); the macro letter plus the two digits must fit in the three effect cells.</li>
              <li><strong>Interpolation</strong>: Press <strong>L</strong> on an empty effect cell to create a range between the nearest matching macro above/below. Press L again to cycle Linear → Exponential → None (remove).</li>
              <li><strong>Endpoints</strong>: Ramps start at the beginning of the first macro row and end just before the start of the last row to avoid timestamp overlap; interior rows don’t reset the ramp.</li>
              <li><strong>Visuals</strong>: Linear ranges highlight in soft green; exponential in soft blue.</li>
              <li><strong>Edits</strong>: Typing any effect inside a range clears that range. Adjacent ranges are allowed; overlapping ones are ignored.</li>
            </ul>
          </section>
        </q-tab-panel>

        <q-tab-panel name="transport">
          <section class="help-section">
            <h2>Transport & patterns</h2>
            <ul>
              <li><strong>Play modes</strong>: Pattern vs Song in the tracker toolbar.</li>
              <li><strong>Length</strong>: set rows per pattern and step size in the right panel.</li>
              <li><strong>Sequence</strong>: arrange patterns in the sequence editor at the top.</li>
            </ul>
          </section>
        </q-tab-panel>

        <q-tab-panel name="shortcuts">
          <section class="help-section">
            <h2>Keyboard shortcuts</h2>

            <h3>General</h3>
            <ul>
              <li><strong>F2</strong>: Toggle edit mode on/off.</li>
              <li><strong>F10</strong>: Toggle fullscreen pattern view.</li>
              <li><strong>Ctrl+Z</strong>: Undo.</li>
              <li><strong>Ctrl+Y / Ctrl+Shift+Z</strong>: Redo.</li>
              <li><strong>Spacebar</strong>: Play/pause pattern.</li>
            </ul>

            <h3>Navigation</h3>
            <ul>
              <li><strong>Arrow Up/Down</strong>: Move one row.</li>
              <li><strong>PageUp/PageDown</strong>: Move 16 rows.</li>
              <li><strong>Home/End</strong>: Jump to first/last row.</li>
              <li><strong>Tab/Shift+Tab</strong>: Move to next/previous track.</li>
              <li><strong>Shift+PageUp/PageDown</strong>: Adjust base octave.</li>
              <li><strong>Ctrl+ArrowUp/ArrowDown</strong>: Adjust step size.</li>
            </ul>

            <h3>Selection &amp; Clipboard</h3>
            <ul>
              <li><strong>Shift+Arrow keys</strong>: Extend/shrink rectangular selection.</li>
              <li><strong>Ctrl+C / Ctrl+V</strong>: Copy/paste selection.</li>
              <li><strong>F3</strong>: Copy current track.</li>
              <li><strong>Shift+F3</strong>: Cut current track.</li>
              <li><strong>F4</strong>: Paste track to current track.</li>
              <li><strong>F6</strong>: Copy entire pattern.</li>
              <li><strong>Shift+F6</strong>: Cut entire pattern.</li>
              <li><strong>Ctrl+F6</strong>: Paste pattern to current pattern.</li>
            </ul>

            <h3>Transpose</h3>
            <ul>
              <li><strong>Ctrl+Shift+ArrowUp/ArrowDown</strong>: Transpose selection by one octave.</li>
              <li><strong>F7</strong>: Transpose current track down 1 semitone.</li>
              <li><strong>Shift+F7</strong>: Transpose current track up 1 semitone.</li>
              <li><strong>F8</strong>: Transpose entire pattern down 1 semitone.</li>
              <li><strong>Shift+F8</strong>: Transpose entire pattern up 1 semitone.</li>
            </ul>

            <h3>Editing</h3>
            <ul>
              <li><strong>Insert</strong>: Write note-off (###).</li>
              <li><strong>Shift+Insert</strong>: Insert blank row and shift steps down.</li>
              <li><strong>Delete</strong>: Clear current step (or just Vol/Macro field when in those columns).</li>
              <li><strong>Shift+Delete</strong>: Delete row and shift steps up.</li>
              <li><strong>L (effect column)</strong>: Cycle macro interpolation (Linear → Exponential → None).</li>
            </ul>
          </section>
        </q-tab-panel>
      </q-tab-panels>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const tab = ref<'basics' | 'effects' | 'transport' | 'shortcuts'>('basics');
</script>

<style scoped>
.help-page {
  background: #0b111a;
  color: #e8f3ff;
}

.help-container {
  max-width: 980px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.help-tabs {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  --q-primary: var(--tracker-accent, #4df2c5);
  --q-accent: var(--tracker-accent, #4df2c5);
  --q-tabs-text: var(--tracker-default-text, #e8f3ff);
}

.help-separator {
  border-color: rgba(255, 255, 255, 0.08);
}

.help-panels {
  background: transparent;
}

.help-section {
  padding: 16px 18px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.help-section h2 {
  margin-top: 0;
  margin-bottom: 10px;
  font-size: 20px;
}

.help-section ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}

.pill-row {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  margin-bottom: 12px;
}

.pill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.pill-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  font-size: 11px;
  color: #8ef5c5;
}

.effect-table {
  display: grid;
  gap: 16px;
}

.effect-group {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  background: rgba(10, 16, 24, 0.7);
}

.effect-group h3 {
  margin: 0 0 8px 0;
  font-size: 15px;
  color: #b9ceff;
  letter-spacing: 0.04em;
}

.effect-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.effect-row:last-child {
  border-bottom: none;
}

.effect-row code {
  display: inline-block;
  min-width: 58px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #8ef5c5;
  font-weight: 700;
}

.effect-row span {
  color: rgba(232, 243, 255, 0.82);
}

.help-section h3 {
  margin: 12px 0 6px 0;
}
</style>
