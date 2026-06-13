// Unlink EdDSA-Poseidon signer on the Secure Element (cx_bn + cx_blake2b).
// 1:1 transposition of the GMP host port validated 9/9 vs the SDK vectors.
//   s  = LE( prune(Blake2b(key)[0:32]) )      // multiple of 8, bit254 set
//   A  = (s>>3)·Base8
//   r  = LE( Blake2b(key_hash[32:64] ‖ msgLE32) ) mod subOrder
//   R8 = r·Base8 ;  hm = Poseidon5(R8x,R8y,Ax,Ay,msg) ;  S = (r + hm·s) mod subOrder
#include <string.h>
#include "cx.h"
#include "os.h"
#include "unlink_crypto.h"
#include "unlink_params.h"

// locked-session modulus handles
static cx_bn_t P, SUB, bA, bD, B8X, B8Y;

static void fmul(cx_bn_t r, const cx_bn_t a, const cx_bn_t b){ cx_bn_mod_mul(r,a,b,P); }
static void fadd(cx_bn_t r, const cx_bn_t a, const cx_bn_t b){ cx_bn_mod_add(r,a,b,P); }
static void fsub(cx_bn_t r, const cx_bn_t a, const cx_bn_t b){ cx_bn_mod_sub(r,a,b,P); }
static void finv(cx_bn_t r, const cx_bn_t a){ cx_bn_mod_invert_nprime(r,a,P); }
static void fdiv(cx_bn_t r, const cx_bn_t a, const cx_bn_t b){ cx_bn_t i; cx_bn_alloc(&i,32); finv(i,b); fmul(r,a,i); cx_bn_destroy(&i); }

// p3 = p1 + p2 on BabyJubJub (matches addPoint)
static void addPoint(cx_bn_t rx,cx_bn_t ry,const cx_bn_t x1,const cx_bn_t y1,const cx_bn_t x2,const cx_bn_t y2){
  cx_bn_t beta,gamma,delta,tau,dtau,t1,t2,num,den,one;
  cx_bn_alloc(&beta,32);cx_bn_alloc(&gamma,32);cx_bn_alloc(&delta,32);cx_bn_alloc(&tau,32);
  cx_bn_alloc(&dtau,32);cx_bn_alloc(&t1,32);cx_bn_alloc(&t2,32);cx_bn_alloc(&num,32);cx_bn_alloc(&den,32);cx_bn_alloc(&one,32);
  cx_bn_set_u32(one,1);
  fmul(beta,x1,y2);
  fmul(gamma,y1,x2);
  fmul(t1,bA,x1); fsub(t1,y1,t1);     // y1 - a*x1
  fadd(t2,x2,y2);                      // x2 + y2
  fmul(delta,t1,t2);
  fmul(tau,beta,gamma);
  fmul(dtau,bD,tau);
  fadd(num,beta,gamma); fadd(den,one,dtau); fdiv(rx,num,den);             // (beta+gamma)/(1+dtau)
  fmul(t1,bA,beta); fsub(t1,t1,gamma); fadd(num,delta,t1);                // delta + a*beta - gamma
  fsub(den,one,dtau); fdiv(ry,num,den);                                  // /(1-dtau)
  cx_bn_destroy(&beta);cx_bn_destroy(&gamma);cx_bn_destroy(&delta);cx_bn_destroy(&tau);
  cx_bn_destroy(&dtau);cx_bn_destroy(&t1);cx_bn_destroy(&t2);cx_bn_destroy(&num);cx_bn_destroy(&den);cx_bn_destroy(&one);
}

// R = e·(bx,by) double-and-add (matches mulPointEscalar)
static void mulPoint(cx_bn_t rx,cx_bn_t ry,const cx_bn_t bx,const cx_bn_t by,const cx_bn_t e){
  cx_bn_t resx,resy,ex,ey,rem,nx,ny; bool bit; int diff;
  cx_bn_alloc(&resx,32);cx_bn_alloc(&resy,32);cx_bn_alloc(&ex,32);cx_bn_alloc(&ey,32);
  cx_bn_alloc(&rem,32);cx_bn_alloc(&nx,32);cx_bn_alloc(&ny,32);
  cx_bn_set_u32(resx,0); cx_bn_set_u32(resy,1); cx_bn_copy(ex,bx); cx_bn_copy(ey,by); cx_bn_copy(rem,e);
  for(;;){
    cx_bn_cmp_u32(rem,0,&diff); if(diff==0) break;
    cx_bn_tst_bit(rem,0,&bit);
    if(bit){ addPoint(nx,ny,resx,resy,ex,ey); cx_bn_copy(resx,nx); cx_bn_copy(resy,ny); }
    addPoint(nx,ny,ex,ey,ex,ey); cx_bn_copy(ex,nx); cx_bn_copy(ey,ny);
    cx_bn_shr(rem,1);
  }
  cx_bn_copy(rx,resx); cx_bn_copy(ry,resy);
  cx_bn_destroy(&resx);cx_bn_destroy(&resy);cx_bn_destroy(&ex);cx_bn_destroy(&ey);
  cx_bn_destroy(&rem);cx_bn_destroy(&nx);cx_bn_destroy(&ny);
}

static void pow5(cx_bn_t r,const cx_bn_t v){ cx_bn_t o; cx_bn_alloc(&o,32); fmul(o,v,v); fmul(o,o,o); fmul(r,v,o); cx_bn_destroy(&o); }

