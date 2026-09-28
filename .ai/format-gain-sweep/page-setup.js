(async () => {
  if (window.__meas) return 'already';
  const { getSharedAudioSystem } = await import('/synth/src/audio/shared-audio-system.ts');
  const sys = getSharedAudioSystem();
  const ctx = sys.audioContext;
  const code = `
  class M extends AudioWorkletProcessor {
    constructor(){ super(); this.reset(); this.port.onmessage = (e) => { if (e.data==='take') { this.port.postMessage(this.snap()); this.reset(); } }; }
    reset(){ this.peak=0; this.ss=0; this.n=0; this.over=0; this.hist=new Uint32Array(200); this.blocks=[]; this.bss=0; this.bn=0; }
    snap(){ return {peak:this.peak, ss:this.ss, n:this.n, over:this.over, hist:Array.from(this.hist), blocks:this.blocks}; }
    process(inputs){
      const inp = inputs[0];
      if (inp && inp.length) {
        const L = inp[0], R = inp[1] || inp[0];
        for (let i=0;i<L.length;i++){
          const a = Math.abs(L[i]), b = Math.abs(R[i]);
          const m = a>b?a:b;
          if (m>this.peak) this.peak=m;
          if (m>1) this.over++;
          // histogram in 0.25 dB bins from -40 dB to +10 dB
          if (m>0.01) { let k = Math.floor((20*Math.log10(m)+40)*4); if(k>199)k=199; this.hist[k]++; }
          const s = (L[i]*L[i]+R[i]*R[i])*0.5; this.ss+=s; this.bss+=s; this.bn++;
          this.n++;
        }
        // 400 ms blocks of mean square, for gated loudness
        if (this.bn >= sampleRate*0.4) { this.blocks.push(this.bss/this.bn); this.bss=0; this.bn=0; }
      }
      return true;
    }
  }
  registerProcessor('meas-meter', M);`;
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'meas-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  sys.destinationNode.connect(node);
  const z = ctx.createGain(); z.gain.value = 0; node.connect(z); z.connect(ctx.destination);
  window.__meas = {
    sys, node,
    take: () => new Promise((res) => { node.port.onmessage = (e) => res(e.data); node.port.postMessage('take'); }),
  };
  return 'ok sr=' + ctx.sampleRate + ' state=' + ctx.state;
})()
