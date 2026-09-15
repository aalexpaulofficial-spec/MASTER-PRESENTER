import { useCallback, useEffect, useRef, useState } from "react";
import {
  GestureGate,
  PointSmoother,
  classifyGesture,
  mapToSlide,
  type Gesture,
  type Landmark,
} from "@/lib/hand-control";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export type CameraStatus = "idle" | "starting" | "live" | "error";
/**
 * The index fingertip (landmark 8) mapped into slide space (0..1 on both axes),
 * tagged with which Master Write gesture produced it: a lone index finger drives
 * the cursor, index + middle re-opens the writing toolbar (§3 §7). This is a
 * cursor sample and nothing more — it never means "write" on its own (§1 §5).
 * Laser mode never emits it (§13).
 */
export type IndexFingerPoint = {
  slide: { x: number; y: number };
  mode: "index" | "eraser";
};

type Options = {
  enabled: boolean;
  onAction: (action: "next" | "prev") => void;
  onPointer: (point: { x: number; y: number } | null) => void;
  pointerMode?: "laser" | "writing";
  onIndexPoint?: (point: IndexFingerPoint | null) => void;
  slideAspect?: number;
};

export function useHandTracking({
  enabled,
  onAction,
  onPointer,
  pointerMode = "laser",
  onIndexPoint,
  slideAspect = 16 / 9,
}: Options) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture>("none");
  const [handVisible, setHandVisible] = useState(false);

  const actionRef = useRef(onAction);
  const pointerRef = useRef(onPointer);
  const indexPointRef = useRef(onIndexPoint);
  const pointerModeRef = useRef(pointerMode);
  const slideAspectRef = useRef(slideAspect);
  actionRef.current = onAction;
  pointerRef.current = onPointer;
  indexPointRef.current = onIndexPoint;
  pointerModeRef.current = pointerMode;
  slideAspectRef.current = slideAspect;

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setStatus("idle");
    setAttempt((a) => a + 1);
  }, []);

  // Re-acquired tracking must not leak listeners or streams. The whole loop lives
  // inside this effect, which tears down (cancels the rAF, closes the landmarker,
  // stops every track and clears srcObject) on cleanup — and `attempt` is the only
  // thing that re-runs it, so React StrictMode / re-entrancy can't double-mount it
  // (§17 camera reconnect, no duplicate loops / leaks).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let landmarker: {
      detectForVideo: (v: HTMLVideoElement, t: number) => unknown;
      close: () => void;
    } | null = null;
    // Master Hand / Master Voice use the original laser smoother. Master Write gets a
    // near-passthrough smoother: a little jitter removal, no visible lag (§8 low-latency).
    const smoother = new PointSmoother();
    const writeSmoother = new PointSmoother(0.82, 16, 1);
    const gate = new GestureGate();
    let lastTs = -1;

    async function start() {
      setStatus("starting");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support camera access.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => undefined);

        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
        let created: Awaited<ReturnType<typeof vision.HandLandmarker.createFromOptions>>;
        try {
          created = await vision.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 1,
            minHandDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
        } catch {
          created = await vision.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
            runningMode: "VIDEO",
            numHands: 1,
          });
        }
        if (cancelled) {
          created.close();
          return;
        }
        landmarker = created as unknown as typeof landmarker;
        setStatus("live");

        const loop = () => {
          // Drive detection from rAF so we never re-render React per camera frame;
          // only refs are touched, keeping the fingertip→ink path at display latency (§8).
          raf = requestAnimationFrame(loop);

          if (
            stream &&
            (!stream.active || stream.getTracks().some((t) => t.readyState === "ended"))
          ) {
            setAttempt((a) => a + 1);
            return;
          }

          const el = videoRef.current;
          if (!el || !landmarker || el.readyState < 2) return;
          // Skip a frame only if the video clock hasn't advanced — this throttles to the
          // camera's true rate instead of hammering detectForVideo with duplicate timestamps.
          const ts = el.currentTime * 1000;
          if (ts === lastTs) return;
          lastTs = ts;

          let result: { landmarks?: Landmark[][]; handedness?: { categoryName?: string }[][] };
          try {
            result = landmarker.detectForVideo(el, performance.now()) as typeof result;
          } catch {
            return;
          }
          const lm = result.landmarks?.[0];
          if (!lm) {
            setHandVisible(false);
            setGesture("none");
            smoother.reset();
            writeSmoother.reset();
            pointerRef.current(null);
            indexPointRef.current?.(null);
            gate.update("none", performance.now());
            return;
          }
          setHandVisible(true);
          const label = result.handedness?.[0]?.[0]?.categoryName ?? "Right";
          const g = classifyGesture(lm, label);
          setGesture(g);

          const writing = pointerModeRef.current === "writing";
          // Landmark 8 is the ACTUAL INDEX FINGERTIP — never wrist / palm centre / bound
          // box. Every coordinate downstream is this point, so the cursor and ink sit
          // exactly under the physical finger (§3 §7). If MediaPipe ever emits a clearly
          // impossible value, discard it rather than drawing a giant stray line (§16).
          const tip = lm[8];
          if (
            !tip ||
            !isFinite(tip.x) ||
            !isFinite(tip.y) ||
            tip.x < -0.5 ||
            tip.x > 1.5 ||
            tip.y < -0.5 ||
            tip.y > 1.5
          ) {
            writeSmoother.reset();
            pointerRef.current(null);
            indexPointRef.current?.(null);
            return;
          }

          const camAspect =
            el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 4 / 3;
          const sAspect = slideAspectRef.current || 16 / 9;

          if (g === "pointing" && tip) {
            const mapped = mapToSlide(tip.x, tip.y, camAspect, sAspect);
            if (writing) {
              // A lone index finger drives the writing cursor. It never feeds the
              // laser (§13), and raising it does not start a stroke by itself —
              // WriteGestureMachine decides that (§1 §5).
              smoother.reset();
              const s = writeSmoother.next(mapped.x, mapped.y);
              pointerRef.current(null);
              indexPointRef.current?.({ slide: s, mode: "index" });
            } else {
              // Laser mode is unchanged: the index finger drives the laser dot.
              writeSmoother.reset();
              const s = smoother.next(mapped.x, mapped.y);
              pointerRef.current(s);
              indexPointRef.current?.(null);
            }
          } else if (g === "two-fingers" && writing && tip) {
            // Index + middle re-opens the writing toolbar. The fingertip it reports
            // is still landmark 8, tracked just as tightly as the pen (§7 §9).
            smoother.reset();
            const mapped = mapToSlide(tip.x, tip.y, camAspect, sAspect);
            const s = writeSmoother.next(mapped.x, mapped.y);
            pointerRef.current(null);
            indexPointRef.current?.({ slide: s, mode: "eraser" });
          } else {
            smoother.reset();
            writeSmoother.reset();
            pointerRef.current(null);
            indexPointRef.current?.(null);
          }

          const action = gate.update(g, performance.now());
          if (action) actionRef.current(action);
        };
        raf = requestAnimationFrame(loop);
      } catch (err) {
        if (cancelled) return;
        const e = err as { name?: string; message?: string };
        const message =
          e.name === "NotAllowedError" || e.name === "SecurityError"
            ? "Camera access was blocked. Allow camera permission in your browser settings, then try again."
            : e.name === "NotFoundError" || e.name === "OverconstrainedError"
              ? "No usable camera was found on this device."
              : e.name === "NotReadableError"
                ? "Your camera is being used by another app. Close it and try again."
                : (e.message ?? "Camera could not be started.");
        setError(message);
        setStatus("error");
      }
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      landmarker?.close();
      stream?.getTracks().forEach((t) => t.stop());
      const el = videoRef.current;
      if (el) el.srcObject = null;
      pointerRef.current(null);
      indexPointRef.current?.(null);
    };
  }, [enabled, attempt]);

  return { videoRef, status, error, gesture, handVisible, retry };
}
