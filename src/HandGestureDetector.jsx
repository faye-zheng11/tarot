import { useEffect, useRef } from 'react';

/**
 * HandGestureDetector
 * Loads MediaPipe via CDN and emits normalized hand landmarks.
 */
export function HandGestureDetector({ onHandsDetected, onPinchDetected }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handsRef = useRef(null);
  const cameraRef = useRef(null);
  const lastPinchStateRef = useRef({ left: false, right: false });
  const lastFrameTsRef = useRef(0);
  const scriptsLoadedRef = useRef(false);

  useEffect(() => {
    if (scriptsLoadedRef.current) return;

    const script1 = document.createElement('script');
    script1.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js';
    script1.async = true;

    const script2 = document.createElement('script');
    script2.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
    script2.async = true;

    script1.onload = () => {
      script2.onload = () => {
        scriptsLoadedRef.current = true;
        initializeHands();
      };
      document.body.appendChild(script2);
    };

    document.body.appendChild(script1);

    return () => {
      handsRef.current?.close();
      cameraRef.current?.stop();
    };
  }, []);

  const initializeHands = async () => {
    if (!window.Hands || !window.Camera) {
      setTimeout(initializeHands, 100);
      return;
    }

    const hands = new window.Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
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
        return;
      }

      const handsData = [];
      results.multiHandLandmarks.forEach((landmarks, i) => {
        const handedness = results.multiHandedness[i].label;
        const gesture = classifyGesture(landmarks, handedness);

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
    });

    if (!videoRef.current) return;

    try {
      const camera = new window.Camera(videoRef.current, {
        onFrame: async () => {
          const now = performance.now();
          // Reduce detection rate to stabilize interaction and lower CPU.
          if (now - lastFrameTsRef.current < 48) return;
          lastFrameTsRef.current = now;
          if (videoRef.current && handsRef.current) {
            await handsRef.current.send({ image: videoRef.current });
          }
        },
        width: 640,
        height: 480,
      });

      await camera.start();
      cameraRef.current = camera;
    } catch (err) {
      console.warn('Gesture detection unavailable:', err.message);
      onHandsDetected?.([]);
    }
  };

  const classifyGesture = (landmarks, handedness) => {
    if (!landmarks || landmarks.length < 21) return 'UNKNOWN';

    const thumbTip = landmarks[4];
    const thumbIp = landmarks[3];
    const indexTip = landmarks[8];
    const indexPip = landmarks[6];
    const middleTip = landmarks[12];
    const middlePip = landmarks[10];
    const ringTip = landmarks[16];
    const ringPip = landmarks[14];
    const pinkyTip = landmarks[20];
    const pinkyPip = landmarks[18];

    const isRight = handedness?.toLowerCase() === 'right';
    const thumbOpen = isRight ? thumbTip.x < thumbIp.x : thumbTip.x > thumbIp.x;
    const indexOpen = indexTip.y < indexPip.y;
    const middleOpen = middleTip.y < middlePip.y;
    const ringOpen = ringTip.y < ringPip.y;
    const pinkyOpen = pinkyTip.y < pinkyPip.y;

    const openCount = [thumbOpen, indexOpen, middleOpen, ringOpen, pinkyOpen].filter(Boolean).length;

    if (openCount <= 1) return 'CLOSED_FIST';
    if (openCount >= 4) return 'OPEN_PALM';
    return 'OTHER';
  };

  return (
    <div style={{ position: 'absolute', bottom: 0, left: 0, zIndex: 0, pointerEvents: 'none' }}>
      <video
        ref={videoRef}
        playsInline
        muted
        style={{ display: 'none', width: 640, height: 480 }}
      />
      <canvas
        ref={canvasRef}
        width={640}
        height={480}
        style={{ display: 'none' }}
      />
    </div>
  );
}

export default HandGestureDetector;
