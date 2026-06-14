#pragma once

/**
 * Handler for GET_VIEWING_KEY: returns the 32-byte Unlink viewing private key
 * (read/decrypt capability). No on-device review (it grants no spend authority).
 */
int handler_get_viewing_key(void);
