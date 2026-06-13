// Unlink native signer — validation handler.
// On GET_PUBLIC_KEY, sign a fixed message with a fixed test key entirely on the
// Secure Element and return Ax|Ay|R8x|R8y|S (160 bytes). Compared byte-exact to
// the reference @zk-kit/eddsa-poseidon signer. (Production: derive key from seed.)
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

    // 32-byte test key = ASCII "unlink-ledger-native-signer-test"
    static const uint8_t key[32] = "unlink-ledger-native-signer-test";
    uint8_t msg[32] = {0};
    msg[31] = 42;  // message_hash = field element 42 (big-endian)

    uint8_t Ax[32], Ay[32], R8x[32], R8y[32], S[32];
    unlink_sign(key, 32, msg, Ax, Ay, R8x, R8y, S);

    uint8_t resp[160];
    memcpy(resp + 0, Ax, 32);
    memcpy(resp + 32, Ay, 32);
    memcpy(resp + 64, R8x, 32);
    memcpy(resp + 96, R8y, 32);
    memcpy(resp + 128, S, 32);

    return io_send_response_pointer(resp, sizeof(resp), SWO_SUCCESS);
}
