# Release tooling

These commands produce reviewable files. The coordinator publishes releases
only after the relevant platform and installer checks pass. None of these
scripts discovers credentials, creates a signing profile, opens an application,
or publishes to GitHub.

`prepare_runtime.py --output-dir /absolute/new/stage-root` copies the declared
public runtime sources and installs production npm files directly from exact
locked archives. It runs no package scripts. `runtime-stage.json` records source
and dependency files; `npm-inputs/` retains the verified archive inputs.

`package_runtime.py --stage /absolute/stage-root/stage --stage-inventory
/absolute/stage-root/runtime-stage.json --npm-inputs /absolute/stage-root/npm-inputs
--version v0.1.0-alpha.1 --os linux --arch x64 --output-dir /absolute/assets`
verifies the entire prepared stage against those inputs, then bundles the
unchanged platform Node24.21.0 executable and complete notices. Darwin arm64,
Linux x64 and Linux arm64 have pinned Node inputs. This runtime requires an
explicit existing Darwin native controller; it does not install an unsigned
controller or bootstrap a desktop application.

`build-native.sh --output-dir /absolute/new/build --jobs 2` regenerates locked
OpenSSL and patched LibVNC inputs and builds the daemon, host app and offline
tests on Darwin arm64. An exported source snapshot needs `--source-revision
<full-commit>`; its actual native source hash is recorded separately. Native
controller linkage is GPL-3.0-or-later. The independent host app is MIT.
`--reuse-inputs /absolute/prior/build` verifies and reuses the prior task-owned
input archives, patches, source trees and read-only native inputs; it preserves
the original receipt and creates a separate result directory. Reuse refuses a
prior build whose receipt or input manifest names a different source lock or
dependency build configuration. `--dependencies-only` builds and verifies just
those inputs under a `fruitctl-native-dependency-build` receipt, which release
tooling does not accept as a tested native build. `--jobs` accepts 1 up to the
host's logical CPU count (2 is always accepted). Each `commands[]` entry records
diagnostic `wallSeconds`. No live VNC or GUI capture test is part of this
command.

Hosted CI caches a dependency-only build keyed on the runner image, Xcode, SDK,
cmake, dependency build configuration, source lock and builder script, then
passes it to `--reuse-inputs`, so every run re-verifies the restored inputs.
Pull requests that change only `docs/`, `skills/`, root Markdown or the docs
workflow keep the native check name but run it as a no-op on Linux.

`package_source.py` requires a passing native receipt, an explicit public
file/hash inventory, exact native output paths and unchanged dependency source.
It includes licenses, build/install scripts, patched LibVNC, OpenSSL, the pinned
Swift Argument Parser and Node source archive. The output links actual binary
hashes to corresponding source. A source package is required alongside any
native binary release; an old release's notarization cannot establish that link.
Receipts in the source package replace local staging paths with portable roots.
`snapshot_source.py --output /absolute/new/inventory.json` records that public
file/hash inventory from a clean Git checkout. `--allow-working-tree` is an
explicit review candidate; its dirty snapshot is never presented as a published
commit. Native source bytes must match the tested build in either case by
default.

For a package selecting only `claude-kvm-daemon`, the explicit option
`--tested-native-source-root /absolute/tested/source` permits a corrected
`FruitctlHost/README.md` in the reviewed public inventory. The complete tested
native source tree must still match the original build receipt, and its README
must also match the original Host bundle resource. Every other native input,
including code, project files, tests and other resources, must match exactly;
missing or extra native files are refused. The option refuses any selected Host
binary. It records both complete native input maps and their hashes in the
archive manifest and package receipt. The archive keeps the corrected public
README under `fruitctl/` and the tested README under
`build-evidence/tested-native-resource-docs/`, with both document hashes and the
excluded owning Host artifact recorded. The tested tree hash and original
receipt remain unchanged. This option grants no new runtime qualification.
The packager pins the initial native receipt bytes and SHA-256 for signing-chain
checks, portable archive evidence and its output receipt; replacing that input
file during packaging cannot substitute an unvalidated build.
Generated `__pycache__` trees are excluded, as in `snapshot_source.py`; they do
not become required source files or archive inputs. Authored release scripts and
license files remain required.
Copied dependency source maps are checked again before archiving, and each
binary descriptor is recorded from its validated observation without a second
read that could substitute another binary identity.
The native input manifest is pinned to its tested hash. Source-lock and
dependency metadata are pinned to the reviewed public inventory, and copied
upstream archives and patches must retain their validated hashes. The package
records the reviewed public inventory and original native manifest hashes.

