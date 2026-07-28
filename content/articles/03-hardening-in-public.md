---
title: "Part 3: Hardening a Crypto Crate in Public"
description: "This is part 3 of a 3-part series on tholos-pq. What public review broke in tholos-pq packaging — malleability, deps, docs — and what still isn’t promised."
date: 2025-12-10
tags:
- crypto review
- signature malleability
- CBOR
- supply chain
- threat model
- open-source hardening

draft: false
series: pqe-multi-recipient-encryption
---


## Cryptography is necessary; packaging is where you get hurt

Parts 1 and 2 described a tidy design: CEK, envelopes, ML-KEM, ML-DSA, XChaCha, CBOR.

Then we reviewed the crate the way an attacker (or a careful user) would. Several issues were not “wrong algorithms.” They were **wrong assumptions about encodings, dependencies, and documentation**—the glue that turns primitives into a protocol.

This post is that cleanup story, written so you can steal the lessons even if you never use tholos-pq.

---

## Lesson 1: Sign the bytes on the wire

### The bug-shaped assumption

An early design effectively treated the signed object as a *structure*: decode the bundle, re-encode the inner fields, verify the signature over the re-encoding.

That feels elegant. It is also how you invent **malleability**.

CBOR (like many binary encodings) can represent “the same” value with different byte strings—optional self-describe tags, and historically more flexibility depending on the decoder. If verification re-encodes, then:

- Tag-stripped ciphertext might still verify
- Two peers on different encoder versions might disagree
- An attacker might find encodings you did not test

### The fix

`BundleSigned.inner` is now **opaque CBOR bytes**. ML-DSA verifies over those bytes **exactly as received**. Only after a successful verify do we deserialize `BundleUnsigned` and decrypt.

We also require the outer self-describe tag on the wire object, reject unknown CBOR fields (`deny_unknown_fields`), and stopped claiming “canonical CBOR” when we meant “deterministic for this encoder.”

**Takeaway for your own protocols:** If the signature does not cover the transmitted representation, you are authenticating a dream, not a message.

---

## Lesson 2: Unmaintained codecs are a security dependency

The CBOR stack originally used `serde_cbor`. It works until it doesn’t: the crate is unmaintained, shows up in `cargo audit`, and freezes your encoder behavior in amber.

We migrated to **`ciborium`**. That was a **breaking wire/dependency change**, which is fine when you have few users and a suite/version gate. It would have been painful after wide deployment—another argument for getting the codec right before you promise stability.

**Takeaway:** In a crypto crate, your serializer is in the TCB. Treat “archived on GitHub” as a vulnerability class.

---

## Lesson 3: “Pure Rust” must be true when you say it

Documentation once implied a pure-Rust story while Dilithium came through **`pqcrypto-dilithium`** / PQClean C. That is a legitimate engineering choice—and a dishonest README bullet.

We moved signatures to **`dilithium-rs`** (ML-DSA-65), kept **`ml-kem`** for KEM, and made zeroization of secret material a first-class concern (CEK/KEK via `Zeroizing`, ML-KEM decapsulation keys, ML-DSA keypairs on drop).

The suite string now says what we ship: `Kyber1024+XChaCha20P1305+MlDsa65`.

**Takeaway:** Security marketing is part of the attack surface. If the docs lie, users mis-estimate supply-chain and audit scope.

---

## Lesson 4: Test the format, not just the round trip

Encrypt-then-decrypt in the same process proves the code agrees with itself. It does **not** prove the wire format is stable.

What helps:

- **Checked-in golden vectors** under `tests/data/v0.3.0/` with fixed seeds
- **Security regression tests** (tag stripping, unknown field injection)
- **Property tests** for multi-recipient behavior and allowlist rejection
- **CI** that runs doctests, clippy `-D warnings`, docs `-D warnings`, MSRV, and `cargo audit`

When the encoder drifts, the golden vector fails loudly. That is the point.

**Takeaway:** For versioned ciphertext formats, vectors are not a nice-to-have. They are how you notice you broke the world.

---

## Lesson 5: Fail closed on policy edges

Small API choices matter:

- Empty recipient list → `NoRecipients` (don’t emit nonsense bundles)
- Unknown suite/version → `UnsupportedSuite`
- Header `recipients` must match envelope `kid`s in order; duplicates rejected
- Disallowed sender → `BadSignature`

None of these replace a threat model. They keep accidental misuse from looking like success.

---

## What we still don’t claim (read this twice)

The README’s limitations are not fine print. They are the product boundary.

### No forward secrecy

Recipient ML-KEM keys are long-lived. If Bob’s private key leaks, an attacker with archived ciphertext for Bob can decrypt those messages. There is no ratchet, no ephemeral handshake, no “compromise tomorrow doesn’t open yesterday” story.

If you need FS, you want a session protocol (or at least ephemeral KEMs and disciplined key lifetime)—not only envelope encryption to static directories.

### No built-in replay protection

`msg_id` and `timestamp_unix` are **authenticated** (they sit under the signed inner content and in AEAD AAD). They are **not enforced**.

Use `verify_header`, then record `msg_id` (and maybe a timestamp window) in your application. Cryptography can bind metadata; only your state can reject “I already saw this.”

### Encoder determinism ≠ canonical CBOR

We encode with `ciborium` and sign the result. We do not implement full RFC 8949 canonicalization. Interoperability means “same suite + compatible encoder behavior,” backed by vectors—not “any CBOR library in any language will byte-identical round-trip.”

### Allowlists are your key management

tholos-pq will happily reject a bad signature. It will not invent a PKI. Distribution of sender ML-DSA public keys and recipient ML-KEM public keys is application territory.

### Size and CPU are PQ-sized

See part 2. If your constraint is 300-byte BLE packets, this suite is the wrong tool.

---

## A short “should I use this?” checklist

**Consider tholos-pq if you want:**

- One ciphertext, many recipients
- NIST PQ KEM + PQ signature defaults
- A small Rust API with a versioned CBOR wire format
- Explicit sender allowlisting

**Choose something else (or build more) if you need:**

- Forward secrecy / ratcheting
- Member management and group evolution (look at MLS)
- Minimal bandwidth above all else
- A full end-user messaging product UX
- Hybrid classical+PQ transport (different layer, often complementary)

---

## Where the project stands

As of **0.3.x**, the headline hardening work is in:

- Opaque signed `inner` bytes
- Unknown-field rejection and suite gates
- `ciborium` instead of unmaintained CBOR
- Pure-Rust ML-DSA via `dilithium-rs`
- Zeroization where the stack allows
- Golden vectors + security tests + stricter CI

The algorithms from part 2 did not magically become “safe” because of that work. They became **harder to misuse at the packaging layer**, and the docs got closer to the truth.

That is most of what a young crypto library can responsibly claim.

---

## Closing the series

1. **Part 1:** HNDL and multi-recipient envelopes explain *why* the crate exists  
2. **Part 2:** CEK + ML-KEM wraps + ML-DSA + XChaCha explain *how* it works  
3. **Part 3:** Wire-byte signatures, dependency honesty, and explicit non-goals explain *how not to fool yourself*

If you try it, break it, or need a different suite (smaller KEM, hybrid KEM, AES-GCM), open an issue—or better, a failing vector.

```bash
cargo add tholos-pq
cargo run --example demo
```

Thanks for reading.

---

*tholos-pq is Apache-2.0.*  
*[GitHub](https://github.com/thanos/tholos-pq) · [crates.io](https://crates.io/crates/tholos-pq) · [docs.rs](https://docs.rs/tholos-pq)*
