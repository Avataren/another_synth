import numpy as np, math
MAXH=512
def ladder():
    return [max(1,round(512*2**(-l/2))) for l in range(18)]
LAD=ladder()
def level_for(f0):
    for l,h in enumerate(LAD):
        if h*f0<0.5: return l
    return 17
def spectrum(cyc):
    n=len(cyc); X=np.fft.fft(np.array(cyc,float))
    c=np.zeros(MAXH+1,complex); c[0]=X[0].real/n
    for k in range(1,MAXH+1):
        th=math.pi*k/n
        c[k]=X[k%n]*np.exp(-1j*th)*math.sin(th)/(math.pi*k)
    return c
def build(c,H,S,frac):
    sp=np.zeros(S,complex); sp[0]=c[0]*S
    for k in range(1,H+1):
        sp[k]=c[k]*S; sp[S-k]=np.conj(c[k]*S)
    t=np.fft.ifft(sp).real  # numpy ifft scales by 1/S -> sum c_k e^
    if frac is None: return t
    return np.clip(np.round(t*(1<<frac)),-32768,32767)/(1<<frac)
def render(tab,n,delta,frames):
    S=len(tab); ratio=S//n; mask=(S<<16)-1
    pos=(np.arange(frames,dtype=np.int64)*delta)%(0x280<<16)
    p=(pos*ratio)&mask; i=p>>16; fr=(p&0xffff)
    a=tab[i]; b=tab[(i+1)&(S-1)]
    if np.issubdtype(np.asarray(tab).dtype,np.floating) and not np.all(tab==np.round(tab)):
        return a+(b-a)*fr/65536.0
    return a+(b-a)*fr/65536.0
def inharm(x,f0,H):
    N=len(x); w=np.blackman(N)  # blackman approx
    from numpy import cos,pi
    k=np.arange(N); w=0.35875-0.48829*cos(2*pi*k/N)+0.14128*cos(4*pi*k/N)-0.01168*cos(6*pi*k/N)
    P=np.abs(np.fft.rfft((x-x.mean())*w))**2
    tot=P[1:].sum(); harm=0
    mask=np.zeros(len(P),bool)
    for h in range(1,H+1):
        b=h*f0*N
        lo=max(1,int(b-8)); hi=int(b+9)
        mask[lo:hi]=True
    return 10*np.log10(max(P[~mask][1:].sum(),1e-30)/tot)
def run(name,cyc,bps_list):
    n=len(cyc); c=spectrum(cyc)
    for bps in bps_list:
        delta=round(bps*65536); f0=delta/65536/n
        l=level_for(f0); H=LAD[l]
        Sad=max(min(max(64,1<<(8*H-1).bit_length()),4096),n)
        row=[]
        for S,frac in [(4096,4),(4096,7),(4096,None),(Sad,7),(Sad,None)]:
            tab=build(c,H,S,frac)
            x=render(tab,n,delta,65536)
            row.append(inharm(x,f0,H))
        print(f"{name:10s} bps {bps:.3f} f0 {f0:.4f} H {H:3d} Sad {Sad:4d}: S4096/F4 {row[0]:7.1f}  S4096/F7 {row[1]:7.1f}  S4096/float {row[2]:7.1f} | Sad/F7 {row[3]:7.1f}  Sad/float {row[4]:7.1f}")
fs=48000
bps=[3546895/p/fs for p in (0xd60,0x400,0x280,0x180,0xe2,0x71)]
run("sq4",[127,127,-128,-128],bps)
run("sq32_25",[127]*8+[-128]*24,bps)
saw=lambda n:[int(-128+255*i/(n-1)) for i in range(n)]
run("saw8",saw(8),bps)
run("saw128",saw(128),bps)
tri=lambda n:[int(round(127*(1-abs(4*i/n-2)) if True else 0)) for i in range(n)]
run("tri16",tri(16),bps)

print("\n=== multiplier sweep (FRAC 7, Sad = clamp(next_pow2(M*H),64,4096) max n) ===")
def run2(name,cyc,bps_list):
    n=len(cyc); c=spectrum(cyc)
    for bps in bps_list:
        delta=round(bps*65536); f0=delta/65536/n
        l=level_for(f0); H=LAD[l]
        row=[]
        for M in (8,16,32,64):
            S=max(min(max(64,1<<(M*H-1).bit_length()),4096),n)
            x=render(build(c,H,S,7),n,delta,65536); row.append((S,inharm(x,f0,H)))
        ref=inharm(render(build(c,H,4096,4),n,delta,65536),f0,H)
        print(f"{name:8s} f0 {f0:.4f} H {H:3d}: now(4096/F4) {ref:6.1f} | "+"  ".join(f"M{M}:{S}:{v:6.1f}" for M,(S,v) in zip((8,16,32,64),row)))
for nm,cy in [("sq4",[127,127,-128,-128]),("sq32_25",[127]*8+[-128]*24),("saw8",saw(8)),("tri16",tri(16))]:
    run2(nm,cy,bps[1:])
