import hid, time, sys
from ledgerblue.ledgerWrapper import wrapCommandAPDU, unwrapResponseAPDU
CH=0x0101
apdu=bytes.fromhex(sys.argv[1]); tmo=int(sys.argv[2]) if len(sys.argv)>2 else 120
path=[d['path'] for d in hid.enumerate(0x2c97,0) if d.get('usage_page',0)==0xffa0][0]
dev=hid.device(); dev.open_path(path)
def rd(ms):
    try: return bytes(dev.read(64, ms))
    except Exception: return b""
while rd(120): pass
pk=wrapCommandAPDU(CH, apdu, 64)
for i in range(0,len(pk),64): dev.write(b'\x00'+pk[i:i+64])
buf=b""; t=time.time()
while time.time()-t<tmo:
    c=rd(800)
    if not c: continue
    buf+=c
    try: r=unwrapResponseAPDU(CH,buf,64)
    except Exception: r=None
    if r: print("RESP "+bytes(r).hex()); sys.exit(0)
print("NO_RESP after %.0fs"%(time.time()-t))
