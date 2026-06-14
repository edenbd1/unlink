// Emits the Poseidon(t=6)+BabyJubJub constants as 32-byte big-endian C arrays for cx_bn.
const path=require("path"), fs=require("fs");
const SDK=path.resolve(__dirname,"../../node_modules/poseidon-lite");
const unstringify=require(path.join(SDK,"poseidon/unstringify.js")).default;
const {C,M}=unstringify(require(path.join(SDK,"constants/5.js")).default);
const be=(x)=>{let h=BigInt(x).toString(16).padStart(64,"0");return "0x"+h.match(/../g).join(",0x");};
const arr=(x)=>`{${be(x)}}`;
const flatC=C.map(arr).join(",\n  ");
const flatM=M.flat().map(arr).join(",\n  ");
const consts={
  P:"21888242871839275222246405745257275088548364400416034343698204186575808495617",
  SUB:"2736030358979909402780800718157159386076813972158567259200215660948447373041",
  B8X:"5299619240641551281634865583518297030282874472190772894086521144482721001553",
  B8Y:"16950150798460657717958625567821834550301663161624707787222815936182638968203",
  A:"168700", D:"168696"};
let h=`// AUTO-GENERATED — Poseidon(t=6)+BabyJubJub constants as 32-byte BE arrays\n#pragma once\n#include <stdint.h>\n`;
for(const [k,v] of Object.entries(consts)) h+=`static const uint8_t PARM_${k}[32]=${arr(v)};\n`;
h+=`#define POSEIDON_NROUNDS 68\n#define POSEIDON_T 6\n#define POSEIDON_RF 8\n#define POSEIDON_RP 60\n`;
h+=`static const uint8_t POSEIDON_C[${C.length}][32]={\n  ${flatC}\n};\n`;
h+=`static const uint8_t POSEIDON_M[36][32]={\n  ${flatM}\n};\n`;
fs.writeFileSync(path.resolve(__dirname,"../app/src/unlink_params.h"),h);
console.log("unlink_params.h: C="+C.length+" M=36  (32B BE arrays)");
