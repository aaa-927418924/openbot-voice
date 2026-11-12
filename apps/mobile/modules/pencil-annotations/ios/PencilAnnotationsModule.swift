import ExpoModulesCore

public final class PencilAnnotationsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PencilAnnotations")

    View(PencilSurfaceView.self) {
      Prop("strokeColor") { (view: PencilSurfaceView, value: String) in
        view.strokeColorHex = value
      }
      Prop("strokeWidth") { (view: PencilSurfaceView, value: Double) in
        view.strokeWidth = CGFloat(value)
      }
      Events("onSqueeze", "onInkChange")

      AsyncFunction("clear") { (view: PencilSurfaceView) in
        view.clearInk()
      }.runOnQueue(.main)

      AsyncFunction("capture") { (view: PencilSurfaceView) -> [String: Any] in
        try view.capture()
      }.runOnQueue(.main)
    }
  }
}
