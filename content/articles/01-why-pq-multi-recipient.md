---
title: "Part 1: Why Post-Quantum Multi-Recipient Encryption?"
description: "Why encrypt-once / decrypt-many needs post-quantum crypto: HNDL risk and the tholos-pq motivation. This is part 1 of a 3-part series on tholos-pq, a Rust crate for encrypting one message to many recipients with NIST post-quantum cryptography."
date: 2025-12-10
tags:
 - post-quantum
 - multi-recipient encryption
 - tholos-pq
 - harvest now decrypt later
 - ML-KEM
 - Rust crypto

draft: false
series: pqe-multi-recipient-encryption
---



## The awkward middle of messaging crypto

Most encryption tutorials start with Alice and Bob. Alice encrypts to Bob’s public key. Bob decrypts. The story ends.

Real systems rarely look like that.

A server notifies five devices. A workflow tool fans a sealed document out to a committee. A backend writes one ciphertext that any of N service identities can open later. You want **one blob**, **many legitimate openers**, and a clear story about **who authored it**.

Classical crypto already has patterns for this—CMS/PKCS#7 enveloped data, PGP to multiple recipients, NaCl-style sealed boxes multiplied N times. What it does *not* have, by default, is a clean answer to a quieter threat: **ciphertext that will still matter in ten or twenty years**.

