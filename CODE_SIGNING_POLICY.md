# Code Signing Policy

Cerberus Local Runner's Windows release builds are code-signed using a certificate provided free
of charge to this open source project by the [SignPath Foundation](https://signpath.org/),
through the [SignPath.io](https://signpath.io/) platform. This page documents the governance
SignPath requires from open source projects it signs for.

## Team and roles

Two people work on this project, both at Cerberus Testing:

| Role | People | Responsibility |
|---|---|---|
| **Authors** | Benoit Civel (bcivel@cerberus-testing.com), Benoit Dumont (bdumont@cerberus-testing.com) | Trusted to author and merge changes to this repository's source code. |
| **Reviewers** | Benoit Civel, Benoit Dumont | Review any contribution before merge - in particular anything not authored by one of the two Authors above. |
| **Approvers** | Benoit Civel (primary - handles most releases), Benoit Dumont (backup) | Authorize each individual signing request in the SignPath dashboard before a release build is signed. |

Both Authors/Reviewers/Approvers have multi-factor authentication enabled on their GitHub account
and on SignPath.

## What gets signed

Only release artifacts built by this project's own CI (`.github/workflows/release.yml`) from this
repository's own source code are ever submitted for signing. Vendored third-party binaries
(Selenium, the Cerberus Robot Extension/Proxy, cloudflared, the bundled JRE - see
[ARCHITECTURE.md](ARCHITECTURE.md)) are never re-signed under this certificate; they keep
whatever signature/license their own publisher provides.

## Privacy

The signing pipeline only processes what's required to build and sign a release: this
repository's source code and the resulting build artifacts. No end-user data collected by the
running application (see the "Important security limitation" section of
[README.md](README.md)) is ever sent to SignPath. See SignPath's own
[terms](https://signpath.org/terms.html) for how they handle data on their side.

## Credits

Free code signing for this project is provided by:

- [SignPath.io](https://signpath.io) - the signing platform.
- [SignPath Foundation](https://signpath.org) - the certificate authority backing free
  certificates for eligible open source projects.