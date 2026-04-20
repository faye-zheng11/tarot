import React, {
  useMemo,
  useRef,
  useState,
  useEffect,
  useCallback,
  Suspense,
  createContext,
  useContext,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, useTexture, Environment } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import HandGestureDetector from './HandGestureDetector';
import { GestureManager } from './GestureManager';
import { parseTarotDeckCsv, cardImageSrc } from './tarotDeck';
import { POINTER_PIXEL_TO_RAD } from './inputConstants';
import InterpretationCard from './components/InterpretationCard';

const CARD_COUNT = 22;
const RING_RADIUS = 6;
const CARD_SIZE = [1, 1.6, 0.06];
/** 环形步进角：2π / n，用于吸附到最近一张牌 */
const RING_ANGLE_SLICE = (Math.PI * 2) / CARD_COUNT;
const TWO_PI = Math.PI * 2;
/** 松手后角速度摩擦：每帧等效 velocity *= 0.95^（delta·60） */
const VELOCITY_FRICTION = 0.95;

const RingOffsetRefContext = createContext(null);

const SPREAD_SLOT_LABELS = ['过去 (Past)', '现在 (Present)', '未来 (Future)'];
const DOM_CAROUSEL_RADIUS = 250;
const GESTURE_LOCK_MS = 2200;
const LOCK_ALIGN_MS = 180;
const GLOW_HOLD_MS = 350;
const HOLD_DURATION_MS = 800;

/** 当前 θ 下最靠近相机正前方的环上卡牌索引（与 RingCard 角公式一致） */
function computeFrontRingIndex(theta) {
  const idx = Math.round(-theta / RING_ANGLE_SLICE);
  return ((idx % CARD_COUNT) + CARD_COUNT) % CARD_COUNT;
}

// ─── RingCard ─────────────────────────────────────────────────────────────────
// angle = index * (2π/total) + theta（总偏移，由 RingCarousel 唯一维护）
function RingCard({
  index,
  total,
  radius,
  backMap,
  onPick,
  onRequestFocus,
  onHoverChange,
  isFocused,
}) {
  const { camera, gl } = useThree();
  const ringOffsetRef = useContext(RingOffsetRefContext);
  const meshRef = useRef();
  const frontMatRef = useRef();
  const backMatRef = useRef();
  const [hovered, setHovered] = useState(false);

  useFrame((_, delta) => {
    if (!meshRef.current || !ringOffsetRef) return;
    const theta = ringOffsetRef.current;
    const angle = index * (TWO_PI / total) + theta;
    meshRef.current.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
    const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
    const dist = Math.abs(wrapped);
    const focusZone = Math.min(Math.PI / 2.1, RING_ANGLE_SLICE * 4.5);
    const focusAlpha = Math.max(0, 1 - dist / focusZone);
    const scaleTarget = 0.8 + focusAlpha * 0.35 + (isFocused ? 0.05 : 0);
    const yRotOffset = (1 - focusAlpha) * 0.22 * Math.sign(wrapped || 1);
    meshRef.current.rotation.set(0, angle + yRotOffset, 0);

    const hoverBoost = hovered ? 0.06 : 0;
    const s = THREE.MathUtils.damp(meshRef.current.scale.x, scaleTarget + hoverBoost, 14, delta);
    meshRef.current.scale.setScalar(s);

    const targetEm = isFocused ? 0.95 : hovered ? 0.55 : 0.15;
    [frontMatRef.current, backMatRef.current].forEach((mat) => {
      if (!mat) return;
      mat.transparent = true;
      mat.opacity = 0.5 + focusAlpha * 0.5;
      mat.emissiveIntensity = THREE.MathUtils.damp(mat.emissiveIntensity, targetEm, 14, delta);
    });
  });

  const screenRectFromMesh = (object3d) => {
    const worldPos = new THREE.Vector3();
    object3d.getWorldPosition(worldPos);
    const ndc = worldPos.clone().project(camera);
    const rect = gl.domElement.getBoundingClientRect();
    const w = 78;
    const h = 124;
    const left = rect.left + (ndc.x * 0.5 + 0.5) * rect.width - w / 2;
    const top = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height - h / 2;
    return { left, top, width: w, height: h };
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (isFocused) {
      onPick(index, screenRectFromMesh(e.object));
    } else {
      onRequestFocus?.(index);
    }
  };

  const emitHoverTransform = (obj) => {
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    obj.getWorldPosition(worldPos);
    obj.getWorldQuaternion(worldQuat);
    const euler = new THREE.Euler().setFromQuaternion(worldQuat);
    onHoverChange?.(index, {
      position: [worldPos.x, worldPos.y, worldPos.z],
      rotation: [euler.x, euler.y, euler.z],
      screenRect: screenRectFromMesh(obj),
    });
  };

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, 0]}
      rotation={[0, 0, 0]}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        emitHoverTransform(e.object);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
        onHoverChange?.(null, null);
        document.body.style.cursor = 'auto';
      }}
      onClick={handleClick}
      castShadow
    >
      <boxGeometry args={CARD_SIZE} />
      <meshStandardMaterial attach="material-0" color="#d4af37" roughness={0.1} metalness={0.9} />
      <meshStandardMaterial attach="material-1" color="#d4af37" roughness={0.1} metalness={0.9} />
      <meshStandardMaterial attach="material-2" color="#d4af37" roughness={0.1} metalness={0.9} />
      <meshStandardMaterial attach="material-3" color="#d4af37" roughness={0.1} metalness={0.9} />
      <meshStandardMaterial
        ref={frontMatRef}
        attach="material-4"
        map={backMap}
        roughness={0.15}
        metalness={0.8}
        emissive="#d4af37"
        emissiveIntensity={0.15}
      />
      <meshStandardMaterial
        ref={backMatRef}
        attach="material-5"
        map={backMap}
        roughness={0.15}
        metalness={0.8}
        emissive="#d4af37"
        emissiveIntensity={0.15}
      />
    </mesh>
  );
}

function DeepSpaceDust() {
  const pointsRef = useRef();
  const [geometry] = useState(() => {
    const g = new THREE.BufferGeometry();
    const count = 380;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const radius = 20 + Math.random() * 95;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = (Math.random() - 0.5) * 35;
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  });

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    pointsRef.current.rotation.y += delta * 0.014;
    pointsRef.current.rotation.x += delta * 0.004;
  });

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        color="#f7edd6"
        size={0.18}
        sizeAttenuation
        transparent
        opacity={0.42}
        depthWrite={false}
      />
    </points>
  );
}

/**
 * 环形转盘：单一 theta（总弧度）驱动整环；指针位移在 Move 中只写入 pending，
 * 在 useFrame（等价 RAF）中合并进 theta，避免与渲染节拍错位导致卡顿。
 */
