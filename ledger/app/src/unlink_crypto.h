#pragma once
#include <stdint.h>
#include <stddef.h>
// Sign message_hash (big-endian field element) with raw private key bytes.
// Outputs 32-byte big-endian Ax,Ay (pubkey) and R8x,R8y,S (signature).
void unlink_sign(const uint8_t *key, size_t keylen, const uint8_t msg_be32[32],
                 uint8_t Ax[32], uint8_t Ay[32], uint8_t R8x[32], uint8_t R8y[32], uint8_t S[32]);
// Public key only (A = (s>>3)*Base8). Faster than a full sign.
void unlink_pubkey(const uint8_t *key, size_t keylen, uint8_t Ax[32], uint8_t Ay[32]);
// Derive the Unlink spending-key material from the device seed (m/44'/1'/0'/0/0):
// the 32-byte BIP32 node rendered as its decimal ASCII string (the Unlink
// privateKey form). Writes up to 78 chars into out, returns the length.
size_t unlink_derive_key(char out[80]);
// Derive the Unlink viewing private key (m/44'/1'/0'/0/1) — a 32-byte read/decrypt
// capability. Exportable (it grants read access only, never spend authority).
void unlink_viewing_key(uint8_t out[32]);
