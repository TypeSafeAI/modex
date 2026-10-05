# Proposed Modex branding

Four branding assets offered for maintainer review. The artwork was AI-generated, and the header was subsequently refined in Photoshop and exported as WebP.

| File                       | Intended use                | Dimensions  |
| -------------------------- | --------------------------- | ----------- |
| `modex-header.webp`        | README header               | 1764 × 550  |
| `modex-icon.png`           | App icon artwork            | 1254 × 1254 |
| `modex-social-preview.png` | Social preview concept      | 1774 × 887  |
| `modex-routing.png`        | README routing illustration | 1774 × 887  |

The icon, social preview, and routing illustration have opaque backgrounds. The WebP header supports transparency. These are raster assets, not vector masters.

From v0.0.5, `modex-icon.png` is the app icon. `apps/desktop/scripts/make-icon.swift` places it on the macOS icon grid and writes `apps/desktop/build/icon.icns`. Re-run it after changing the artwork:

```sh
cd apps/desktop && swift scripts/make-icon.swift ../../docs/branding/modex-icon.png build/icon.icns
```

## Header

![Modex header](modex-header.webp)

## Icon

<img src="modex-icon.png" alt="Modex icon" width="256">

## Social preview

![Modex social preview](modex-social-preview.png)

## Routing illustration

![Modex routing illustration](modex-routing.png)
