#pragma once

/**
 * Handler for CONNECT: shows a pairing approval ("Connect this account to the
 * Unlink app?") and waits for a tap. Replies 0x9000 on approval, 0x6985 on reject.
 */
int handler_connect(void);
