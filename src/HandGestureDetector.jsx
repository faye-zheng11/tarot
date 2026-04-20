import { useEffect, useRef } from 'react';

/**
 * HandGestureDetector
 * Loads MediaPipe via CDN and emits normalized hand landmarks.
 */
export function HandGestureDetector({
  onHandsDetected,
  onPinchDetected,
  onCameraStateChange,
  onFirstHandLandmarks,
  onGestureStatusChange,
  enabled = true,
}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handsRef = useRef(null);
  const cameraRef = useRef(null);
  const lastPinchStateRef = useRef({ left: false, right: false });
  const lastFrameTsRef = useRef(0);
  const initializedRef = useRef(false);
  const cameraStartedRef = useRef(false);
  const firstHandLandmarksSeenRef = useRef(false);
  const handsBusyRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      stopDetection();
      onHandsDetected?.([]);
      onGestureStatusChange?.('off');
      onCameraStateChange?.('off');
      return;
    }
    onCameraStateChange?.('loading');
    initializeHands();

    return () => {
      stopDetection();
    };
  }, [enabled]);

  useEffect(() => {
    const resumeByUserGesture = () => {
      if (!enabled || cameraStartedRef.current) return;
      onCameraStateChange?.('loading');
      initializeHands();
    };
    window.addEventListener('pointerdown', resumeByUserGesture, { passive: true });
    window.addEventListener('touchstart', resumeByUserGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', resumeByUserGesture);
      window.removeEventListener('touchstart', resumeByUserGesture);
    };
  }, [enabled]);

  const stopDetection = () => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    cameraStartedRef.current = false;
    handsRef.current?.close();
    handsRef.current = null;
    initializedRef.current = false;
    handsBusyRef.current = false;
  };

  const initializeHands = async () => {
    if (initializedRef.current && cameraStartedRef.current) return;
    initializedRef.current = true;

    if (!window.Hands || !window.Camera) {
      setTimeout(initializeHands, 100);
      return;
    }

    const hands = new window.Hands({
      locateFile: (file) => `/mediapipe/hands/${file}`,
    });

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      // Prefer stable "no movement" over noisy false positives.
      minDetectionConfidence: 0.78,
      minTrackingConfidence: 0.72,
    });

    handsRef.current = hands;

    hands.onResults((results) => {
      if (!results.multiHandLandmarks || !results.multiHandedness) {
        onHandsDetected?.([]);
        onGestureStatusChange?.('no-hand');
        return;
      }

      if (!firstHandLandmarksSeenRef.current) {
        firstHandLandmarksSeenRef.current = true;
        onFirstHandLandmarks?.();
      }

      const handsData = [];
      let primaryGesture = 'OTHER';
      results.multiHandLandmarks.forEach((landmarks, i) => {
        const handedness = results.multiHandedness[i].label;
        const gesture = classifyGesture(landmarks, handedness);
        if (i === 0) {
          primaryGesture = gesture;
        }

        const thumb = landmarks[4];
        const index = landmarks[8];
        const distance = Math.sqrt(
          Math.pow(thumb.x - index.x, 2) + Math.pow(thumb.y - index.y, 2),
        );
        const isPinching = distance < 0.08;

        const key = handedness.toLowerCase();
        const prev = lastPinchStateRef.current[key];
        if (isPinching !== prev) {
          lastPinchStateRef.current[key] = isPinching;
          onPinchDetected?.({
            handedness,
            isPinching,
            position: {
              x: (thumb.x + index.x) / 2,
              y: (thumb.y + index.y) / 2,
            },
          });
        }

        handsData.push({
          handedness,
          landmarks: landmarks.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z })),
          isPinching,
          gesture,
          indexTip: { x: index.x, y: index.y, z: index.z },
        });
      });

      onHandsDetected?.(handsData);
      onGestureStatusChange?.(
        primaryGesture === 'OPEN_PALM'
          ? 'open-palm'
          : primaryGesture === 'CLOSED_FIST'
            ? 'fist'
            : 'no-hand',
      );
    });

    if (!videoRef.current) return;

    try {
      const camera = new window.Camera(videoRef.current, {
        onFrame: async () => {
          if (!enabled || handsBusyRef.current) return;
          const now = performance.now();
          // Keep 15-20 FPS gesture detection to avoid UI frame drops.
          if (now - lastFrameTsRef.current < 55) return;
          lastFrameTsRef.current = now;
          if (videoRef.current && handsRef.current) {
            handsBusyRef.current = true;
            try {
              await handsRef.current.send({ image: videoRef.current });
            } finally {
              handsBusyRef.current = false;
            }
          }
        },
        width: 640,
        height: 480,
        facingMode: 'user',
      });

      await camera.start();
      cameraRef.current = camera;
      cameraStartedRef.current = true;
      onCameraStateChange?.('ready');
    } catch (err) {
      console.warn('Gesture detection unavailable:', err.message);
      onHandsDetected?.([]);
      onGestureStatusChange?.('no-hand');
      onCameraStateChange?.('needs-user-gesture');
      cameraStartedRef.current = false;
      initializedRef.current = false;
    }
  };

  const classifyGesture = (landmarks, handedness) => {
    if (!landmarks || landmarks.length < 21) return 'UNKNOWN';
    void handedness;
    const wrist = landmarks[0];
    const fingerDefs = [
      { tip: 8, pip: 6 },
      { tip: 12, pip: 10 },
      { tip: 16, pip: 14 },
      { tip: 20, pip: 18 },
    ];
    const dist = (a, b) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
    const fingersOpen = fingerDefs.every(({ tip, pip }) => {
      const tipLm = landmarks[tip];
      const pipLm = landmarks[pip];
      return tipLm.y < pipLm.y && dist(tipLm, wrist) > dist(pipLm, wrist) * 1.08;
    });
    if (fingersOpen) return 'OPEN_PALM';
    const fingersClosed = fingerDefs.every(({ tip, pip }) => landmarks[tip].y > landmarks[pip].y);
    if (fingersClosed) return 'CLOSED_FIST';
    return 'OTHER';
  };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        zIndex: 0,
        pointerEvents: 'none',
        width: 1,
        height: 1,
        overflow: 'hidden',
      }}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        style={{ width: 1, height: 1, opacity: 0 }}
      />
      <canvas ref={canvasRef} width={640} height={480} style={{ display: 'none' }} />
    </div>
  );
}

export default HandGestureDetector;