That is the niche [tholos-pq](https://crates.io/crates/tholos-pq) aims at: *encrypt once, decrypt many*, with a versioned binary wire format, using NIST post-quantum primitives for the long-lived parts of the design.

---

## Harvest now, decrypt later

Public-key encryption has a peculiar property: the ciphertext is often more durable than the algorithm that sealed it.

An attacker who records traffic today does not need to break anything today. They wait. When a large quantum computer can solve the discrete-log or factoring problems that underpin `ECDH` and `RSA`, yesterday’s archives become readable. Cryptographers call this **harvest now, decrypt later (HNDL)**.

You do not need to believe that a cryptographically relevant quantum computer arrives next year. You only need to believe that:

1. Some messages you send now must stay confidential for a long time, and
2. Your threat model includes a patient adversary with a large archive.

For those messages, classical KEM/key-agreement is the weak link. Symmetric algorithms like `AES-256` and `ChaCha20` are comparatively comfortable against known quantum attacks (with the usual caveats about key sizes and implementation). The urgent migration is on the **asymmetric** side: how secrets are established and how authorship is proven.

NIST’s standardization of **ML-KEM** (Kyber) and **ML-DSA** (Dilithium) is the industry’s official “this is what you should plan around” signal. tholos-pq uses those families on purpose.

---

## Why multi-recipient specifically?

Single-recipient PQ encryption is useful. Multi-recipient PQ encryption is *annoying in a productive way*.

If you encrypt the whole payload separately to each recipient, you pay:

- N times the bulk encryption cost (usually fine), and more importantly
- N times the **large** post-quantum `KEM` ciphertext overhead (not fine if you are careless)

Lattice KEMs have bigger public keys and ciphertexts than `X25519`. Multiplying them carelessly turns “a short notification” into “a small attachment.”

The standard engineering answer is older than post-quantum crypto:

1. Pick a random **content encryption key** (`CEK`).
2. Encrypt the payload **once** under the `CEK` with a symmetric AEAD.
3. For each recipient, use public-key crypto only to convey that `CEK` (or a wrapping key derived from a shared secret).

That is envelope encryption. tholos-pq is envelope encryption with PQ KEMs for the per-recipient wrap, PQ signatures for the sender, and a CBOR wire format you can version and test.

It is **not** a group messaging protocol. It does not do member churn, transcript consistency, or continuous key evolution the way [MLS](https://datatracker.ietf.org/doc/rfc9420/) does. Think “sealed broadcast / fan-out ciphertext,” not “team chat.”

---

## A concrete threat model

It helps to say who is trying to do what.

**Assets**

- Confidentiality of the plaintext against anyone without a recipient private key
- Authenticity of the bundle: recipients should reject ciphertext that was not signed by an allowed sender
- Integrity of header metadata that applications may use for replay tracking (`msg_id`, timestamp)

**Principals**

- **Sender:** holds an ML-DSA-65 signing key; produces the wire blob
- **Recipients:** each hold an ML-KEM-1024 decapsulation key; any one of them can open the payload
- **Application:** maintains the allowlist of sender IDs → public keys (out of band)

**Adversary**

- Can read, store, and modify ciphertext on the wire or at rest
- Can try to forge senders, strip signatures, inject fields, reorder recipients, or transplant envelopes
- May be quantum-capable *in the future* against classical asymmetric schemes (the HNDL case)

**Out of scope (for now—and we mean it)**

- Forward secrecy if a recipient’s long-lived ML-KEM private key leaks
- Automatic replay rejection (IDs are authenticated; policy is yours)
- Anonymous senders, deniability, or traffic analysis resistance
- Being a drop-in replacement for Signal, Age’s full UX, or CMS enterprise ecosystems

Honesty about scope is part of the security story. A crate that claims “post-quantum secure messaging” while shipping long-lived static recipient keys would be lying by omission.

---

## Confidentiality vs authenticity (don’t mix them up)

Multi-recipient encryption answers: *who can read this?*

Signatures answer: *who produced this?*

Those are different questions. Encrypting to Alice does not prove the ciphertext came from the server you trust. Signing without encryption does not hide the payload.

tholos-pq does both:

- **ML-KEM-1024** so each recipient can recover the `CEK`
- **ML-DSA-65** so recipients can check the sender against an allowlist before they trust the plaintext
- **XChaCha20-Poly1305** for the actual bulk encryption (and for wrapping the `CEK`)

The allowlist is deliberate. Cryptography can prove “signed by key K.” Policy decides “key K is allowed to speak as `server1`.” If you decrypt with an empty or attacker-controlled allowlist, you have a key-distribution bug, not an algorithm bug.

---

## Why not “just use hybrid encryption” or “just wait”?

Hybrid classical+PQ constructions are excellent for transport protocols where you want defense in depth during migration. They also add moving parts: two KEMs, transcript binding, size, and failure modes.

tholos-pq currently ships a **pure PQ asymmetric suite** for the envelope and signature layers, with classical-strength symmetric crypto underneath. That is a product choice for a small library with a versioned `suite` string—not a claim that hybrids are wrong. Suites can evolve; the wire format is built to say which suite you are looking at.

Waiting is also a choice. For data with a short half-life, classical crypto may be fine. For archives, compliance logs, sealed documents, and “we might still care in 2040” payloads, waiting is how HNDL wins.

---

## What “success” looks like for this series

By the end of part 3 you should be able to answer:

1. Why multi-recipient envelope encryption is the right shape for PQ fan-out
2. What each algorithm in `Kyber1024+XChaCha20P1305+MlDsa65` is doing
3. Why signing **opaque on-wire bytes** matters more than people expect
4. Which guarantees tholos-pq gives you—and which ones your application must still implement

---

## Try the crate (optional appetizer)

```toml
[dependencies]
tholos-pq = "0.3"
```

```rust
use tholos_pq::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (pub_a, priv_a) = gen_recipient_keypair("alice");
    let (pub_b, priv_b) = gen_recipient_keypair("bob");
    let sender = gen_sender_keypair("server1");
    let allowed = vec![(sender.sid.clone(), sender_pub(&sender).pk_dilithium)];

    let wire = encrypt(b"Hello, post-quantum world!", &sender, &[pub_a, pub_b])?;
    assert_eq!(decrypt(&wire, "alice", &priv_a.sk_kyber, &allowed)?, b"Hello, post-quantum world!");
    assert_eq!(decrypt(&wire, "bob", &priv_b.sk_kyber, &allowed)?, b"Hello, post-quantum world!");
    Ok(())
}
```

One encrypt. Two decrypts. Same ciphertext.

In [part 2](/articles/02-wire-format-and-algorithms/), we open that ciphertext: headers, envelopes, `CEK` wrapping, and why those particular algorithms.

---

*tholos-pq is Apache-2.0. Code and docs: [github.com/thanos/tholos-pq](https://github.com/thanos/tholos-pq) · [crates.io](https://crates.io/crates/tholos-pq) · [docs.rs](https://docs.rs/tholos-pq)*
