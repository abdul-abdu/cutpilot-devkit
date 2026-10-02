// face-helper: face boxes in frames sampled from a video, with Apple Vision.
//
//   face-helper <video> [--ranges 0-5000,8000-12000] [--fps 5]
//
// Reads the video with AVFoundation (AVAssetReader, decoding only the given ranges of source
// time, in ms), takes `fps` frames per second from each range, runs
// VNDetectFaceRectanglesRequest on them and prints JSON lines to stdout:
//
//   {"width":1920,"height":1080,"durationMs":61000}                 first, once: the upright frame size
//   {"t":1200,"faces":[{"x":0.61,"y":0.18,"w":0.12,"h":0.21,"confidence":0.98}]}
//
// t is the frame's source time in ms. x, y, w, h are fractions of the upright frame (the
// track's rotation applied); x, y is the box's top-left corner with y measured from the top
// (Vision measures from the bottom; it is converted here). Errors go to stderr with exit
// code 2 (usage), 3 (can't read the video) or 4 (no video track).
//
// Build: helper/build.sh (a universal binary at bin/face-helper). macOS 12 or later.

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(("face-helper: " + message + "\n").data(using: .utf8)!)
  exit(code)
}

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// ── arguments ───────────────────────────────────────────────────────────────

struct Range {
  let start: Int64
  let end: Int64
}

var videoArg: String?
var ranges: [Range] = []
var fps = 5.0
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  switch a {
  case "--fps":
    guard let v = args.first.flatMap({ Double($0) }), v > 0, v <= 60 else { fail(2, "--fps takes a number from 0 to 60") }
    fps = v
    args.removeFirst()
  case "--ranges":
    guard let v = args.first else { fail(2, "--ranges takes start-end pairs in ms, like 0-5000,8000-12000") }
    args.removeFirst()
    for part in v.split(separator: ",") {
      let ends = part.split(separator: "-").compactMap { Int64($0) }
      guard ends.count == 2, ends[0] >= 0, ends[1] > ends[0] else { fail(2, "bad range \(part): use start-end in ms") }
      ranges.append(Range(start: ends[0], end: ends[1]))
    }
  case "-h", "--help":
    print("usage: face-helper <video> [--ranges 0-5000,8000-12000] [--fps 5]")
    exit(0)
  default:
    if a.hasPrefix("--") || videoArg != nil { fail(2, "unexpected argument \(a)") }
    videoArg = a
  }
}
guard let path = videoArg else { fail(2, "usage: face-helper <video> [--ranges 0-5000,...] [--fps 5]") }

// ── the video ───────────────────────────────────────────────────────────────

let asset = AVURLAsset(url: URL(fileURLWithPath: path))
guard let track = asset.tracks(withMediaType: .video).first else {
  if !FileManager.default.isReadableFile(atPath: path) { fail(3, "can't read \(path)") }
  fail(4, "\(path) has no video track")
}
let durationMs = Int64((CMTimeGetSeconds(asset.duration) * 1000).rounded())
if ranges.isEmpty { ranges = [Range(start: 0, end: max(durationMs, 1))] }

/// How the stored frames are turned to be upright, for Vision.
func orientation(of t: CGAffineTransform) -> CGImagePropertyOrientation {
  switch (t.a, t.b, t.c, t.d) {
  case (0, 1, -1, 0): return .right  // stored landscape, shown rotated 90° clockwise (portrait phone video)
  case (0, -1, 1, 0): return .left  // rotated 90° counter-clockwise
  case (-1, 0, 0, -1): return .down  // upside down
  default: return .up
  }
}
let turn = orientation(of: track.preferredTransform)
let upright = track.naturalSize.applying(track.preferredTransform)
emit(
  "{\"width\":\(Int(abs(upright.width).rounded())),\"height\":\(Int(abs(upright.height).rounded())),\"durationMs\":\(durationMs)}"
)

// ── detection ───────────────────────────────────────────────────────────────

func clamp(_ v: CGFloat) -> CGFloat { min(1, max(0, v)) }
func num(_ v: CGFloat) -> String { String(format: "%.4f", Double(v)) }

func faces(in pixels: CVPixelBuffer) -> String {
  let request = VNDetectFaceRectanglesRequest()
  let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: turn, options: [:])
  do { try handler.perform([request]) } catch {
    FileHandle.standardError.write("face-helper: detection failed: \(error)\n".data(using: .utf8)!)
    return ""
  }
  return (request.results ?? []).map { face in
    // Vision: normalized to the upright image, origin at the bottom left
    let b = face.boundingBox
    let x = clamp(b.minX)
    let y = clamp(1 - b.maxY)
    let w = clamp(b.maxX) - x
    let h = clamp(1 - b.minY) - y
    return "{\"x\":\(num(x)),\"y\":\(num(y)),\"w\":\(num(w)),\"h\":\(num(h)),\"confidence\":\(num(CGFloat(face.confidence)))}"
  }.joined(separator: ",")
}

let interval = 1000.0 / fps
let ms = { (t: CMTime) -> Int64 in Int64((CMTimeGetSeconds(t) * 1000).rounded()) }

for r in ranges {
  guard r.start < durationMs else { continue }
  let reader: AVAssetReader
  do { reader = try AVAssetReader(asset: asset) } catch { fail(3, "can't read \(path): \(error.localizedDescription)") }
  let output = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
  )
  output.alwaysCopiesSampleData = false
  reader.add(output)
  reader.timeRange = CMTimeRange(
    start: CMTime(value: r.start, timescale: 1000),
    end: CMTime(value: min(r.end, durationMs), timescale: 1000)
  )
  guard reader.startReading() else {
    fail(3, "can't decode \(path): \(reader.error?.localizedDescription ?? "unknown error")")
  }
  // decode every frame of the range, keep the first at or after each sample time
  var next = Double(r.start)
  while let sample = output.copyNextSampleBuffer() {
    let t = ms(CMSampleBufferGetPresentationTimeStamp(sample))
    guard t >= r.start, t <= r.end, Double(t) >= next - 0.5, let pixels = CMSampleBufferGetImageBuffer(sample) else {
      continue
    }
    autoreleasepool {
      emit("{\"t\":\(t),\"faces\":[\(faces(in: pixels))]}")
    }
    while next <= Double(t) { next += interval }
  }
  if reader.status == .failed {
    fail(3, "decoding \(path) failed: \(reader.error?.localizedDescription ?? "unknown error")")
  }
}
