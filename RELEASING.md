# Releasing Laci

Laci is released for Linux x86-64 from a tag. Pushing a tag `v<version>` starts [the Release workflow](.github/workflows/release.yml). It checks the tag and builds and tests the packages. After rifkii approves the `release` environment, it signs the AppImage for the updater. It ends with a **draft** release that holds every asset and an attestation for each one. Nothing is public until rifkii publishes the draft. Releases in this repository are immutable once published: a published release, its assets and its tag can't change, and a mistake needs a new version.

## What a release holds

| Asset | What it is |
| --- | --- |
| `laci_<version>_amd64.AppImage` | The app in one file. It can update itself from inside Laci. |
| `laci_<version>_amd64.AppImage.sig` | The updater's signature of the AppImage, made with the key in the `release` environment. |
| `laci_<version>_amd64.deb` | For Debian, Ubuntu and Mint, installed with `apt install ./<file>`. A new version is downloaded from the release page and installed the same way; Laci only links to it. |
| `laci-<version>-1.x86_64.rpm` | For Fedora, installed with `dnf install ./<file>`. Its dependencies have Fedora's names, so it is not for openSUSE. A new version is downloaded from the release page and installed the same way; Laci only links to it. |
| `latest.json` | The updater feed: the version, the notes and the AppImage's address and signature. |
| `provenance.json` | Where the packages come from: the commit, the tag, the run, the build's runner and glibc floor, the checks that passed and each file's SHA-256. |
| `SHA256SUMS` | The SHA-256 of every other asset, for `sha256sum -c`. |

The packages are built on Ubuntu 22.04. They need glibc 2.35 or newer: Ubuntu 22.04, Mint 21, Debian 12 or later. Each run's summary names the exact glibc floor, and `provenance.json` records it.

## How the workflow runs

1. **verify** refuses the release unless all of these hold:
   - The tag is `v` followed by the version, and that version is in `Cargo.toml`, `Cargo.lock`, `package.json` and `ui/package.json`.
   - The tagged commit is on `main` or on a `release/*` branch.
   - `CHANGELOG.md` has the notes. A final version `X.Y.Z` needs `## [X.Y.Z] - YYYY-MM-DD`. A pre-release `X.Y.Z-rc.N` takes `## [X.Y.Z]` if there is one, and otherwise `## [Unreleased]`.
   - `THIRD_PARTY_NOTICES.md` is current (`node scripts/notices.mjs --check`).
2. **build** runs `pnpm build` on Ubuntu 22.04 and reports the glibc floor. It checks that the WebDriver server is not in the build, runs `scripts/package-smoke.mjs` and uploads the packages. Only then does it install `tauri-driver` (an exact version from crates.io, the one tool outside the lockfiles) and run the packaged AppImage's native regression, as `check.yml` does, so nothing installed for testing can change the files that get signed. Release runs use no caches.
3. **install** installs the deb with apt on Ubuntu 22.04 and the rpm with dnf on Fedora, with the dependencies they name, and runs `laci --version` from each.
4. **sign** waits for rifkii's approval of the `release` environment. Only this job can read the updater key. It installs the Tauri CLI from the lockfile without running any package's scripts, then runs `tauri signer sign --app-version <version>` on the AppImage. Then it checks the signature against the public key in `src-tauri/tauri.conf.json`, the key every installed Laci uses to check updates.
5. **finalize** writes `latest.json` and reads it the way the updater does. Every download it names must be among the assets, and its signature must verify under the app's key for the announced version. Then it writes `provenance.json` and `SHA256SUMS` and runs `sha256sum -c`.
6. **attest** makes a build provenance attestation for every asset.
7. **draft** creates the draft release, titled `Laci <version>`, with the CHANGELOG section as its notes. A version with a `-` is marked as a pre-release.

`bundle.createUpdaterArtifacts` stays off: `tauri.conf.json` doesn't turn it on, and the build doesn't either. With it on, the whole build would need the key, which means every crate's build script and every npm package would run next to it. Signing afterwards in a small job of its own gives the same signature: the same CLI, with the version in the signed comment, which is what `requireSignedVersion` checks.