The Apple rail uses `apple_distribution.py` phases in order:

1. `sign` on PZM requires the exact tested app, build receipt, an explicitly
   supplied Developer ID identity, existing keychain, expected certificate and
   team. `sign-tool` signs a private copy of the tested controller with its
   explicit stable identifier. Existing-keychain access can still prompt macOS
   approval; unattended signing is a separate admission and is not assumed.
   The current narrow app rail
   refuses embedded frameworks/plugins until their signing order is reviewed.
2. `archive` verifies signed bytes and creates a submission ZIP for transfer.
   App bundles retain their parent directory and sequester AppleDouble metadata
   under `__MACOSX`, keeping the app payload equal to the signed file inventory.
   Bare controller archives contain only the executable and omit resource metadata.
3. `notarize` on Neo requires that ZIP, its archive receipt and an existing
   operator-established keychain profile or explicit existing ASC material
   directory. A real Apple `Accepted` response and
   submission ID are required; failed submissions are not retried automatically.
4. `staple` on PZM requires the unchanged signed app and complete receipt chain,
   staples the actual accepted ticket and verifies the final signature.
5. `distribute` on PZM (Host only) archives the stapled app, re-extracts that
   ZIP into a new directory, and runs `stapler validate`, the strict signature
   and designated-requirement readback and `spctl --assess` on the restored
   copy. Its `fruitctl-private-stapled-host-distribution` receipt records the
   ZIP's complete payload and AppleDouble map with the same function
   `write_manifest.py --native-only` uses to check it. A bare controller has no
   staple or distribution phase; its Accepted submission ZIP is the asset.

The source packager accepts a matching staple receipt when signing changed
the app's executable bytes, or `--tool-sign-receipt` for the receipt-bound private
controller copy. The historical pinned signing rail remains intact.
Signing and notarization do not grant privacy permissions or prove capture
exclusion, input mapping, product SLOs or frontend compatibility.

`write_manifest.py` emits `fruitctl-release.json` and `SHA256SUMS` from actual
package receipts. `verify-release.py MANIFEST --assets-dir /absolute/assets`
checks exact canonical URLs, asset hashes, safe tar entries, installer files
and pinned Node bytes/notices. Its result is structural verification. Installer
execution, Linux/Darwin runtime checks and desktop qualification have their own
evidence; the installer fails explicitly when no qualifying release exists.

## Host on the release rail

`FruitctlHost.app` comes out of the same `build-native.sh` build as the
controller, but it ships as its own **native-only** release: one tag carries one
`fruitctl-release.json`, and `bin/fruitctl-host-install.mjs` accepts only a
`mode: native-only` manifest with a `FruitctlHost.app` native asset. Choose an
exact Host tag distinct from the runtime tag (`HOST_TAG` below). Tag it as a
signed annotated tag, as for runtime releases.

Signing, notarization and publication are operator steps. The commands below
are the exact sequence. They do not grant Screen Recording or Accessibility,
launch the Host, or qualify capture exclusion; those remain attended
qualification (see `FruitctlHost/ATTENDED-QUALIFICATION.md` and
`scripts/qualification/overlay_exclusion_gate.mjs`).

Variables, on PZM: `B` is the build root of the release cut. It holds `source/`,
a clean checkout at the cut, and `build/` from `build-native.sh`. `DEP` is a
separate earlier build root whose inputs `build/` reuses. The identity values are
the controller's, read from the reviewed pin:

```sh
B=/absolute/build-root/of/the/cut
DEP=/absolute/other-root/build   # a passing build-native.sh output outside $B
HOST_TAG=<exact-host-tag>
PIN() { /usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["controller"][sys.argv[2]])' "$B/source/nix/native-release.json" "$1"; }
ID=$(PIN certificateSha1); TEAM=$(PIN developerIDTeam)
KC="$HOME/Library/Keychains/login.keychain-db"
AD="$B/source/scripts/release/apple_distribution.py"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin   # distribute runs spctl from /usr/sbin
mkdir -m 700 "$B/host" "$B/host-assets"
```

