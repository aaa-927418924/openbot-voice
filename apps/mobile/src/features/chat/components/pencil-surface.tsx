// The JS half of the Apple Pencil annotation surface. The native view draws only Apple Pencil
// touches, so a finger keeps scrolling the chat; `capture` renders the message bubble it sits on,
// marker included, into a PNG file for the chat to send.

import { requireNativeViewManager } from "expo-modules-core";
import { type ComponentType, forwardRef, type Ref, useImperativeHandle, useRef } from "react";
import { StyleSheet, type ViewProps } from "react-native";

export interface PencilAnnotationImage {
  uri: string;
  width: number;
  height: number;
}

export interface PencilSurfaceHandle {
  clear: () => Promise<void>;
  capture: () => Promise<PencilAnnotationImage>;
}

interface PencilSurfaceProps extends ViewProps {
  strokeColor?: string;
  strokeWidth?: number;
  /** The native view captures the bubble it sits in before it sends this. */
  onSqueeze?: (image: Partial<PencilAnnotationImage>) => void;
}

const NativePencilSurface: ComponentType<PencilSurfaceProps & { ref?: Ref<PencilSurfaceHandle> }> =
  requireNativeViewManager<PencilSurfaceProps>("PencilAnnotations");

export const PencilSurface = forwardRef<PencilSurfaceHandle, PencilSurfaceProps>(function PencilSurface(props, ref) {
  const nativeRef = useRef<PencilSurfaceHandle | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => nativeRef.current?.clear() ?? Promise.resolve(),
      capture: () => nativeRef.current?.capture() ?? Promise.reject(new Error("The pencil surface is not mounted.")),
    }),
    [],
  );

  return <NativePencilSurface {...props} ref={nativeRef} style={[StyleSheet.absoluteFill, props.style]} />;
});
