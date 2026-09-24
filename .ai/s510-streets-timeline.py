import sys
b=open('src/tests/fixtures/gt-songs/aeuk/metal_warrior_4_streets.sng','rb').read()
at=101; lists=[]
for s in range(b[100]):
  for c in range(3):
    n=b[at]; d=b[at+1:at+2+n]; at+=n+2; lists.append(d)
for i in range(31):
  h=b[at:at+8]; at+=24; at+= (h[7]>>1)*2
np_=b[at]; at+=1; pats=[]
for p in range(np_):
  L=b[at]; at+=1; pats.append(b[at:at+L]); at+=L
plen=[len(p)//3-1 for p in pats]
def decode(d,mode):
  t=0; r=1; ents=[]; pat_at=[]
  for k,v in enumerate(d[:-2]):
    if v>=0xe0: t=v-0xf0
    elif v>=0xd0: r=((v&15) or 16) if mode=='old' else (v&15)+1
    else: ents.append((v,t,r)); pat_at.append(k); r=1
  rb=d[-1]; restart=next(i for i,a in enumerate(pat_at) if a>=rb)
  return ents,restart
def timeline(ents,restart,total=None):
  segs=[]; at=0
  def push(i):
    nonlocal at
    p,t,r=ents[i]
    for k in range(r): segs.append((at,p,t,k,i)); at+=plen[p]
  for i in range(len(ents)): push(i)
  if total is None: return segs
  while at<total:
    i=restart
    while i<len(ents) and at<total: push(i); i+=1
  return segs
def grid(mode):
  dec=[decode(lists[c],mode) for c in range(3)]
  total=max(sum(plen[p]*r for p,t,r in e) for e,_ in dec)
  tls=[timeline(e,rs,total) for e,rs in dec]
  starts=sorted({s[0] for tl in tls for s in tl if s[0]<total})
  cells=[]
  for st in starts:
    row=[]
    for tl in tls:
      seg=[s for s in tl if s[0]<=st][-1]; row.append(seg)
    cells.append((st,row))
  return total,cells
for mode in ('old','new'):
  total,cells=grid(mode)
  print(mode,'total rows',total,'positions',len(cells))
  for idx in [i for i,(st,_) in enumerate(cells) if 1300<=st<=1700]:
    st,row=cells[idx]
    print(' pos %d row %d: '%(idx,st)+' | '.join('e%d p%02x t%+d r%d off%d'%(s[4],s[1],s[2],s[3],st-s[0]) for s in row))

print()
print('=== channel timelines, subtune 0: entry: pattern transpose plays -> start row (old | GT) ===')
for c in range(3):
    eo,_=decode(lists[c],'old'); en,_=decode(lists[c],'new')
    ro=rn=0
    print('channel',c+1,'(%d entries)'%len(en))
    for i,((p,t,r0),(_,_,r1)) in enumerate(zip(eo,en)):
        print('  e%02d p%02x %+d  plays %2d|%2d  start %4d|%4d'%(i,p,t,r0,r1,ro,rn))
        ro+=plen[p]*r0; rn+=plen[p]*r1
    print('  end %d|%d'%(ro,rn))