### The dry run

A manual run on any branch is a dry run, and so is the run of a pull request that changes `release.yml` or `scripts/release/`:

```sh
gh workflow run release.yml --ref <branch>
gh workflow run release.yml --ref <branch> -f version=3.0.0-rc.1   # build as that version, to try its names
```

It runs the same checks, build and tests. It signs with a throwaway key that it makes in the job and never stores, then makes and checks `latest.json` with that key. It runs `sha256sum -c SHA256SUMS` and keeps the would-be release as the artifact `laci-release-<version>` (the `assets/` folder and `notes.md`). It has no environment, no attestations and no release. A commit on a branch other than `main` or `release/*` only gets a warning. Download the result with `gh run download <run id> -n laci-release-<version>`.

## Cut a release

The example is `3.0.0-rc.1`. For a final version, use `3.0.0`.

1. **Bump the version** on a branch from `main`:

   ```sh
   git switch -c release-3.0.0-rc.1 main
   node scripts/release/version.mjs set 3.0.0-rc.1   # Cargo.toml, Cargo.lock, package.json, ui/package.json
   node scripts/release/version.mjs                  # prints the version, or names a file that differs
   ```

2. **Write the CHANGELOG.** A release candidate can keep its notes under `## [Unreleased]`, or under `## [3.0.0]` without a date. A final version needs the date it is published: `## [3.0.0] - 2026-10-30`. Preview what the release gets:

   ```sh
   node scripts/release/notes.mjs 3.0.0-rc.1
   ```

   For a final version, also check the README's Status line, which names the latest release while release candidates are out.

3. **Check the notices** if the lockfiles changed since the last release: `node scripts/notices.mjs --check`, or `pnpm notices` to write them again.

4. **Open a pull request** with `Cargo.toml`, `Cargo.lock`, `package.json`, `ui/package.json`, `CHANGELOG.md` and any notices. Wait for CI. Optionally, run a dry run on the branch (`gh workflow run release.yml --ref release-3.0.0-rc.1`). Then merge it.

