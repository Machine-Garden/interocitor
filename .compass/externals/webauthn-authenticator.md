# WebAuthn authenticator

## What it is

A passkey provider or security key the person possesses — a platform
authenticator behind a biometric, a roaming key, or a password manager acting as
one. It holds origin-scoped credentials and, where supported, a small blob bound
to a credential.

## Good at

Requiring a deliberate human gesture before a secret becomes usable, and keeping
that secret out of ordinary browser storage.

## Bad at

Portability and bulk. `largeBlob` support is uneven across authenticators, blobs
are small, and a credential is bound to one origin.

## How it breaks

The user cancels the prompt, or the platform shows none. `largeBlob` is
unavailable on an authenticator that otherwise registers fine. A lost
authenticator is unrecoverable by design — that is what the
[recovery](../interocitor/trust/recovery/README.md) path exists for.

## How you talk to it

The WebAuthn browser API, behind the credential and secret stores in
[credential-custody](../interocitor/trust/credential-custody/README.md).

## Their chart

—
