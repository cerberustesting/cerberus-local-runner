# Code Signing Policy

Cerberus Local Runner is the official desktop companion of
[Cerberus](https://github.com/cerberustesting/cerberus-core), the open source test automation
platform (GPL-3.0). This repository is MIT-licensed and is a component of the Cerberus project.

Its Windows release builds are code-signed using a certificate provided free of charge to the
Cerberus open source project by the [SignPath Foundation](https://signpath.org/), through the
[SignPath.io](https://signpath.io/) platform. This page documents the governance SignPath
requires from open source projects it signs for.

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

Only the Windows installer built by this repository's own CI (`.github/workflows/release.yml`)
from this repository's own source code is ever submitted to SignPath for signing. Nothing built
from any other Cerberus repository is signed under this project. Vendored third-party binaries
(Selenium, the Cerberus Robot Extension/Proxy, cloudflared, the bundled JRE - see
[ARCHITECTURE.md](ARCHITECTURE.md)) are never re-signed under the SignPath certificate; they
keep whatever signature/license their own publisher provides.

The macOS builds are not part of this policy: they are signed and notarized with the
maintainers' own Apple Developer ID certificate, not through SignPath.

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