import { readFileSync, existsSync } from 'node:fs';
const rows = [0,1,2,3,4].flatMap(i => existsSync(`res${i}.jsonl`) ? readFileSync(`res${i}.jsonl`,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)) : []).filter(r=>!r.error);
const db = x => 20*Math.log10(Math.max(x,1e-9));
const group = r => r.coll==='amiga' ? (r.channels>4?'MOD >4ch':'MOD 4ch') : r.coll==='ahx' ? r.format : r.coll==='a2m' ? (r.channels<=9?'A2M <=9ch':'A2M >9ch') : r.coll;
for (const r of rows) {
  const tot = r.hist.reduce((a,b)=>a+b,0) || 1;
  // level exceeded by 0.1% of loud samples: walk histogram from top
  let acc=0, p999=-40; for (let k=199;k>=0;k--){acc+=r.hist[k]; if(acc>=tot*0.001){p999=k/4-40;break;}}
  const top = r.hist[160]/tot; // samples in the [0,+0.25) dB bin (chip clamp at gain 1)
  // gated loudness: mean of 400ms blocks above -40dB abs and within 10dB of ungated mean
  const b = r.blocks.filter(x=>x>1e-4); const m1 = b.reduce((a,x)=>a+x,0)/(b.length||1); const g = b.filter(x=>x>m1/10);
  r.gl = db(Math.sqrt(g.reduce((a,x)=>a+x,0)/(g.length||1)));
  r.pk = db(r.peak); r.p999=p999; r.over = r.over/r.n; r.top=top;
}
const by = {}; for (const r of rows) (by[group(r)] ??= []).push(r);
const med = a => { const s=[...a].sort((x,y)=>x-y); return s.length? (s[Math.floor((s.length-1)/2)]+s[Math.ceil((s.length-1)/2)])/2 : NaN; };
const pct = (a,p) => { const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1,Math.floor(p*(s.length-1)+0.5))]; };
console.log('group            n  peak dB med/p80/max   p99.9 dB med/p80   loud dB med (min..max)  %songs>0dBFS');
for (const [k,a] of Object.entries(by).sort()) {
  const f = x=>x.toFixed(1).padStart(5);
  console.log(k.padEnd(14), String(a.length).padStart(3), f(med(a.map(r=>r.pk))), f(pct(a.map(r=>r.pk),0.8)), f(Math.max(...a.map(r=>r.pk))), '  ', f(med(a.map(r=>r.p999))), f(pct(a.map(r=>r.p999),0.8)), '   ', f(med(a.map(r=>r.gl))), '(', f(Math.min(...a.map(r=>r.gl))), '..', f(Math.max(...a.map(r=>r.gl))), ')', (100*a.filter(r=>r.pk>0).length/a.length).toFixed(0).padStart(4));
}
if (process.argv[2]) for (const r of rows.filter(r=>group(r).startsWith(process.argv[2]))) console.log(r.file.padEnd(60), r.channels, 'pk', r.pk.toFixed(1), 'p999', r.p999.toFixed(1), 'loud', r.gl.toFixed(1), 'over', (r.over*100).toFixed(2)+'%', 'top', (r.top*100).toFixed(2)+'%');
