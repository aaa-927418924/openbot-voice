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
  /// The bubble the pencil wrote on last. A squeeze is delivered to one of the many interactions in
  /// the list, so capturing `self` could photograph an unrelated row; this keeps the target exact.
  private static weak var lastInkedSurface: PencilSurfaceView?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    isOpaque = false
    backgroundColor = .clear
    clipsToBounds = true

    inkView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(inkView)

    // `allowedTouchTypes` is what keeps the feature out of the finger's way: the recognizer never
    // begins for a finger, so the chat's scroll view receives that touch as usual. A pan would wait
    // for the pencil to move a few points before it begins, which dropped the start of every line;
    // this recognizer begins on the first pencil touch instead.
    let stroke = PencilStrokeRecognizer()
    stroke.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
    stroke.cancelsTouchesInView = false
    stroke.onBegan = { [weak self] point in
      guard let self else { return }
      PencilSurfaceView.lastInkedSurface = self
      self.inkView.beginStroke(at: point, color: self.markerColor(), width: self.strokeWidth)
    }
    stroke.onMoved = { [weak self] point in
      self?.inkView.addPoint(point)
    }
    stroke.onEnded = { [weak self] in
      guard let self else { return }
      self.inkView.endStroke()
      guard !self.hasInk else { return }
      self.hasInk = true
      self.dispatchEvent("onInkChange", payload: ["hasInk": true])
    }
    addGestureRecognizer(stroke)

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

  func clearInk() {
    inkView.clear()
    if PencilSurfaceView.lastInkedSurface === self {
      PencilSurfaceView.lastInkedSurface = nil
    }
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
    // A long message at 2x can produce a 6000 px tall PNG. Cap the long side so encoding stays
    // quick enough for the main thread that owns the squeeze event.
    let longestSide = max(bounds.width, bounds.height)
    let cappedScale = longestSide > 0 ? min(UIScreen.main.scale, 1600 / longestSide) : UIScreen.main.scale
    format.scale = max(0.5, cappedScale)
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
    // Every surface carries an interaction, so a squeeze can arrive here more than once. Capture
    // only in the JS row that owns the written bubble, and let its busy flag drop the extra events.
    let target = PencilSurfaceView.lastInkedSurface ?? self
    guard target.hasInk else { return }
    target.dispatchEvent("onSqueeze", payload: [:])
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

/// Begins on the first pencil touch rather than after a movement threshold, so the start of a line
/// is drawn immediately. The system still sends it only pencil touches.
private final class PencilStrokeRecognizer: UIGestureRecognizer {
  var onBegan: ((CGPoint) -> Void)?
  var onMoved: ((CGPoint) -> Void)?
  var onEnded: (() -> Void)?

  init() {
    super.init(target: nil, action: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard state == .possible, let touch = touches.first else { return }
    state = .began
    onBegan?(touch.location(in: view))
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard state == .began || state == .changed else { return }
    state = .changed
    for touch in touches {
      onMoved?(touch.location(in: view))
    }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    guard state == .began || state == .changed else { return }
    state = .ended
    onEnded?()
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    guard state == .began || state == .changed else { return }
    state = .cancelled
    onEnded?()
  }
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
