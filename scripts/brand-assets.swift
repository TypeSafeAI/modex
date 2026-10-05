// Package the official, unmodified mark for app and web surfaces.
// Run from the repository root: swift scripts/brand-assets.swift
import AppKit
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("docs/branding/modex-mark.png")
guard let reader = CGImageSourceCreateWithURL(source as CFURL, nil),
      let mark = CGImageSourceCreateImageAtIndex(reader, 0, nil) else {
  fatalError("Run from the repository root with docs/branding/modex-mark.png present")
}
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let background = CGColor(srgbRed: 8 / 255, green: 12 / 255, blue: 23 / 255, alpha: 1)
let pink = NSColor(srgbRed: 0.96, green: 0.49, blue: 0.61, alpha: 1)

func canvas(_ width: Int, _ height: Int) -> CGContext {
  // App Store icons must be opaque. Transparency remains in the original mark copies.
  let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
    bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  context.setFillColor(background)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.interpolationQuality = .high
  return context
}
func drawMark(_ context: CGContext, x: CGFloat, y: CGFloat, height: CGFloat) {
  context.draw(mark, in: CGRect(x: x, y: y, width: height * CGFloat(mark.width) / CGFloat(mark.height), height: height))
}
func label(_ context: CGContext, _ text: String, x: CGFloat, y: CGFloat, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .white) {
  let value = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color])
  context.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(CTLineCreateWithAttributedString(value), context)
}
func write(_ context: CGContext, _ path: String) {
  let url = root.appendingPathComponent(path)
  try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  precondition(CGImageDestinationFinalize(destination), "Cannot write \(path)")
  print("wrote \(path)")
}
func copy(_ from: String, _ to: String) {
  let destination = root.appendingPathComponent(to)
  try! FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
  try! Data(contentsOf: root.appendingPathComponent(from)).write(to: destination)
}

let icon = canvas(1024, 1024)
let height: CGFloat = 700
drawMark(icon, x: (1024 - height * CGFloat(mark.width) / CGFloat(mark.height)) / 2, y: (1024 - height) / 2, height: height)
write(icon, "docs/branding/modex-icon.png")
copy("docs/branding/modex-icon.png", "apps/ios/ModexCompanion/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
copy("docs/branding/modex-icon.png", "apps/site/public/assets/modex-icon.png")
for path in ["apps/desktop/src/renderer/assets/modex-mark.png", "apps/ios/ModexCompanion/Resources/Assets.xcassets/ModexMark.imageset/modex-mark.png", "apps/site/public/assets/modex-mark.png"] {
  copy("docs/branding/modex-mark.png", path)
}

for (width, height, name) in [(1800, 600, "modex-header"), (1200, 630, "modex-social-preview")] {
  let context = canvas(width, height)
  let h = CGFloat(height)
  drawMark(context, x: h * 0.15, y: h * 0.2, height: h * 0.6)
  let x = h * 0.76
  label(context, "Modex", x: x, y: h * 0.49, size: h * 0.17, weight: .semibold)
  label(context, "Your agents. Your workspace.", x: x + 2, y: h * 0.36, size: h * 0.043, color: NSColor(white: 0.72, alpha: 1))
  label(context, "modex.build", x: x + 2, y: h * 0.24, size: h * 0.032, weight: .medium, color: pink)
  write(context, "docs/branding/\(name).png")
}
copy("docs/branding/modex-social-preview.png", "apps/site/public/assets/social-preview.png")

let routing = canvas(1600, 720)
drawMark(routing, x: 76, y: 525, height: 115)
label(routing, "One task. The right agent.", x: 210, y: 563, size: 52, weight: .semibold)
label(routing, "Choose a CLI, or let Auto route the next step.", x: 212, y: 511, size: 24, color: NSColor(white: 0.72, alpha: 1))
let columns: [(CGFloat, String, String)] = [(76, "Your task", "A local repository"), (576, "Modex", "Auto routing · optional Jev judge"), (1076, "Claude Code / Codex", "Turns run through their CLIs")]
for (x, title, detail) in columns {
  let rect = CGRect(x: x, y: 224, width: 448, height: 164)
  routing.setFillColor(CGColor(srgbRed: 0.06, green: 0.08, blue: 0.13, alpha: 1))
  routing.addPath(CGPath(roundedRect: rect, cornerWidth: 22, cornerHeight: 22, transform: nil))
  routing.fillPath()
  label(routing, title, x: x + 27, y: 321, size: 29, weight: .semibold, color: pink)
  label(routing, detail, x: x + 27, y: 274, size: 21, color: NSColor(white: 0.75, alpha: 1))
}
for x: CGFloat in [535, 1035] { label(routing, "→", x: x, y: 287, size: 32, color: pink) }
label(routing, "Commands, edits, and approvals stay visible in your thread.", x: 76, y: 123, size: 27)
write(routing, "docs/branding/modex-routing.png")
