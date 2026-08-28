# Release signing keys

This directory holds the public half of the GPG key that signs release
tags. The publish pipeline imports
`release-tag-signing.asc` and fails closed unless the pushed tag carries a
valid signature from it.

Setup instructions live in
[docs/releasing.md](../../docs/releasing.md), section *One-time signing
setup*.
