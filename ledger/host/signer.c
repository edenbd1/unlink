// Host validation of the Unlink EdDSA-Poseidon signer (GMP backend).
// Goal: reproduce @zk-kit/eddsa-poseidon byte-exact, validated vs test vectors.
// Once this matches, the same algorithm gets a cx_math_*/SE bignum backend in BOLOS.
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <gmp.h>
#include "consts.h"
#include "vectors.h"

// ---------- Blake2b-512 (RFC 7693), no key, 64-byte digest ----------
typedef struct { uint8_t b[128]; uint64_t h[8]; uint64_t t[2]; size_t c; } blake2b_ctx;
static const uint64_t blake2b_iv[8] = {
  0x6a09e667f3bcc908ULL,0xbb67ae8584caa73bULL,0x3c6ef372fe94f82bULL,0xa54ff53a5f1d36f1ULL,
  0x510e527fade682d1ULL,0x9b05688c2b3e6c1fULL,0x1f83d9abfb41bd6bULL,0x5be0cd19137e2179ULL};
static const uint8_t blake2b_sigma[12][16] = {
  {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},{14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3},
  {11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4},{7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8},
  {9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13},{2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9},
  {12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11},{13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10},
  {6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5},{10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0},
  {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},{14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3}};
static uint64_t rotr64(uint64_t x,int n){return (x>>n)|(x<<(64-n));}
#define B2B_G(a,b,c,d,x,y){v[a]+=v[b]+x;v[d]=rotr64(v[d]^v[a],32);v[c]+=v[d];v[b]=rotr64(v[b]^v[c],24);\
  v[a]+=v[b]+y;v[d]=rotr64(v[d]^v[a],16);v[c]+=v[d];v[b]=rotr64(v[b]^v[c],63);}
static void blake2b_compress(blake2b_ctx*ctx,int last){
  uint64_t v[16],m[16];
  for(int i=0;i<8;i++){v[i]=ctx->h[i];v[i+8]=blake2b_iv[i];}
  v[12]^=ctx->t[0];v[13]^=ctx->t[1];if(last)v[14]=~v[14];
  for(int i=0;i<16;i++){m[i]=0;for(int j=0;j<8;j++)m[i]|=(uint64_t)ctx->b[i*8+j]<<(8*j);}
  for(int i=0;i<12;i++){const uint8_t*s=blake2b_sigma[i];
    B2B_G(0,4,8,12,m[s[0]],m[s[1]]);B2B_G(1,5,9,13,m[s[2]],m[s[3]]);
    B2B_G(2,6,10,14,m[s[4]],m[s[5]]);B2B_G(3,7,11,15,m[s[6]],m[s[7]]);
    B2B_G(0,5,10,15,m[s[8]],m[s[9]]);B2B_G(1,6,11,12,m[s[10]],m[s[11]]);
    B2B_G(2,7,8,13,m[s[12]],m[s[13]]);B2B_G(3,4,9,14,m[s[14]],m[s[15]]);}
  for(int i=0;i<8;i++)ctx->h[i]^=v[i]^v[i+8];
}
static void blake2b_init(blake2b_ctx*ctx){
  for(int i=0;i<8;i++)ctx->h[i]=blake2b_iv[i];
  ctx->h[0]^=0x01010000^64; ctx->t[0]=ctx->t[1]=0; ctx->c=0;
}
static void blake2b_update(blake2b_ctx*ctx,const uint8_t*in,size_t len){
  for(size_t i=0;i<len;i++){
    if(ctx->c==128){ctx->t[0]+=128;if(ctx->t[0]<128)ctx->t[1]++;blake2b_compress(ctx,0);ctx->c=0;}
    ctx->b[ctx->c++]=in[i];}
}
static void blake2b_final(blake2b_ctx*ctx,uint8_t*out){
  ctx->t[0]+=ctx->c;if(ctx->t[0]<ctx->c)ctx->t[1]++;
  while(ctx->c<128)ctx->b[ctx->c++]=0;
  blake2b_compress(ctx,1);
  for(int i=0;i<64;i++)out[i]=(ctx->h[i>>3]>>(8*(i&7)))&0xff;
}
static void blake2b(uint8_t*out,const uint8_t*in,size_t len){
  blake2b_ctx ctx; blake2b_init(&ctx); blake2b_update(&ctx,in,len); blake2b_final(&ctx,out);
}

// ---------- field globals ----------
static mpz_t P, SUB, A_, D_, B8X, B8Y;
static mpz_t Cc[POSEIDON_T*(POSEIDON_RF+POSEIDON_RP)];
static mpz_t Mm[POSEIDON_T][POSEIDON_T];

static void fmul(mpz_t r,const mpz_t a,const mpz_t b){mpz_mul(r,a,b);mpz_mod(r,r,P);}
static void fadd(mpz_t r,const mpz_t a,const mpz_t b){mpz_add(r,a,b);mpz_mod(r,r,P);}
static void fsub(mpz_t r,const mpz_t a,const mpz_t b){mpz_sub(r,a,b);mpz_mod(r,r,P);}
static void finv(mpz_t r,const mpz_t a){mpz_invert(r,a,P);}
static void fdiv(mpz_t r,const mpz_t a,const mpz_t b){mpz_t i;mpz_init(i);finv(i,b);fmul(r,a,i);mpz_clear(i);}

