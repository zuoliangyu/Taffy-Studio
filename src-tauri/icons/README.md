# Icons

Tauri expects these files for desktop bundling:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

Generate them once you have a 1024×1024 master PNG:

```bash
pnpm tauri icon path/to/master-1024.png
```

This command writes all required platform icon variants (including Android
mipmaps and iOS AppIcon contents) into the right directories.
