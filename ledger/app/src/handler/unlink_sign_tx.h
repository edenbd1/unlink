#pragma once

#include "buffer.h"

/**
 * Handler for SIGN_TX: signs an Unlink private transaction.
 * cdata = 32-byte message hash (big-endian field element).
 * Shows an on-device review; on approval returns Ax|Ay|R8x|R8y|S (160 bytes).
 */
int handler_unlink_sign_tx(buffer_t *cdata);
