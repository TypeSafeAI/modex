# Official Modex branding

`modex-mark.png` is the official logo supplied by Val on 2026-10-05. This transparent
447 × 565 PNG is preserved byte-for-byte. Keep its pink color, aspect ratio, and clear
space in both Jev and OpenCoven themes. Do not substitute the old diamond, stack symbol,
or generated logo concepts. A higher-resolution or vector master can replace the source
when supplied; the current platform icons necessarily scale up this raster.

## Generate platform assets

From the repository root on macOS:

```sh
swift scripts/brand-assets.swift
(cd apps/desktop && swift scripts/make-icon.swift ../../docs/branding/modex-icon.png build/icon.icns)
```

The first script copies the original mark into desktop, iOS, and website assets. It packages
it on an opaque near-black blue background (`#080c17`) for iOS and web icons, and produces
the README and social artwork. It does not redraw, recolor, stretch, or crop the mark.
The second script adds the macOS rounded body, transparent surround and shadow, then
packs every required icon size. App and DMG volume icons use the same `.icns` file.

| File | Use | Dimensions |
| --- | --- | --- |
| `modex-mark.png` | Canonical transparent logo | 447 × 565 |
| `modex-icon.png` | iOS App Store and website icon | 1024 × 1024, opaque |
| `modex-header.png` | README header | 1800 × 600 |
| `modex-social-preview.png` | Website social preview | 1200 × 630 |
| `modex-routing.png` | README routing illustration | 1600 × 720 |

The desktop sidebar, welcome and new-chat screens use the transparent mark. The companion
uses it on onboarding and its workspace header, with the opaque tile as its home-screen
icon. Website navigation and footer use the transparent mark; its favicon, touch icon,
social preview, and captured product screens share the same identity.

<img src="modex-mark.png" alt="Official Modex mark" width="112">

![Modex social preview](modex-social-preview.png)
