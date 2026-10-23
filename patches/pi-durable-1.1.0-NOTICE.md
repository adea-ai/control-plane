# Pi Durable 1.1.0 compatibility patch attribution

This repository carries an additive compatibility patch to
`@earendil-works/pi-durable@1.1.0`. It is a local downstream patch, not an upstream
release. The package version and original registry integrity remain pinned; Bun's
root `patchedDependencies` registration identifies the downstream changes.

## Upstream provenance

- Project: [Earendil Works Pi](https://github.com/earendil-works/pi), package
  `packages/durable`.
- Release: `v1.1.0`.
- Source commit: `abe508e1b89912adde45528136c3221eb69acdd7`.
- Registry tarball:
  <https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.1.0.tgz>.
- Original tarball integrity:
  `sha512-NtuB3RY24vQ+0/rWYpeHupyFWBfXuKq17to3VMYUYqfD/uuGnz6F6UTPBEm51VSxxA6LZwRcDwLX2LtRehnIgQ==`.
- npm provenance identifies the release commit through the upstream
  `.github/workflows/build-binaries.yml` workflow, run
  <https://github.com/earendil-works/pi/actions/runs/37690337028/attempts/2>.

The downloaded original tarball matched that integrity. Its compiled JavaScript
source maps embed 67 TypeScript sources, each compared byte for byte with the
release commit. The tarball contains compiled JavaScript, declarations and source
maps, but no standalone TypeScript sources or LICENSE file. This notice preserves
the license from the exact upstream release commit.

## Debug metadata

The compatibility patch changes five existing JavaScript files and eight
TypeScript declaration files, and adds a JavaScript helper. Source-map reference
comments are removed only from the changed JavaScript and declaration files:
the original upstream maps do not describe the additive API. All upstream map
files remain present and unchanged; this patch does not claim to regenerate them.

## Qualification limits

An additive SDK compatibility surface does not qualify production cancellation,
complete writer registration or independent restore-generation authority. Native
transaction behavior, all-writer closure and independent generation fencing must
be established by their respective tests and authority implementations. Existing
fail-closed defaults and production qualification gates remain in force. This
notice does not claim upstream endorsement or a published upstream capability.

## Upstream license

The following license is reproduced verbatim from
[`LICENSE` at the release commit](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/LICENSE).
Retain this copyright and permission notice when distributing copies or
substantial portions of the upstream software, including this compatibility patch.

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
