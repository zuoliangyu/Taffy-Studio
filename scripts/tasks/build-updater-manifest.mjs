#!/usr/bin/env node
// Walk a directory of release artifacts, find the updater-eligible bundles
// (the ones tauri emitted with a matching .sig sidecar), and write out a
// Tauri-compatible `latest.json` manifest.
//
// Called from .github/workflows/release.yml after `softprops/action-gh-release`
// downloads all the matrix artifacts into a single folder.
//
// Usage:
//   node scripts/tasks/build-updater-manifest.mjs \
//        --in  artifacts \
//        --out latest.json \
//        --version 0.1.0 \
//        --repo myhandle/taffy-studio
//
// Output shape (https://v2.tauri.app/plugin/updater/):
//   {
//     "version": "0.1.0",
//     "pub_date": "2026-05-27T12:34:56Z",
//     "notes": "See the GitHub Release for details.",
//     "platforms": {
//       "darwin-aarch64": { "signature": "...", "url": "https://..." },
//       "darwin-x86_64":  { "signature": "...", "url": "https://..." },
//       "linux-x86_64":   { "signature": "...", "url": "https://..." },
//       "windows-x86_64": { "signature": "...", "url": "https://..." }
//     }
//   }
//
// Files that don't have a `.sig` sibling are skipped (only updater-eligible
// bundles produce sigs — .deb / .msi / .dmg don't and would be ignored here
// even if present).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

// --- arg parsing (tiny; avoid pulling a dep just for this) -------------

function getArg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || i === process.argv.length - 1) {
    if (required) {
      console.error(`error: missing required --${name}`)
      process.exit(2)
    }
    return undefined
  }
  return process.argv[i + 1]
}

const inDir   = getArg('in')
const outFile = getArg('out')
const version = getArg('version')
const repo    = getArg('repo') // "owner/name"
const notes   = getArg('notes', false) || `Release ${version}. See the GitHub Release page for changes.`

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  console.error(`error: --repo must look like "owner/name", got: ${repo}`)
  process.exit(2)
}

// --- platform mapping ---------------------------------------------------
//
// We match by filename suffix + arch hint. Tauri's bundlers emit a known
// set of names per target:
//   macOS app:   *_${arch}.app.tar.gz  (aarch64 | x64 | universal)
//   Linux:       *_${arch}.AppImage    (amd64)  -> linux-x86_64
//                *_${arch}.AppImage.tar.gz       (some templates wrap it)
//   Windows:     *_${arch}-setup.exe   (NSIS)   -> windows-x86_64
//                *_${arch}-setup.nsis.zip       (zipped NSIS for updater)
//
// Tauri updater accepts the .nsis.zip on Windows, the .app.tar.gz on macOS,
// and the .AppImage.tar.gz (or .AppImage) on Linux. Anything else here is
// noise we ignore.

function classify(filename) {
  const f = filename.toLowerCase()
  // macOS .app.tar.gz
  if (f.endsWith('.app.tar.gz')) {
    if (f.includes('aarch64') || f.includes('arm64')) return 'darwin-aarch64'
    if (f.includes('universal'))                       return 'darwin-universal'
    if (f.includes('x86_64')   || f.includes('x64'))   return 'darwin-x86_64'
    return null
  }
  // Linux AppImage (with or without tar.gz wrapping)
  if (f.endsWith('.appimage') || f.endsWith('.appimage.tar.gz')) {
    if (f.includes('aarch64')) return 'linux-aarch64'
    return 'linux-x86_64' // amd64 default
  }
  // Windows updater bundle
  if (f.endsWith('-setup.nsis.zip') || f.endsWith('.nsis.zip')) {
    if (f.includes('arm64') || f.includes('aarch64')) return 'windows-aarch64'
    return 'windows-x86_64'
  }
  return null
}

// --- scan -------------------------------------------------------------

if (!statSync(inDir).isDirectory()) {
  console.error(`error: --in must be a directory: ${inDir}`)
  process.exit(2)
}

const entries = readdirSync(inDir)
const sigSet  = new Set(entries.filter((n) => n.endsWith('.sig')))
const platforms = {}

for (const name of entries) {
  if (name.endsWith('.sig')) continue
  const platform = classify(name)
  if (!platform) continue
  const sigName = `${name}.sig`
  if (!sigSet.has(sigName)) {
    console.warn(`warn: ${name} -> ${platform} but no ${sigName} alongside; skipped`)
    continue
  }
  const signature = readFileSync(join(inDir, sigName), 'utf8').trim()
  // Stable download URL for the artifact attached to the GH Release.
  const url = `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`
  if (platforms[platform]) {
    console.warn(`warn: duplicate artifact for ${platform}: keeping ${platforms[platform].url}, ignoring ${url}`)
    continue
  }
  platforms[platform] = { signature, url }
}

const platformCount = Object.keys(platforms).length
if (platformCount === 0) {
  console.error('error: no updater-eligible artifacts found. Did `tauri build` actually sign anything?')
  process.exit(1)
}

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  notes,
  platforms,
}

writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote ${outFile} (${platformCount} platforms: ${Object.keys(platforms).sort().join(', ')})`)
