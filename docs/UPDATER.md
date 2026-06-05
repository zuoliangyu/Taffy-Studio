# Updater — signing keys, manifest, hosting, rotation

Taffy Studio ships with `tauri-plugin-updater` wired in. Out of the box
the config has **placeholder** values for the signing pubkey and the
manifest URL — they make the build typecheck-pass but the actual update
flow won't work until you complete the steps in this doc.

The whole setup is a one-time procedure. Once done, every `v*.*.*` tag
push triggers a signed release whose installed binaries can auto-update
to the next signed release.

---

## How it works (5-line summary)

1. You hold a **private signing key** locally + as a GitHub secret.
2. `tauri build` in CI signs each updater-eligible bundle, producing a
   `*.sig` sidecar next to the binary.
3. A `latest.json` manifest aggregates `{platform → (url, signature)}`
   and rides along in the GitHub Release assets.
4. Installed clients poll the `endpoint` URL (which redirects to the
   latest release's `latest.json`), verify the bundle signature against
   the **public key baked into the app**, and download if newer.
5. If the signature check fails, the client refuses the update — that's
   what protects users from a malicious server replacing the binary.

---

## Setup — one time

### 1. Generate the keypair

From a checkout of this repo, run **one** of:

```powershell
# Windows
.\scripts\setup-updater.ps1
```

```bash
# macOS / Linux
./scripts/setup-updater.sh
```

The script will:

- Run `pnpm tauri signer generate` and write the keypair to
  `secrets/taffy-updater.key` + `.pub` (gitignored — never committed).
- Patch `src-tauri/tauri.conf.json` so `plugins.updater.pubkey` becomes
  the freshly-minted public key.
- Print the **base64-encoded private key** + **passphrase reminder** for
  you to paste into GitHub repo secrets.

Pick a strong passphrase when prompted. You'll need it once more to
register the GH secret.

### 2. Register the GitHub secrets

In your repo, go to **Settings → Secrets and variables → Actions** and
add two repository secrets:

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the long base64 string the script printed |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase you typed |

`release.yml` pulls these as `env:` for the `tauri build` step. They are
not visible to PR builds — only tag pushes from the same repo.

### 3. Set the manifest endpoint URL

Open `src-tauri/tauri.conf.json` and replace `zuoliangyu/Taffy-Studio` in
`plugins.updater.endpoints[0]` with your real GitHub handle / repo
name. The default points at:

```
https://github.com/zuoliangyu/Taffy-Studio/releases/latest/download/latest.json
```

GitHub redirects `/releases/latest/download/<file>` to the latest
release's asset of that name, so once you push a `v0.1.0` tag the URL
becomes self-updating without any extra hosting.

### 4. Sanity check (optional but recommended)

Before tagging a real release, run the workflow manually:

- GitHub repo → Actions → Release → "Run workflow"

It builds without uploading. If `tauri build` produces `.sig` files in
the `staged/` artifact dump, signing is working.

### 5. Tag a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs the matrix, signs each updater bundle, generates
`latest.json` from the `.sig` files, and uploads everything as draft
release assets. Promote the draft to a published release when ready.

---

## Hosting alternatives

The defaults assume GitHub Releases. If you'd rather host `latest.json`
elsewhere — corporate CDN, S3, your own domain — swap the `endpoint`
URL in `tauri.conf.json`. The format is:

```jsonc
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://your.host/path/latest.json"
      ]
    }
  }
}
```

You're then responsible for getting the manifest there yourself
(e.g. another workflow step that uploads `release/latest.json` to S3
via `aws s3 cp`).

`endpoints` is an array — you can list a CDN URL first and a GitHub
fallback second; the updater tries them in order.

---

## Key rotation

If a private key leaks (or you simply rotate annually):

1. Generate a new keypair:
   ```bash
   ./scripts/setup-updater.sh   # FORCE=1 to overwrite the old key
   ```
2. Update both GitHub secrets to the new private key + passphrase.
3. Commit + push the new `pubkey` in `tauri.conf.json`.
4. Tag a release built with the new key.

Caveat: **existing installations were built with the old pubkey baked
in** and won't trust updates signed by the new key. They'll keep
running but stop auto-updating. There are two paths back:

- **Soft migration**: ship one final update signed with the OLD key
  whose payload bundles the NEW pubkey + a "please reinstall manually"
  notice. Tauri doesn't natively support multi-pubkey trust, so the
  next update after that one is the rotation cliff.
- **Hard cliff**: just tag the new release; users on older builds keep
  the version they have until they download a fresh installer.

For a project with few users, hard cliff is fine. For a real audience,
plan the rotation in advance and document the manual-reinstall path.

---

## Troubleshooting

**Workflow runs but no `.sig` files appear in artifacts.**
The signing secrets aren't set on the repo (or were set on the wrong
repo). Re-check **Settings → Secrets and variables → Actions**. Re-run
the release workflow once both are present.

**`build-updater-manifest.mjs` exits with "no updater-eligible artifacts
found".**
Same cause as above, OR you built with `--bundles deb,dmg` only —
neither produces updater bundles. Make sure the matrix includes at
least one of `appimage` (Linux), `app` (macOS), `nsis` (Windows).

**Client never sees the new release.**
- Endpoint URL points at the wrong owner/repo (open it in a browser:
  it should return JSON, not a GitHub 404 page).
- New release is still in **Draft** state — only Published releases are
  served by `/releases/latest/download/`.
- The installed client's pubkey doesn't match the key that signed
  `latest.json` — it'll silently refuse. Tail
  `~/.config/com.taffy.studio/logs/...` for the verification error.

**`pnpm tauri signer generate` fails on first run.**
Make sure `pnpm install` has been run at least once so `@tauri-apps/cli`
is on disk.

---

## Threat model — what the updater *doesn't* protect against

- **Initial install integrity.** The first download isn't signature-
  checked — only later updates are. Host the v0.1.0 installer over
  HTTPS and consider providing a checksum on the README.
- **Key compromise + a published rogue release.** If someone gets your
  private key AND can push to your repo, they can replace clients in
  the wild. Treat the GH secrets as sensitive; rotate per the procedure
  above if you suspect either.
- **Downgrade attacks.** Tauri's updater always installs whatever
  `latest.json` advertises, even if that version is lower than the
  installed one. Don't intentionally downgrade `latest.json` once
  published.