5. **Tag `main`** at that merge, and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a v3.0.0-rc.1 -m "Laci 3.0.0-rc.1"
   git push origin v3.0.0-rc.1
   ```

6. **Approve the environment.** Follow the run with `gh run watch`, or under Actions → Release. The checks and the build take about ten minutes. Then the sign job waits for **Review deployments → release → Approve and deploy**. Reject it if anything in the run looks wrong.

7. **Check the draft.**
   - Run `gh release view v3.0.0-rc.1`. It should be a draft holding 7 assets, and a pre-release if the version has a `-`.
   - Download the assets and verify them as in [Verify a download](#verify-a-download).
   - Start the AppImage once.

8. **Publish** under Releases → the draft → Edit → Publish release:
   - A release candidate stays a pre-release, and is never the latest release.
   - A final version on the newest line (from `main`) is published with "Set as the latest release" checked. From then on every installed final Laci finds it.
   - A final version from an older line's `release/*` branch, such as a 2.5.x fix after 3.0.0, is published with "Set as the latest release" **unchecked**. Checked, it would take over `releases/latest`, and every newer Laci would read its feed (or none), find nothing newer and say nothing. If it happens anyway, mark the newest release as the latest again: `gh release edit v<newest> --latest`.

   Once published, the release can't change.

### When something fails

- **A check, the build or a test fails before the draft:** no release exists yet.
  1. Fix it on `main` through a pull request.
  2. Delete the tag (`git push --delete origin v3.0.0-rc.1 && git tag -d v3.0.0-rc.1`).
  3. Tag the fixed commit.

  A failure that wasn't caused by the code, such as a runner problem, needs only `gh run rerun <run id> --failed`.
- **A draft for the tag already exists** (from an earlier run): the draft job refuses to overwrite it. Delete the draft, then run the failed jobs again.
- **Something is wrong after publishing:** the release is immutable. Release a new version with the fix, and say in its notes what was wrong.

## Release candidates and the update test

Every release, final or candidate, carries a `latest.json` for its own assets. Installed copies read one feed: `https://github.com/mrramdn/laci/releases/latest/download/latest.json`. GitHub's "latest" release is the newest published release that is neither a draft nor a pre-release. As a result:

- **A final version only ever sees final versions.** Release candidates are pre-releases, so `latest` never points at one. Laci also refuses a pre-release on a final version, whatever a feed says (`src-tauri/src/app/update.rs`). This guards against a release candidate marked as the latest release by mistake.
- **A release candidate is offered the final version that follows it** (3.0.0 is newer than 3.0.0-rc.2). Before the first final version with a feed, `latest` is 2.5.2, which has no `latest.json`. That feed answers 404, and Laci says nothing.
- **The latest release is the newest line's.** A fix for an older line, published from a `release/*` branch, must not be marked as the latest (step 8). Installed copies would read its feed, which is older or missing, so none would be offered an update until the newest release is marked as the latest again, and nothing would show an error.
- **The deb and rpm of a release candidate rank above the final version.** Tauri writes the version as it is, and both dpkg and rpm sort `3.0.0-rc.2` after `3.0.0` (dpkg reads `rc.2` as a Debian revision; rpm counts it as more segments). To both, installing 3.0.0 over a candidate is a downgrade: apt asks first (and `apt-get install -y` refuses it without `--allow-downgrades`), and dnf lists it under Downgrading. Testers of a deb or rpm candidate remove it first (`sudo apt remove laci` or `sudo dnf remove laci`; settings and data stay), then install the final version. A release candidate's notes say so. Candidates among themselves (rc.1 to rc.2) and the AppImage are not affected.
- **A release candidate is not offered the next candidate by itself.** A tester points it at the next candidate's feed with `LACI_UPDATE_ENDPOINT`, which must be an https address. Everything after that is the real update path:
  1. The feed is read the same way.
  2. The AppImage is downloaded from the release.
  3. The signature is checked against the key built into the app, along with the signed version.
  4. The AppImage is replaced and Laci restarts.

  Only the address of the feed differs.

The tradeoff: a release-candidate channel that updates by itself would need a feed that changes, such as a release that is replaced or a page hosted elsewhere. Releases here are immutable, and a second host would be one more thing to trust and keep running. A tester typing one variable costs less.

### The update test (rc.1 to rc.2)

1. Publish `v3.0.0-rc.1` as above. Download `laci_3.0.0-rc.1_amd64.AppImage`, make it executable, and start it once from where it will stay, such as `~/Applications`.
2. Cut and publish `v3.0.0-rc.2` the same way. It must be published, as a pre-release: a draft's files can't be downloaded.
3. Quit every running Laci: a second start only brings the running one to the front, without the variable. Then start rc.1 with rc.2's feed:

   ```sh
   LACI_UPDATE_ENDPOINT=https://github.com/mrramdn/laci/releases/download/v3.0.0-rc.2/latest.json \
     ~/Applications/laci_3.0.0-rc.1_amd64.AppImage
   ```

4. In Settings → Updates (Simple) or Settings → About & updates (Detailed), choose **Check now**. In Detailed, <kbd>Ctrl</kbd> <kbd>K</kbd> → *Check for updates* does the same. Laci should offer version 3.0.0-rc.2 with its notes and date. Choose **Install**, then **Restart**.
5. Check that the update took. The AppImage file keeps its name, but `~/Applications/laci_3.0.0-rc.1_amd64.AppImage --version` now prints `laci 3.0.0-rc.2`.
6. The refusals:
   - rc.2 started with rc.1's feed offers nothing, because it is older.
   - rc.2 started without the variable offers nothing.
   - An installed deb or rpm of rc.1, given rc.2's feed, shows a link to the release page instead of Install. (Going from a candidate's deb or rpm to the final version needs the candidate removed first; see above.)

## Verify a download

Put the files you downloaded in one folder with `SHA256SUMS` from the same release:

```sh
gh release download v3.0.0 -R mrramdn/laci     # every asset; or download them from the release page
sha256sum -c SHA256SUMS --ignore-missing      # each file you have must say OK
```

Published releases are immutable, and GitHub attests the release itself. This is the check that a file is the one that was released:

```sh
gh release verify v3.0.0 -R mrramdn/laci                                       # the release and its assets
gh release verify-asset v3.0.0 laci_3.0.0_amd64.AppImage -R mrramdn/laci       # this file is one of them
```

Each asset also has a build provenance attestation, made by the Release workflow before the draft. Check that it was made by `release.yml` for the tag, not by another workflow or branch of the repository:

```sh
gh attestation verify laci_3.0.0_amd64.AppImage -R mrramdn/laci \
  --signer-workflow mrramdn/laci/.github/workflows/release.yml --source-ref refs/tags/v3.0.0
```

It proves where a file was built, not that it was published: a run whose draft was rejected, or whose tag was deleted and pushed again, leaves attestations under the same tag name. `provenance.json` names the commit; `--source-digest <commit>` pins that too.

The updater signature can be checked from a checkout of this repository:

```sh
node scripts/release/minisign.mjs laci_3.0.0_amd64.AppImage laci_3.0.0_amd64.AppImage.sig 3.0.0
```

**What the updater checks** before an AppImage replaces itself:

1. It reads the feed over HTTPS from GitHub, and only from `github.com/mrramdn/laci` unless `LACI_UPDATE_ENDPOINT` names another https address.
2. It takes only a newer version, and a pre-release only when the running copy is one.
3. It downloads the AppImage the feed names.
4. It checks the minisign signature of the downloaded bytes and of the signed comment. The check uses the public key built into Laci (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, key id `235A76CE57614C5F`).
5. With `requireSignedVersion`, the version in the signed comment must equal the version the feed announces. This stops someone who controls a feed from pairing an older signed AppImage with a newer version number.
6. Only then does it replace the AppImage. Laci restarts into it when you choose Restart.

A deb, an rpm or a copy put in place by hand is never replaced by Laci. It shows a link to the release page.

## The updater key

The private half of the updater key is the minisign key every update must be signed with. It is kept in two places:

- in the GitHub environment `release`, as the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Only the sign job of a `v*` tag can read them, after rifkii approves;
- with rifkii, in `~/.key/laci/` and an offline backup.

The public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, which is built into every Laci.

### If the key leaks

Someone holding the key, and able to serve a feed that installed copies read, could ship them an update. The feed is this repository's releases on GitHub, so that also needs write access to the repository or a broken HTTPS connection. Act anyway:

1. **Stop signing with it.** Remove both secrets from the `release` environment, and reject any waiting sign job.
2. **Make a new key** on rifkii's computer, with a new password. Keep it in `~/.key/laci/` (mode 600), add a line to `~/.key/index.tsv`, and make an offline backup:

   ```sh
   pnpm tauri signer generate -w ~/.key/laci/updater-<date>.key
   ```

3. **Put the new public key** (the `.key.pub` file's content) into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` through a pull request.
4. **Store the new private key and password** as the environment's secrets, from the files: `gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/.key/laci/updater-<date>.key`, and the password the same way.
5. **Release a new version.** It is signed with the new key, which the copies already installed don't trust: their in-app update fails with a signature error. Their users have to download this version by hand, once. Say so in the release notes and in a security advisory, and name the versions whose updater trusted the leaked key.

There is deliberately no release signed with the old key that carries the new one. It would ask every copy to trust the leaked key one more time.

### If the key is lost

The copies already installed can never be updated in the app again: only the lost key could sign an update they accept. Make a new key and release with it as in steps 2–5 above, without the advisory. Say in the notes that this version has to be downloaded by hand. To keep it from happening, keep the key and its password in two places offline as well as in the environment.
