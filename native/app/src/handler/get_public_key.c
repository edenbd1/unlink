// GET_PUBLIC_KEY — return the Unlink account public key A = (Ax|Ay).
// The Unlink spending key is derived from the device seed and never leaves the
// Secure Element; only the public point is returned. No on-device review is
// needed (a public key is not secret), so this APDU answers immediately.
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "io.h"
#include "buffer.h"
#include "sw.h"
#include "get_public_key.h"
#include "../unlink_crypto.h"

int handler_get_public_key(buffer_t *cdata, bool display) {
    (void) cdata;
    (void) display;

    char key[80];
    size_t klen = unlink_derive_key(key);

    uint8_t resp[64];  // Ax | Ay
    unlink_pubkey((const uint8_t *) key, klen, resp, resp + 32);
    explicit_bzero(key, sizeof(key));

    return io_send_response_pointer(resp, sizeof(resp), SWO_SUCCESS);
}