// ---------- twisted Edwards (BabyJubJub) ----------
// Projective unified add (no inversion) — same formulas as the on-device version.
static void addProj(mpz_t X3,mpz_t Y3,mpz_t Z3,
                    const mpz_t X1,const mpz_t Y1,const mpz_t Z1,
                    const mpz_t X2,const mpz_t Y2,const mpz_t Z2){
  mpz_t A,B,C,D,E,F,G,t1,t2; mpz_inits(A,B,C,D,E,F,G,t1,t2,NULL);
  fmul(A,Z1,Z2); fmul(B,A,A); fmul(C,X1,X2); fmul(D,Y1,Y2);
  fmul(E,D_,C); fmul(E,E,D); fsub(F,B,E); fadd(G,B,E);
  fadd(t1,X1,Y1); fadd(t2,X2,Y2); fmul(t1,t1,t2); fsub(t1,t1,C); fsub(t1,t1,D);
  fmul(t1,t1,F); fmul(X3,t1,A);
  fmul(t2,A_,C); fsub(t2,D,t2); fmul(t2,t2,G); fmul(Y3,t2,A);
  fmul(Z3,F,G);
  mpz_clears(A,B,C,D,E,F,G,t1,t2,NULL);
}
// R = e * (bx,by) — projective double-and-add, single inversion at end.
static void mulPoint(mpz_t rx,mpz_t ry,const mpz_t bx,const mpz_t by,const mpz_t e){
  mpz_t Rx,Ry,Rz,Px,Py,Pz,Tx,Ty,Tz,zi,rem;
  mpz_inits(Rx,Ry,Rz,Px,Py,Pz,Tx,Ty,Tz,zi,rem,NULL);
  mpz_set_ui(Rx,0); mpz_set_ui(Ry,1); mpz_set_ui(Rz,1);
  mpz_set(Px,bx); mpz_set(Py,by); mpz_set_ui(Pz,1); mpz_set(rem,e);
  while(mpz_sgn(rem)!=0){
    if(mpz_odd_p(rem)){ addProj(Tx,Ty,Tz, Rx,Ry,Rz, Px,Py,Pz); mpz_set(Rx,Tx);mpz_set(Ry,Ty);mpz_set(Rz,Tz); }
    addProj(Tx,Ty,Tz, Px,Py,Pz, Px,Py,Pz); mpz_set(Px,Tx);mpz_set(Py,Ty);mpz_set(Pz,Tz);
    mpz_fdiv_q_2exp(rem,rem,1);
  }
  finv(zi,Rz); fmul(rx,Rx,zi); fmul(ry,Ry,zi);
  mpz_clears(Rx,Ry,Rz,Px,Py,Pz,Tx,Ty,Tz,zi,rem,NULL);
}

// ---------- Poseidon t=6 ----------
static void pow5(mpz_t r,const mpz_t v){mpz_t o;mpz_init(o);fmul(o,v,v);fmul(o,o,o);fmul(r,v,o);mpz_clear(o);}
static void poseidon5(mpz_t out,const mpz_t in0,const mpz_t in1,const mpz_t in2,const mpz_t in3,const mpz_t in4){
  int t=POSEIDON_T, rf=POSEIDON_RF, rp=POSEIDON_RP;
  mpz_t st[6],ns[6],acc,tmp; for(int i=0;i<t;i++){mpz_init(st[i]);mpz_init(ns[i]);} mpz_inits(acc,tmp,NULL);
  mpz_set_ui(st[0],0); mpz_set(st[1],in0); mpz_set(st[2],in1); mpz_set(st[3],in2); mpz_set(st[4],in3); mpz_set(st[5],in4);
  for(int x=0;x<rf+rp;x++){
    for(int y=0;y<t;y++){
      fadd(st[y],st[y],Cc[x*t+y]);
      if(x<rf/2 || x>=rf/2+rp) pow5(st[y],st[y]);
      else if(y==0) pow5(st[y],st[y]);
    }
    for(int xx=0;xx<t;xx++){ mpz_set_ui(acc,0); for(int yy=0;yy<t;yy++){ fmul(tmp,Mm[xx][yy],st[yy]); fadd(acc,acc,tmp);} mpz_set(ns[xx],acc);}
    for(int i=0;i<t;i++) mpz_set(st[i],ns[i]);
  }
  mpz_set(out,st[0]);
  for(int i=0;i<t;i++){mpz_clear(st[i]);mpz_clear(ns[i]);} mpz_clears(acc,tmp,NULL);
}

// ---------- LE bytes <-> mpz ----------
static void le_to_mpz(mpz_t r,const uint8_t*b,size_t n){ mpz_import(r,n,-1,1,0,0,b); }
static void mpz_to_le(uint8_t*out,size_t n,const mpz_t z){
  memset(out,0,n); size_t cnt=0; mpz_export(out,&cnt,-1,1,0,0,z); // little-endian, low bytes first
}

