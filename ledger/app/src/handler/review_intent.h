#pragma once

#include "buffer.h"

/**
 * Handler for REVIEW_INTENT: shows the human-readable transfer (amount +
 * recipient) on the device and waits for a physical approval, before the
 * transaction is prepared. cdata = "<amount>\0<recipient>".
 * Replies 0x9000 on approval, 0x6985 on rejection.
 */
int handler_review_intent(buffer_t *cdata);
