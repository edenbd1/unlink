// GET_VIEWING_KEY — return the Unlink viewing private key (32 bytes).
// The viewing key is a read/decrypt capability only (it grants no spend
// authority — that stays with the spending key in the Secure Element). The host
// needs it to build the account's registration material and decrypt balances,
// mirroring Aleo's view-key sharing under user consent.
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "io.h"
#include "buffer.h"
#include "sw.h"
#include "get_viewing_key.h"
#include "../unlink_crypto.h"

int handler_get_viewing_key(void) {
    static uint8_t vk[32];
    unlink_viewing_key(vk);
    return io_send_response_pointer(vk, sizeof(vk), SWO_SUCCESS);
}
