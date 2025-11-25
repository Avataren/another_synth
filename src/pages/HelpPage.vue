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
          <div class="pill"><span class="pill-label">Macro</span><span>0FF</span></div>
        </div>
        <ul>
          <li><strong>Note</strong>: musical note (e.g., C-4) or ### for note-off.</li>
          <li><strong>Instr</strong>: two-digit instrument slot ID (01..).</li>
          <li><strong>Vol</strong>: hex velocity (00–FF) mapped to 0–127 MIDI velocity.</li>
          <li><strong>Macro</strong>: three hex nibbles: <code>Mxx</code> → macro index (0–3) + value (00–FF).</li>
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
        <p>The macro column supports special effect commands in addition to macro automation:</p>
        <ul>
          <li>
            <strong>Fxx – Speed/Tempo</strong>: Changes playback speed or tempo mid-pattern.
            <ul>
              <li><code>F01</code>–<code>F1F</code>: Set speed (ticks per row, 1–31). Lower = faster.</li>
              <li><code>F20</code>–<code>FFF</code>: Set tempo in BPM (32–255).</li>
            </ul>
          </li>
          <li>
            <strong>0xx–3xx – Macro</strong>: Set macro slot 0–3 to value xx (00–FF).
          </li>
        </ul>
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
          <li><strong>Transpose selection</strong>: Ctrl/Cmd+ArrowUp/ArrowDown transposes all notes in the selection by one semitone; Shift+Ctrl/Cmd+ArrowUp/ArrowDown transposes by one octave.</li>
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
</style>
