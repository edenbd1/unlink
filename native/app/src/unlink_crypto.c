// Unlink EdDSA-Poseidon signer on the Secure Element — lean cx_bn backend.
// Uses cx_bn (hardware modular arithmetic) with a FIXED register file so the BN
// pool never grows: 6 persistent (modulus/params/base) + 17 scratch = 23 total.
// Projective point arithmetic. 1:1 with the GMP host port (9/9 vectors).
#include <string.h>
#include "cx.h"
#include "os.h"
#include "os_io_seproxyhal.h"
#include "unlink_crypto.h"
#include "unlink_params.h"

#define N 32
#define NREG 17
// K = 2^256 mod subOrder (for reducing the 64-byte nonce with 32-byte ops only)
static const uint8_t PARM_K[32] = {
  0x01,0xf1,0x64,0x24,0xe1,0xbb,0x77,0x24,0xf8,0x5a,0x92,0x01,0xd8,0x18,0xf0,0x15,
  0xe7,0xac,0xff,0xc6,0xa0,0x98,0xf2,0x4b,0x07,0x33,0x15,0xde,0xa0,0x8f,0x9c,0x76};
static cx_bn_t P, SUB, bA, bD, B8X, B8Y;   // persistent
static cx_bn_t R[NREG];                      // scratch register file

static void fmul(cx_bn_t r,const cx_bn_t a,const cx_bn_t b){ cx_bn_mod_mul(r,a,b,P); }
static void fadd(cx_bn_t r,const cx_bn_t a,const cx_bn_t b){ cx_bn_mod_add(r,a,b,P); }
static void fsub(cx_bn_t r,const cx_bn_t a,const cx_bn_t b){ cx_bn_mod_sub(r,a,b,P); }
static void finv(cx_bn_t r,const cx_bn_t a){ cx_bn_mod_invert_nprime(r,a,P); }

// Projective unified add (no inversion). Outputs X3,Y3,Z3; scratch = R[10..16].
static void addProj(cx_bn_t X3,cx_bn_t Y3,cx_bn_t Z3,
                    const cx_bn_t X1,const cx_bn_t Y1,const cx_bn_t Z1,
                    const cx_bn_t X2,const cx_bn_t Y2,const cx_bn_t Z2){
  cx_bn_t A=R[10],B=R[11],C=R[12],D=R[13],E=R[14],F=R[15],G=R[16];
  fmul(A,Z1,Z2); fmul(B,A,A); fmul(C,X1,X2); fmul(D,Y1,Y2);
  fmul(E,bD,C); fmul(E,E,D); fsub(F,B,E); fadd(G,B,E);
  fadd(B,X1,Y1); fadd(E,X2,Y2); fmul(B,B,E); fsub(B,B,C); fsub(B,B,D);
  fmul(B,B,F); fmul(X3,B,A);
  fmul(E,bA,C); fsub(E,D,E); fmul(E,E,G); fmul(Y3,E,A);
  fmul(Z3,F,G);
}

// out = (e·base) affine, exported to rx32/ry32. base passed as cx_bn (bx,by).
// Uses R[0..9] (addProj uses R[10..16]).
static void mulPoint(uint8_t *rx32,uint8_t *ry32,const cx_bn_t bx,const cx_bn_t by,const uint8_t *e){
  cx_bn_t Rx=R[0],Ry=R[1],Rz=R[2],Bz=R[3],Tx=R[6],Ty=R[7],Tz=R[8],zi=R[9];
  cx_bn_set_u32(Rx,0); cx_bn_set_u32(Ry,1); cx_bn_set_u32(Rz,1);   // identity
  cx_bn_set_u32(Bz,1);
  for (int i = 255; i >= 0; i--) {
    if ((i & 7) == 0) io_seproxyhal_io_heartbeat();
    addProj(Tx,Ty,Tz, Rx,Ry,Rz, Rx,Ry,Rz);
    cx_bn_copy(Rx,Tx); cx_bn_copy(Ry,Ty); cx_bn_copy(Rz,Tz);
    if ((e[N-1-(i>>3)] >> (i&7)) & 1) {
      addProj(Tx,Ty,Tz, Rx,Ry,Rz, bx,by,Bz);
      cx_bn_copy(Rx,Tx); cx_bn_copy(Ry,Ty); cx_bn_copy(Rz,Tz);
    }
  }
  finv(zi,Rz); fmul(R[4],Rx,zi); fmul(R[5],Ry,zi);
  cx_bn_export(R[4],rx32,N); cx_bn_export(R[5],ry32,N);
}