function RingCarousel({
  stopped,
  gestureScrollOffset,
  verticalOffset,
  thetaBridgeRef,
  rotationSpeed = 0,
  focusTargetIndex = null,
  onFocusedIndexChange,
  onFocusTargetSettled,
  children,
}) {
  const { gl } = useThree();
  /** 总旋转角 θ：每张牌角 = index·(2π/n) + θ */
  const thetaRef = useRef(0);
  const ringOffsetRef = thetaRef;
  const isDraggingRef = useRef(false);
  /** PointerMove 累积的弧度增量，每帧在 useFrame 开头并入 theta 后清零 */
  const pointerPendingRadRef = useRef(0);
  const velocityRef = useRef(0);
  const lastPointerXRef = useRef(0);
  const prevGestureScrollRef = useRef(gestureScrollOffset);
  const lastMoveTsRef = useRef(performance.now());
  const focusedIndexRef = useRef(0);

  useEffect(() => {
    prevGestureScrollRef.current = gestureScrollOffset;
  }, [gestureScrollOffset]);

  useFrame((_, delta) => {
    if (stopped) {
      velocityRef.current *= Math.pow(VELOCITY_FRICTION, delta * 60);
      thetaRef.current = THREE.MathUtils.euclideanModulo(thetaRef.current, TWO_PI);
      return;
    }

    const pending = pointerPendingRadRef.current;
    pointerPendingRadRef.current = 0;
    thetaRef.current += pending;
    thetaRef.current += rotationSpeed * delta;

    const gestureDelta = isDraggingRef.current
      ? 0
      : gestureScrollOffset - prevGestureScrollRef.current;
    prevGestureScrollRef.current = gestureScrollOffset;
    thetaRef.current += gestureDelta;

    if (!isDraggingRef.current) {
      const friction = Math.pow(VELOCITY_FRICTION, delta * 60);
      velocityRef.current *= friction;
      thetaRef.current += velocityRef.current * delta;

      if (focusTargetIndex !== null && Number.isInteger(focusTargetIndex)) {
        const targetBase = -focusTargetIndex * RING_ANGLE_SLICE;
        const diff = Math.atan2(Math.sin(targetBase - thetaRef.current), Math.cos(targetBase - thetaRef.current));
        thetaRef.current += diff * Math.min(1, delta * 10);
        if (Math.abs(diff) < 0.01) {
          onFocusTargetSettled?.(focusTargetIndex);
        }
      }

      if (Math.abs(velocityRef.current) < 0.04 && Math.abs(rotationSpeed) < 0.001) {
        velocityRef.current = 0;
        const snapTarget = Math.round(thetaRef.current / RING_ANGLE_SLICE) * RING_ANGLE_SLICE;
        const snapAlpha = Math.min(1, delta * 12);
        thetaRef.current += (snapTarget - thetaRef.current) * snapAlpha;
      }
    }

    thetaRef.current = THREE.MathUtils.euclideanModulo(thetaRef.current, TWO_PI);
    const focusedIndex = computeFrontRingIndex(thetaRef.current);
    if (focusedIndex !== focusedIndexRef.current) {
      focusedIndexRef.current = focusedIndex;
      onFocusedIndexChange?.(focusedIndex);
    }
    if (thetaBridgeRef) {
      thetaBridgeRef.current = thetaRef.current;
    }
  }, -1);

  useEffect(() => {
    const el = gl.domElement;
    el.style.touchAction = 'none';

    const onPointerDown = (e) => {
      if (stopped) return;
      if (e.button !== undefined && e.button !== 0) return;
      isDraggingRef.current = true;
      lastPointerXRef.current = e.clientX;
      velocityRef.current = 0;
      lastMoveTsRef.current = performance.now();
      if (typeof el.setPointerCapture === 'function') {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    const onPointerMove = (e) => {
      if (!isDraggingRef.current || stopped) return;
      const now = performance.now();
      const dtMs = Math.max(now - lastMoveTsRef.current, 1);
      lastMoveTsRef.current = now;

      const frameDx = e.clientX - lastPointerXRef.current;
      lastPointerXRef.current = e.clientX;
      const dRad = frameDx * POINTER_PIXEL_TO_RAD;
      pointerPendingRadRef.current += dRad;
      velocityRef.current = dRad / (dtMs / 1000);
    };

    const endDrag = (e) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      if (e?.pointerId != null && typeof el.releasePointerCapture === 'function') {
        try {
          if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);
    const onWheel = (e) => {
      if (stopped) return;
      e.preventDefault();
      const impulse = (e.deltaY + e.deltaX) * -0.00095;
      pointerPendingRadRef.current += impulse;
      velocityRef.current += impulse * 38;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', endDrag);
      el.removeEventListener('lostpointercapture', endDrag);
      el.removeEventListener('wheel', onWheel);
      el.style.touchAction = '';
    };
  }, [gl, stopped]);

  return (
    <RingOffsetRefContext.Provider value={ringOffsetRef}>
      <group position={[0, verticalOffset, 0]} rotation={[-0.22, 0, 0]}>
        {children}
      </group>
    </RingOffsetRefContext.Provider>
  );
}

// ─── SceneContent ─────────────────────────────────────────────────────────────
function SceneContent({
  appPhase,
  onRingPick,
  onRequestFocus,
  scrollOffset,
  rotationSpeed,
  focusedRingIndex,
  focusTargetIndex,
  onFocusedIndexChange,
  onFocusTargetSettled,
  raycastEnabled,
  onHoverCard,
  isPortraitMobile,
  thetaBridgeRef,
}) {
  const [backMap] = useTexture(['/Card1.jpg']);

  useEffect(() => {
    if (!backMap) return;
    backMap.colorSpace = THREE.SRGBColorSpace;
    backMap.anisotropy = 8;
  }, [backMap]);

  return (
    <>
      <color attach="background" args={['#07021a']} />
      <ambientLight intensity={0.32} />
      <directionalLight position={[5, 8, 6]} intensity={0.85} />
      <directionalLight position={[-5, 4, 8]} intensity={0.42} color="#b4a8ff" />
      <Environment preset="city" />
      <Stars radius={100} depth={60} count={3000} factor={4} saturation={0} fade speed={0.6} />
      <DeepSpaceDust />

      {/* ── Ring：仅在选牌阶段渲染 ── */}
      <RingCarousel
        stopped={appPhase !== 'selection'}
        gestureScrollOffset={scrollOffset}
        verticalOffset={isPortraitMobile ? -0.75 : -0.95}
        thetaBridgeRef={thetaBridgeRef}
        rotationSpeed={rotationSpeed}
        focusTargetIndex={focusTargetIndex}
        onFocusedIndexChange={onFocusedIndexChange}
        onFocusTargetSettled={onFocusTargetSettled}
      >
        {appPhase === 'selection' &&
          Array.from({ length: CARD_COUNT }, (_, i) => (
            <RingCard
              key={i}
              index={i}
              total={CARD_COUNT}
              radius={RING_RADIUS}
              backMap={backMap}
              onPick={onRingPick}
              onRequestFocus={onRequestFocus}
              onHoverChange={onHoverCard}
              isFocused={i === focusedRingIndex}
            />
          ))}
      </RingCarousel>

      <EffectComposer>
        <Bloom
          luminanceThreshold={0.3}
          luminanceSmoothing={0.9}
          intensity={1.1}
          radius={0.85}
        />
      </EffectComposer>
    </>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  const [tarotDeck, setTarotDeck] = useState([]);
  const [deckStatus, setDeckStatus] = useState('loading');
  const [pastCard, setPastCard] = useState(null);
  const [presentCard, setPresentCard] = useState(null);
  const [futureCard, setFutureCard] = useState(null);
  const [appPhase, setAppPhase] = useState('selection');
  const [spreadSlots, setSpreadSlots] = useState(() => [null, null, null]);
  const [readingFlipped, setReadingFlipped] = useState(() => [false, false, false]);
  const [flyCard, setFlyCard] = useState(null);
  const [flyPhase, setFlyPhase] = useState('idle');
  const [flyTrail, setFlyTrail] = useState(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isRotating, setIsRotating] = useState(false);
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [focusedRingIndex, setFocusedRingIndex] = useState(0);
  const [centerIndex, setCenterIndex] = useState(0);
  const [focusTargetIndex, setFocusTargetIndex] = useState(null);
  const [gestureEnabled, setGestureEnabled] = useState(false);
  const [gestureUiStatus, setGestureUiStatus] = useState('no-hand');
  const [domTheta, setDomTheta] = useState(0);
  const [isDomDragging, setIsDomDragging] = useState(false);
  const [ritualState, setRitualState] = useState({ active: false, ringIndex: null, phase: 'idle' });
  const [gestureCursor, setGestureCursor] = useState({ x: 0.5, y: 0.5, visible: false });
  const [gestureState, setGestureState] = useState('NONE');
  const [handDetected, setHandDetected] = useState(false);
  const [raycastEnabled, setRaycastEnabled] = useState(false);
  const [cameraState, setCameraState] = useState('loading');
  const [aiSummary, setAiSummary] = useState('');
  const [aiStatus, setAiStatus] = useState('idle');
  const [aiFallbackNotice, setAiFallbackNotice] = useState('');
  const aiRequestKeyRef = useRef('');
  const [cameraHintDismissed, setCameraHintDismissed] = useState(false);
  const hoveredCardRef = useRef(null);
  const lastFistSelectTsRef = useRef(0);
  const prevDetectedGestureRef = useRef('OTHER');
  const ringThetaBridgeRef = useRef(0);
  const wasPalmRef = useRef(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [sceneSeed, setSceneSeed] = useState(0);
  const [isPortraitMobile, setIsPortraitMobile] = useState(false);
  const slotInnerRefs = [useRef(null), useRef(null), useRef(null)];
  const domCardRefs = useRef([]);
  const domCarouselRef = useRef(null);
  const flyCommitRef = useRef(null);
  const flyLockRef = useRef(false);
  const flyCommitTimerRef = useRef(null);
  const ritualStartRectRef = useRef(null);
  const gestureLockUntilRef = useRef(0);
  const readingFlipTimersRef = useRef([]);
  const ritualTimersRef = useRef([]);
  const lockBounceImpulseRef = useRef(0);
  const lockBounceTriggeredRef = useRef(false);
  const [slotSnapped, setSlotSnapped] = useState([false, false, false]);
  const [reshuffling, setReshuffling] = useState(false);

  // Ref-based taken set lets gesture callbacks read it without stale-closure issues
  const takenRingIndicesRef = useRef(new Set());

  const canvasWrapRef = useRef(null);

  // ── Sound hook placeholders ──────────────────────────────────────────────────
  const playSelectSound = () => { /* TODO: add grab/select sound */ };
  const playFlipSound = () => { /* TODO: add flip/reveal sound */ };

  useEffect(() => {
    if (cameraState === 'ready') {
      setCameraHintDismissed(true);
    }
  }, [cameraState]);

  useEffect(() => {
    const el = domCarouselRef.current;
    if (!el) return undefined;
    let rafId = 0;
    let theta = ringThetaBridgeRef.current || 0;
    let velocity = 0;
    let dragging = false;
    let lastX = 0;
    let prevTs = performance.now();
    let prevGestureScroll = scrollOffset;

    const onPointerDown = (e) => {
      if (appPhase !== 'selection') return;
      if (ritualState.active || flyLockRef.current) return;
      dragging = true;
      setIsDomDragging(true);
      lastX = e.clientX;
      velocity = 0;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const onPointerMove = (e) => {
      if (!dragging || appPhase !== 'selection') return;
      const now = performance.now();
      const dt = Math.max((now - prevTs) / 1000, 1 / 120);
      prevTs = now;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const dRad = dx * POINTER_PIXEL_TO_RAD;
      theta += dRad;
      velocity = dRad / dt;
    };
    const onPointerUp = (e) => {
      dragging = false;
      setIsDomDragging(false);
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const onWheel = (e) => {
      if (appPhase !== 'selection') return;
      if (ritualState.active || flyLockRef.current) return;
      e.preventDefault();
      const impulse = (e.deltaY + e.deltaX) * -0.001;
      theta += impulse;
      velocity += impulse * 34;
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    const tick = (ts) => {
      const delta = Math.min(0.05, (ts - prevTs) / 1000 || 1 / 60);
      prevTs = ts;
      if (appPhase === 'selection') {
        if (ritualState.active && Number.isInteger(ritualState.ringIndex)) {
          dragging = false;
          velocity = 0;
          prevGestureScroll = scrollOffset;
          const targetBase = -ritualState.ringIndex * RING_ANGLE_SLICE;
          const diff = Math.atan2(Math.sin(targetBase - theta), Math.cos(targetBase - theta));
          theta += diff * Math.min(1, delta * 11.5);
          if (
            ritualState.phase === 'locking' &&
            !lockBounceTriggeredRef.current &&
            Math.abs(diff) < 0.045
          ) {
            lockBounceTriggeredRef.current = true;
            lockBounceImpulseRef.current = -Math.sign(diff || 1) * 0.026;
          }
          if (Math.abs(lockBounceImpulseRef.current) > 0.00005) {
            theta += lockBounceImpulseRef.current;
            lockBounceImpulseRef.current *= Math.pow(0.82, delta * 60);
          } else {
            lockBounceImpulseRef.current = 0;
          }
        } else if (!dragging) {
          const gestureDelta = scrollOffset - prevGestureScroll;
          prevGestureScroll = scrollOffset;
          theta += gestureDelta + rotationSpeed * delta;
          velocity *= Math.pow(0.93, delta * 60);
          theta += velocity * delta;
          if (focusTargetIndex !== null && Number.isInteger(focusTargetIndex)) {
            const targetBase = -focusTargetIndex * RING_ANGLE_SLICE;
            const diff = Math.atan2(Math.sin(targetBase - theta), Math.cos(targetBase - theta));
            theta += diff * Math.min(1, delta * 10);
            if (Math.abs(diff) < 0.008) setFocusTargetIndex(null);
          }
          if (Math.abs(rotationSpeed) < 0.001 && Math.abs(velocity) < 0.04 && focusTargetIndex === null) {
            const snapTarget = Math.round(theta / RING_ANGLE_SLICE) * RING_ANGLE_SLICE;
            theta += (snapTarget - theta) * Math.min(1, delta * 9);
          }
        }
      }
      const normalizedTheta = THREE.MathUtils.euclideanModulo(theta, TWO_PI);
      ringThetaBridgeRef.current = normalizedTheta;
      setDomTheta(theta);
      const idx = computeFrontRingIndex(normalizedTheta);
      setFocusedRingIndex(idx);
      setCenterIndex(idx);
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [appPhase, focusTargetIndex, ritualState.active, ritualState.ringIndex, rotationSpeed, scrollOffset]);

  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const inSelection = appPhase === 'selection' && !flyLockRef.current;
      const target = inSelection && isRotating ? 1.05 : 0;
      setRotationSpeed((prev) => {
        const smooth = target > prev ? 0.085 : 0.34;
        const next = prev + (target - prev) * smooth;
        return Math.abs(next - target) < 0.004 ? target : next;
      });
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isRotating, appPhase]);

  const gestureManagerRef = useRef(
    new GestureManager({
      smoothFactor: 0.1,
      deadZoneX: 0.001,
      swipeSensitivity: 7,
      inertiaDamping: 0.9,
      stateLockMs: 200,
      palmStillMs: 100,
      /** 与握拳横移方向一致；若感觉左右反了改成 -1 */
      fistScrollSign: -1,
    }),
  );

  const pickCount = useMemo(() => spreadSlots.filter(Boolean).length, [spreadSlots]);

  // Which ring indices have already been committed to slots (drives "留空" in the carousel)
  const takenRingIndices = useMemo(
    () => new Set(spreadSlots.filter(Boolean).map((s) => s.ringIndex)),
    [spreadSlots],
  );
  useEffect(() => {
    takenRingIndicesRef.current = takenRingIndices;
  }, [takenRingIndices]);
  const getCardForRingIndex = useCallback(
    (ringIndex) => {
      if (!tarotDeck.length) return null;
      return tarotDeck[ringIndex % tarotDeck.length] ?? null;
    },
    [tarotDeck],
  );
  const resolveCardData = useCallback(
    (candidate) => {
      if (!candidate) return null;
      const byId = Number.isFinite(Number(candidate.id))
        ? tarotDeck.find((item) => Number(item.id) === Number(candidate.id))
        : null;
      if (byId) return byId;
      const cname = String(candidate.name ?? '').trim();
      if (!cname) return candidate;
      return tarotDeck.find((item) => String(item.name ?? '').trim() === cname) ?? candidate;
    },
    [tarotDeck],
  );
  const drawnCards = useMemo(
    () => [
      resolveCardData(spreadSlots[0]?.reading ?? pastCard),
      resolveCardData(spreadSlots[1]?.reading ?? presentCard),
      resolveCardData(spreadSlots[2]?.reading ?? futureCard),
    ],
    [resolveCardData, spreadSlots, pastCard, presentCard, futureCard],
  );
  const [pastData, presentData, futureData] = drawnCards;
  const compactAiSummary = useMemo(() => {
    const raw = String(aiSummary ?? '');
    return raw
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }, [aiSummary]);
  const readingCardsKey = useMemo(() => {
    const [past, present, future] = drawnCards;
    if (!past || !present || !future) return '';
    return [past.id ?? past.name ?? '', present.id ?? present.name ?? '', future.id ?? future.name ?? '']
      .map((v) => String(v))
      .join('|');
  }, [drawnCards]);
  const formattedAiSummary = useMemo(() => {
    const raw = String(compactAiSummary || '').trim();
    const [p, c, f] = drawnCards;
    const fallback = p && c && f ? `从${p.name}的阶段走来，你当前正面临${c.name}的影响，这预示着未来你将向${f.name}的状态演变。建议：保持觉察与行动并进，先接纳当下，再用稳定的小步推进，把机会落成现实。` : '';
    const source = raw || fallback;
    const getSection = (title) => {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = source.match(new RegExp(`【${escaped}】([\\s\\S]*?)(?=【(?:现状洞察|因果串联|行动建议)】|$)`));
      return m?.[1]?.replace(/\s+/g, ' ').trim() || '';
    };
    const sections = {
      insight: getSection('现状洞察'),
      chain: getSection('因果串联'),
      action: getSection('行动建议'),
    };
    if (!sections.insight || !sections.chain || !sections.action) {
      const normalized = source.replace(/\s+/g, ' ').trim();
      const parts = normalized
        .split(/[。！？]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const n = parts.length;
      if (!sections.insight) sections.insight = parts.slice(0, Math.max(1, Math.ceil(n / 3))).join('，') || normalized;
      if (!sections.chain)
        sections.chain = parts.slice(Math.ceil(n / 3), Math.max(Math.ceil((2 * n) / 3), Math.ceil(n / 3) + 1)).join('，') || normalized;
      if (!sections.action) sections.action = parts.slice(Math.ceil((2 * n) / 3)).join('，') || normalized;
    }
    return sections;
  }, [compactAiSummary, drawnCards]);
  const sectionBoundaries = useMemo(() => ({
    chainStarted: compactAiSummary.includes('【因果串联】'),
    actionStarted: compactAiSummary.includes('【行动建议】'),
  }), [compactAiSummary]);

  const readingTitle = useMemo(() => {
    if (pastCard && presentCard && futureCard) {
      return [pastCard, presentCard, futureCard].map((c) => c.name).join(' · ');
    }
    if (!spreadSlots.every(Boolean)) return '';
    return spreadSlots.map((s) => s.reading?.name ?? '').filter(Boolean).join(' · ');
  }, [spreadSlots, pastCard, presentCard, futureCard]);
  const fallbackSummary = useMemo(() => {
    const [past, present, future] = drawnCards;
    if (!past || !present || !future) return '';
    return `从${past.name}的阶段走来，你当前正面临${present.name}的影响，这预示着未来你将向${future.name}的状态演变。建议：保持觉察与行动并进，先接纳当下，再用稳定的小步推进，把机会落成现实。`;
  }, [drawnCards]);

  useEffect(() => {
    const [past, present, future] = drawnCards;
    if (!panelVisible || appPhase !== 'reading' || !past || !present || !future) {
      setAiSummary('');
      setAiStatus('idle');
      setAiFallbackNotice('');
      aiRequestKeyRef.current = '';
      return;
    }
    if (aiRequestKeyRef.current === readingCardsKey) return;
    aiRequestKeyRef.current = readingCardsKey;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 32000);

    setAiSummary('');
    setAiStatus('loading');
    setAiFallbackNotice('');

    const consumeStream = async () => {
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pastCard: past,
            presentCard: present,
            futureCard: future,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        setAiStatus('streaming');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.forEach((line) => {
            const t = line.trim();
            if (!t || !t.startsWith('data:')) return;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') return;
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                setAiSummary((prev) => prev + delta);
              }
            } catch {
              // 兼容后端已解析后的纯文本 SSE 分片
              if (payload) {
                setAiSummary((prev) => prev + payload);
              }
            }
          });
        }

        setAiStatus('done');
      } catch {
        setAiStatus('fallback');
        setAiSummary(fallbackSummary);
        setAiFallbackNotice('星轨信号微弱，基于牌面提供基础建议。');
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    consumeStream();

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [panelVisible, appPhase, drawnCards, fallbackSummary, readingCardsKey]);

  useEffect(() => {
    let cancelled = false;
    const tryFetchDeck = async () => {
      const candidates = ['/tarot-deck.csv', '/Tarot_Tarot卡片 (1).csv'];
      for (const url of candidates) {
        try {
          const r = await fetch(url);
          if (!r.ok) continue;
          return await r.text();
        } catch {
          // try next candidate
        }
      }
      throw new Error('deck csv not found');
    };

    tryFetchDeck()
      .then((text) => {
        if (cancelled) return;
        const deck = parseTarotDeckCsv(text);
        setTarotDeck(deck);
        setDeckStatus(deck.length ? 'ready' : 'error');
      })
      .catch(() => {
        if (!cancelled) setDeckStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRingPick = useCallback(
    (ringIndex, screenRect, options = {}) => {
      if (appPhase !== 'selection' || flyLockRef.current) return;
      if (!tarotDeck.length) return;
      gestureLockUntilRef.current = Math.max(gestureLockUntilRef.current, Date.now() + 1500);
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(50);
      }

      setSpreadSlots((prev) => {
        if (prev.some((s) => s && s.ringIndex === ringIndex)) return prev;
        const nextSlot = prev.findIndex((s) => !s);
        if (nextSlot < 0) return prev;
        const pickedCard = getCardForRingIndex(ringIndex);
        if (!pickedCard) return prev;

        const slotEl = slotInnerRefs[nextSlot]?.current;
        if (!slotEl) return prev;

        const targetRect = slotEl.getBoundingClientRect();
        const start = {
          left: screenRect.left,
          top: screenRect.top,
          width: screenRect.width,
          height: screenRect.height,
        };
        const end = {
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: targetRect.height,
        };
        const dx = end.left - start.left;
        const dy = end.top - start.top;
        const scaleTo = start.width > 0 ? end.width / start.width : 1;
        const startCenter = {
          x: start.left + start.width / 2,
          y: start.top + start.height / 2,
        };
        const endCenter = {
          x: end.left + end.width / 2,
          y: end.top + end.height / 2,
        };
        const rawAngle = ringIndex * RING_ANGLE_SLICE + ringThetaBridgeRef.current;
        const wrapped = Math.atan2(Math.sin(rawAngle), Math.cos(rawAngle));
        const computedStartRotateY = THREE.MathUtils.clamp((wrapped * 180) / Math.PI, -42, 42);
        const startRotateY = Number.isFinite(options.startRotateY)
          ? options.startRotateY
          : computedStartRotateY;

        queueMicrotask(() => {
          if (flyLockRef.current) return;
          flyLockRef.current = true;
          flyCommitRef.current = { slotIndex: nextSlot, ringIndex, reading: pickedCard };
          hoveredCardRef.current = null;

          const holdMs = options.holdMs ?? 0;
          const duration = options.durationMs ?? 820;

          playSelectSound();

          setFlyCard({
            start,
            end,
            dx,
            dy,
            scaleTo,
            slotIndex: nextSlot,
            ringIndex,
            backSrc: cardImageSrc(pickedCard, 'back'),
            startRotateY,
            durationMs: duration,
            startScale: options.startScale ?? 1.04,
          });

          if (flyCommitTimerRef.current) {
            window.clearTimeout(flyCommitTimerRef.current);
          }

          // Shared commit logic — called by both safety timer and transitionEnd
          const doCommit = () => {
            const commit = flyCommitRef.current;
            if (!commit) return;
            flyCommitRef.current = null;
            if (flyCommitTimerRef.current) {
              window.clearTimeout(flyCommitTimerRef.current);
              flyCommitTimerRef.current = null;
            }
            const { slotIndex: si, ringIndex: cRingIndex, reading } = commit;
            setSlotSnapped((prev) => { const n = [...prev]; n[si] = true; return n; });
            window.setTimeout(() => setSlotSnapped((prev) => { const n = [...prev]; n[si] = false; return n; }), 580);
            setSpreadSlots((prevSlots) => {
              const nextSlots = [...prevSlots];
              nextSlots[si] = { ringIndex: cRingIndex, reading };
              queueMicrotask(() => {
                setPastCard(nextSlots[0]?.reading ?? null);
                setPresentCard(nextSlots[1]?.reading ?? null);
                setFutureCard(nextSlots[2]?.reading ?? null);
              });
              if (nextSlots.every(Boolean)) {
                queueMicrotask(() => setAppPhase('reading'));
              }
              return nextSlots;
            });
            setFlyCard(null);
            setFlyTrail(null);
            setFlyPhase('idle');
            flyLockRef.current = false;
            // Reshuffle: 0.5s after card commits, carousel does a quick jostle
            window.setTimeout(() => {
              setReshuffling(true);
              window.setTimeout(() => setReshuffling(false), 530);
            }, 500);
          };

          if (holdMs > 0) {
            // Phase 1: hold at grab position with energy glow
            setFlyPhase('hold');
            const holdTimer = window.setTimeout(() => {
              // Phase 2: arc + flight — spawn trail right as the card starts moving
              setFlyTrail({
                id: `${Date.now()}-${ringIndex}-${nextSlot}`,
                start: startCenter,
                end: endCenter,
              });
              requestAnimationFrame(() => requestAnimationFrame(() => setFlyPhase('fly')));
              flyCommitTimerRef.current = window.setTimeout(doCommit, duration + 240);
            }, holdMs);
            ritualTimersRef.current.push(holdTimer);
          } else {
            setFlyPhase('start');
            setFlyTrail({
              id: `${Date.now()}-${ringIndex}-${nextSlot}`,
              start: startCenter,
              end: endCenter,
            });
            flyCommitTimerRef.current = window.setTimeout(doCommit, duration + 240);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => setFlyPhase('fly'));
            });
          }
        });

        return prev;
      });
    },
    [appPhase, getCardForRingIndex, tarotDeck],
  );

  const finalizeFlyCommit = useCallback(() => {
    const commit = flyCommitRef.current;
    if (!commit) return;
    flyCommitRef.current = null;
    if (flyCommitTimerRef.current) {
      window.clearTimeout(flyCommitTimerRef.current);
      flyCommitTimerRef.current = null;
    }
    const { slotIndex, ringIndex, reading } = commit;
    // Slot snap feedback on card landing
    setSlotSnapped((prev) => { const n = [...prev]; n[slotIndex] = true; return n; });
    window.setTimeout(() => setSlotSnapped((prev) => { const n = [...prev]; n[slotIndex] = false; return n; }), 580);
    setSpreadSlots((prev) => {
      const next = [...prev];
      next[slotIndex] = { ringIndex, reading };
      queueMicrotask(() => {
        setPastCard(next[0]?.reading ?? null);
        setPresentCard(next[1]?.reading ?? null);
        setFutureCard(next[2]?.reading ?? null);
      });
      if (next.every(Boolean)) {
        queueMicrotask(() => setAppPhase('reading'));
      }
      return next;
    });
    setFlyCard(null);
    setFlyTrail(null);
    setFlyPhase('idle');
    flyLockRef.current = false;
    window.setTimeout(() => {
      setReshuffling(true);
      window.setTimeout(() => setReshuffling(false), 530);
    }, 500);
  }, []);

  const onFlyTransitionEnd = useCallback(
    (e) => {
      if (e.propertyName !== 'transform') return;
      finalizeFlyCommit();
    },
    [finalizeFlyCommit],
  );

  useEffect(() => {
    if (appPhase !== 'reading') {
      readingFlipTimersRef.current.forEach((id) => window.clearTimeout(id));
      readingFlipTimersRef.current = [];
      setReadingFlipped([false, false, false]);
      setPanelVisible(false);
      return;
    }
    setReadingFlipped([false, false, false]);
    setPanelVisible(false);
    const tFlipAll = window.setTimeout(() => setReadingFlipped([true, true, true]), 380);
    const tPanel = window.setTimeout(() => setPanelVisible(true), 1120);
    readingFlipTimersRef.current = [tFlipAll, tPanel];
    return () => {
      readingFlipTimersRef.current.forEach((id) => window.clearTimeout(id));
      readingFlipTimersRef.current = [];
    };
  }, [appPhase]);

  useEffect(() => {
    if (appPhase === 'selection') return;
    setRitualState({ active: false, ringIndex: null, phase: 'idle' });
    ritualStartRectRef.current = null;
    lockBounceImpulseRef.current = 0;
    lockBounceTriggeredRef.current = false;
    ritualTimersRef.current.forEach((id) => window.clearTimeout(id));
    ritualTimersRef.current = [];
    if (flyCommitTimerRef.current) {
      window.clearTimeout(flyCommitTimerRef.current);
      flyCommitTimerRef.current = null;
    }
  }, [appPhase]);

  const handleReset = () => {
    setIsTransitioning(true);
    setPanelVisible(false);
    setTimeout(() => {
      setAppPhase('selection');
      setReshuffling(false);
      setSpreadSlots([null, null, null]);
      setPastCard(null);
      setPresentCard(null);
      setFutureCard(null);
      setAiSummary('');
      setAiStatus('idle');
      setAiFallbackNotice('');
      setReadingFlipped([false, false, false]);
      setFlyCard(null);
      setFlyTrail(null);
      setFlyPhase('idle');
      setRitualState({ active: false, ringIndex: null, phase: 'idle' });
      ritualStartRectRef.current = null;
      lockBounceImpulseRef.current = 0;
      lockBounceTriggeredRef.current = false;
      flyCommitRef.current = null;
      flyLockRef.current = false;
      if (flyCommitTimerRef.current) {
        window.clearTimeout(flyCommitTimerRef.current);
        flyCommitTimerRef.current = null;
      }
      gestureLockUntilRef.current = 0;
      ritualTimersRef.current.forEach((id) => window.clearTimeout(id));
      ritualTimersRef.current = [];
      setScrollOffset(0);
      setIsRotating(false);
      setRotationSpeed(0);
      setFocusedRingIndex(0);
      setFocusTargetIndex(null);
      setGestureUiStatus('no-hand');
      setGestureCursor({ x: 0.5, y: 0.5, visible: false });
      setGestureState('NONE');
      setHandDetected(false);
      setRaycastEnabled(false);
      setCameraState('loading');
      hoveredCardRef.current = null;
      wasPalmRef.current = false;
      setSceneSeed((v) => v + 1);
      gestureManagerRef.current.reset();
      document.body.style.cursor = 'auto';
      setTimeout(() => setIsTransitioning(false), 260);
    }, 380);
  };

  useEffect(() => {
    const updateViewportMode = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setIsPortraitMobile(w <= 768 && h > w);
    };
    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    window.addEventListener('orientationchange', updateViewportMode);
    return () => {
      window.removeEventListener('resize', updateViewportMode);
      window.removeEventListener('orientationchange', updateViewportMode);
    };
  }, []);

  const dispatchPointerToCanvas = (normalizedPos, eventTypes) => {
    if (!canvasWrapRef.current) return false;
    const canvas = canvasWrapRef.current.querySelector('canvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + normalizedPos.x * rect.width;
    const clientY = rect.top + normalizedPos.y * rect.height;

    eventTypes.forEach((type) => {
      const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      });
      canvas.dispatchEvent(evt);
    });
    return true;
  };

  const hoverCanvasAtCursor = (normalizedPos) =>
    dispatchPointerToCanvas(normalizedPos, ['pointermove']);

  const handleHoverCard = (ringIndex, payload) => {
    if (ringIndex === null || !payload?.screenRect) {
      hoveredCardRef.current = null;
      return;
    }
    hoveredCardRef.current = { ringIndex, screenRect: payload.screenRect };
  };

  const handleFocusRequest = (ringIndex) => {
    if (appPhase !== 'selection') return;
    setFocusTargetIndex(ringIndex);
  };

  const getVisualCenterRingIndex = useCallback(() => {
    // Needle is fixed at horizontal viewport center — measure each card's
    // center X against that needle and pick the closest non-taken card.
    const needleX = window.innerWidth / 2;
    const taken = takenRingIndicesRef.current;
    let bestIdx = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const el = domCardRefs.current[i];
      if (!el) continue;
      if (taken.has(i)) continue; // skip already-taken slots
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cardCenterX = r.left + r.width / 2;
      const dist = Math.abs(cardCenterX - needleX);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, []);

  const triggerFistSelectionRitual = useCallback(
    (rawRingIndex) => {
      const visualIdx = getVisualCenterRingIndex();
      const ringIndex = Number.isInteger(visualIdx) ? visualIdx : rawRingIndex;
      if (appPhase !== 'selection' || flyLockRef.current) return;
      if (ritualState.active) return;
      setIsRotating(false);
      setRotationSpeed(0);
      setScrollOffset(0);
      lockBounceImpulseRef.current = 0;
      lockBounceTriggeredRef.current = false;
      setFocusTargetIndex(ringIndex);
      setRitualState({ active: true, ringIndex, phase: 'locking' });
      gestureLockUntilRef.current = Math.max(gestureLockUntilRef.current, Date.now() + GESTURE_LOCK_MS);
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate([36, 32, 36]);
      }
      ritualTimersRef.current.forEach((id) => window.clearTimeout(id));
      ritualTimersRef.current = [];
      const tAlign = window.setTimeout(() => {
        setRitualState((prev) =>
          prev.active && prev.ringIndex === ringIndex ? { ...prev, phase: 'focused' } : prev,
        );
      }, LOCK_ALIGN_MS);
      // Re-capture rect after ring has snapped to center — guarantees visual sync
      const tFly = window.setTimeout(() => {
        const freshRect = domCardRefs.current[ringIndex]?.getBoundingClientRect() ?? null;
        if (!freshRect) return;
        handleRingPick(ringIndex, freshRect, {
          durationMs: 1000,
          startRotateY: 0,
          holdMs: HOLD_DURATION_MS,
        });
      }, LOCK_ALIGN_MS);
      const tEnd = window.setTimeout(() => {
        setRitualState({ active: false, ringIndex: null, phase: 'idle' });
      }, LOCK_ALIGN_MS + 120);
      ritualTimersRef.current = [tAlign, tFly, tEnd];
    },
    [appPhase, getVisualCenterRingIndex, handleRingPick, ritualState.active],
  );

  useEffect(
    () => () => {
      ritualTimersRef.current.forEach((id) => window.clearTimeout(id));
      ritualTimersRef.current = [];
    },
    [],
  );

  // ── Gesture ─────────────────────────────────────────────────────────────────
  const handleHandsDetected = (handsData) => {
    const now = Date.now();
    if (!gestureEnabled) {
      setHandDetected(false);
      setGestureState('NONE');
      setGestureCursor((v) => ({ ...v, visible: false }));
      setRaycastEnabled(false);
      setScrollOffset(0);
      setIsRotating(false);
      wasPalmRef.current = false;
      prevDetectedGestureRef.current = 'OTHER';
      return;
    }
    if (now < gestureLockUntilRef.current) {
      setGestureState('LOCKED');
      setRaycastEnabled(false);
      setScrollOffset(0);
      setIsRotating(false);
      return;
    }
    const primaryHand = handsData?.[0] ?? null;
    const inSelection =
      appPhase === 'selection' &&
      pickCount < 3 &&
      !flyLockRef.current &&
      deckStatus === 'ready' &&
      tarotDeck.length > 0;
    const readingFlipDone = readingFlipped.every(Boolean);
    const result = gestureManagerRef.current.process(primaryHand, {
      hasSelectedCard: appPhase === 'reading',
      isFlipped: readingFlipDone,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 900,
      selectionPalmEdgeOnly: appPhase === 'selection',
    });

    setGestureCursor(result.cursor);
    setGestureState(result.state === 'CLOSED_FIST' ? 'FIST' : result.state === 'OPEN_PALM' ? 'PALM' : 'OTHER');
    setHandDetected(Boolean(primaryHand));
    setRaycastEnabled(result.raycastEnabled && !panelVisible && appPhase === 'selection');
    setScrollOffset(result.scrollOffset);
    const fistEdge =
      result.state === 'CLOSED_FIST' && prevDetectedGestureRef.current !== 'CLOSED_FIST';
    const isPalm = result.state === 'OPEN_PALM';
    setIsRotating((isPalm || gestureUiStatus === 'open-palm') && inSelection);

    if (result.cursor.visible && inSelection && !panelVisible) {
      hoverCanvasAtCursor(result.cursor);
    }

    if (fistEdge && inSelection && !panelVisible) {
      if (now - lastFistSelectTsRef.current > 700) {
        lastFistSelectTsRef.current = now;
        setIsRotating(false);
        setRotationSpeed(0);
        setScrollOffset(0);
        triggerFistSelectionRitual(centerIndex);
      }
    }
    wasPalmRef.current = isPalm;
    prevDetectedGestureRef.current = result.state;
  };

  const handlePinchDetected = () => {};
  const gestureHintText = !gestureEnabled
    ? '手势识别已关闭'
    : Date.now() < gestureLockUntilRef.current
      ? '⏳ 命运共振中，请稍候...'
    : gestureUiStatus === 'open-palm'
      ? '🔮 灵力感应中，正在洗牌...'
      : gestureUiStatus === 'fist'
        ? '✨ 已定格！正在翻开命定之牌...'
        : '请展示你的手掌...';
  const guideText =
    deckStatus === 'error'
      ? '牌库加载失败：请确认 public/tarot-deck.csv 存在且格式正确'
      : deckStatus === 'loading'
        ? '正在加载牌库…'
        : appPhase === 'reading'
          ? '三张牌已就位，静观牌面依次为你翻开'
          : pickCount === 0
            ? '从环中点选三张牌：依次落入过去、现在、未来；每次选中均与当前中心卡牌一一对应'
            : pickCount === 1
              ? '已选 1/3 · 继续选择「现在」'
              : pickCount === 2
                ? '已选 2/3 · 再选一张完成「未来」'
                : '正在完成选牌…';
  const cameraConfig = isPortraitMobile
    ? { position: [0, 0.2, 10], fov: 54 }
    : { position: [0, 0.5, 11], fov: 48 };
  const exposure = isPortraitMobile ? 1.2 : 1.15;

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        /* dvh for mobile browsers that adjust for URL bar */
        // fallback to 100vh above, override below via CSS
        background: '#07021a',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <HandGestureDetector
        enabled={gestureEnabled && appPhase === 'selection'}
        onHandsDetected={handleHandsDetected}
        onPinchDetected={handlePinchDetected}
        onCameraStateChange={setCameraState}
        onGestureStatusChange={setGestureUiStatus}
        onFirstHandLandmarks={() => setCameraHintDismissed(true)}
      />

      {appPhase === 'selection' && (
        <div
          style={{
            position: 'absolute',
            top: 'max(12px, env(safe-area-inset-top))',
            right: 'max(12px, env(safe-area-inset-right))',
            zIndex: 30,
          }}
        >
          <button
            type="button"
            onClick={() => {
              const next = !gestureEnabled;
              setGestureEnabled(next);
              if (!next) {
                setIsRotating(false);
                setRotationSpeed(0);
                setGestureUiStatus('no-hand');
              }
            }}
            style={{
              border: '1px solid rgba(212,175,55,0.45)',
              borderRadius: 10,
              background: gestureEnabled ? 'rgba(28,18,58,0.82)' : 'rgba(12,10,20,0.78)',
              color: '#f7efd8',
              fontSize: 12,
              padding: '7px 10px',
              letterSpacing: 0.4,
              cursor: 'pointer',
              boxShadow: '0 0 16px rgba(0,0,0,0.25)',
            }}
          >
            {gestureEnabled ? '关闭手势识别' : '开启手势识别'}
          </button>
        </div>
      )}

      {/* ── Minimal Top Guide ── */}
      <div
        className="top-guide"
        style={{
          position: 'absolute',
          top: 'max(10px, env(safe-area-inset-top))',
          left: '50%',
          transform: 'translateX(-50%)',
          textAlign: 'center',
          zIndex: 16,
          pointerEvents: 'none',
          userSelect: 'none',
          width: 'min(82vw, 620px)',
        }}
      >
        <div
          style={{
            fontSize: 'clamp(10px,1.2vw,13px)',
            letterSpacing: 'clamp(3px,0.8vw,7px)',
            textTransform: 'uppercase',
            marginBottom: 6,
            fontFamily: 'Georgia,serif',
            background: 'linear-gradient(90deg,#af8327 0%,#fff1bd 50%,#af8327 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: '0 0 12px rgba(212,175,55,0.2)',
            animation: 'titleBreath 3.6s ease-in-out infinite',
          }}
        >
          神秘塔罗 · MYSTIC TAROT
        </div>
        <div
          style={{
            color: 'rgba(247,239,216,0.58)',
            fontSize: 'clamp(10px,1.1vw,13px)',
            letterSpacing: 1.2,
            lineHeight: 1.42,
            fontFamily: 'Georgia,serif',
            maxWidth: 560,
            margin: '0 auto',
          }}
        >
          {guideText}
        </div>
      </div>
      {appPhase === 'selection' && (
        <div
          style={{
            position: 'absolute',
            top: 'max(74px, calc(env(safe-area-inset-top) + 62px))',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            pointerEvents: 'none',
            border: '1px solid rgba(245, 206, 122, 0.35)',
            borderRadius: 11,
            background: 'rgba(16,10,34,0.7)',
            color: '#f7efd8',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            padding: '7px 12px',
            fontSize: 'clamp(11px,1.2vw,13px)',
            letterSpacing: 0.5,
            boxShadow: '0 0 20px rgba(212,175,55,0.2)',
            textAlign: 'center',
            minWidth: 'min(84vw, 280px)',
          }}
        >
          {gestureHintText}
        </div>
      )}

      {/* ── Carousel area ── */}
      <div
        ref={canvasWrapRef}
        className="canvas-shell"
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          touchAction: 'none',
          paddingTop: 'clamp(64px, 9vh, 110px)',
        }}
      >
        <div
          ref={domCarouselRef}
          style={{
            width: '100%',
            height: '100%',
            position: 'relative',
            pointerEvents: panelVisible || appPhase !== 'selection' ? 'none' : 'auto',
            perspective: 1400,
            perspectiveOrigin: '50% 42%',
          }}
        >
          {appPhase === 'selection' && (
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: isPortraitMobile ? '44%' : '46%',
                width: 'min(92vw, 980px)',
                height: 'min(48vh, 360px)',
                transform: 'translate(-50%, -50%)',
                transformStyle: 'preserve-3d',
              }}
            >
              {/* Reshuffle wrapper — receives the jostle animation when a card is committed */}
              <div
                className={reshuffling ? 'carousel-reshuffle' : ''}
                style={{ width: '100%', height: '100%', position: 'relative', transformStyle: 'preserve-3d' }}
              >
              {Array.from({ length: CARD_COUNT }, (_, i) => {
                const angle = i * RING_ANGLE_SLICE + domTheta;
                const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
                const distNorm = Math.min(1, Math.abs(wrapped) / (Math.PI * 0.9));
                const focusAlpha = 1 - distNorm;
                const isFocused = i === centerIndex;
                const cardData = getCardForRingIndex(i);
                const isRitualCard = ritualState.active && ritualState.ringIndex === i;
                const isTakingOffGhost = flyCard && (flyPhase === 'fly' || flyPhase === 'hold') && flyCard.ringIndex === i;
                // Cards already committed to a slot become invisible — preserving the "留空" gap
                const isTaken = takenRingIndices.has(i);
                const ritualScaleBoost = isRitualCard
                  ? ritualState.phase === 'focused'
                    ? 0.96
                    : 0.92
                  : 1;
                const scale = (isFocused ? 1.25 : 0.8 + focusAlpha * 0.3) * ritualScaleBoost;
                const opacity = isTakingOffGhost ? 0 : isTaken ? 0 : isFocused ? 1 : 0.6 + focusAlpha * 0.3;
                const tilt = (1 - focusAlpha) * 14 * Math.sign(wrapped || 1);
                const angleDeg = (angle * 180) / Math.PI;
                const ringTransform = `translate(-50%, -50%) rotateY(${angleDeg}deg) translate3d(0,0,${DOM_CAROUSEL_RADIUS}px) rotateY(${
                  -angleDeg + tilt
                }deg) scale(${scale})`;
                return (
                  <button
                    key={i}
                    ref={(el) => {
                      domCardRefs.current[i] = el;
                    }}
                    data-ring-index={i}
                    data-card-id={cardData?.id ?? i}
                    type="button"
                    onClick={() => {
                      if (ritualState.active || isTaken) return;
                      if (!isFocused) {
                        setFocusTargetIndex(i);
                        return;
                      }
                      const rect = domCardRefs.current[i]?.getBoundingClientRect();
                      if (!rect) return;
                      handleRingPick(i, rect);
                    }}
                    className={
                      isRitualCard
                        ? ritualState.phase === 'focused'
                          ? 'active-focus'
                          : 'selected-pulse'
                        : ''
                    }
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: '50%',
                      width: 'clamp(74px, 8.2vw, 112px)',
                      aspectRatio: '78/124',
                      border: isFocused
                        ? '1px solid rgba(255,215,122,0.9)'
                        : '1px solid rgba(212,175,55,0.38)',
                      borderRadius: 12,
                      background: 'url(/Card1.jpg) center / cover no-repeat',
                      backgroundColor: 'rgba(15,9,32,0.92)',
                      boxShadow: isFocused
                        ? '0 0 32px rgba(255,215,122,0.65), 0 12px 28px rgba(0,0,0,0.48)'
                        : '0 7px 16px rgba(0,0,0,0.36)',
                      opacity,
                      filter: (isTakingOffGhost || isTaken)
                        ? 'none'
                        : `brightness(${isFocused ? 1.2 : 0.85 + focusAlpha * 0.2})`,
                      transform: ringTransform,
                      transformStyle: 'preserve-3d',
                      transition: isTaken ? 'opacity 0.15s ease' : 'all 0.5s ease-out',
                      zIndex: isFocused ? 120 : Math.round(20 + focusAlpha * 40),
                      cursor: isFocused && !isTaken ? 'pointer' : 'default',
                      pointerEvents: isTaken || isTakingOffGhost ? 'none' : 'auto',
                      outline: 'none',
                    }}
                  />
                );
              })}
              </div>
            </div>
          )}
          {/* ── Needle: fixed pointer used for card selection detection ── */}
          {appPhase === 'selection' && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '50%',
                top: isPortraitMobile ? '31%' : '33%',
                transform: 'translate(-50%, 0)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                pointerEvents: 'none',
                zIndex: 130,
              }}
            >
              {/* Arrowhead */}
              <div
                className="needle-tip"
                style={{
                  width: 0,
                  height: 0,
                  borderLeft: '9px solid transparent',
                  borderRight: '9px solid transparent',
                  borderTop: '15px solid rgba(255, 213, 122, 0.92)',
                }}
              />
              {/* Stem line */}
              <div
                style={{
                  width: 2,
                  height: 18,
                  background: 'linear-gradient(180deg, rgba(255,213,122,0.75) 0%, rgba(255,213,122,0) 100%)',
                }}
              />
            </div>
          )}
        </div>
        {appPhase === 'reading' && spreadSlots.every(Boolean) && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 'max(20px, env(safe-area-inset-bottom))',
              zIndex: 34,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-end',
              gap: 'clamp(10px, 3.2vw, 24px)',
              pointerEvents: 'none',
              paddingLeft: 14,
              paddingRight: 14,
            }}
          >
            {spreadSlots.map((slot, i) => (
              <div
                key={`${slot.ringIndex}-${i}`}
                style={{
                  flex: '1 1 0',
                  maxWidth: 168,
                  perspective: 1100,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    aspectRatio: '78/124',
                    transformStyle: 'preserve-3d',
                    transition: 'transform 0.72s cubic-bezier(0.22, 1, 0.36, 1)',
                    transform: readingFlipped[i] ? 'rotateY(180deg)' : 'rotateY(0deg)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 11,
                      overflow: 'hidden',
                      backfaceVisibility: 'hidden',
                      WebkitBackfaceVisibility: 'hidden',
                      boxShadow: '0 10px 32px rgba(0,0,0,0.45)',
                      border: '1px solid rgba(212,175,55,0.35)',
                    }}
                  >
                    <img
                      src={cardImageSrc(slot.reading, 'back')}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </div>
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 11,
                      overflow: 'hidden',
                      backfaceVisibility: 'hidden',
                      WebkitBackfaceVisibility: 'hidden',
                      transform: 'rotateY(180deg)',
                      boxShadow: '0 10px 32px rgba(0,0,0,0.45)',
                      border: '1px solid rgba(212,175,55,0.45)',
                    }}
                  >
                    <img
                      src={cardImageSrc(slot.reading)}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </div>
                </div>
                <div
                  style={{
                    marginTop: 8,
                    textAlign: 'center',
                    fontSize: 11,
                    letterSpacing: 0.6,
                    color: 'rgba(247,239,216,0.78)',
                    fontFamily: 'Georgia,serif',
                  }}
                >
                  {SPREAD_SLOT_LABELS[i]}
                </div>
              </div>
            ))}
          </div>
        )}

        {flyTrail && (
          <svg
            key={flyTrail.id}
            width="100%"
            height="100%"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 188,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            <defs>
              <linearGradient id="fateArcGlow" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(255,217,122,0.85)" />
                <stop offset="100%" stopColor="rgba(255,217,122,0.08)" />
              </linearGradient>
            </defs>
            <path
              className="arc-trace"
              d={`M ${flyTrail.start.x} ${flyTrail.start.y} Q ${(flyTrail.start.x + flyTrail.end.x) / 2} ${
                Math.min(flyTrail.start.y, flyTrail.end.y) - 70
              } ${flyTrail.end.x} ${flyTrail.end.y}`}
              fill="none"
              stroke="url(#fateArcGlow)"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
          </svg>
        )}

        {flyCard && (
          <img
            id="selected-flying-card"
            className={
              flyPhase === 'hold' ? 'card-hold-energy' :
              flyPhase === 'start' ? 'selected-pulse' : 'card-flying'
            }
            src={flyCard.backSrc || '/Card1.jpg'}
            alt=""
            onTransitionEnd={onFlyTransitionEnd}
            style={{
              position: 'fixed',
              zIndex: 9998,
              pointerEvents: 'none',
              objectFit: 'cover',
              borderRadius: 11,
              border: flyPhase === 'hold'
                ? '1.5px solid rgba(255,215,0,0.9)'
                : '1px solid rgba(212,175,55,0.4)',
              boxShadow: flyPhase === 'hold'
                ? 'none'
                : '0 14px 44px rgba(0,0,0,0.55)',
              left: flyCard.start.left,
              top: flyCard.start.top,
              width: flyCard.start.width,
              height: flyCard.start.height,
              // hold phase: CSS animation owns the transform; fly phase: CSS transition
              transform: flyPhase === 'fly'
                ? `translate(${flyCard.dx ?? 0}px, ${flyCard.dy ?? 0}px) rotateY(0deg) rotateZ(0deg) scale(${flyCard.scaleTo ?? 1})`
                : flyPhase === 'hold'
                ? undefined
                : `rotateY(${flyCard.startRotateY ?? 0}deg) rotateZ(-2deg) scale(${flyCard.startScale ?? 1.04})`,
              transition: flyPhase === 'fly'
                ? `transform ${flyCard.durationMs ?? 820}ms cubic-bezier(0.25, 0.46, 0.45, 0.94), filter 0.4s ease`
                : 'none',
            }}
          />
        )}

      </div>

      {appPhase === 'selection' && (
        <div
          style={{
            flexShrink: 0,
            zIndex: 28,
            padding: '10px clamp(12px, 4vw, 28px) max(12px, env(safe-area-inset-bottom))',
            background: 'linear-gradient(180deg, transparent 0%, rgba(7,2,26,0.92) 38%, rgba(5,2,14,0.98) 100%)',
            borderTop: '1px solid rgba(212,175,55,0.22)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 'clamp(12px, 4vw, 32px)',
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  flex: '1 1 0',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  minWidth: 0,
                }}
              >
                <div
                  ref={slotInnerRefs[i]}
                  className={slotSnapped[i] ? 'slot-snap' : ''}
                  style={{
                    width: '100%',
                    maxWidth: 92,
                    aspectRatio: '78 / 124',
                    borderRadius: 11,
                    border: spreadSlots[i]
                      ? '1px solid rgba(212,175,55,0.5)'
                      : '1px dashed rgba(212,175,55,0.42)',
                    background: spreadSlots[i]
                      ? `url(${cardImageSrc(spreadSlots[i].reading, 'back')}) center / cover no-repeat`
                      : 'rgba(14,8,34,0.45)',
                    boxShadow: spreadSlots[i] ? '0 8px 22px rgba(0,0,0,0.38)' : 'inset 0 0 0 1px rgba(255,255,255,0.04)',
                  }}
                />
                <div
                  style={{
                    marginTop: 9,
                    fontSize: 'clamp(10px, 2.8vw, 12px)',
                    color: 'rgba(247,239,216,0.76)',
                    textAlign: 'center',
                    fontFamily: 'Georgia,serif',
                    letterSpacing: 0.4,
                    lineHeight: 1.35,
                  }}
                >
                  {SPREAD_SLOT_LABELS[i]}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {appPhase === 'reading' && (
        <button
          className="reset-btn"
          onClick={handleReset}
          aria-label="重新抽牌"
          style={{
            position: 'absolute',
            top: 'max(14px, env(safe-area-inset-top))',
            right: 'clamp(12px, 2vw, 24px)',
            width: 38,
            height: 38,
            borderRadius: 999,
            border: '1px solid rgba(212,175,55,0.72)',
            background: 'rgba(14,8,34,0.5)',
            color: '#ffd87d',
            fontSize: 17,
            lineHeight: 1,
            cursor: 'pointer',
            zIndex: 42,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            boxShadow: '0 0 16px rgba(212,175,55,0.18)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(212,175,55,0.2)';
            e.currentTarget.style.boxShadow = '0 0 18px rgba(212,175,55,0.35)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(14,8,34,0.5)';
            e.currentTarget.style.boxShadow = '0 0 16px rgba(212,175,55,0.18)';
          }}
        >
          ↺
        </button>
      )}

      {/* ── Result panel — 过去/现在/将来 三栏 + 命运结语 ── */}
      <div
        className="result-panel"
        style={{
          position: 'relative',
          margin: panelVisible
            ? '0 clamp(10px,2vw,22px) max(10px, env(safe-area-inset-bottom))'
            : '0 clamp(10px,2vw,22px) 0',
          maxHeight: panelVisible ? 'min(52vh, 420px)' : '0px',
          opacity: panelVisible ? 1 : 0,
          transform: `translateY(${panelVisible ? '0' : '10px'})`,
          transition:
            'max-height 0.62s cubic-bezier(0.22,1,0.36,1), opacity 0.35s ease, transform 0.35s ease, margin 0.35s ease',
          background: 'linear-gradient(180deg, rgba(10,5,26,0.88) 0%, rgba(5,2,14,0.94) 100%)',
          backdropFilter: 'blur(20px) saturate(125%)',
          WebkitBackdropFilter: 'blur(20px) saturate(125%)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 'clamp(12px,1.8vw,16px)',
          padding: 'clamp(14px,2vw,22px) clamp(14px,3vw,28px) clamp(14px,2vw,20px)',
          zIndex: 30,
          boxShadow: '0 -8px 48px rgba(0,0,0,0.6)',
          overflowX: 'hidden',
          overflowY: panelVisible ? 'auto' : 'hidden',
          pointerEvents: panelVisible ? 'auto' : 'none',
        }}
      >
        <div
          className="result-panel-content"
          style={{
            maxWidth: 1060,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 'clamp(10px, 2.2vw, 18px)',
            alignItems: 'stretch',
          }}
        >
          {[
            { title: '过去 (Past)', cardData: pastData, position: 'past' },
            { title: '现在 (Present)', cardData: presentData, position: 'present' },
            { title: '将来 (Future)', cardData: futureData, position: 'future' },
          ].map((col) => (
            <div
              key={col.title}
              className="reading-col"
              style={{
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                background: 'linear-gradient(180deg, rgba(16,10,34,0.62) 0%, rgba(9,5,22,0.72) 100%)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                padding: '12px 12px 14px',
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <InterpretationCard
                position={col.position}
                name={col.cardData?.name}
                tags={col.cardData?.tags}
                description={col.cardData?.description}
              />
            </div>
          ))}
        </div>

        <div
          className="fate-summary-shell"
          style={{
            marginTop: 14,
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            background: 'linear-gradient(180deg, rgba(14,9,32,0.62) 0%, rgba(8,4,20,0.78) 100%)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            boxShadow: '0 8px 26px rgba(0,0,0,0.28)',
            padding: '12px 14px',
          }}
        >
          <div
            style={{
              fontSize: 13,
              letterSpacing: 2.4,
              marginBottom: 8,
              color: '#f5deb3',
              textTransform: 'uppercase',
            }}
          >
            命运结语
          </div>
          <div
            style={{
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 15,
              padding: '12px 14px',
            }}
          >
            {aiStatus === 'loading' ? (
              <p
                style={{
                  margin: 0,
                  color: '#dddddd',
                  fontSize: 'clamp(13px,1.25vw,14px)',
                  lineHeight: 1.8,
                  minHeight: 54,
                  textAlign: 'left',
                }}
              >
                <span className="fate-loading">✦ 猫灵正在翻阅星历...</span>
              </p>
            ) : (
              <div
                style={{
                  margin: 0,
                  color: '#dddddd',
                  fontSize: 'clamp(13px,1.25vw,14px)',
                  lineHeight: 1.8,
                  overflowWrap: 'anywhere',
                  wordBreak: 'break-word',
                  whiteSpace: 'normal',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {/* 现状洞察 — always first */}
                <div className="fate-section">
                  <span style={{ color: '#f5ce7c', fontWeight: 600 }}>【现状洞察】</span>
                  <span>{formattedAiSummary.insight || readingTitle || '—'}</span>
                </div>
                {/* 因果串联 — appears when header arrives in stream */}
                {sectionBoundaries.chainStarted && (
                  <div className="fate-section section-appear">
                    <span style={{ color: '#f5ce7c', fontWeight: 600 }}>【因果串联】</span>
                    <span>{formattedAiSummary.chain || '—'}</span>
                  </div>
                )}
                {/* 行动建议 — appears last */}
                {sectionBoundaries.actionStarted && (
                  <div className="fate-section section-appear">
                    <span style={{ color: '#f5ce7c', fontWeight: 600 }}>【行动建议】</span>
                    <span>{formattedAiSummary.action || '—'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          {aiFallbackNotice && (
            <div
              style={{
                marginTop: 8,
                color: 'rgba(255, 216, 125, 0.86)',
                fontSize: 12,
                letterSpacing: 0.3,
              }}
            >
              {aiFallbackNotice}
            </div>
          )}
        </div>
      </div>

      {isTransitioning && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 80,
            pointerEvents: 'none',
            background:
              'radial-gradient(circle at center, rgba(18,10,42,0.3) 0%, rgba(7,2,26,0.88) 72%, rgba(7,2,26,0.96) 100%)',
            animation: 'resetFade 0.62s ease',
          }}
        />
      )}

      {gestureEnabled &&
        !cameraHintDismissed &&
        (cameraState === 'loading' || cameraState === 'needs-user-gesture') && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(7,2,26,0.2), rgba(7,2,26,0.42))',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              border: '1px solid rgba(212,175,55,0.52)',
              borderRadius: 12,
              padding: '12px 14px',
              color: '#f7efd8',
              background: 'rgba(10,5,26,0.75)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              textAlign: 'center',
              maxWidth: 'min(88vw, 360px)',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {cameraState === 'loading'
              ? '正在初始化摄像头与手势识别...'
              : '请点击屏幕并允许摄像头权限，启用手势交互'}
          </div>
        </div>
      )}


      <style>{`
        * { box-sizing: border-box; }

        /* Mobile: use dynamic viewport height to account for browser chrome */
        @supports (height: 100dvh) {
          body, #root { height: 100dvh !important; }
        }
        html, body, #root { width: 100%; overflow: hidden; }

        .canvas-shell {
          transform: translateZ(0);
          transform-style: preserve-3d;
        }
        .canvas-shell canvas {
          transform: translateZ(0);
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
          will-change: transform;
        }

        @keyframes titleBreath {
          0%,100% { filter:brightness(0.92); opacity:0.72; }
          50%     { filter:brightness(1.08); opacity:0.9; }
        }
        @keyframes resetFade {
          0%   { opacity:0; }
          35%  { opacity:1; }
          100% { opacity:0; }
        }
        @keyframes fateBlink {
          0%,100% { opacity: 0.48; text-shadow: 0 0 8px rgba(255,216,125,0.28); }
          50% { opacity: 1; text-shadow: 0 0 16px rgba(255,216,125,0.56); }
        }
        .selected-pulse {
          animation: flash-gold 0.6s ease-out forwards, card-vibe 0.28s linear 2;
          z-index: 100;
          will-change: transform, filter, box-shadow;
        }
        .active-focus {
          animation: focusAura 1s ease-in-out infinite;
          z-index: 140;
          will-change: transform, filter, box-shadow;
          filter:
            drop-shadow(0 0 8px rgba(255, 215, 100, 0.92))
            drop-shadow(0 0 18px rgba(255, 215, 100, 0.72))
            drop-shadow(0 0 28px rgba(255, 215, 100, 0.44));
          box-shadow:
            0 0 18px rgba(255, 213, 122, 0.78),
            0 0 32px rgba(255, 213, 122, 0.56),
            0 0 54px rgba(255, 213, 122, 0.32);
        }
        .card-flying {
          position: absolute;
          pointer-events: none;
          will-change: left, top, width, height, transform;
        }

        /* ── Needle pulse ── */
        @keyframes needlePulse {
          0%, 100% {
            filter: drop-shadow(0 0 5px rgba(255,201,92,0.55));
            opacity: 0.82;
          }
          50% {
            filter: drop-shadow(0 0 18px rgba(255,201,92,1)) drop-shadow(0 0 6px rgba(255,255,200,0.6));
            opacity: 1;
          }
        }
        .needle-tip {
          animation: needlePulse 1.6s ease-in-out infinite;
        }

        /* ── Hold phase: energy focus glow + breathing (scale up to 1.10) ── */
        @keyframes cardHoldEnergy {
          0%, 100% {
            transform: scale(1.02);
            filter: brightness(1.12) saturate(1.15);
            box-shadow:
              0 0 22px rgba(255,215,0,0.7),
              0 0 48px rgba(255,215,0,0.35),
              0 14px 40px rgba(0,0,0,0.45);
          }
          50% {
            transform: scale(1.10);
            filter: brightness(1.45) saturate(1.6);
            box-shadow:
              0 0 56px rgba(255,215,0,0.98),
              0 0 110px rgba(255,215,0,0.6),
              0 0 160px rgba(255,215,0,0.22);
          }
        }
        .card-hold-energy {
          animation: cardHoldEnergy 0.72s ease-in-out infinite;
          will-change: transform, filter, box-shadow;
          z-index: 9998 !important;
        }

        /* ── Slot snap feedback on card landing ── */
        @keyframes slotSnapIn {
          0%   { transform: scale(1.12); box-shadow: 0 0 28px rgba(255,215,0,0.75), 0 8px 22px rgba(0,0,0,0.38); }
          45%  { transform: scale(0.95); }
          72%  { transform: scale(1.04); }
          100% { transform: scale(1); }
        }
        .slot-snap {
          animation: slotSnapIn 0.52s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        /* ── Carousel reshuffle jostle (0.5s after card commits) ── */
        @keyframes reshuffleShake {
          0%   { transform: rotateY(0deg); }
          18%  { transform: rotateY(-2.2deg); }
          36%  { transform: rotateY(2.6deg); }
          54%  { transform: rotateY(-1.6deg); }
          72%  { transform: rotateY(0.9deg); }
          88%  { transform: rotateY(-0.4deg); }
          100% { transform: rotateY(0deg); }
        }
        .carousel-reshuffle {
          animation: reshuffleShake 0.52s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
        }

        /* ── Fate section sequential appear ── */
        @keyframes sectionFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .section-appear {
          animation: sectionFadeIn 0.38s ease forwards;
        }
        .fate-section {
          text-align: left;
          line-height: 1.78;
        }
        .arc-trace {
          stroke-dasharray: 280;
          stroke-dashoffset: 280;
          filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.65));
          animation: arcDraw 0.82s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        @keyframes arcDraw {
          0% { stroke-dashoffset: 280; opacity: 0; }
          25% { opacity: 1; }
          100% { stroke-dashoffset: 0; opacity: 0; }
        }
        @keyframes card-vibe {
          0% { transform: translateX(0); }
          25% { transform: translateX(-1.6px); }
          50% { transform: translateX(1.6px); }
          75% { transform: translateX(-1.2px); }
          100% { transform: translateX(0); }
        }
        @keyframes flash-gold {
          0% { transform: scale(1.1); filter: brightness(1); box-shadow: 0 0 0px #ffd700; }
          50% { transform: scale(1.2); filter: brightness(2); box-shadow: 0 0 30px #ffd700; }
          100% { transform: scale(1.1); filter: brightness(1.2); box-shadow: 0 0 10px #ffd700; }
        }
        @keyframes focusAura {
          0%, 100% {
            transform: scale(1);
            opacity: 0.98;
          }
          50% {
            transform: scale(1.03);
            opacity: 1;
          }
        }
        @keyframes borderBeam {
          0% { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        .fate-summary-shell {
          position: relative;
          overflow: hidden;
        }
        .fate-summary-shell::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(
            120deg,
            rgba(255, 215, 128, 0.05),
            rgba(255, 215, 128, 0.32),
            rgba(255, 255, 255, 0.08),
            rgba(255, 215, 128, 0.05)
          );
          background-size: 200% 100%;
          animation: borderBeam 3.6s linear infinite;
          -webkit-mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
        }
        .fate-loading {
          animation: fateBlink 1.2s ease-in-out infinite;
          color: #ffd87d;
        }

        ::-webkit-scrollbar { width:3px; }
        ::-webkit-scrollbar-thumb { background:rgba(212,175,55,0.3); border-radius:2px; }

        @media (max-width: 900px) {
          .top-guide { width: min(92vw, 560px) !important; }
          .result-panel {
            padding: 12px 14px 12px !important;
          }
          .result-panel-content { gap: 14px !important; }
          .reading-col { padding: 10px 10px 12px !important; }
          .reset-btn {
            width: 44px !important;
            height: 44px !important;
            right: max(10px, env(safe-area-inset-right)) !important;
            top: max(10px, env(safe-area-inset-top)) !important;
            font-size: 18px !important;
          }
        }

        @media (max-width: 600px) {
          .top-guide {
            top: max(6px, env(safe-area-inset-top)) !important;
            width: min(95vw, 440px) !important;
          }
          .top-guide > div:first-child {
            letter-spacing: 2.6px !important;
            font-size: clamp(9px, 3vw, 11px) !important;
            margin-bottom: 4px !important;
          }
          .top-guide > div:last-child {
            font-size: clamp(10px, 3.4vw, 12px) !important;
            line-height: 1.35 !important;
            color: rgba(247,239,216,0.66) !important;
          }
          .canvas-shell {
            padding-top: max(58px, env(safe-area-inset-top)) !important;
          }
          .result-panel {
            border-radius: 12px !important;
          }
          .result-panel-content {
            grid-template-columns: 1fr !important;
          }
          .reading-col h3 {
            min-height: 0 !important;
          }
        }

        @media (max-height: 760px) and (max-width: 900px) {
          .top-guide {
            top: max(4px, env(safe-area-inset-top)) !important;
            width: min(94vw, 500px) !important;
          }
          .top-guide > div:first-child { margin-bottom: 2px !important; opacity: 0.84 !important; }
          .top-guide > div:last-child { opacity: 0.62 !important; }
          .result-panel { max-height: 42vh !important; }
          .canvas-shell { padding-top: max(48px, env(safe-area-inset-top)) !important; }
        }
      `}</style>
    </div>
  );
}

export default App;
