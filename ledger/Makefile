# Host validation of the Unlink on-device signer (EdDSA-Poseidon) vs test vectors.
GMP ?= /opt/homebrew/opt/gmp
CFLAGS = -O2 -Wall -I$(GMP)/include
LDFLAGS = -L$(GMP)/lib -lgmp

host/signer: host/signer.c host/consts.h host/vectors.h
	cc $(CFLAGS) host/signer.c -o host/signer $(LDFLAGS)

consts: ## regenerate constants + vectors headers from the SDK
	node tools/dump-constants.cjs && node tools/dump-vectors.cjs

test: host/signer ## build and run the vector validation
	./host/signer

clean:
	rm -f host/signer
.PHONY: consts test clean
