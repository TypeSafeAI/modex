// Renders the macOS app icon from the square branding artwork:
//
//   swift scripts/make-icon.swift ../../docs/branding/modex-icon.png build/icon.icns
//
// The artwork is full-bleed and opaque, so it is placed the way macOS lays out app icons: an
// 824 px rounded-rectangle body centred on a transparent 1024 px canvas, with a soft shadow,
// then rendered at every iconset size and packed with `iconutil`. electron-builder picks up
// build/icon.icns by default, for the app bundle and the DMG volume icon.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("make-icon: \(message)\n".data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: swift make-icon.swift <square source.png> <output.icns>") }
let sourceURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])

guard let src = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let art = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read \(sourceURL.path)") }
guard art.width == art.height, art.width >= 1024 else { fail("source must be square and at least 1024 px, got \(art.width)×\(art.height)") }

let space = CGColorSpace(name: CGColorSpace.sRGB)!
func context(_ size: Int) -> CGContext {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  return ctx
}

// 1024 master: macOS icon grid (body 824 px at a 100 px inset, corner radius 185 px).
let master: CGImage = {
  let ctx = context(1024)
  let body = CGRect(x: 100, y: 100, width: 824, height: 824)
  let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 20, color: CGColor(gray: 0, alpha: 0.3))
  ctx.addPath(shape)
  ctx.setFillColor(CGColor(gray: 0, alpha: 1))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(shape)
  ctx.clip()
  // Trim 6% of the artwork's dark margin so the mark keeps its weight inside the smaller body.
  let trim = Int(Double(art.width) * 0.06)
  let crop = art.cropping(to: CGRect(x: trim, y: trim, width: art.width - 2 * trim, height: art.height - 2 * trim))!
  ctx.draw(crop, in: body)
  ctx.restoreGState()
  // A faint edge keeps the dark body distinct from a dark Dock or desktop.
  ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1, dy: 1), cornerWidth: 184, cornerHeight: 184, transform: nil))
  ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.12))
  ctx.setLineWidth(2)
  ctx.strokePath()
  return ctx.makeImage()!
}()

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("modex-\(UUID().uuidString).iconset")
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }

for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
  let pixels = points * scale
  let ctx = context(pixels)
  ctx.draw(master, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
  let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
  let dest = CGImageDestinationCreateWithURL(iconset.appendingPathComponent(name) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  guard CGImageDestinationFinalize(dest) else { fail("cannot write \(name)") }
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", outputURL.path]
try! iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fail("iconutil exited \(iconutil.terminationStatus)") }
print("wrote \(outputURL.path)")