0. **Build (PZM, SSH).** Build with `--reuse-inputs`. `write_manifest.py
   --native-only` in step 7 requires the build receipt's `dependencyBuildDir`.
   It also requires the source, build and dependency roots to be distinct. A
   build without `--reuse-inputs` records no dependency root, so step 7 refuses
   it. Make `DEP` first with `build-native.sh --output-dir "$DEP" --jobs 2` (or
   `--dependencies-only`) from the same source lock:

   ```sh
   cd "$B/source"
   /usr/bin/python3 -I scripts/release/snapshot_source.py --output "$B/source-inventory.json"
   ./scripts/build-native.sh --reuse-inputs "$DEP" --output-dir "$B/build" --jobs 2
   ```

1. **Private copy (PZM, SSH).** Sign a copy so the tested build output stays
   byte-identical for the source package:

   ```sh
   ditto "$B/build/derived/Build/Products/Release/FruitctlHost.app" "$B/host/FruitctlHost.app"
   ```

2. **Sign (PZM, Aqua `asuser` route, no console keystrokes).** The Developer ID
   key is usable only inside the Aqua bootstrap namespace; a plain SSH
   `codesign` fails with `errSecInternalComponent` or "no identity found". Use a
   host-local `SUDO_ASKPASS` helper that prints PZM's own materialized become
   password; never place the password in argv or the environment.

   ```sh
   SUDO_ASKPASS=/absolute/host-local/askpass sudo -A /bin/launchctl asuser "$(id -u)" \
     sudo -H -u "$(id -un)" /usr/bin/python3 -I -B "$AD" sign \
       --app "$B/host/FruitctlHost.app" --identity "$ID" --team "$TEAM" \
       --existing-keychain "$KC" --certificate-sha1 "$ID" \
       --build-receipt "$B/build/build-receipt.json" --receipt "$B/host-sign-receipt.json"
   ```

3. **Archive (PZM, SSH).**

   ```sh
   /usr/bin/python3 -I -B "$AD" archive --app "$B/host/FruitctlHost.app" \
     --sign-receipt "$B/host-sign-receipt.json" \
     --zip "$B/host-assets/FruitctlHost-submission.zip" --receipt "$B/host-archive-receipt.json"
   ```

4. **Notarize (Neo, one submission).** Relay the ZIP, its archive receipt and
   `apple_distribution.py` to Neo (`scp -3` through the relay seat) and compare
   SHA-256 on every hop. Use the same `--material-dir` route as the controller,
   resolving the sops-nix generation path at run time:

   ```sh
   N=/absolute/notary-dir/on/neo   # holds the three relayed files
   M=$(/usr/bin/python3 -c 'import os;print(os.path.realpath(os.path.expanduser("~/.config/sops-nix/secrets/infrastructure")))')
   /usr/bin/python3 -I -B "$N/apple_distribution.py" notarize --zip "$N/FruitctlHost-submission.zip" \
     --archive-receipt "$N/host-archive-receipt.json" --material-dir "$M" \
     --receipt "$N/host-notarization-receipt.json"
   ```

   On a `--wait` timeout do not resubmit; recover the submission ID read-only
   with `notarytool history`/`info` using the same material. Relay
   `host-notarization-receipt.json` back to `$B` and compare its hash.

5. **Staple and distribute (PZM, SSH).**

   ```sh
   /usr/bin/python3 -I -B "$AD" staple --app "$B/host/FruitctlHost.app" \
     --sign-receipt "$B/host-sign-receipt.json" --archive-receipt "$B/host-archive-receipt.json" \
     --notarization-receipt "$B/host-notarization-receipt.json" --receipt "$B/host-staple-receipt.json"
   /usr/bin/python3 -I -B "$AD" distribute --app "$B/host/FruitctlHost.app" \
     --sign-receipt "$B/host-sign-receipt.json" --archive-receipt "$B/host-archive-receipt.json" \
     --notarization-receipt "$B/host-notarization-receipt.json" --staple-receipt "$B/host-staple-receipt.json" \
     --zip "$B/host-assets/FruitctlHost-stapled-distribution.zip" --extract-dir "$B/host-reextracted" \
     --receipt "$B/host-distribution-receipt.json"
   ```

