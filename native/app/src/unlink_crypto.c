// Unlink EdDSA-Poseidon signer on the Secure Element — cx_math backend.
// Uses the buffer-based cx_math_* modular API (NO cx_bn allocation pool), so it
// can't exhaust the BN pool. Field elements are 32-byte big-endian.
// 1:1 with the GMP host port validated 9/9 vs the SDK vectors; projective point
// arithmetic (one inversion per scalar mul).
#include <string.h>
#include "cx.h"
#include "os.h"
#include "unlink_crypto.h"
#include "unlink_params.h"

#define N 32
static void fmul(uint8_t *r, const uint8_t *a, const uint8_t *b){ cx_math_multm_no_throw(r, a, b, PARM_P, N); }
static void fadd(uint8_t *r, const uint8_t *a, const uint8_t *b){ cx_math_addm_no_throw(r, a, b, PARM_P, N); }
static void fsub(uint8_t *r, const uint8_t *a, const uint8_t *b){ cx_math_subm_no_throw(r, a, b, PARM_P, N); }
static void finv(uint8_t *r, const uint8_t *a){ cx_math_invprimem_no_throw(r, a, PARM_P, N); }

// Projective twisted-Edwards unified add (no inversion). (X:Y:Z), x=X/Z, y=Y/Z.
static void addProj(uint8_t *X3,uint8_t *Y3,uint8_t *Z3,
                    const uint8_t *X1,const uint8_t *Y1,const uint8_t *Z1,
                    const uint8_t *X2,const uint8_t *Y2,const uint8_t *Z2){
  static uint8_t A[N],B[N],C[N],D[N],E[N],F[N],G[N],t1[N],t2[N];
  fmul(A,Z1,Z2); fmul(B,A,A); fmul(C,X1,X2); fmul(D,Y1,Y2);
  fmul(E,PARM_D,C); fmul(E,E,D); fsub(F,B,E); fadd(G,B,E);
  fadd(t1,X1,Y1); fadd(t2,X2,Y2); fmul(t1,t1,t2); fsub(t1,t1,C); fsub(t1,t1,D);
  fmul(t1,t1,F); fmul(X3,t1,A);                       // X3 = A*F*((X1+Y1)(X2+Y2)-C-D)
  fmul(t2,PARM_A,C); fsub(t2,D,t2); fmul(t2,t2,G); fmul(Y3,t2,A);   // Y3 = A*G*(D-a*C)
  fmul(Z3,F,G);                                       // Z3 = F*G
}

// R = e·(bx,by), e a 32-byte big-endian scalar. Left-to-right double-and-add.
static void mulPoint(uint8_t *rx,uint8_t *ry,const uint8_t *bx,const uint8_t *by,const uint8_t *e){
  static uint8_t Rx[N],Ry[N],Rz[N],Bx[N],By[N],Bz[N],Tx[N],Ty[N],Tz[N],zi[N];
  memset(Rx,0,N); memset(Ry,0,N); Ry[N-1]=1; memset(Rz,0,N); Rz[N-1]=1;   // identity (0:1:1)
  memcpy(Bx,bx,N); memcpy(By,by,N); memset(Bz,0,N); Bz[N-1]=1;            // base (bx:by:1)
  for (int i = 255; i >= 0; i--) {
    addProj(Tx,Ty,Tz, Rx,Ry,Rz, Rx,Ry,Rz);                               // R = 2R
    memcpy(Rx,Tx,N); memcpy(Ry,Ty,N); memcpy(Rz,Tz,N);
    if ((e[N-1-(i>>3)] >> (i&7)) & 1) {
      addProj(Tx,Ty,Tz, Rx,Ry,Rz, Bx,By,Bz);                             // R = R + base
      memcpy(Rx,Tx,N); memcpy(Ry,Ty,N); memcpy(Rz,Tz,N);
    }
  }
  finv(zi,Rz); fmul(rx,Rx,zi); fmul(ry,Ry,zi);                           // affine (one inversion)
}

static void pow5(uint8_t *r,const uint8_t *v){ static uint8_t o[N]; fmul(o,v,v); fmul(o,o,o); fmul(r,v,o); }

