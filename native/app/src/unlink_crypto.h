#pragma once
#include <stdint.h>
#include <stddef.h>
// Sign message_hash (big-endian field element) with raw private key bytes.
// Outputs 32-byte big-endian Ax,Ay (pubkey) and R8x,R8y,S (signature).
void unlink_sign(const uint8_t *key, size_t keylen, const uint8_t msg_be32[32],
                 uint8_t Ax[32], uint8_t Ay[32], uint8_t R8x[32], uint8_t R8y[32], uint8_t S[32]);
void unlink_poseidon_test(uint8_t out[192], int nr);
