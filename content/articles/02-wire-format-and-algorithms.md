---
title: "Part 2: Inside tholos-pq — Wire Format and Algorithm Suite"
description: "This is part 2 of a 3-part series on tholos-pq suite and wire format: ML-KEM-1024, XChaCha20-Poly1305, ML-DSA-65, CBOR envelopes."
date: 2025-12-10
tags:
- Kyber
- Dilithium
- wire format
- CBOR
- XChaCha20-Poly1305
- ML-DSA
- ML-KEM
- tholos-pq

draft: false
series: pqe-multi-recipient-encryption
---

## The suite string is a contract

Every tholos-pq bundle carries a header field:

```text
suite = Kyber1024+XChaCha20P1305+MlDsa65
```

That string is not marketing. Decryptors reject unsupported `(version, suite)` pairs. When the algorithms change, the suite changes, and old code fails closed instead of half-interpreting a new layout.

The current suite means:

| Role | Algorithm | NIST / common name |
|------|-----------|--------------------|
| Per-recipient key establishment | **ML-KEM-1024** | Kyber-1024 |
| Bulk + CEK wrap AEAD | **XChaCha20-Poly1305** | — |
| Sender authentication | **ML-DSA-65** | Dilithium3 |
| Encoding | **CBOR** (via `ciborium`) | RFC 8949 family |

Below is how those pieces fit together—and why each one is there.

---

## The shape of a bundle

At a high level:

```text
                    ┌─────────────────────────────────────┐
  plaintext ──AEAD──► payload (nonce + ciphertext)        │
                    │                                     │
  random CEK ──┬────┴── wrap under KEK_i ──► envelope_i   │
               │         for each recipient i             │
               │                                          │
               └─ never appears on the wire in the clear  │
                                                          │
  BundleUnsigned { header, payload, envelopes[] }         │
            │                                             │
            ▼ CBOR encode                                 │
         inner bytes                                      │
            │                                             │
            ▼ ML-DSA-65 sign(inner)                       │
  BundleSigned { inner, sig_dilithium } ──CBOR──► wire    │
                    └─────────────────────────────────────┘
```

**Encrypt once** for the payload. **Wrap N times** for the CEK. **Sign once** over the encoded inner bytes.

### Header

Authenticated metadata:

- `v` — format version (currently `1`)
- `suite` — algorithm suite string
- `sender` — sender ID string
- `recipients` — list of recipient key IDs (`kid`s), order-matched to envelopes
- `msg_id` — UUID string (for *your* replay logic)
- `timestamp_unix` — seconds since epoch (same)

The header is also used as **AEAD associated data** when encrypting the payload and when wrapping the CEK. That binds ciphertext to this header: you cannot casually transplant an envelope into a different message’s context without breaking authentication.

### Payload

XChaCha20-Poly1305 ciphertext of the plaintext under a random 32-byte CEK, with a 24-byte nonce.

### Recipient envelopes

For each recipient:

1. ML-KEM-1024 encapsulate to their public key → shared secret + KEM ciphertext
2. `KEK = HKDF-SHA256(shared, salt=kid, info=header_cbor)`
3. AEAD-wrap the CEK under that KEK (again with the header as AAD)
4. Store `{ kid, kem_ct, wrap_nonce, wrapped_cek }`

Only someone with the matching ML-KEM private key can recover the shared secret, derive the same KEK, and unwrap the CEK.

### Outer signed object

`BundleSigned` is what hits the wire:

- `inner`: **opaque bytes** — the CBOR encoding of `BundleUnsigned`
- `sig_dilithium`: ML-DSA-65 detached signature over those exact bytes

Verification checks the signature **before** treating the inner structure as trusted input for decryption policy. That design choice gets its own war story in part 3; for now, remember: *we sign what we send, not what we re-serialize later.*

---

## Algorithm deep dive: why these four

### ML-KEM-1024 — the per-recipient door

**What it is.** A lattice-based key encapsulation mechanism. You encapsulate to a public key and get `(ciphertext, shared_secret)`. The holder of the secret key decapsulates the ciphertext to the same shared secret.

**What it is not.** It is not “encrypt arbitrary messages with Kyber.” In tholos, Kyber only protects a key-encryption key path that wraps the CEK.

**Why 1024 (Category 5), not 768.** Recipient keys in this model are **long-lived**. There is no ratchet. If you are going to keep a static PQ encapsulation key for years, paying for the higher NIST security category is a reasonable default for a library that advertises archival-friendly confidentiality. The cost is size: ML-KEM-1024 public keys and ciphertexts are large (~1568 bytes for the public key). That is the PQ tax.

**Alternatives considered.**