// hm = Poseidon5(in0..in4)  (t=6, RF=8, RP=60)
static void poseidon5(cx_bn_t out, cx_bn_t in0,cx_bn_t in1,cx_bn_t in2,cx_bn_t in3,cx_bn_t in4){
  const int t=POSEIDON_T;
  cx_bn_t st[6], ns[6], c, acc, tmp;
  for(int i=0;i<t;i++){ cx_bn_alloc(&st[i],32); cx_bn_alloc(&ns[i],32); }
  cx_bn_alloc(&c,32); cx_bn_alloc(&acc,32); cx_bn_alloc(&tmp,32);
  cx_bn_set_u32(st[0],0); cx_bn_copy(st[1],in0); cx_bn_copy(st[2],in1); cx_bn_copy(st[3],in2); cx_bn_copy(st[4],in3); cx_bn_copy(st[5],in4);
  for(int x=0;x<POSEIDON_NROUNDS;x++){
    for(int y=0;y<t;y++){
      cx_bn_init(c, POSEIDON_C[x*t+y], 32);
      fadd(st[y],st[y],c);
      if(x<POSEIDON_RF/2 || x>=POSEIDON_RF/2+POSEIDON_RP) pow5(st[y],st[y]);
      else if(y==0) pow5(st[y],st[y]);
    }
    for(int xx=0;xx<t;xx++){
      cx_bn_set_u32(acc,0);
      for(int yy=0;yy<t;yy++){ cx_bn_init(c, POSEIDON_M[xx*t+yy], 32); fmul(tmp,c,st[yy]); fadd(acc,acc,tmp); }
      cx_bn_copy(ns[xx],acc);
    }
    for(int i=0;i<t;i++) cx_bn_copy(st[i],ns[i]);
  }
  cx_bn_copy(out,st[0]);
  for(int i=0;i<t;i++){ cx_bn_destroy(&st[i]); cx_bn_destroy(&ns[i]); }
  cx_bn_destroy(&c); cx_bn_destroy(&acc); cx_bn_destroy(&tmp);
}

static void blake2b512(uint8_t *out, const uint8_t *in, size_t len){
  cx_blake2b_t h; cx_blake2b_init_no_throw(&h, 512);
  cx_hash_no_throw((cx_hash_t*)&h, CX_LAST, in, len, out, 64);
}
static void reverse32(uint8_t *b){ for(int i=0;i<16;i++){ uint8_t t=b[i]; b[i]=b[31-i]; b[31-i]=t; } }

// Core. key = raw private key bytes; msg_be32 = message_hash (big-endian field element).
// Outputs 32-byte big-endian Ax,Ay,R8x,R8y,S.
void unlink_sign(const uint8_t *key, size_t keylen, const uint8_t msg_be32[32],
                 uint8_t Ax[32], uint8_t Ay[32], uint8_t R8x[32], uint8_t R8y[32], uint8_t S[32]){
  uint8_t hash[64], sBuf[32], concat[64], rBuf[64], msgLE[32];
  blake2b512(hash, key, keylen);
  memcpy(sBuf, hash, 32);
  sBuf[0]&=248; sBuf[31]&=127; sBuf[31]|=64;            // pruneBuffer (LE byte order)
  reverse32(sBuf);                                      // -> big-endian for cx_bn_init

  cx_bn_lock(32, 0);
  cx_bn_alloc_init(&P,32,PARM_P,32); cx_bn_alloc_init(&SUB,32,PARM_SUB,32);
  cx_bn_alloc_init(&bA,32,PARM_A,32); cx_bn_alloc_init(&bD,32,PARM_D,32);
  cx_bn_alloc_init(&B8X,32,PARM_B8X,32); cx_bn_alloc_init(&B8Y,32,PARM_B8Y,32);

  cx_bn_t s,sShift,r,hm,ax,ay,rx,ry,Sb,tmp;
  cx_bn_alloc(&s,32);cx_bn_alloc(&sShift,32);cx_bn_alloc(&r,32);cx_bn_alloc(&hm,32);
  cx_bn_alloc(&ax,32);cx_bn_alloc(&ay,32);cx_bn_alloc(&rx,32);cx_bn_alloc(&ry,32);cx_bn_alloc(&Sb,32);cx_bn_alloc(&tmp,32);

  cx_bn_init(s, sBuf, 32);
  cx_bn_copy(sShift,s); cx_bn_shr(sShift,3);            // s>>3
  mulPoint(ax,ay,B8X,B8Y,sShift);                       // A
  cx_bn_export(ax,Ax,32); cx_bn_export(ay,Ay,32);

  // nonce: r = Blake2b(hash[32:64] ‖ msgLE) mod subOrder
  memcpy(msgLE, msg_be32, 32); reverse32(msgLE);        // message little-endian
  memcpy(concat, hash+32, 32); memcpy(concat+32, msgLE, 32);
  blake2b512(rBuf, concat, 64);                         // 64 bytes
  // reduce 64-byte LE value mod subOrder: build big-endian then reduce
  uint8_t rBE[64]; for(int i=0;i<64;i++) rBE[i]=rBuf[63-i];
  cx_bn_t rWide; cx_bn_alloc_init(&rWide,64,rBE,64);
  cx_bn_reduce(r, rWide, SUB); cx_bn_destroy(&rWide);   // r = LE(rBuf) mod subOrder
  mulPoint(rx,ry,B8X,B8Y,r);                            // R8
  cx_bn_export(rx,R8x,32); cx_bn_export(ry,R8y,32);

  // hm = Poseidon5(R8x,R8y,Ax,Ay,msg)
  cx_bn_t mbn; cx_bn_alloc_init(&mbn,32,msg_be32,32);
  poseidon5(hm, rx, ry, ax, ay, mbn);
  cx_bn_destroy(&mbn);

  // S = (r + hm*s) mod subOrder   (s here is the full pruned value)
  cx_bn_mod_mul(tmp, hm, s, SUB);
  cx_bn_mod_add(Sb, r, tmp, SUB);
  cx_bn_export(Sb, S, 32);

  cx_bn_unlock();
}