6. **Corresponding source (PZM, from `$B/source` at the cut).**

   ```sh
   cd "$B/source"
   /usr/bin/python3 -I scripts/release/package_source.py --build-dir "$B/build" \
     --source-inventory "$B/source-inventory.json" \
     --binary "$B/host/FruitctlHost.app/Contents/MacOS/FruitctlHost" \
     --app-sign-receipt "$B/host-sign-receipt.json" --app-archive-receipt "$B/host-archive-receipt.json" \
     --app-notarization-receipt "$B/host-notarization-receipt.json" \
     --app-submission-archive "$B/host-assets/FruitctlHost-submission.zip" \
     --staple-receipt "$B/host-staple-receipt.json" \
     --output "$B/host-assets/fruitctl-$HOST_TAG-host-corresponding-source.tar.gz" \
     --receipt "$B/host-source-receipt.json"
   ```

7. **Native-only manifest and structural verification (PZM).** The input
   contract names every asset (all beside the manifest) and every original
   receipt; `sourceRoot`/`buildRoot` are the original roots replaced by portable
   placeholders in public evidence.

   ```sh
   /usr/bin/python3 -I - "$B" "$HOST_TAG" <<'PY'
   import json, sys
   b, tag = sys.argv[1:]; a = b + "/host-assets/"
   value = {"kind": "fruitctl-native-release-input", "schemaVersion": 1, "component": "FruitctlHost.app",
            "archive": a + "FruitctlHost-stapled-distribution.zip", "submissionArchive": a + "FruitctlHost-submission.zip",
            "sourceArchive": a + "fruitctl-" + tag + "-host-corresponding-source.tar.gz",
            "sourceRoot": b + "/source", "buildRoot": b + "/build"}
   for key, name in (("build", "build/build-receipt.json"), ("source", "host-source-receipt.json"),
                     ("sign", "host-sign-receipt.json"), ("archive", "host-archive-receipt.json"),
                     ("notary", "host-notarization-receipt.json"), ("staple", "host-staple-receipt.json"),
                     ("distribution", "host-distribution-receipt.json")):
       value[key + "Receipt"] = b + "/" + name
   open(b + "/host-native-input.json", "x").write(json.dumps(value, indent=2) + "\n")
   PY
   /usr/bin/python3 -I scripts/release/write_manifest.py --native-only --version "$HOST_TAG" \
     --native-input "$B/host-native-input.json" --output-dir "$B/host-assets"
   /usr/bin/python3 -I scripts/verify-release.py "$B/host-assets/fruitctl-release.json" \
     --assets-dir "$B/host-assets" --native-only
   ```

8. **File-only install check (PZM, before publication).** Install offline into
   a scratch parent, run doctor, then uninstall. It launches nothing. The
   installer requires Node.js 24, so use a Node 24 executable for `node`
   when the login profile provides another version.

   ```sh
   mkdir -m 700 "$B/install-check"
   node bin/fruitctl-host-install.mjs install --version "$HOST_TAG" \
     --app-path "$B/install-check/FruitctlHost.app" \
     --manifest-path "$B/host-assets/fruitctl-release.json" \
     --manifest-sha256 "$(shasum -a 256 "$B/host-assets/fruitctl-release.json" | cut -d' ' -f1)" \
     --evidence-path "$B/host-assets/native-evidence.json" \
     --archive-path "$B/host-assets/FruitctlHost-stapled-distribution.zip"
   node bin/fruitctl-host-install.mjs doctor --app-path "$B/install-check/FruitctlHost.app"
   node bin/fruitctl-host-install.mjs uninstall --app-path "$B/install-check/FruitctlHost.app"
   ```

9. **Publish (operator).** Push only the signed annotated `HOST_TAG` and create
   a prerelease with exactly the files in `$B/host-assets` named by the
   manifest plus `fruitctl-release.json` and `SHA256SUMS`. Re-run
   `verify-release.py --native-only` on an anonymous download of every asset,
   then `fruitctl-host-install install --version "$HOST_TAG"` online on the
   target. The Home Manager `hostHelper.appPath` default
   (`~/Applications/FruitctlHost.app`) is the installer's default path.