- **ML-KEM-768:** smaller, still strong; fine for many apps; we preferred margin for static keys
- **Classical ECDH only:** fails the HNDL story from part 1
- **Hybrid ECDH+ML-KEM:** excellent for transports; more suite complexity than we wanted in v1

### XChaCha20-Poly1305 — the workhorse

**What it is.** An AEAD: confidentiality + integrity for the payload and for wrapped CEKs. XChaCha extends ChaCha20-Poly1305 with a **192-bit nonce**, which makes random nonces practical without the catastrophic reuse story of 96-bit GCM nonces under a long-lived key.

**Why not AES-GCM?** AES-GCM is everywhere and often hardware-accelerated. For a pure-Rust, misuse-resistant-leaning library default, XChaCha’s nonce length and the maturity of the `chacha20poly1305` crate were the better fit. Applications that must use AES can imagine a future suite—today’s suite string is explicit.

**Why not encrypt the payload directly under KEM shared secrets?** Because then you encrypt N times and still need a clean AAD/header story. A single CEK keeps bulk encryption O(1) in recipients.

### ML-DSA-65 — the sender’s nameplate

**What it is.** NIST’s Dilithium parameter set often called Dilithium3: a module-lattice signature scheme. tholos uses it to authenticate the sender of a bundle.

**Why signatures instead of MAC-only?** Recipients do not share a symmetric auth key with the sender in this model. Public verification + an allowlist matches “many readers, few writers.”

**Why ML-DSA-65?** Middle NIST strength commonly recommended for general use; public keys ~1952 bytes, signatures ~3309 bytes. SPHINCS+ would avoid lattices at the cost of much larger signatures. Smaller Dilithium parameters save space; we prioritized a conservative general-purpose default.

**Verification policy.** Decrypt looks up `header.sender` in the caller-provided allowlist, checks the ML-DSA public key, verifies `sig` over `inner`, and only then proceeds. Unknown or disallowed senders become `BadSignature`.

### CBOR + HKDF — boring glue that must not be cute

**CBOR** gives a compact binary encoding with a self-describe tag (`d9 d9 f7`) on the outer wire object. We use maintained `ciborium`. We do **not** claim full RFC 8949 canonical CBOR; we claim “signatures cover the encoded inner bytes as transmitted,” which is the property that matters for authenticity.

**HKDF-SHA256** turns the ML-KEM shared secret into a KEK, salted with the recipient `kid` and informed by the header encoding. That binds “this wrapping key” to “this recipient identity” and “this message header,” so swapping envelope bodies between recipients or headers fails closed.

---

## Decrypt path (the reader’s journey)

1. Require the outer CBOR self-describe tag
2. Decode `BundleSigned`
3. Verify ML-DSA over `inner` using the allowlisted key for `header.sender`
4. Decode and validate `BundleUnsigned` (suite/version, recipient list consistency, no duplicate `kid`s)
5. Find the envelope for `my_kid`
6. Decapsulate ML-KEM → HKDF → unwrap CEK
7. AEAD-open the payload with header as AAD
8. Return plaintext (caller owns it)

If you only need metadata for replay tracking, `verify_header` stops after step 4’s authenticated header—without revealing plaintext.

---

## Size: the bill you knew was coming

Rough order-of-magnitude for the PQ parts (symmetric payload scales with message size):

| Object | Approx size |
|--------|-------------|
| ML-KEM-1024 public key | ~1.6 KiB |
| ML-KEM ciphertext (per recipient) | ~1.6 KiB |
| ML-DSA-65 public key | ~2.0 KiB |
| ML-DSA-65 signature (per bundle) | ~3.3 KiB |

A three-recipient bundle is dominated by **one signature + three KEM ciphertexts**, not by a 200-byte JSON alert body. That is expected. PQ multi-recipient encryption is for messages where the security properties matter more than fitting in a UDP probe.

---

## What this is optimized for

- Fan-out sealed messages with explicit sender authentication
- A versioned, testable wire format (checked-in vectors live under `tests/data/`)
- A pure-Rust dependency story for the asymmetric stack (`ml-kem`, `dilithium-rs`) plus `chacha20poly1305`

What it is not optimized for: minimal bandwidth, forward secrecy, or replacing a full messaging protocol.

---

## Next

You now have the map. [Part 3](/articles/03-hardening-in-public/) is about the sharp edges we hit while making that map trustworthy: malleable encodings, unmaintained CBOR crates, C-based Dilithium, and the limits we still print in bold in the README.

---

*Suite reference: `Kyber1024+XChaCha20P1305+MlDsa65` · Crate: [tholos-pq 0.3](https://crates.io/crates/tholos-pq)*
