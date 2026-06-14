#!/usr/bin/env python3
# Talk to the Ledger Ethereum app over the same reliable macOS HID poller used by
# apdu.py — no native node-hid build needed.
#   get_address  m/44'/60'/0'/0/0                 -> 0x… address
#   sign712      <path> <domainHash> <msgHash>    -> 0x<r><s><v> (65-byte sig)
# Ethereum app APDUs: INS 0x02 GET_ETH_PUBLIC_ADDRESS, INS 0x0C SIGN_EIP712_HASHED.
import hid, time, sys
from ledgerblue.ledgerWrapper import wrapCommandAPDU, unwrapResponseAPDU
CH = 0x0101

def open_dev():
    path = [d['path'] for d in hid.enumerate(0x2c97, 0) if d.get('usage_page', 0) == 0xffa0][0]
    dev = hid.device(); dev.open_path(path); return dev

def rd(dev, ms):
    try: return bytes(dev.read(64, ms))
    except Exception: return b""

def exchange(apdu, tmo=60):
    dev = open_dev()
    while rd(dev, 120): pass
    pk = wrapCommandAPDU(CH, apdu, 64)
    for i in range(0, len(pk), 64): dev.write(b'\x00' + pk[i:i+64])
    buf = b""; t = time.time()
    while time.time() - t < tmo:
        c = rd(dev, 800)
        if not c: continue
        buf += c
        try: r = unwrapResponseAPDU(CH, buf, 64)
        except Exception: r = None
        if r: return bytes(r)
    raise SystemExit("NO_RESP")

def encode_path(path):  # "44'/60'/0'/0/0" -> bytes
    parts = path.replace("m/", "").split("/")
    out = bytes([len(parts)])
    for p in parts:
        v = int(p[:-1]) | 0x80000000 if p.endswith("'") else int(p)
        out += v.to_bytes(4, 'big')
    return out

def get_address(path="44'/60'/0'/0/0", display=0):
    data = encode_path(path)
    apdu = bytes([0xE0, 0x02, display, 0x00, len(data)]) + data
    r = exchange(apdu, 60)
    sw = r[-2:].hex()
    if sw != "9000": raise SystemExit("getAddress SW=" + sw)
    body = r[:-2]
    pk_len = body[0]; off = 1 + pk_len
    addr_len = body[off]; addr = body[off+1:off+1+addr_len].decode()
    return "0x" + addr if not addr.startswith("0x") else addr

def sign712(path, domain_hash_hex, msg_hash_hex):
    data = encode_path(path) + bytes.fromhex(domain_hash_hex) + bytes.fromhex(msg_hash_hex)
    apdu = bytes([0xE0, 0x0C, 0x00, 0x00, len(data)]) + data
    r = exchange(apdu, 120)
    sw = r[-2:].hex()
    if sw != "9000": raise SystemExit("sign712 SW=" + sw)
    body = r[:-2]                       # v(1) r(32) s(32)
    v = body[0]; rr = body[1:33]; ss = body[33:65]
    return "0x" + rr.hex() + ss.hex() + bytes([v]).hex()

def sign_tx(path, raw_tx_hex):
    # INS 0x04 SIGN_TX. Payload = path + serialized (unsigned) tx, chunked at 255B.
    rawtx = bytes.fromhex(raw_tx_hex[2:] if raw_tx_hex.startswith("0x") else raw_tx_hex)
    payload = encode_path(path) + rawtx
    r = None; off = 0; first = True
    while off < len(payload):
        chunk = payload[off:off+255]; off += len(chunk)
        p1 = 0x00 if first else 0x80; first = False
        apdu = bytes([0xE0, 0x04, p1, 0x00, len(chunk)]) + chunk
        r = exchange(apdu, 120)
    sw = r[-2:].hex()
    if sw != "9000": raise SystemExit("sign_tx SW=" + sw)
    body = r[:-2]                       # v(1) r(32) s(32)
    return "0x" + body.hex()            # caller assembles v,r,s

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "get_address"
    if cmd == "get_address":
        print(get_address(sys.argv[2] if len(sys.argv) > 2 else "44'/60'/0'/0/0"))
    elif cmd == "sign712":
        print(sign712(sys.argv[2], sys.argv[3], sys.argv[4]))
    elif cmd == "sign_tx":
        print(sign_tx(sys.argv[2], sys.argv[3]))
    else:
        print("usage: eth_apdu.py get_address [path] | sign712 <path> <domH> <msgH> | sign_tx <path> <rawtx>")
