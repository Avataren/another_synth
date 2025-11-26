<template>
  <q-page class="help-page q-pa-xl">
    <div class="help-container">
      <header class="help-hero">
        <div>
          <div class="eyebrow">Guide</div>
          <h1>Tracker quickstart</h1>
          <p class="lede">
            Learn how to enter notes, shape steps, and manage instruments in the tracker.
          </p>
        </div>
      </header>

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
          <li><strong>Effect</strong>: FT2-style effect command (e.g., <code>4A8</code> = vibrato) or <code>Mnxx</code> for macro automation.</li>
        </ul>
      </section>

      <section class="help-section">
        <h2>Entering notes</h2>
        <ul>
          <li><strong>Typing</strong>: use the keyboard rows (Z/X/C… and Q/W/E… etc.) just like the patch editor.</li>
          <li><strong>Octave</strong>: adjust base octave in the tracker panel or with Shift+PgUp/PgDn.</li>
          <li><strong>Advance</strong>: notes move the cursor by the step size; Tab/Shift+Tab move tracks.</li>
          <li><strong>Note-off / insert row</strong>: Insert writes ### (note-off) at the current row; Shift+Insert inserts a blank row at the cursor and shifts steps below down. Delete clears the step.</li>
        </ul>
      </section>

      <section class="help-section">
        <h2>Instruments</h2>
        <ul>
          <li><strong>Slots</strong>: each tracker instrument slot holds a synth patch (same engine as the editor).</li>
          <li><strong>Edit</strong>: click <em>Edit</em> beside a slot to open the patch editor for that instrument.</li>
          <li><strong>Assign</strong>: choose patches from the bank dropdown per slot; slots use two-digit IDs in steps.</li>
          <li><strong>Preview</strong>: typing notes will preview using the active instrument if it has a patch.</li>
        </ul>
      </section>

      <section class="help-section">
        <h2>Effect commands</h2>
        <p>The effect column supports FastTracker 2-style commands. Use <code>Mnxx</code> prefix for macro automation.</p>

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

          <div class="effect-group">
            <h3>Macro Automation</h3>
            <div class="effect-row"><code>M0xx</code><span>Set macro 0 to xx (00–FF → 0–1)</span></div>
            <div class="effect-row"><code>M1xx</code><span>Set macro 1 to xx</span></div>
            <div class="effect-row"><code>M2xx</code><span>Set macro 2 to xx</span></div>
            <div class="effect-row"><code>M3xx</code><span>Set macro 3 to xx</span></div>
          </div>
        </div>
      </section>

      <section class="help-section">
        <h2>Transport & patterns</h2>
        <ul>
          <li><strong>Play</strong>: Pattern vs Song modes in the tracker toolbar.</li>
          <li><strong>Length</strong>: set rows per pattern and step size in the right panel.</li>
          <li><strong>Sequence</strong>: arrange patterns in the sequence editor at the top.</li>
        </ul>
      </section>

      <section class="help-section">
        <h2>Keyboard shortcuts</h2>
        <ul>
          <li><strong>Edit mode</strong>: F2 toggles edit mode on/off.</li>
          <li><strong>Fullscreen pattern</strong>: F10 toggles the pattern view between normal and full-screen.</li>
          <li><strong>Undo / redo</strong>: Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo.</li>
          <li><strong>Copy / paste</strong>: Ctrl/Cmd+C copies the current selection; Ctrl/Cmd+V pastes it at the cursor (overwriting steps inside the pasted block).</li>
          <li><strong>Play / pause pattern</strong>: Spacebar.</li>
          <li><strong>Row navigation</strong>: Arrow Up/Down move one row; PageUp/PageDown move 16 rows. Hold Shift+Arrow keys to extend or shrink a rectangular selection.</li>
          <li><strong>Step size</strong>: Ctrl+ArrowUp/ArrowDown increases/decreases the step size (rows to advance after entering a note).</li>
          <li><strong>Transpose selection</strong>: Ctrl+Shift+ArrowUp/ArrowDown transposes all notes in the selection by one octave.</li>
          <li><strong>Jump rows</strong>: Home jumps to the first row; End jumps to the last row.</li>
          <li><strong>Track navigation</strong>: Tab moves to the next track; Shift+Tab to the previous track.</li>
          <li><strong>Octave</strong>: Shift+PageUp/PageDown adjusts the base octave.</li>
          <li><strong>Row edits</strong>: Insert writes a note-off (###); Shift+Insert inserts a blank row and shifts steps down.</li>
          <li><strong>Delete</strong>: Delete clears the current step; Shift+Delete deletes the row and shifts steps up. In Vol/Macro columns, Delete clears just that field.</li>
        </ul>
      </section>
    </div>
  </q-page>
</template>

<style scoped>
.help-page {
  background: #0b111a;
  color: #e8f3ff;
}

.help-container {
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.help-hero {
  padding: 18px 20px;
  background: linear-gradient(135deg, rgba(77, 242, 197, 0.08), rgba(112, 194, 255, 0.12));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 11px;
  color: #9fb3d3;
}

h1 {
  margin: 4px 0 6px;
  font-size: 26px;
}

.lede {
  margin: 0;
  color: #c8d9f2;
}

.help-section {
  padding: 14px 16px;
  background: #0f1621;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.help-section h2 {
  margin: 0;
  font-size: 18px;
}

.help-section h3 {
  margin: 12px 0 4px;
  font-size: 14px;
  color: #9fb3d3;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.help-section ul {
  margin: 0;
  padding-left: 18px;
  color: #c8d9f2;
}

.pill-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pill {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 13px;
}

.pill-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #9fb3d3;
  font-size: 11px;
}

code {
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 6px;
  border-radius: 6px;
}

.effect-table {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.effect-group {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  padding: 12px;
}

.effect-group h3 {
  margin: 0 0 8px 0;
  font-size: 12px;
  color: #70c2ff;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 6px;
}

.effect-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  font-size: 12px;
  line-height: 1.4;
}

.effect-row code {
  flex-shrink: 0;
  min-width: 60px;
  font-size: 11px;
  color: #4df2c5;
  background: rgba(77, 242, 197, 0.1);
}

.effect-row span {
  color: #b8c9e0;
}
</style>
