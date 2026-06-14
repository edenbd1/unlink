// REVIEW_INTENT — show a transaction on the device and wait for a physical
// approval, BEFORE the tx is prepared, so the tap is outside the engine's
// prepare->submit window. cdata is a flat list of NUL-separated strings:
//   "<label1>\0<value1>\0<label2>\0<value2>..."  (up to 4 pairs).
// e.g. "Amount\0" "1.00 USDC\0" "Vault\0" "Unlink Demo Vault\0" "Address\0" "0xaf..".
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "io.h"
#include "buffer.h"
#include "sw.h"
#include "glyphs.h"
#include "nbgl_use_case.h"
#include "menu.h"
#include "../ui/display.h"
#include "review_intent.h"

#define MAX_PAIRS 4

static char g_buf[320];                 // holds the NUL-separated label/value strings
static nbgl_contentTagValue_t g_pairs[MAX_PAIRS];
static nbgl_contentTagValueList_t g_pairList;

static void review_cb(bool confirm) {
    if (confirm) {
        io_send_sw(SWO_SUCCESS);
        nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main);
    } else {
        io_send_sw(SWO_CONDITIONS_NOT_SATISFIED);
        nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_REJECTED, ui_menu_main);
    }
}

int handler_review_intent(buffer_t *cdata) {
    if (!cdata || cdata->size < 2) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    size_t n = cdata->size;
    if (n >= sizeof(g_buf)) n = sizeof(g_buf) - 1;
    memcpy(g_buf, cdata->ptr, n);
    g_buf[n] = 0;

    // collect segment pointers (split on the NUL separators already in g_buf)
    const char *seg[MAX_PAIRS * 2];
    int nseg = 0;
    seg[nseg++] = g_buf;
    for (size_t i = 0; i < n && nseg < MAX_PAIRS * 2; i++) {
        if (g_buf[i] == 0) seg[nseg++] = &g_buf[i + 1];
    }
    int npairs = nseg / 2;
    if (npairs < 1) return io_send_sw(SWO_WRONG_DATA_LENGTH);
    if (npairs > MAX_PAIRS) npairs = MAX_PAIRS;

    for (int p = 0; p < npairs; p++) {
        g_pairs[p].item = seg[p * 2];
        g_pairs[p].value = seg[p * 2 + 1];
    }
    g_pairList.nbPairs = npairs;
    g_pairList.pairs = g_pairs;

    nbgl_useCaseReview(TYPE_TRANSACTION,
                       &g_pairList,
                       &ICON_APP_BOILERPLATE,
                       "Review Unlink\nprivate transaction",
                       NULL,
                       "Sign this private\ntransaction?",
                       review_cb);
    return 0;
}