static void pow5(cx_bn_t r,const cx_bn_t v){ cx_bn_t o=R[15],o2=R[14]; fmul(o,v,v); fmul(o2,o,o); fmul(r,v,o2); } // o2 avoids cx_bn_mod_mul(r,a,a) with r==a==b (broken on SE)

// hm = Poseidon5(in0..in4) (host buffers), exported to out32. Uses R[0..14].
static void poseidon5(uint8_t *out32, const uint8_t *in0,const uint8_t *in1,const uint8_t *in2,const uint8_t *in3,const uint8_t *in4){
  cx_bn_t *st=&R[0], *ns=&R[6], acc=R[12], c=R[13], tmp=R[14];
  uint8_t cbuf[N];   // RAM copy of flash constants (cx_bn_init needs a RAM source on the SE)
  cx_bn_set_u32(st[0],0);
  cx_bn_init(st[1],in0,N); cx_bn_init(st[2],in1,N); cx_bn_init(st[3],in2,N); cx_bn_init(st[4],in3,N); cx_bn_init(st[5],in4,N);
  for (int x = 0; x < POSEIDON_NROUNDS; x++) {
    for (int y = 0; y < POSEIDON_T; y++) {
      memcpy(cbuf, POSEIDON_C[x*POSEIDON_T + y], N); cx_bn_init(c, cbuf, N);
      cx_bn_mod_add(R[16], st[y], c, P); cx_bn_copy(st[y], R[16]); // r==a-safe
      if (x < POSEIDON_RF/2 || x >= POSEIDON_RF/2 + POSEIDON_RP) pow5(st[y], st[y]);
      else if (y == 0) pow5(st[y], st[y]);
    }
    for (int xx = 0; xx < POSEIDON_T; xx++) {
      cx_bn_set_u32(acc,0);
      for (int yy = 0; yy < POSEIDON_T; yy++) { memcpy(cbuf, POSEIDON_M[xx*POSEIDON_T+yy], N); cx_bn_init(c, cbuf, N); fmul(tmp,c,st[yy]); cx_bn_mod_add(R[16], acc, tmp, P); cx_bn_reduce(acc, R[16], P); } // reduce: SE mod_add can leave acc in [P,2P)
      cx_bn_copy(ns[xx], acc);
    }
    for (int i = 0; i < POSEIDON_T; i++) cx_bn_copy(st[i], ns[i]);
  }
  cx_bn_export(st[0], out32, N);
}

static void blake2b512(uint8_t *out, const uint8_t *in, size_t len){
  cx_blake2b_t h; cx_blake2b_init_no_throw(&h, 512);
  cx_hash_no_throw((cx_hash_t*)&h, CX_LAST, in, len, out, 64);
}
static void reverse32(uint8_t *b){ for (int i=0;i<16;i++){ uint8_t t=b[i]; b[i]=b[31-i]; b[31-i]=t; } }
static void shr3_be(uint8_t *out,const uint8_t *in){ uint8_t carry=0;
  for (int i=0;i<N;i++){ uint8_t v=in[i]; out[i]=(v>>3)|carry; carry=(uint8_t)(v<<5); } }

