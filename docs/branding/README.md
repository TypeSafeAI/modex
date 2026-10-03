# Proposed Modex branding

Four AI-generated branding assets offered for maintainer review. These are the original PNG exports; adoption and any further refinements are up to the maintainers.

| File | Intended use | Original dimensions |
| --- | --- | --- |
| `modex-header.png` | README header | 2172 × 724 |
| `modex-icon.png` | Square app/repo icon concept | 1254 × 1254 |
| `modex-social-preview.png` | Social preview concept | 1774 × 887 |
| `modex-routing.png` | README routing illustration | 1774 × 887 |

The icon, social preview, and routing illustration have opaque backgrounds. The header is an RGBA PNG. These are raster concepts, not vector masters or packaged platform icons.

From v0.0.5, `modex-icon.png` is the app icon. `apps/desktop/scripts/make-icon.swift` places it on the macOS icon grid and writes `apps/desktop/build/icon.icns`. Re-run it after changing the artwork:

```sh
cd apps/desktop && swift scripts/make-icon.swift ../../docs/branding/modex-icon.png build/icon.icns
```

## Header

![Modex header](modex-header.png)

## Icon

<img src="modex-icon.png" alt="Modex icon" width="256">

## Social preview

![Modex social preview](modex-social-preview.png)

## Routing illustration

![Modex routing illustration](modex-routing.png)
