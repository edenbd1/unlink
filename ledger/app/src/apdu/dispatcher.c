/*****************************************************************************
 *   Ledger App Boilerplate.
 *   (c) 2020 Ledger SAS.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *****************************************************************************/

#include <stdint.h>
#include <stdbool.h>

#include "buffer.h"
#include "io.h"
#include "ledger_assert.h"

#include "dispatcher.h"
#include "constants.h"
#include "globals.h"
#include "types.h"
#include "sw.h"
#include "get_version.h"
#include "get_app_name.h"
#include "get_public_key.h"
#include "get_viewing_key.h"
#include "sign_tx.h"
#include "unlink_sign_tx.h"
#include "review_intent.h"
#include "connect.h"
#include "provide_token_info.h"

int apdu_dispatcher(const command_t *cmd) {
    LEDGER_ASSERT(cmd != NULL, "NULL cmd");

    if (cmd->cla != CLA) {
        return io_send_sw(SWO_INVALID_CLA);
    }

    buffer_t buf = {0};

    switch (cmd->ins) {
        case GET_VERSION:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }

            return handler_get_version();

        case GET_APP_NAME:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }

            return handler_get_app_name();

        case GET_PUBLIC_KEY:
            if (cmd->p1 > 1 || cmd->p2 > 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }

            if (!cmd->data) {
                return io_send_sw(SWO_WRONG_DATA_LENGTH);
            }

            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;

            return handler_get_public_key(&buf, (bool) cmd->p1);

        case GET_VIEWING_KEY:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            return handler_get_viewing_key();

        case REVIEW_INTENT:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) {
                return io_send_sw(SWO_WRONG_DATA_LENGTH);
            }
            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;
            return handler_review_intent(&buf);

        case CONNECT:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            return handler_connect();

        case SIGN_TX:
            // Unlink private-tx signing: single-frame, cdata = 32-byte message hash.
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }

            if (!cmd->data) {
                return io_send_sw(SWO_WRONG_DATA_LENGTH);
            }

            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;

            return handler_unlink_sign_tx(&buf);

        case PROVIDE_TOKEN_INFO:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }

            if (!cmd->data) {
                return io_send_sw(SWO_WRONG_DATA_LENGTH);
            }

            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;

            return handler_provide_token_info(&buf);

        default:
            return io_send_sw(SWO_INVALID_INS);
    }
}
