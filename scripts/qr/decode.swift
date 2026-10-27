// Optional local QR decoder for the Phase 6 image-decode suite.
//
// `src/tests/integration/phase6.qr-decode.integration.test.ts` proves that a QR image rendered by
// the app's own encoder can be read back by an INDEPENDENT decoder and that the decoded value is
// what the server accepts. No decoder is bundled with the project, so the test takes one from the
// machine running it:
//
//   GM_QR_DECODER='swift scripts/qr/decode.swift' \
//   GM_IT_SQL_DRIVER=supabase npx vitest run src/tests/integration/phase6.qr-decode.integration.test.ts
//
// This script uses Apple's Vision framework (macOS only), which is a genuine, third-party
// implementation of QR decoding, not a re-encoding of the expected value. Any other "cmd <png>"
// decoder works too, e.g. `zbarimg -q --raw`. Where no decoder is available the image assertions
// are reported as skipped rather than passed.
//
// Usage: swift scripts/qr/decode.swift <image.png>   -> prints one payload per detected QR code
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write("usage: swift decode.swift <image.png>\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image\n".data(using: .utf8)!)
  exit(3)
}
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
do {
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
  FileHandle.standardError.write("vision error: \(error)\n".data(using: .utf8)!)
  exit(4)
}
let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
if payloads.isEmpty { print("NO_SYMBOL") } else { payloads.forEach { print($0) } }