// ---------- sign ----------
// sk = the privateKey bytes (in Unlink: the ASCII bytes of the spending scalar's decimal string)
static void sign(const uint8_t *sk, size_t sklen, const mpz_t msg, mpz_t Ax,mpz_t Ay,mpz_t R8x,mpz_t R8y,mpz_t S){
  uint8_t hash[64], sBuff[32], concat[64], rBuff[64], msgLE[32];
  blake2b(hash, sk, sklen);
  memcpy(sBuff, hash, 32);
  sBuff[0]&=248; sBuff[31]&=127; sBuff[31]|=64;          // pruneBuffer
  mpz_t s,sShift,r,hm,t1; mpz_inits(s,sShift,r,hm,t1,NULL);
  le_to_mpz(s,sBuff,32);
  mpz_fdiv_q_2exp(sShift,s,3);                            // s >> 3
  mulPoint(Ax,Ay,B8X,B8Y,sShift);                        // A = (s>>3)*Base8
  mpz_to_le(msgLE,32,msg);
  memcpy(concat,hash+32,32); memcpy(concat+32,msgLE,32);
  blake2b(rBuff,concat,64);
  le_to_mpz(r,rBuff,64); mpz_mod(r,r,SUB);               // r = LE(rBuff) mod subOrder
  mulPoint(R8x,R8y,B8X,B8Y,r);                           // R8 = r*Base8
  poseidon5(hm,R8x,R8y,Ax,Ay,msg);
  mpz_mul(t1,hm,s); mpz_add(t1,t1,r); mpz_mod(S,t1,SUB); // S = (r + hm*s) mod subOrder
  mpz_clears(s,sShift,r,hm,t1,NULL);
}

static void hex_to_bytes(const char*hex,uint8_t*out,size_t n){
  for(size_t i=0;i<n;i++){unsigned v;sscanf(hex+2*i,"%2x",&v);out[i]=(uint8_t)v;}
}

int main(void){
  mpz_inits(P,SUB,A_,D_,B8X,B8Y,NULL);
  mpz_set_str(P,BN254_P,10); mpz_set_str(SUB,SUBORDER,10);
  mpz_set_str(A_,TE_A,10); mpz_set_str(D_,TE_D,10);
  mpz_set_str(B8X,BASE8X,10); mpz_set_str(B8Y,BASE8Y,10);
  for(int i=0;i<POSEIDON_T*(POSEIDON_RF+POSEIDON_RP);i++){mpz_init(Cc[i]);mpz_set_str(Cc[i],POSEIDON_C[i],10);}
  for(int i=0;i<POSEIDON_T;i++)for(int j=0;j<POSEIDON_T;j++){mpz_init(Mm[i][j]);mpz_set_str(Mm[i][j],POSEIDON_M[i][j],10);}

  int pass=0;
  mpz_t msg,Ax,Ay,R8x,R8y,S,eAx,eAy,eR8x,eR8y,eS;
  mpz_inits(msg,Ax,Ay,R8x,R8y,S,eAx,eAy,eR8x,eR8y,eS,NULL);
  for(int i=0;i<N_VECTORS;i++){
    // Unlink: the spending scalar (hex) -> decimal string -> its ASCII bytes are the privateKey
    mpz_t skz; mpz_init(skz); mpz_set_str(skz,VECTORS[i].sk,16);
    char *skdec = mpz_get_str(NULL,10,skz);
    mpz_set_str(msg,VECTORS[i].msg,10);
    sign((const uint8_t*)skdec, strlen(skdec), msg, Ax,Ay,R8x,R8y,S);
    free(skdec); mpz_clear(skz);
    mpz_set_str(eAx,VECTORS[i].Ax,10); mpz_set_str(eAy,VECTORS[i].Ay,10);
    mpz_set_str(eR8x,VECTORS[i].R8x,10); mpz_set_str(eR8y,VECTORS[i].R8y,10); mpz_set_str(eS,VECTORS[i].S,10);
    int okA = !mpz_cmp(Ax,eAx)&&!mpz_cmp(Ay,eAy);
    int okR = !mpz_cmp(R8x,eR8x)&&!mpz_cmp(R8y,eR8y);
    int okS = !mpz_cmp(S,eS);
    int ok = okA&&okR&&okS; pass+=ok;
    printf("vec %d  pubkey:%s  R8:%s  S:%s  => %s\n", i, okA?"ok":"X", okR?"ok":"X", okS?"ok":"X", ok?"PASS":"FAIL");
    if(!ok && i==0){ gmp_printf("  got Ax=%Zd\n  exp Ax=%Zd\n  got S =%Zd\n  exp S =%Zd\n",Ax,eAx,S,eS); }
  }
  printf("\n%d/%d vectors PASS\n", pass, N_VECTORS);
  return pass==N_VECTORS?0:1;
}