// hm = Poseidon5(in0..in4)  (t=6, RF=8, RP=60)
static void poseidon5(uint8_t *out, const uint8_t *in0,const uint8_t *in1,const uint8_t *in2,const uint8_t *in3,const uint8_t *in4){
  static uint8_t st[6][N], ns[6][N], acc[N], tmp[N];
  memset(st[0],0,N); memcpy(st[1],in0,N); memcpy(st[2],in1,N); memcpy(st[3],in2,N); memcpy(st[4],in3,N); memcpy(st[5],in4,N);
  for (int x = 0; x < POSEIDON_NROUNDS; x++) {
    for (int y = 0; y < POSEIDON_T; y++) {
      fadd(st[y], st[y], POSEIDON_C[x*POSEIDON_T + y]);
      if (x < POSEIDON_RF/2 || x >= POSEIDON_RF/2 + POSEIDON_RP) pow5(st[y], st[y]);
      else if (y == 0) pow5(st[y], st[y]);
    }
    for (int xx = 0; xx < POSEIDON_T; xx++) {
      memset(acc,0,N);
      for (int yy = 0; yy < POSEIDON_T; yy++) { fmul(tmp, POSEIDON_M[xx*POSEIDON_T+yy], st[yy]); fadd(acc, acc, tmp); }
      memcpy(ns[xx], acc, N);
    }
    for (int i = 0; i < POSEIDON_T; i++) memcpy(st[i], ns[i], N);
  }
  memcpy(out, st[0], N);
}

static void blake2b512(uint8_t *out, const uint8_t *in, size_t len){
  cx_blake2b_t h; cx_blake2b_init_no_throw(&h, 512);
  cx_hash_no_throw((cx_hash_t*)&h, CX_LAST, in, len, out, 64);
}
static void reverse32(uint8_t *b){ for (int i=0;i<16;i++){ uint8_t t=b[i]; b[i]=b[31-i]; b[31-i]=t; } }
static void shr3_be(uint8_t *out,const uint8_t *in){ // out = in >> 3 (big-endian 32 bytes)
  uint8_t carry=0;
  for (int i=0;i<N;i++){ uint8_t v=in[i]; out[i]=(v>>3)|carry; carry=(uint8_t)(v<<5); }
}

// key = raw private key bytes; msg_be32 = message_hash (big-endian field element).
// Outputs 32-byte big-endian Ax,Ay,R8x,R8y,S.
void unlink_sign(const uint8_t *key, size_t keylen, const uint8_t msg_be32[32],
                 uint8_t Ax[32], uint8_t Ay[32], uint8_t R8x[32], uint8_t R8y[32], uint8_t S[32]){
  static uint8_t hash[64], sBuf[32], concat[64], rBuf[64], msgLE[32];
  static uint8_t s[N], sShift[N], r[N], hm[N], mbn[N], tmp[N], hmod[N], smod[N];

  blake2b512(hash, key, keylen);
  memcpy(sBuf, hash, 32);
  sBuf[0]&=248; sBuf[31]&=127; sBuf[31]|=64;          // pruneBuffer (little-endian)
  reverse32(sBuf);                                     // -> big-endian
  memcpy(s, sBuf, 32);
  shr3_be(sShift, s);                                  // s >> 3
  mulPoint(Ax, Ay, PARM_B8X, PARM_B8Y, sShift);        // A = (s>>3)*Base8

  memcpy(msgLE, msg_be32, 32); reverse32(msgLE);
  memcpy(concat, hash+32, 32); memcpy(concat+32, msgLE, 32);
  blake2b512(rBuf, concat, 64);                        // 64-byte little-endian nonce material
  static uint8_t rBE[64], SUB64[64]; for (int i=0;i<64;i++) rBE[i]=rBuf[63-i];
  memset(SUB64, 0, 32); memcpy(SUB64+32, PARM_SUB, 32);   // subOrder padded to 64 bytes (equal lengths)
  cx_math_modm_no_throw(rBE, 64, SUB64, 64);           // reduce mod subOrder (result in low 32 bytes)
  memcpy(r, rBE+32, 32);
  mulPoint(R8x, R8y, PARM_B8X, PARM_B8Y, r);           // R8 = r*Base8

  memcpy(mbn, msg_be32, 32);
  poseidon5(hm, R8x, R8y, Ax, Ay, mbn);                // hm = Poseidon5(R8x,R8y,Ax,Ay,msg)

  // S = (r + hm*s) mod subOrder
  memcpy(hmod, hm, N); cx_math_modm_no_throw(hmod, 32, PARM_SUB, 32);
  memcpy(smod, s,  N); cx_math_modm_no_throw(smod, 32, PARM_SUB, 32);
  cx_math_multm_no_throw(tmp, hmod, smod, PARM_SUB, 32);
  cx_math_addm_no_throw(S, r, tmp, PARM_SUB, 32);
}
