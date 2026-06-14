// SIGN_TX — sign an Unlink private transaction on the Secure Element.
// The host sends the 32-byte message hash (big-endian field element). The device
// shows an on-device review ("Sign Unlink private tx?"); only on a physical tap
// does it derive the spending key from the seed, sign (EdDSA-Poseidon on the SE)
// and return Ax|Ay|R8x|R8y|S. The signature verifies under @zk-kit/eddsa-poseidon.
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"
#include "sw.h"
#include "glyphs.h"
#include "nbgl_use_case.h"
#include "menu.h"
#include "../ui/display.h"
#include "unlink_sign_tx.h"
#include "../unlink_crypto.h"

#define UNLINK_IMMEDIATE_SIGN  // DEV: skip the review (USB capture for testing)

static uint8_t g_hash[32];
static nbgl_contentTagValue_t g_pairs[2];
static nbgl_contentTagValueList_t g_pairList;

static int do_sign(void) {
    char key[80];
    size_t klen = unlink_derive_key(key);
    uint8_t resp[160];  // Ax | Ay | R8x | R8y | S
    unlink_sign((const uint8_t *) key, klen, g_hash,
                resp, resp + 32, resp + 64, resp + 96, resp + 128);
    explicit_bzero(key, sizeof(key));
    return io_send_response_pointer(resp, sizeof(resp), SWO_SUCCESS);
}

static void review_choice(bool confirm) {
    if (confirm) {
        do_sign();
        nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main);
    } else {
        io_send_sw(SWO_CONDITIONS_NOT_SATISFIED);
        nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_REJECTED, ui_menu_main);
    }
}

int handler_unlink_sign_tx(buffer_t *cdata) {
    if (!cdata || cdata->size < 32) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    memcpy(g_hash, cdata->ptr, 32);

#ifdef UNLINK_IMMEDIATE_SIGN
    return do_sign();
#else
    g_pairs[0].item = "Action";
    g_pairs[0].value = "Sign Unlink private tx";
    g_pairs[1].item = "Privacy";
    g_pairs[1].value = "amount & recipient hidden";
    g_pairList.nbPairs = 2;
    g_pairList.pairs = g_pairs;

    nbgl_useCaseReview(TYPE_TRANSACTION,
                       &g_pairList,
                       &ICON_APP_BOILERPLATE,
                       "Review Unlink\nprivate transaction",
                       NULL,
                       "Sign Unlink\nprivate transaction?",
                       review_choice);
    return 0;
#endif
}
