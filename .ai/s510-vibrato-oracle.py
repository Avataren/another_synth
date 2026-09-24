# Independent transcription of gplay.c tick-N CMD_VIBRATO / CMD_DONOTHING (615-640, 767-800)
# for one channel whose note is set by a one-row wave table on frame 1.
def gt(frames, tempo, cmp, speed, mode='cmd4', vibdelay=0):
    vibtime=0; off=0; out=[]
    vd=vibdelay
    for f in range(frames):
        tick=f%tempo
        if f==0: out.append(None); continue          # new note frame: NEXTCHN
        if f==1: off=0; vibtime=0; out.append(off); continue  # wave note: freq=base, vibtime=0
        if tick!=0:
            run=True
            if mode=='ins':
                if vd==0: run=False
                elif vd>1: vd-=1; run=False
            if run:
                if vibtime<0x80 and vibtime>cmp: vibtime^=0xff
                vibtime=(vibtime+2)&0xff
                off = off-speed if vibtime&1 else off+speed
        out.append(off)
    return out
import sys
o=gt(80,64,16,5); print(o)
# phase lengths
signs=[]; prev=0
for a,b in zip(o[1:],o[2:]):
    signs.append(b-a)
runs=[]; 
for s in signs:
    if runs and runs[-1][0]==s: runs[-1][1]+=1
    else: runs.append([s,1])
print(runs)
print(gt(12,6,1,10)); print(gt(20,100,1,10))
print('ins d=3',gt(12,100,2,7,'ins',3)); print('ins d=0',gt(8,100,2,7,'ins',0)); print('ins d=1',gt(8,100,2,7,'ins',1))
print('T40', gt(80,40,16,5))
print('T6c1', gt(14,6,1,10))
print('insd3', gt(12,100,2,7,'ins',3))
print('insd2t6', gt(14,6,2,7,'ins',2))
