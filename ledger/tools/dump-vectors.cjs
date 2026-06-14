const path=require("path"),fs=require("fs");
const v=require(path.resolve(__dirname,"../host/test-vectors.json"));
let h=`// AUTO-GENERATED from test-vectors.json\n#ifndef UNLINK_VECTORS_H\n#define UNLINK_VECTORS_H\ntypedef struct{const char*sk;const char*msg;const char*Ax;const char*Ay;const char*R8x;const char*R8y;const char*S;}vec_t;\nstatic const vec_t VECTORS[${v.length}]={\n`;
for(const x of v)h+=` {"${x.sk.replace(/^0x/,"")}","${x.msg}","${x.Ax}","${x.Ay}","${x.R8x}","${x.R8y}","${x.S}"},\n`;
h+=`};\n#define N_VECTORS ${v.length}\n#endif\n`;
fs.writeFileSync(path.resolve(__dirname,"../host/vectors.h"),h);
console.log("vectors.h: "+v.length);