void unlink_sign(const uint8_t *key, size_t keylen, const uint8_t msg_be32[32],
                 uint8_t Ax[32], uint8_t Ay[32], uint8_t R8x[32], uint8_t R8y[32], uint8_t S[32]){
  uint8_t hash[64], sBuf[32], concat[64], rBuf[64], msgLE[32], sShift[32], rsc[32], hmb[32];

  blake2b512(hash, key, keylen);
  memcpy(sBuf, hash, 32);
  sBuf[0]&=248; sBuf[31]&=127; sBuf[31]|=64; reverse32(sBuf);     // prune -> BE
  shr3_be(sShift, sBuf);

  cx_bn_lock(N, 0);
  cx_bn_alloc_init(&P,N,PARM_P,N); cx_bn_alloc_init(&SUB,N,PARM_SUB,N);
  cx_bn_alloc_init(&bA,N,PARM_A,N); cx_bn_alloc_init(&bD,N,PARM_D,N);
  cx_bn_alloc_init(&B8X,N,PARM_B8X,N); cx_bn_alloc_init(&B8Y,N,PARM_B8Y,N);
  for (int i=0;i<NREG;i++) cx_bn_alloc(&R[i],N);

  mulPoint(Ax, Ay, B8X, B8Y, sShift);                 // A = (s>>3)*Base8

  memcpy(msgLE,msg_be32,32); reverse32(msgLE);
  memcpy(concat,hash+32,32); memcpy(concat+32,msgLE,32);
  blake2b512(rBuf,concat,64);
  // r = LE(rBuf) mod subOrder, with 32-byte ops only (no oversized BN):
  // value = lo + hi*2^256 ; r = (lo mod sub) + (hi mod sub)*K mod sub, K=2^256 mod sub
  uint8_t loBE[32], hiBE[32];
  for (int i=0;i<32;i++){ loBE[i]=rBuf[31-i]; hiBE[i]=rBuf[63-i]; }
  cx_bn_init(R[0], loBE, N); cx_bn_init(R[1], hiBE, N);
  cx_bn_reduce(R[2], R[0], SUB); cx_bn_reduce(R[3], R[1], SUB);   // lo mod sub, hi mod sub
  cx_bn_init(R[4], PARM_K, N);
  cx_bn_mod_mul(R[5], R[3], R[4], SUB);                           // hi*K mod sub
  cx_bn_mod_add(R[0], R[5], R[2], SUB);                           // r = (hi*K + lo) mod sub
  cx_bn_export(R[0], rsc, N);
  mulPoint(R8x, R8y, B8X, B8Y, rsc);                  // R8 = r*Base8

  poseidon5(hmb, R8x, R8y, Ax, Ay, msg_be32);         // hm

  // S = (r + hm*s) mod subOrder
  cx_bn_init(R[0], rsc, N);                           // r (< sub)
  cx_bn_init(R[1], sBuf, N);                          // s (full, ~2^254 > sub)
  cx_bn_init(R[2], hmb, N);                           // hm (< P)
  cx_bn_reduce(R[3], R[2], SUB);                      // hm mod sub
  cx_bn_reduce(R[6], R[1], SUB);                      // s mod sub  (operands MUST be < modulus)
  cx_bn_mod_mul(R[4], R[3], R[6], SUB);               // (hm*s) mod sub
  cx_bn_reduce(R[7], R[4], SUB);                       // force < sub (SE mod_mul can leave [sub,2sub))
  cx_bn_mod_add(R[5], R[0], R[7], SUB);               // r + hm*s mod sub
  cx_bn_reduce(R[8], R[5], SUB);                       // force < sub
  cx_bn_export(R[8], S, N);

  cx_bn_unlock();
}

// DEBUG: round-0 SBOX + MIX, export ns[0..5] (state after one full round).
void unlink_poseidon_test(uint8_t out[192], int nr){ (void)nr;
  uint8_t cbuf[N];
  cx_bn_lock(N,0);
  cx_bn_alloc_init(&P,N,PARM_P,N);
  for(int i=0;i<NREG;i++) cx_bn_alloc(&R[i],N);
  cx_bn_t *st=&R[0], *ns=&R[6], acc=R[12], c=R[13], tmp=R[14];
  cx_bn_set_u32(st[0],0); for(int y=1;y<6;y++) cx_bn_set_u32(st[y],y);
  for(int y=0;y<6;y++){
    memcpy(cbuf,POSEIDON_C[y],N); cx_bn_init(c,cbuf,N);
    cx_bn_mod_add(R[16],st[y],c,P); cx_bn_copy(st[y],R[16]);
    pow5(st[y],st[y]);
  }
  for(int xx=0;xx<6;xx++){
    cx_bn_set_u32(acc,0);
    for(int yy=0;yy<6;yy++){
      memcpy(cbuf,POSEIDON_M[xx*6+yy],N); cx_bn_init(c,cbuf,N);
      fmul(tmp,c,st[yy]); cx_bn_mod_add(R[16],acc,tmp,P); cx_bn_reduce(acc,R[16],P);
    }
    cx_bn_copy(ns[xx],acc);
  }
  for(int i=0;i<6;i++) cx_bn_export(ns[i], out+i*32, N);
  cx_bn_unlock();
}
