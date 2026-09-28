// usage: node drive.mjs <port> <listfile.json> <out.jsonl> [seconds]
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const [, , cdpPort, listFile, outFile, secsArg] = process.argv;
const SECS = Number(secsArg ?? 60);
const songs = JSON.parse(readFileSync(listFile, 'utf8'));
const done = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);
const setup = readFileSync(new URL('./page-setup.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800)); return r.result?.result?.value; };

await send('Page.navigate', { url: 'http://localhost:9321/synth/#/jukebox' });
await sleep(8000);
console.log('setup', await ev(setup));
const findPage = `(() => { let c = document.querySelector('.jukebox-page').__vueParentComponent; while (c && !(c.setupState && c.setupState.player)) c = c.parent; return c.setupState; })()`;
await ev(`window.__jb = ${findPage}; window.__jb.player.stop(); 'ok'`);

for (const s of songs) {
  if (done.has(s.file)) continue;
  const t0 = Date.now();
  try {
    await ev(`(async () => { const jb = window.__jb; jb.player.clear(); const i = jb.player.addSong(${JSON.stringify(s)}); await jb.player.playIndex(i); jb.jukebox.setActive(false); jb.host.songBank.setUserMasterVolume(1); await window.__meas.take(); return 'ok'; })()`);
    await sleep(SECS * 1000);
    const m = await ev(`(async () => { const r = await window.__meas.take(); window.__jb.player.stop(); window.__jb.playbackStore.stop(); return r; })()`);
    appendFileSync(outFile, JSON.stringify({ ...s, ...m, loadMs: 0 }) + '\n');
    console.log(s.file, 'peak', m.peak.toFixed(3), 'rms', Math.sqrt(m.ss / m.n).toFixed(4), 'secs', (m.n / 48000).toFixed(1));
  } catch (e) {
    console.log('FAIL', s.file, String(e).slice(0, 300));
    appendFileSync(outFile, JSON.stringify({ ...s, error: String(e).slice(0, 300) }) + '\n');
  }
  await sleep(1500);
}
ws.close();
