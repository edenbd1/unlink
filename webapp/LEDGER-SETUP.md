# Real Ledger OpenPGP custody — macOS setup (tested, working)

How the Unlink seed is custodied in a physical Ledger on macOS. The seed is
encrypted to the Ledger's OpenPGP encryption key; only the device decrypts it.

Validated end-to-end on a Ledger (Nano Gen5, OpenPGP app 3.3): generate key
on-card → encrypt seed → decrypt via device → real private USDC transfer.

## 1. GnuPG config (the part that makes macOS + Ledger work)

`~/.gnupg/scdaemon.conf`
```
disable-ccid      # use the OS PC/SC stack, not scdaemon's internal CCID driver
pcsc-shared
disable-pinpad    # enter PINs via host pinentry, not an assumed on-reader pad
```

`~/.gnupg/gpg-agent.conf`
```
pinentry-program /opt/homebrew/bin/pinentry-mac   # GUI PIN dialog
```

Reload after changes: `gpgconf --kill scdaemon gpg-agent`.

Without `disable-ccid` you get `selecting card failed: Operation not supported`.
Without `disable-pinpad` the host PIN dialog never appears.

## 2. On the device

- Unlock the Ledger, then **open the OpenPGP app** (its USB product id changes
  from `2c97:8000` (dashboard) — GPG only sees the card while the app is open).
- The app keeps a **PIN mode** setting (gear icon): `Confirm Only [default]`
  means sensitive operations need a physical confirmation on the device — which
  is exactly the custody UX we want for decryption.
- Default OpenPGP PINs: **User `123456`**, **Admin `12345678`** (independent of
  the device unlock PIN). If the User PIN counter gets stuck, reset it with the
  admin PIN (no data loss):
  ```
  gpg-connect-agent --hex \
    "scd apdu 00 20 00 83 08 31 32 33 34 35 36 37 38" \  # verify admin
    "scd apdu 00 2C 02 81 06 31 32 33 34 35 36" /bye      # reset User PIN -> 123456
  ```

## 3. Generate the encryption key on-card

```
gpg --card-edit
> admin
> generate            # off-card backup: n   (hardware-only)
                      # enter Admin PIN (12345678) and User PIN (123456) when asked
                      # name: Ledger Custody   email: custody@unlink.local
```
`gpg --card-status` should then show an `Encryption key`. The private key never
leaves the Secure Element.

## 4. Point the app at it

`.env`
```
LEDGER_OPENPGP_RECIPIENT=custody@unlink.local
```
`createCustodiedSeed()` encrypts a fresh 64-byte seed to this key; `decryptSeed()`
routes the decryption through the device. See `test/hw-e2e.mjs` for the full run.
