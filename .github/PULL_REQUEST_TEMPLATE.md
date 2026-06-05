## What & why

<!-- What does this change, and why? Link issues with "Closes #123". -->

## Checklist

- [ ] `tsc -b` passes (TypeScript strict mode)
- [ ] `cargo fmt --all` run, and `cargo clippy --all-targets -- -D warnings` is clean
- [ ] Ran `ci-local` locally (`scripts/tasks/ci-local.ps1` / `.sh`)
- [ ] JS → Rust calls go through `src/lib/ipc.ts` (no inline `invoke()` in components)
- [ ] Business logic lives in `crates/taffy-core` (no `tauri::` / `axum::` types there)
- [ ] Updated README / docs if behaviour, commands, or config changed

## Notes

<!-- Screenshots, platforms tested (Windows / macOS / Linux / iOS / Android / Web),
     follow-ups, or anything a reviewer should know. -->
