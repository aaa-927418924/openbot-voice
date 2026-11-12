import ExpoModulesCore
import UIKit

/// A transparent marker layer that lives inside one AI message bubble. Only Apple Pencil touches
/// reach it, so a finger keeps scrolling the chat. A squeeze on Apple Pencil Pro asks the JS side
/// to capture the whole bubble (marker included) and send it.
public final class PencilSurfaceView: ExpoView, UIPencilInteractionDelegate {
  var strokeColorHex = "#E53935"
  var strokeWidth: CGFloat = 3.5

  private let inkView = InkCanvasView()
  private var squeezeInteraction: UIPencilInteraction?
  private var hasInk = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    isOpaque = false
    backgroundColor = .clear
    clipsToBounds = true

    inkView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(inkView)

    // `allowedTouchTypes` is what keeps the feature out of the finger's way: the recognizer never
    // begins for a finger, so the chat's scroll view receives that touch as usual.
    let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
    pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
    pan.maximumNumberOfTouches = 1
    pan.cancelsTouchesInView = false
    addGestureRecognizer(pan)

    if #available(iOS 17.5, *) {
      let interaction = UIPencilInteraction()
      interaction.delegate = self
      addInteraction(interaction)
      squeezeInteraction = interaction
    }
  }

  deinit {
    if let squeezeInteraction {
      removeInteraction(squeezeInteraction)
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    inkView.frame = bounds
  }

  @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
    let point = gesture.location(in: self)
    switch gesture.state {
    case .began:
      inkView.beginStroke(at: point, color: markerColor(), width: strokeWidth)
    case .changed:
      inkView.addPoint(point)
    case .ended, .cancelled, .failed:
      inkView.endStroke()
      if !hasInk {
        hasInk = true
        dispatchEvent("onInkChange", payload: ["hasInk": true])
      }
    default:
      break
    }
  }

  func clearInk() {
    inkView.clear()
    guard hasInk else { return }
    hasInk = false
    dispatchEvent("onInkChange", payload: ["hasInk": false])
  }

  /// Renders the whole bubble this surface is laid over, marker included, into a PNG file.
  func capture() throws -> [String: Any] {
    guard let target = superview, target.bounds.width > 0, target.bounds.height > 0 else {
      throw PencilAnnotationError.noMessage
    }
    let bounds = target.bounds
    let format = UIGraphicsImageRendererFormat.default()
    format.opaque = false
    format.scale = UIScreen.main.scale
    let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
    let image = renderer.image { context in
      target.layer.render(in: context.cgContext)
    }
    guard let data = image.pngData() else {
      throw PencilAnnotationError.encodeFailed
    }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("openbot-annotation-\(UUID().uuidString).png")
    try data.write(to: url, options: .atomic)
    return ["uri": url.absoluteString, "width": image.size.width, "height": image.size.height]
  }

  @available(iOS 17.5, *)
  public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
    // Capture from the surface that received the squeeze. Its superview is the bubble it currently
    // sits in, so the image cannot belong to a row that the list has since recycled.
    do {
      dispatchEvent("onSqueeze", payload: try capture())
    } catch {
      dispatchEvent("onSqueeze", payload: [:])
    }
  }

  private func markerColor() -> UIColor {
    var value = strokeColorHex.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("#") {
      value.removeFirst()
    }
    guard (value.count == 6 || value.count == 8), let number = UInt64(value, radix: 16) else {
      return UIColor.systemRed.withAlphaComponent(0.9)
    }
    if value.count == 8 {
      return UIColor(
        red: CGFloat((number >> 24) & 0xFF) / 255,
        green: CGFloat((number >> 16) & 0xFF) / 255,
        blue: CGFloat((number >> 8) & 0xFF) / 255,
        alpha: CGFloat(number & 0xFF) / 255
      )
    }
    return UIColor(
      red: CGFloat((number >> 16) & 0xFF) / 255,
      green: CGFloat((number >> 8) & 0xFF) / 255,
      blue: CGFloat(number & 0xFF) / 255,
      alpha: 0.9
    )
  }
}

private enum PencilAnnotationError: Error {
  case noMessage
  case encodeFailed
}

/// The strokes themselves. A plain `draw(_:)` view keeps the code small and renders the same in the
/// bubble and in the captured PNG.
private final class InkCanvasView: UIView {
  private struct Stroke {
    let path: UIBezierPath
    let color: UIColor
    let width: CGFloat
  }

  private var strokes: [Stroke] = []
  private var current: Stroke?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func beginStroke(at point: CGPoint, color: UIColor, width: CGFloat) {
    let path = UIBezierPath()
    path.move(to: point)
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    current = Stroke(path: path, color: color, width: width)
    setNeedsDisplay()
  }

  func addPoint(_ point: CGPoint) {
    current?.path.addLine(to: point)
    setNeedsDisplay()
  }

  func endStroke() {
    if let current {
      strokes.append(current)
    }
    current = nil
    setNeedsDisplay()
  }

  func clear() {
    strokes.removeAll()
    current = nil
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    for stroke in strokes {
      stroke.color.setStroke()
      stroke.path.lineWidth = stroke.width
      stroke.path.stroke()
    }
    if let current {
      current.color.setStroke()
      current.path.lineWidth = current.width
      current.path.stroke()
    }
  }
}
