import re,sys
import os
hdr=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','app','src','unlink_params.h')).read()
def field(name):
    m=re.search(name+r'\[32\]\s*=\s*\{(.*?)\};',hdr,re.S)
    return int.from_bytes(bytes(int(x,16) for x in re.findall(r'0x([0-9a-fA-F]{2})',m.group(1))),'big')
def blocks(name,c):
    m=re.search(name+r'\['+str(c)+r'\]\[32\]\s*=\s*\{(.*?)\};',hdr,re.S)
    n=[int(x,16) for x in re.findall(r'0x([0-9a-fA-F]{2})',m.group(1))]
    return [int.from_bytes(bytes(n[i*32:(i+1)*32]),'big') for i in range(c)]
P=field('PARM_P'); A=field('PARM_A'); D=field('PARM_D')
B8=(field('PARM_B8X'),field('PARM_B8Y'))
C=blocks('POSEIDON_C',408); M=blocks('POSEIDON_M',36)
RF,RP,T=8,60,6; NR=68
def padd(p,q):
    x1,y1=p;x2,y2=q
    b=(D*x1*x2*y1*y2)%P
    x3=(x1*y2+y1*x2)*pow((1+b)%P,-1,P)%P
    y3=(y1*y2-A*x1*x2)*pow((1-b)%P,-1,P)%P
    return (x3,y3)
def smul(k,p):
    r=(0,1)
    while k>0:
        if k&1: r=padd(r,p)
        p=padd(p,p); k>>=1
    return r
def poseidon5(ins):
    st=[0]+list(ins)
    for x in range(NR):
        for y in range(T):
            st[y]=(st[y]+C[x*T+y])%P
            if x<RF//2 or x>=RF//2+RP: st[y]=pow(st[y],5,P)
            elif y==0: st[y]=pow(st[y],5,P)
        ns=[0]*T
        for xx in range(T):
            acc=0
            for yy in range(T): acc=(acc+M[xx*T+yy]*st[yy])%P
            ns[xx]=acc
        st=ns
    return st[0]
order=21888242871839275222246405745257275088614511777268538073601725287587578984328
sub=order>>3
def verify(Ax,Ay,R8x,R8y,S,msg):
    hm=poseidon5([R8x,R8y,Ax,Ay,msg])
    lhs=smul(S%sub,B8)
    rhs=padd((R8x,R8y), smul((8*hm)%order,(Ax,Ay)))
    oncurve=(A*Ax*Ax+Ay*Ay - (1+D*Ax*Ax*Ay*Ay))%P==0
    return lhs==rhs, oncurve, hm
def _toint(s): return int(s,16) if s.lower().startswith("0x") else int(s)
if __name__=="__main__":
    # CLI: verify.py Ax Ay R8x R8y S msg  (decimal or 0x-hex) -> prints, exits 0 if valid
    if len(sys.argv)==7:
        a=[_toint(x) for x in sys.argv[1:7]]
        ok,oc,_=verify(a[0],a[1],a[2],a[3],a[4],a[5])
        print("verify=%s on_curve=%s"%(ok,oc)); sys.exit(0 if ok and oc else 1)
    # vector 0 sanity
    v=dict(Ax=0x111ad6eaff70758b7ad109a32526c54ae58eff19a8667f0b41b8c228f86588ee,
           Ay=0x1810293488974f0ae2d566a860d00c5bd24fc094b076e260e3b9b65b0555fb92,
           R8x=0x0afcb8a38dc22f29cdbda58c3ac10550734a791cf4fa00181efe1fad4af3febf,
           R8y=0x14ce4560b8c96fb075cd94a8e773a0ccfd49ece3d67f3c2764e8f7be04b4e64d,
           S=0x01f19b24c634473671fc821393051b631b338608675e489d7d05f6ab4fc55318,msg=42)
    ok,oc,hm=verify(**v)
    print("vector0: verify=%s on_curve=%s"%(ok,oc))
