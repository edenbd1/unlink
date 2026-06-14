// CONNECT — on-device approval when a host opens a session with this account.
// A lightweight pairing gesture: the Ledger shows "Connect this account to the
// Unlink app?" and the user taps. No keys move; the spending key stays in the SE.
#include <stdint.h>
#include <stdbool.h>

#include "io.h"
#include "sw.h"
#include "glyphs.h"
#include "nbgl_use_case.h"
#include "menu.h"
#include "../ui/display.h"
#include "connect.h"

static void connect_cb(bool confirm) {
    io_send_sw(confirm ? SWO_SUCCESS : SWO_CONDITIONS_NOT_SATISFIED);
    ui_menu_main();
}

int handler_connect(void) {
    nbgl_useCaseChoice(&ICON_APP_BOILERPLATE,
                       "Connect this account\nto the Unlink app?",
                       "Your spending key stays\nin the Secure Element.",
                       "Approve",
                       "Reject",
                       connect_cb);
    return 0;
}
