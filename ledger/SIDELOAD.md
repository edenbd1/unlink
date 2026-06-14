# Sideloading Unlink onto a real Ledger (Apex P, dev mode)

Installs the native Unlink app onto a physical device — it then appears as an
app icon on the Ledger (like OpenPGP/Aleo). No certification needed in dev mode.

## Tested working (Ledger Apex P, target_id 0x33400004, SE 1.1.1)

```bash
# 1. build for the device
docker run --rm -v "$PWD:/repo" \
  ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest \
  bash -c "cd /repo/native/app && make -j TARGET=apex_p"

# 2. install from the host (device unlocked, on the dashboard)
pip3 install --user ledgerblue
cd native/app
DATASIZE=$(( 0x$(grep _envram_data debug/app.map | awk '{print $2}' | cut -f2 -dx) \
           - 0x$(grep _nvram_data  debug/app.map | awk '{print $2}' | cut -f2 -dx) ))
IPSIZE=$(( 0x$(grep _einstall_parameters debug/app.map | awk '{print $2}' | cut -f2 -dx) \
         - 0x$(grep _install_parameters  debug/app.map | awk '{print $2}' | cut -f2 -dx) ))
python3 -m ledgerblue.loadApp --targetId 0x33400004 --targetVersion="" --apiLevel 26 \
  --fileName bin/app.hex --appName "Unlink" --appFlags 0x200 --delete --tlv \
  --dataSize $DATASIZE --installparamsSize $IPSIZE
```

Approve **"Allow unknown manager?"** and the install on the device. "Unlink" then
shows in the app list (verify with `python3 -m ledgerblue.listApps`).

For other devices use the matching target: `nanos2` (Nano S Plus), `nanox`,
`stax`, `flex`, `apex_p` — and the corresponding `--targetId`
(Nano X 0x33100004, Nano S+ 0x33200004 ... wait, see ledgerwallet.utils.target_ids).
