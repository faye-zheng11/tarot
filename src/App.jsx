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

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseIdolCsv(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const nameIdx = headers.indexOf('name');
  const posterIdx = headers.indexOf('poster_url');
  const activeIdx = headers.indexOf('active');
  if (nameIdx < 0 || posterIdx < 0) return [];
  return lines.slice(1)
    .map((line) => {
      const cols = parseCsvLine(line);
      const name = String(cols[nameIdx] ?? '').trim();
      const poster_url = String(cols[posterIdx] ?? '').trim();
      const activeRaw = String(cols[activeIdx] ?? '1').trim();
      return {
        name,
        poster_url,
        active: !(activeRaw === '0' || /^false$/i.test(activeRaw)),
      };
    })
    .filter((row) => row.name && row.poster_url);
}

function parseStarGuide(raw) {
  const text = String(raw ?? '').replace(/\r/g, '').trim();
  let body = text;
  let luckyColor = '';
  let luckyItem = '';
  const lc = text.match(/幸运色[：:]\s*([^。\n；;,，]*)(?=\s*幸运物[：:]|$|[。\n；;,，])/u);
  const li = text.match(/幸运物[：:]\s*([^\n。；;]*)/u);
  if (lc) luckyColor = lc[1].trim().replace(/^[-:：\s]+/u, '');
  if (li) luckyItem = li[1].trim().replace(/^[-:：\s]+/u, '');

  // 防止模型把两项写在同一段里，导致 tag 串台
  luckyColor = luckyColor
    .split(/幸运物(?:件)?[：:]/u)[0]
    .replace(/幸运色[：:]/gu, '')
    .trim();
  luckyItem = luckyItem
    .split(/幸运色[：:]/u)[0]
    .replace(/幸运物(?:件)?[：:]/gu, '')
    .trim();

  const cutAt = text.search(/\s*幸运[色物][：:]/u);
  if (cutAt >= 0) body = text.slice(0, cutAt).trim();
  body = body
    .replace(/^【星运解读】\s*/u, '')
    .replace(/\s*幸运色[：:][^。\n]*[。]?/gu, '')
    .replace(/\s*幸运物[：:][^。\n]*[。]?/gu, '')
    .replace(/\b[A-Za-z][A-Za-z0-9_.-]{1,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { body, luckyColor, luckyItem };
}

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
  const [step, setStep] = useState(0);
  const [questionInput, setQuestionInput] = useState('');
  const [entryError, setEntryError] = useState('');
  const [permissionError, setPermissionError] = useState('');
  const [cameraChecking, setCameraChecking] = useState(false);
  const [entryInputInvalid, setEntryInputInvalid] = useState(false);
  const [isIdolFlipped, setIsIdolFlipped] = useState(false);
  const [idolPool, setIdolPool] = useState([]);
  /** 进入本次解读后随机锁定，翻牌仅展示此人，不可再次抽取 */
  const [lockedCosmicIdol, setLockedCosmicIdol] = useState(null);
  const [starGuideRaw, setStarGuideRaw] = useState('');
  const [starGuideStatus, setStarGuideStatus] = useState('idle');
  const [starGuideNotice, setStarGuideNotice] = useState('');
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
  const cosmicIdolKeyRef = useRef('');
  const starGuideKeyRef = useRef('');
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
  const quickResultBootedRef = useRef(false);

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
    if (quickResultBootedRef.current) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('result') !== '1') return;
    if (!tarotDeck.length) return;
    quickResultBootedRef.current = true;

    const picks = [tarotDeck[0], tarotDeck[1], tarotDeck[2]].filter(Boolean);
    if (picks.length < 3) return;

    const seededSlots = picks.map((reading, index) => ({ ringIndex: index, reading }));
    setSpreadSlots(seededSlots);
    setPastCard(picks[0]);
    setPresentCard(picks[1]);
    setFutureCard(picks[2]);
    setReadingFlipped([true, true, true]);
    setQuestionInput((prev) => prev || '今天的整体运势如何？');
    setAppPhase('reading');
    setPanelVisible(true);
    setStep(2);
  }, [tarotDeck]);

  useEffect(() => {
    if (appPhase === 'reading') {
      setStep(2);
    }
  }, [appPhase]);

  useEffect(() => {
    if (appPhase === 'reading' && panelVisible) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [appPhase, panelVisible]);

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
  /** 解读用：从完整牌库均匀随机，且不与已落入槽位的牌重复（环上视觉仍用 getCardForRingIndex） */
  const pickRandomReadingForNextSlot = useCallback((prevSlots) => {
    if (!tarotDeck.length) return null;
    const used = new Set();
    prevSlots.forEach((s) => {
      if (!s?.reading) return;
      const id = Number(s.reading.id);
      if (Number.isFinite(id)) used.add(id);
    });
    const pool = tarotDeck.filter((c) => !used.has(Number(c.id)));
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }, [tarotDeck]);
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
    const cleanFateSection = (value) =>
      String(value ?? '')
        // 清理列表序号（如 1. / 2: / 1、）的残留标记
        .replace(/(^|[\n\r])\s*\d+\s*[\.、:：)\]]\s*/g, '$1')
        // 清理段首孤立标点（如 ".:"）
        .replace(/(^|[\n\r])\s*[\.:：、]+\s*/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return {
      insight: cleanFateSection(sections.insight),
      chain: cleanFateSection(sections.chain),
      action: cleanFateSection(sections.action),
    };
  }, [compactAiSummary, drawnCards]);
  const sectionBoundaries = useMemo(() => ({
    chainStarted: compactAiSummary.includes('【因果串联】'),
    actionStarted: compactAiSummary.includes('【行动建议】'),
  }), [compactAiSummary]);
  const insightText = formattedAiSummary.insight || '星轨仍在汇聚中。';
  const connectionText = sectionBoundaries.chainStarted
    ? formattedAiSummary.chain || '过去的信号正在与你当下共振。'
    : '命运丝线正在编织，请稍候聆听。';
  const adviceText = sectionBoundaries.actionStarted
    ? formattedAiSummary.action || '跟随心念，向前迈出一小步。'
    : '建议即将显现，先保持心绪稳定。';
  const adviceItems = useMemo(() => {
    if (!sectionBoundaries.actionStarted) return [];
    const source = String(formattedAiSummary.action || '').trim();
    if (!source) return [];

    const normalizeAdviceItem = (value) =>
      String(value ?? '')
        .replace(/^\s*[\.:：、，,;；]+\s*/u, '')
        .replace(/^\s*(?:\d+|[一二三四五六七八九十])[.、:：)\]]\s*/u, '')
        .trim();

    const numbered = Array.from(
      source.matchAll(/(?:^|[\n\r])\s*(?:\d+|[一二三四五六七八九十])[.、:：)\]]?\s*([^\n\r]+)/g),
    )
      .map((m) => normalizeAdviceItem(m[1]))
      .filter(Boolean);
    if (numbered.length >= 2) return numbered.slice(0, 2);

    const chunks = source
      .replace(/\s+/g, ' ')
      .split(/[；;。]/)
      .map((s) => normalizeAdviceItem(s))
      .filter(Boolean);
    if (chunks.length >= 2) return chunks.slice(0, 2);

    return [source];
  }, [formattedAiSummary.action, sectionBoundaries.actionStarted]);
  const starParsed = useMemo(() => parseStarGuide(starGuideRaw), [starGuideRaw]);
  const idolPosterUrl = useMemo(() => {
    if (!lockedCosmicIdol?.poster_url) return '/Card1.jpg';
    if (/^https?:\/\//i.test(lockedCosmicIdol.poster_url)) return lockedCosmicIdol.poster_url;
    return `/${encodeURI(lockedCosmicIdol.poster_url)}`;
  }, [lockedCosmicIdol]);
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
    // 与解读面板展开动画解耦：三张牌齐即开始拉流，避免等 panelVisible 才不生成
    if (appPhase !== 'reading' || !past || !present || !future) {
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
            userQuestion: questionInput,
            intent: 'fate',
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(errText || `HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error(`HTTP ${res.status} (no stream body)`);
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
      } catch (err) {
        setAiStatus('fallback');
        setAiSummary(fallbackSummary);
        const msg = typeof err?.message === 'string' ? err.message : '';
        setAiFallbackNotice(
          msg.includes('Missing LLM_API_KEY')
            ? '服务端未配置 LLM_API_KEY，已使用本地结语。'
            : msg.includes('Failed to fetch')
              ? '无法连接 /api/chat：本地请确认已 npm run dev（含 Vite 代理）或部署到 Vercel。'
              : '星轨信号微弱，基于牌面提供基础建议。',
        );
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    consumeStream();

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
      aiRequestKeyRef.current = '';
    };
  }, [appPhase, drawnCards, fallbackSummary, readingCardsKey, questionInput]);

  useEffect(() => {
    if (appPhase !== 'reading') {
      cosmicIdolKeyRef.current = '';
      setLockedCosmicIdol(null);
      setIsIdolFlipped(false);
      return;
    }
    const [past, present, future] = drawnCards;
    if (!past || !present || !future || idolPool.length === 0) return;
    if (cosmicIdolKeyRef.current === readingCardsKey) return;
    cosmicIdolKeyRef.current = readingCardsKey;
    const activeRows = idolPool.filter((row) => row.active);
    const source = activeRows.length ? activeRows : idolPool;
    const pick = source[Math.floor(Math.random() * source.length)];
    setLockedCosmicIdol(pick);
    setIsIdolFlipped(false);
  }, [appPhase, drawnCards, idolPool, readingCardsKey]);

  useEffect(() => {
    const [past, present, future] = drawnCards;
    if (appPhase !== 'reading' || !past || !present || !future || !lockedCosmicIdol) {
      starGuideKeyRef.current = '';
      setStarGuideRaw('');
      setStarGuideStatus('idle');
      setStarGuideNotice('');
      return;
    }
    const sgKey = `${readingCardsKey}::${lockedCosmicIdol.name}`;
    if (starGuideKeyRef.current === sgKey) return;
    starGuideKeyRef.current = sgKey;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 32000);
    setStarGuideRaw('');
    setStarGuideStatus('loading');
    setStarGuideNotice('');

    const consumeStarStream = async () => {
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pastCard: past,
            presentCard: present,
            futureCard: future,
            userQuestion: questionInput,
            intent: 'starGuide',
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(errText || `HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error(`HTTP ${res.status} (no stream body)`);
        }
        setStarGuideStatus('streaming');
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
                setStarGuideRaw((prev) => prev + delta);
              }
            } catch {
              if (payload) setStarGuideRaw((prev) => prev + payload);
            }
          });
        }
        setStarGuideStatus('done');
      } catch (err) {
        setStarGuideStatus('fallback');
        setStarGuideRaw('星运信号较弱，先照顾好作息与心情，把期待留给下一次相遇。');
        const msg = typeof err?.message === 'string' ? err.message : '';
        setStarGuideNotice(
          msg.includes('Failed to fetch')
            ? '无法连接 /api/chat，请确认本地已启动 dev 服务。'
            : '已使用本地占位星运文案。',
        );
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    consumeStarStream();

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [appPhase, drawnCards, lockedCosmicIdol, questionInput, readingCardsKey]);

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

  useEffect(() => {
    let cancelled = false;
    fetch('/Tarot_idol.csv')
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        if (cancelled) return;
        setIdolPool(parseIdolCsv(text));
      })
      .catch(() => {
        if (!cancelled) setIdolPool([]);
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
        const pickedCard = pickRandomReadingForNextSlot(prev);
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
    [appPhase, pickRandomReadingForNextSlot, tarotDeck],
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
      setIsIdolFlipped(false);
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
      setStep(0);
      setQuestionInput('');
      setEntryError('');
      setPermissionError('');
      setEntryInputInvalid(false);
      setCameraChecking(false);
      setGestureEnabled(false);
      setCameraHintDismissed(false);
      setAppPhase('selection');
      setReshuffling(false);
      setSpreadSlots([null, null, null]);
      setPastCard(null);
      setPresentCard(null);
      setFutureCard(null);
      setAiSummary('');
      setAiStatus('idle');
      setAiFallbackNotice('');
      aiRequestKeyRef.current = '';
      cosmicIdolKeyRef.current = '';
      starGuideKeyRef.current = '';
      setLockedCosmicIdol(null);
      setStarGuideRaw('');
      setStarGuideStatus('idle');
      setStarGuideNotice('');
      setIsIdolFlipped(false);
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
      setCenterIndex(0);
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

  const requestCameraPermission = useCallback(async () => {
    if (!navigator?.mediaDevices?.getUserMedia) {
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleStartRitual = useCallback(async () => {
    const trimmedQuestion = questionInput.trim();
    if (!trimmedQuestion) {
      setEntryError('宇宙尚未听到你的声音...');
      setEntryInputInvalid(true);
      window.setTimeout(() => setEntryInputInvalid(false), 520);
      return;
    }
    setEntryInputInvalid(false);
    setEntryError('');
    setPermissionError('');
    setCameraChecking(true);
    const granted = await requestCameraPermission();
    setCameraChecking(false);
    if (!granted) {
      setPermissionError('请开启摄像头权限以检测手势建立连结。若拒绝，将无法感应你的能量。');
      return;
    }
    setCameraHintDismissed(false);
    setGestureEnabled(true);
    setStep(1);
    setAppPhase('selection');
  }, [questionInput, requestCameraPermission]);

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
        : '';
  const cameraConfig = isPortraitMobile
    ? { position: [0, 0.2, 10], fov: 54 }
    : { position: [0, 0.5, 11], fov: 48 };
  const exposure = isPortraitMobile ? 1.2 : 1.15;

  if (step === 0) {
    return (
      <div className="entry-root">
        <div className="entry-bg-radial" aria-hidden="true" />
        <div className="entry-bg-stars" aria-hidden="true" />
        <div className="entry-bg-aurora" aria-hidden="true" />
        <div className={`entry-panel ${entryInputInvalid ? 'entry-panel-shake' : ''}`}>
          <div className="entry-sigil" aria-hidden="true">✦</div>
          <h1 className="entry-title">
            星启指南
            <span>宇宙占星社</span>
          </h1>
          <div className="entry-input-wrap">
            <input
              className={`entry-input ${entryInputInvalid ? 'entry-input-invalid' : ''}`}
              value={questionInput}
              onChange={(e) => {
                setQuestionInput(e.target.value);
                if (entryError) setEntryError('');
                if (entryInputInvalid) setEntryInputInvalid(false);
              }}
              placeholder="将你的问题告诉星辰..."
            />
            <div className="entry-input-line" />
          </div>
          {(entryError || permissionError) && (
            <div className={`entry-hint ${entryError ? 'entry-hint-ethereal' : 'entry-hint-warn'}`}>
              {entryError || permissionError}
            </div>
          )}
          <button
            className="entry-cta"
            type="button"
            disabled={cameraChecking}
            onClick={handleStartRitual}
          >
            <span>{cameraChecking ? '正在建立连结...' : '开启连结'}</span>
            <div className="entry-cta-fill" aria-hidden="true" />
          </button>
          <p className="entry-footnote">Astral Chamber • Pure Connection</p>
        </div>
        <style>{`
          html, body, #root {
            margin: 0;
            width: 100%;
            overflow-x: hidden;
          }
          .entry-root {
            width: 100%;
            min-height: 100vh;
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: #f7efd8;
            background: #050508;
          }
          .entry-bg-radial {
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: radial-gradient(circle at 50% 50%, rgba(64, 40, 110, 0.58), transparent 62%);
            opacity: 0.78;
          }
          .entry-bg-stars {
            position: absolute;
            inset: 0;
            pointer-events: none;
            background-image: url('https://www.transparenttextures.com/patterns/stardust.png');
            opacity: 0.24;
            animation: entryStarsMove 42s linear infinite;
          }
          .entry-bg-aurora {
            position: absolute;
            inset: -20%;
            pointer-events: none;
            background:
              radial-gradient(circle at 20% 30%, rgba(172, 125, 255, 0.22), transparent 40%),
              radial-gradient(circle at 80% 60%, rgba(236, 196, 118, 0.16), transparent 42%),
              radial-gradient(circle at 50% 80%, rgba(123, 92, 242, 0.16), transparent 38%);
            filter: blur(24px);
            animation: entryAuroraFlow 20s ease-in-out infinite alternate;
          }
          .entry-panel {
            position: relative;
            z-index: 10;
            width: min(640px, 92vw);
            padding: clamp(30px, 5vw, 42px) clamp(20px, 4vw, 44px);
            border-radius: 28px;
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: 0 0 50px rgba(0, 0, 0, 0.52);
            transition: transform 0.4s ease;
          }
          .entry-panel-shake {
            animation: entryShake 0.2s ease-in-out 0s 2;
          }
          .entry-sigil {
            position: absolute;
            top: -30px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 38px;
            color: rgba(255, 234, 181, 0.6);
            animation: entryPulse 2s ease-in-out infinite;
          }
          .entry-title {
            margin: 0;
            text-align: center;
            color: #e7dab7;
            font-size: clamp(36px, 5vw, 54px);
            font-family: Georgia, "Times New Roman", serif;
            font-weight: 300;
            letter-spacing: 0.2em;
            line-height: 1.15;
            text-shadow: 0 0 15px rgba(224, 213, 176, 0.5);
          }
          .entry-title span {
            display: block;
            margin-top: 14px;
            font-size: clamp(16px, 2.2vw, 22px);
            letter-spacing: 0.5em;
            opacity: 0.82;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
          }
          .entry-input-wrap {
            position: relative;
            margin-top: 42px;
          }
          .entry-input {
            width: 100%;
            border: none;
            border-bottom: 1px solid rgba(224, 213, 176, 0.32);
            background: transparent;
            color: #f2ead5;
            text-align: center;
            font-size: 18px;
            line-height: 1.4;
            padding: 12px 6px;
            outline: none;
            caret-color: rgba(224, 213, 176, 0.9);
            transition: border-color 0.35s ease;
          }
          .entry-input::placeholder {
            color: rgba(224, 213, 176, 0.35);
          }
          .entry-input:focus {
            border-bottom-color: rgba(224, 213, 176, 0.95);
          }
          .entry-input-invalid {
            border-bottom-color: rgba(245, 122, 139, 0.95);
            box-shadow: 0 8px 18px -14px rgba(241, 80, 120, 0.8);
          }
          .entry-input-line {
            position: absolute;
            left: 0;
            bottom: 0;
            width: 100%;
            height: 1px;
            background: linear-gradient(90deg, transparent, #e0d5b0, transparent);
            transform: scaleX(0);
            transform-origin: center;
            transition: transform 0.45s ease;
          }
          .entry-input-wrap:focus-within .entry-input-line {
            transform: scaleX(1);
          }
          .entry-hint {
            margin-top: 12px;
            text-align: center;
            font-size: 13px;
            line-height: 1.5;
            letter-spacing: 0.03em;
          }
          .entry-hint-ethereal {
            color: rgba(255, 142, 162, 0.9);
            animation: entryFadeIn 0.3s ease;
          }
          .entry-hint-warn {
            color: rgba(233, 205, 152, 0.9);
            animation: entryFadeIn 0.3s ease;
          }
          .entry-cta {
            width: 100%;
            margin-top: 28px;
            position: relative;
            overflow: hidden;
            padding: 15px 18px;
            border-radius: 999px;
            border: 1px solid rgba(224, 213, 176, 0.4);
            background: transparent;
            color: #f2e9d0;
            cursor: pointer;
            transition: all 0.3s ease;
          }
          .entry-cta > span {
            position: relative;
            z-index: 2;
            align-items: center;
            font-size: 15px;
            letter-spacing: 0.3em;
            font-weight: 300;
          }
          .entry-cta:hover {
            border-color: rgba(224, 213, 176, 0.95);
            transform: translateY(-1px) scale(1.01);
            box-shadow: 0 0 24px rgba(224, 213, 176, 0.25);
          }
          .entry-cta:hover > span {
            color: #19140e;
          }
          .entry-cta-fill {
            position: absolute;
            inset: 0;
            background: #e0d5b0;
            transform: translateY(102%);
            transition: transform 0.3s ease;
            z-index: 1;
          }
          .entry-cta:hover .entry-cta-fill {
            transform: translateY(0);
          }
          .entry-cta:disabled {
            cursor: not-allowed;
            opacity: 0.7;
          }
          .entry-footnote {
            margin: 26px 0 0;
            text-align: center;
            font-size: 10px;
            letter-spacing: 0.4em;
            opacity: 0.4;
            text-transform: uppercase;
          }
          @keyframes entryStarsMove {
            from { transform: translate3d(0, 0, 0); }
            to { transform: translate3d(-80px, 40px, 0); }
          }
          @keyframes entryAuroraFlow {
            from { transform: translate3d(-20px, -12px, 0) scale(1); }
            to { transform: translate3d(16px, 14px, 0) scale(1.08); }
          }
          @keyframes entryPulse {
            0%, 100% { opacity: 0.45; transform: translateX(-50%) scale(1); }
            50% { opacity: 0.92; transform: translateX(-50%) scale(1.08); }
          }
          @keyframes entryFadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes entryShake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-5px); }
            75% { transform: translateX(5px); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div
      className={appPhase === 'reading' && panelVisible ? 'result-page' : ''}
      style={{
        width: '100%',
        height: 'auto',
        minHeight: '100vh',
        /* dvh for mobile browsers that adjust for URL bar */
        // fallback to 100vh above, override below via CSS
        background: '#07021a',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        overflowX: 'hidden',
        overflowY: appPhase === 'reading' ? 'visible' : 'hidden',
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

      {/* ── 抽牌页顶栏：大标题 / 副标题 / 手势说明 / 动态状态 ── */}
      {appPhase !== 'reading' && (
        <div
          className="top-guide tarot-header-root"
          style={{
            position: 'absolute',
            top: 'max(12px, env(safe-area-inset-top))',
            left: '50%',
            transform: 'translateX(-50%)',
            textAlign: 'center',
            zIndex: 16,
            pointerEvents: 'none',
            userSelect: 'none',
            width: 'min(90vw, 560px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'clamp(10px, 1.8vh, 16px)',
          }}
        >
          <h1 className="tarot-header-title">神秘塔罗 · MYSTIC TAROT</h1>
          {deckStatus === 'loading' || deckStatus === 'error' ? (
            <p className="tarot-header-subtitle tarot-header-deck-msg">{guideText}</p>
          ) : appPhase === 'selection' ? (
            <>
              <p className="tarot-header-subtitle">
                闭目默念你的问题，静心抽取 3 张分别代表「过去、现在、未来」的牌
              </p>
              <div className="tarot-instruction-box" aria-label="手势操作说明">
                <span className="tarot-guide-item">
                  ✋ <strong>张开手掌</strong> 即为翻牌
                </span>
                <span className="tarot-guide-divider" aria-hidden="true">
                  |
                </span>
                <span className="tarot-guide-item">
                  ✊ <strong>握拳</strong> 即可选中
                </span>
              </div>
              <div className="tarot-gesture-status">{gestureHintText}</div>
            </>
          ) : null}
        </div>
      )}

      {/* ── Carousel area ── */}
      <div
        ref={canvasWrapRef}
        className="canvas-shell"
        style={{
          flex: appPhase === 'reading' ? '0 0 auto' : 1,
          minHeight: appPhase === 'reading' ? 'auto' : 0,
          position: appPhase === 'reading' ? 'static' : 'relative',
          touchAction: 'none',
          paddingTop: appPhase === 'reading' ? 0 : 'clamp(118px, 20vh, 178px)',
          overflow: 'visible',
        }}
      >
        <div
          ref={domCarouselRef}
          style={{
            width: '100%',
            height: appPhase === 'reading' ? 'auto' : '100%',
            position: appPhase === 'reading' ? 'static' : 'relative',
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
              position: 'relative',
              zIndex: 34,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-start',
              gap: 'clamp(10px, 3.2vw, 24px)',
              pointerEvents: 'none',
              marginTop: 'max(12px, env(safe-area-inset-top))',
              marginBottom: 18,
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
          aria-label="重新开始"
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

      {/* ── Result panel — 占星社 x Idol 101 ── */}
      <div
        className="result-panel"
        style={{
          position: 'relative',
          display: panelVisible ? 'block' : 'none',
          margin: '0 clamp(10px,2vw,22px) max(10px, env(safe-area-inset-bottom))',
          background: 'linear-gradient(180deg, rgba(10,5,26,0.88) 0%, rgba(5,2,14,0.94) 100%)',
          backdropFilter: 'blur(20px) saturate(125%)',
          WebkitBackdropFilter: 'blur(20px) saturate(125%)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 'clamp(12px,1.8vw,16px)',
          padding: 'clamp(14px,2vw,22px) clamp(14px,3vw,28px) clamp(14px,2vw,20px)',
          zIndex: 30,
          boxShadow: '0 -8px 48px rgba(0,0,0,0.6)',
          overflow: 'visible',
          pointerEvents: 'auto',
        }}
      >
        <div className="tarot-result-shell">
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

          <section className="tarot-fate-section">
            <div className="tarot-fate-star tarot-fate-star-left">✦</div>
            <div className="tarot-fate-star tarot-fate-star-right">✦</div>

            <h2 className="tarot-fate-title">✦ 命运结语 ✦</h2>

            {aiStatus === 'loading' ? (
              <p className="tarot-fate-loading">
                <span className="fate-loading">✦ 猫灵正在翻阅星历...</span>
              </p>
            ) : (
              <div className="tarot-fate-content">
                <div className="tarot-fate-block">
                  <span className="tarot-fate-label">【现状洞察】</span>
                  <p>{insightText}</p>
                </div>
                <div className={`tarot-fate-block ${sectionBoundaries.chainStarted ? 'section-appear' : ''}`}>
                  <span className="tarot-fate-label">【因果串联】</span>
                  <p>{connectionText}</p>
                </div>
                <div className={`tarot-fate-block ${sectionBoundaries.actionStarted ? 'section-appear' : ''}`}>
                  <span className="tarot-fate-label">【行动建议】</span>
                  {sectionBoundaries.actionStarted ? (
                    <ol className="tarot-fate-advice-list">
                      {(adviceItems.length ? adviceItems : [adviceText]).slice(0, 2).map((item, index) => (
                        <li key={`${index}-${item.slice(0, 16)}`} className="tarot-fate-advice-item">
                          <span className="tarot-fate-advice-index">{index + 1}、</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>{adviceText}</p>
                  )}
                </div>
              </div>
            )}
            {aiFallbackNotice && <div className="tarot-fallback">{aiFallbackNotice}</div>}
          </section>

          <section className="tarot-idol-section">
            <h3 className="tarot-idol-title">
              <span className="tarot-idol-spark">✨</span> 星运指南
            </h3>
            {starGuideStatus === 'loading' || starGuideStatus === 'streaming' ? (
              <p className="tarot-idol-desc">✦ 星轨正在对齐你的应援频率...</p>
            ) : (
              <p className="tarot-idol-desc">{starParsed.body || '星运指南正在汇聚中。'}</p>
            )}

            <div className="tarot-idol-tags">
              <span>幸运色：{starParsed.luckyColor || '—'}</span>
              <span>幸运物件：{starParsed.luckyItem || '—'}</span>
            </div>
            {starGuideNotice && <div className="tarot-fallback">{starGuideNotice}</div>}
          </section>

          <section className="tarot-idol-card-zone">
            <p className="tarot-idol-caption">—— 查看今日与你宇宙连结最深的 IDOL ——</p>
            <div className="idol-flip-stack">
              {isIdolFlipped && lockedCosmicIdol?.name && (
                <div className="idol-name-above">{lockedCosmicIdol.name}</div>
              )}
              <div
                className="card-container group perspective-1000"
                onClick={() => {
                  if (isIdolFlipped) return;
                  setIsIdolFlipped(true);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!isIdolFlipped) setIsIdolFlipped(true);
                  }
                }}
              >
                <div className={`card-flip-inner ${isIdolFlipped ? 'rotate-y-180' : 'animate-card-pulse'}`}>
                  <div className="card-flip-face card-flip-back">
                    <div className="animate-glow">✦</div>
                  </div>

                  <div className="card-flip-face card-flip-front rotate-y-180">
                    <div className="idol-reveal-poster">
                      <img src={idolPosterUrl} alt="" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {isIdolFlipped && (
              <a
                className="tarot-idol-cta"
                href="https://play.google.com/store/apps/details?id=app.oppaya.kpop_idol_chat_oppaya_app"
                target="_blank"
                rel="noopener noreferrer"
              >
                去和他聊聊吧
              </a>
            )}
          </section>
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
        html, body, #root {
          width: 100%;
          min-height: 100vh;
          overflow-x: hidden;
          overflow-y: auto !important;
        }
        .tarot-header-root {
          width: min(90vw, 560px);
        }
        .tarot-header-title {
          margin: 0;
          font-family: Georgia, 'Times New Roman', serif;
          font-size: clamp(20px, 4.5vw, 32px);
          font-weight: 600;
          letter-spacing: clamp(0.12em, 1.2vw, 0.22em);
          line-height: 1.12;
          background: linear-gradient(92deg, #c9a227 0%, #fff9e8 45%, #d4af37 100%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          filter: drop-shadow(0 0 14px rgba(212, 175, 55, 0.35));
          animation: titleBreath 3.6s ease-in-out infinite;
        }
        .tarot-header-subtitle {
          margin: 0;
          color: rgba(247, 239, 216, 0.7);
          font-size: clamp(12px, 2.15vw, 15px);
          letter-spacing: 0.04em;
          line-height: 1.58;
          max-width: 34em;
          font-family: Georgia, 'Times New Roman', serif;
        }
        .tarot-header-deck-msg {
          color: rgba(247, 239, 216, 0.82);
        }
        .tarot-instruction-box {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 8px 14px;
          padding: 11px 18px;
          border-radius: 12px;
          border: 1px solid rgba(212, 175, 55, 0.32);
          background: rgba(12, 8, 32, 0.78);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: 0 4px 28px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04);
          font-size: clamp(11px, 1.95vw, 14px);
          color: rgba(255, 250, 235, 0.96);
          line-height: 1.45;
        }
        .tarot-guide-item strong {
          color: #ffe7a6;
          font-weight: 600;
        }
        .tarot-guide-divider {
          color: rgba(212, 175, 55, 0.42);
          font-weight: 300;
          user-select: none;
        }
        .tarot-gesture-status {
          font-size: clamp(11px, 1.75vw, 13px);
          color: rgba(247, 239, 216, 0.55);
          letter-spacing: 0.06em;
          line-height: 1.35;
          min-height: 1.25em;
        }
        @media (max-width: 480px) {
          .tarot-instruction-box {
            flex-direction: column;
            gap: 8px;
            padding: 10px 14px;
          }
          .tarot-guide-divider {
            display: none;
          }
        }

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
        .tarot-result-shell {
          max-width: 780px;
          margin: 0 auto;
          padding: 8px 4px 14px;
          display: flex;
          flex-direction: column;
          gap: 22px;
        }
        .tarot-card-info-section {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .tarot-card-info-block {
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          background: linear-gradient(180deg, rgba(16,10,34,0.62) 0%, rgba(9,5,22,0.72) 100%);
          padding: 10px 12px;
          min-height: 150px;
        }
        .tarot-card-info-title {
          font-size: 12px;
          color: rgba(224,213,176,0.9);
          letter-spacing: 0.06em;
          margin-bottom: 6px;
        }
        .tarot-card-info-name {
          font-size: 16px;
          color: #f5deb3;
          font-weight: 600;
          margin-bottom: 6px;
        }
        .tarot-card-info-desc {
          margin: 0;
          font-size: 13px;
          color: #d1d5db;
          line-height: 1.6;
        }
        .tarot-fate-section {
          position: relative;
          padding: clamp(18px, 3vw, 26px);
          border-radius: 30px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: 0 18px 40px rgba(0,0,0,0.35);
          overflow: hidden;
        }
        .tarot-fate-star {
          position: absolute;
          top: 16px;
          color: rgba(224,213,176,0.52);
        }
        .tarot-fate-star-left { left: 16px; }
        .tarot-fate-star-right { right: 16px; }
        .tarot-fate-title {
          margin: 0 0 20px;
          color: #e0d5b0;
          text-align: center;
          letter-spacing: 0.3em;
          font-size: clamp(16px, 2.1vw, 22px);
          font-family: Georgia, "Times New Roman", serif;
          font-weight: 500;
        }
        .tarot-fate-content {
          display: flex;
          flex-direction: column;
          gap: 14px;
          color: #e5e7eb;
          line-height: 1.8;
          font-family: Georgia, "Times New Roman", serif;
          text-align: left;
          max-width: 800px;
          margin: 0 auto;
        }
        .tarot-fate-block { opacity: 0.92; }
        .tarot-fate-label {
          color: #e0d5b0;
          display: block;
          margin-bottom: 6px;
          font-weight: 700;
        }
        .tarot-fate-block p {
          margin: 0;
          padding-left: 12px;
          border-left: 1px solid rgba(224,213,176,0.3);
          overflow-wrap: anywhere;
          text-align: left;
          white-space: pre-wrap;
        }
        .tarot-fate-advice-list {
          margin: 0;
          padding: 0 0 0 12px;
          border-left: 1px solid rgba(224,213,176,0.3);
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .tarot-fate-advice-item {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          overflow-wrap: anywhere;
          text-align: left;
          line-height: 1.8;
        }
        .tarot-fate-advice-index {
          color: #e0d5b0;
          font-weight: 700;
          flex: 0 0 auto;
        }
        .tarot-fate-loading {
          margin: 0;
          min-height: 54px;
          color: #dddddd;
          line-height: 1.8;
        }
        .tarot-fallback {
          margin-top: 10px;
          color: rgba(255, 216, 125, 0.86);
          font-size: 12px;
          letter-spacing: 0.3px;
        }
        .tarot-idol-section {
          padding: clamp(18px, 3vw, 26px);
          border-radius: 30px;
          background: linear-gradient(135deg, rgba(88,28,135,0.2), rgba(30,64,175,0.2));
          border: 1px solid rgba(224,213,176,0.2);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .tarot-idol-title {
          margin: 0 0 14px;
          color: #e0d5b0;
          font-size: 17px;
          font-weight: 600;
          letter-spacing: 0.12em;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .tarot-idol-spark {
          animation: fateBlink 1.5s ease-in-out infinite;
        }
        .tarot-idol-desc {
          margin: 0 0 16px;
          color: #d1d5db;
          font-size: 13px;
          line-height: 1.7;
          font-style: italic;
          text-align: left;
          white-space: pre-wrap;
        }
        .tarot-idol-tags {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          align-items: stretch;
          gap: 10px;
        }
        .tarot-idol-tags span {
          padding: 5px 14px;
          border-radius: 999px;
          background: rgba(224,213,176,0.1);
          border: 1px solid rgba(224,213,176,0.3);
          color: #e0d5b0;
          font-size: 12px;
          min-width: 140px;
          flex: 1 1 180px;
          max-width: 240px;
          text-align: center;
        }
        .tarot-idol-card-zone {
          text-align: center;
          padding-top: 8px;
        }
        .tarot-idol-caption {
          margin: 0 0 22px;
          color: rgba(224,213,176,0.55);
          font-size: 14px;
          font-weight: 500;
          letter-spacing: 0.18em;
          line-height: 1.5;
        }
        .idol-flip-stack {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }
        .idol-name-above {
          color: #e0d5b0;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-align: center;
          max-width: 260px;
        }
        .card-container {
          width: 192px;
          height: 288px;
          margin: 0 auto;
          cursor: pointer;
        }
        .card-flip-inner {
          position: relative;
          width: 100%;
          height: 100%;
          transition: transform 0.7s;
          transform-style: preserve-3d;
        }
        .card-flip-face {
          position: absolute;
          inset: 0;
          border-radius: 16px;
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
          overflow: hidden;
        }
        .card-flip-back {
          background: #1a1a2e;
          border: 2px solid rgba(224,213,176,0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 30px rgba(224,213,176,0.1);
          color: rgba(224,213,176,0.5);
          font-size: 32px;
        }
        .card-flip-front {
          border: 2px solid #e0d5b0;
        }
        .idol-reveal-poster {
          width: 100%;
          height: 100%;
          background: #120b2b;
          position: relative;
          overflow: hidden;
        }
        .idol-reveal-poster img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center;
          filter: saturate(1.04) contrast(1.05);
        }
        .tarot-idol-cta {
          margin-top: 26px;
          padding: 12px 30px;
          background: #e0d5b0;
          color: #000;
          border: none;
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.2em;
          cursor: pointer;
          transition: transform 0.2s ease;
          box-shadow: 0 0 20px rgba(224,213,176,0.4);
          text-decoration: none;
          display: inline-block;
        }
        .tarot-idol-cta:hover { transform: scale(1.08); }
        .tarot-idol-cta:active { transform: scale(0.95); }

        @keyframes card-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 20px rgba(224,213,176,0.1); }
          50% { transform: scale(1.03); box-shadow: 0 0 40px rgba(224,213,176,0.3); }
        }
        .animate-card-pulse { animation: card-pulse 3s infinite ease-in-out; }
        .perspective-1000 { perspective: 1000px; }
        .transform-style-3d { transform-style: preserve-3d; }
        .backface-hidden { backface-visibility: hidden; }
        .rotate-y-180 { transform: rotateY(180deg); }

        @keyframes glow {
          0%, 100% { opacity: 0.3; filter: blur(2px); }
          50% { opacity: 1; filter: blur(0px); }
        }
        .animate-glow { animation: glow 2s infinite; }

        ::-webkit-scrollbar { width:3px; }
        ::-webkit-scrollbar-thumb { background:rgba(212,175,55,0.3); border-radius:2px; }

        @media (max-width: 900px) {
          .top-guide.tarot-header-root { width: min(92vw, 520px) !important; }
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
          .top-guide.tarot-header-root {
            top: max(8px, env(safe-area-inset-top)) !important;
            width: min(94vw, 440px) !important;
            gap: 9px !important;
          }
          .tarot-header-title {
            font-size: clamp(17px, 5.2vw, 24px) !important;
            letter-spacing: 0.1em !important;
          }
          .tarot-header-subtitle {
            font-size: clamp(11px, 3.2vw, 14px) !important;
            line-height: 1.48 !important;
          }
          .canvas-shell {
            padding-top: max(108px, calc(env(safe-area-inset-top) + 88px)) !important;
          }
          .result-panel {
            border-radius: 12px !important;
          }
          .result-panel-content {
            grid-template-columns: 1fr !important;
          }
          .tarot-card-info-section {
            grid-template-columns: 1fr;
          }
          .reading-col h3 {
            min-height: 0 !important;
          }
        }

        @media (max-height: 760px) and (max-width: 900px) {
          .top-guide.tarot-header-root {
            top: max(6px, env(safe-area-inset-top)) !important;
            width: min(94vw, 500px) !important;
            gap: 7px !important;
          }
          .tarot-header-title {
            font-size: clamp(16px, 4.2vw, 22px) !important;
          }
          .tarot-gesture-status {
            font-size: clamp(10px, 2.8vw, 12px) !important;
            opacity: 0.92;
          }
          .canvas-shell {
            padding-top: max(96px, calc(env(safe-area-inset-top) + 72px)) !important;
          }
        }
      `}</style>
    </div>
  );
}

export default App;
