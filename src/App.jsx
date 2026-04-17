import React, { useMemo, useRef, useState, useEffect, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars, useTexture, Float, Environment, Trail, MeshReflectorMaterial } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import gsap from 'gsap';
import * as THREE from 'three';
import HandGestureDetector from './HandGestureDetector';
import { GestureManager } from './GestureManager';

const CARD_COUNT = 22;
const RING_RADIUS = 6;
const CARD_SIZE = [1, 1.6, 0.06];

// ─── Full 20-card database (from Feishu CSV) ─────────────────────────────────
// Images marked ✗ are not yet in public/ — they display the card back as placeholder.
// Add the missing PNGs to /public with these exact filenames to unlock them.
const TAROT_DATA = [
  {
    id: 1,
    name: '愚者 (The Fool)',
    resultImage: 'The_Fool.png',           // ✓ exists
    description:
      '这是一个全新的开始。别担心前面的悬崖，像猫一样轻盈地跳跃吧。好奇心虽然会害死猫，但也能让你发现新世界。',
  },
  {
    id: 2,
    name: '魔术师 (The Magician)',
    resultImage: 'The_Magician.png',       // ✓ exists
    description:
      '你拥有改变局势的一切资源。不管是逗猫棒还是激光笔，只要你动动爪子，现实就会随你而变。相信你的创造力。',
  },
  {
    id: 3,
    name: '女祭司 (The High Priestess)',
    resultImage: 'The_High_Priestess.png', // ✓ exists
    description:
      '并不是所有的事都需要奔跑。现在是静坐、观察和觉察的时刻。你的直觉比导航更准，真相藏在深邃的瞳孔里。',
  },
  {
    id: 4,
    name: '皇后 (The Empress)',
    resultImage: 'The_Empress.png',
    description:
      '丰盈、母性与感官的享受。找个阳光最充足的地方躺下，现在是享受舒适、被爱与生产力的时刻。生命正在繁茂生长。',
  },
  {
    id: 5,
    name: '皇帝 (The Emperor)',
    resultImage: 'The_Emperor.png',
    description:
      '结构、控制与权力的象征。你要像狮子一样守护你的边界。现在需要你展现果断的领导力，把混乱的生活理顺。',
  },
  {
    id: 6,
    name: '教皇 (The Hierophant)',
    resultImage: 'The_Hierophant.png',
    description:
      '有时候遵循前辈的足迹是明智的。这代表一种精神指引或对秩序的尊重。加入那个群体，去学习那些传承下来的智慧。',
  },
  {
    id: 7,
    name: '恋人 (The Lovers)',
    resultImage: 'The_Lovers.png',         // ✓ exists
    description:
      '这不仅关乎爱情，更关乎心灵的契合与重要的选择。跟随你的本能去建立连接，在这个充满诱惑的世界里找到你的同类。',
  },
  {
    id: 8,
    name: '战车 (The Chariot)',
    resultImage: 'The_Chariot.png',
    description:
      '专注目标，不要被左右两边的纸箱干扰。即使两种情绪在拉扯，也要保持控制力，胜利属于那个坚定直行的勇者。',
  },
  {
    id: 9,
    name: '力量 (The Strength)',
    resultImage: 'The_Strength.png',
    description:
      '真正的力量不是嘶吼，而是耐心的轻抚。用你的慈悲和勇气去化解困境，以柔克刚是你最强大的武器。',
  },
  {
    id: 10,
    name: '隐士 (The Hermit)',
    resultImage: 'The_Hermit.png',         // ✓ exists
    description:
      '暂时关闭外界的喧嚣。去阁楼、去角落、去内心深处寻找光。你需要一段独处的时光，来重新定位你的灵魂航向。',
  },
  {
    id: 11,
    name: '命运之轮 (Wheel of Fortune)',
    resultImage: 'Wheel_of_Fortune.png',
    description:
      '转运的时刻到了！有时候你是追逐者，有时候你是那个球。接受变化，保持平衡，因为低谷之后必有高峰。',
  },
  {
    id: 12,
    name: '正义 (Justice)',
    resultImage: 'Justice_jpg.jpg',        // ✓ exists
    description:
      '因果规律在运作。每一个罐罐的获得都源于之前的付出。做一个理性的裁决者，现在是是非曲直自有定论的时刻。',
  },
  {
    id: 13,
    name: '吊人 (The Hanged Man)',
    resultImage: 'The_Hanged_Man.png',     // ✓ exists
    description:
      '停滞期并不代表停摆。尝试倒挂着看世界，你会发现之前忽略的宝藏。牺牲一点当下的安逸，换取更伟大的觉悟。',
  },
  {
    id: 14,
    name: '死神 (The Death)',
    resultImage: 'The_Death.png',          // ✓ exists
    description:
      '恐惧源于拒绝改变。让陈旧的部分随风而去吧，死亡是新生的必经之路。剪断过去的束缚，你的新爪子才会更有力。',
  },
  {
    id: 15,
    name: '节制 (Temperance)',
    resultImage: 'Temperance.png',
    description:
      '调和你的欲望与行动。不要一次性喝完所有的奶，学会慢慢调理你的能量。中庸之道会带你走向持久的宁静。',
  },
  {
    id: 16,
    name: '恶魔 (The Devil)',
    resultImage: 'The_Devil.png',
    description:
      '警惕那些让你上瘾但不健康的束缚。你以为链子锁住了你，其实你可以随时走开。认清你的贪婪，重获自由。',
  },
  {
    id: 17,
    name: '塔 (The Tower)',
    resultImage: 'The_Tower.png',          // ✓ exists
    description:
      '突如其来的剧变虽然痛苦，但它击碎了虚伪的表象。当不稳固的根基瓦解时，你终于有机会在空地上重建。',
  },
  {
    id: 18,
    name: '星辰 (The Star)',
    resultImage: 'The_Star.png',           // ✓ exists
    description:
      '治愈的时刻。洗去身上的疲惫，抬头看看那颗指路明灯。不论经历了什么，希望永远不会熄灭，相信奇迹。',
  },
  {
    id: 19,
    name: '月亮 (The Moon)',
    resultImage: 'The_Moon.png',
    description:
      '半梦半醒之间，不安在骚动。不要被表面的阴影吓到，运用你的敏锐嗅觉，穿透迷雾，寻找真实的路径。',
  },
  {
    id: 20,
    name: '太阳 (The Sun)',
    resultImage: 'The_Sun.png',
    description:
      '快乐、成功、充满活力的时刻！你是全场的焦点，所有的阴郁都被驱散。尽情展示你的光芒，好运正当时。',
  },
];

// ─── RingCard ─────────────────────────────────────────────────────────────────
function RingCard({ index, angle, backMap, onSelect, onHoverChange }) {
  const meshRef = useRef();
  const frontMatRef = useRef();
  const backMatRef = useRef();
  const [hovered, setHovered] = useState(false);
  const floatSpeed = useMemo(() => 0.7 + ((index * 0.21) % 1.0), [index]);

  useEffect(() => {
    if (!meshRef.current) return;
    gsap.to(meshRef.current.scale, {
      x: hovered ? 1.14 : 1,
      y: hovered ? 1.14 : 1,
      z: 1,
      duration: 0.22,
      ease: 'power2.out',
    });

    [frontMatRef.current, backMatRef.current].forEach((mat) => {
      if (!mat) return;
      gsap.to(mat, {
        emissiveIntensity: hovered ? 0.65 : 0.15,
        duration: 0.22,
        ease: 'power2.out',
      });
    });
  }, [hovered]);

  const handleClick = (e) => {
    e.stopPropagation();
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    e.object.getWorldPosition(worldPos);
    e.object.getWorldQuaternion(worldQuat);
    const euler = new THREE.Euler().setFromQuaternion(worldQuat);
    onSelect(index, {
      position: [worldPos.x, worldPos.y, worldPos.z],
      rotation: [euler.x, euler.y, euler.z],
    });
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
    });
  };

  return (
    <Float
      speed={floatSpeed}
      rotationIntensity={0.1}
      floatIntensity={0.32}
      floatingRange={[-0.09, 0.09]}
    >
      <mesh
        ref={meshRef}
        position={[Math.sin(angle) * RING_RADIUS, 0, Math.cos(angle) * RING_RADIUS]}
        rotation={[0, angle, 0]}
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
    </Float>
  );
}

// ─── SelectedCard ──────────────────────────────────────────────────────────────
// material-4 (+z, camera sees at rotY=0): card back (before flip)
// material-5 (-z, camera sees at rotY=π): result image (after flip)
function SelectedCard({ startTransform, backMap, resultMap, flipped, onFlip, gestureFlipToken }) {
  const meshRef = useRef();
  const flipping = useRef(false);

  useEffect(() => {
    if (!meshRef.current) return;
    const [sx, sy, sz] = startTransform.position;
    const [rx, ry, rz] = startTransform.rotation;
    meshRef.current.position.set(sx, sy, sz);
    meshRef.current.rotation.set(rx, ry, rz);
    meshRef.current.scale.set(1, 1, 1);
    flipping.current = false;

    const tl = gsap.timeline();
    tl.to(meshRef.current.position, { x: 0, y: 0, z: 5, duration: 0.85, ease: 'power3.out' });
    tl.to(meshRef.current.rotation, { x: 0, y: 0, z: 0, duration: 0.85, ease: 'power3.out' }, 0);
    tl.to(meshRef.current.scale, { x: 1.55, y: 1.55, z: 1.55, duration: 0.85, ease: 'back.out(1.1)' }, 0);
    meshRef.current.renderOrder = 20;
  }, [startTransform]);

  // Gentle vertical float (no spin)
  useFrame((state) => {
    if (!meshRef.current || flipping.current) return;
    meshRef.current.position.y = Math.sin(state.clock.elapsedTime * 1.2) * 0.07;
  });

  const runFlip = () => {
    if (flipped || flipping.current || !meshRef.current) return;
    flipping.current = true;
    gsap.to(meshRef.current.rotation, {
      y: Math.PI,
      duration: 0.9,
      ease: 'back.inOut(1.2)',
      onComplete: () => {
        flipping.current = false;
        onFlip();
      },
    });
  };

  const handleClick = (e) => {
    e.stopPropagation();
    runFlip();
  };

  useEffect(() => {
    if (!gestureFlipToken) return;
    runFlip();
  }, [gestureFlipToken]);

  return (
    <group renderOrder={20}>
      <pointLight position={[0, 2, 8]} intensity={1.8} color="#ffd87d" />
      <Trail width={1.1} length={4.8} color="#f2cf7d" attenuation={(t) => t * t}>
        <mesh ref={meshRef} onClick={handleClick} castShadow>
          <boxGeometry args={CARD_SIZE} />
          <meshStandardMaterial attach="material-0" color="#d4af37" roughness={0.08} metalness={1.0} />
          <meshStandardMaterial attach="material-1" color="#d4af37" roughness={0.08} metalness={1.0} />
          <meshStandardMaterial attach="material-2" color="#d4af37" roughness={0.08} metalness={1.0} />
          <meshStandardMaterial attach="material-3" color="#d4af37" roughness={0.08} metalness={1.0} />
          {/* Before flip: card back faces camera */}
          <meshStandardMaterial attach="material-4" map={backMap} roughness={0.12} metalness={0.8} />
          {/* After flip: result image faces camera — no emissive so image stays clear */}
          <meshStandardMaterial attach="material-5" map={resultMap} roughness={0.12} metalness={0.5} />
        </mesh>
      </Trail>
    </group>
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

// ─── Ring group — mouse rotation, halts once a card is selected ───────────────
function RingGroup({ children, stopped, swipeOffset, verticalOffset = -0.7 }) {
  const groupRef = useRef();
  useFrame(({ mouse }) => {
    if (!groupRef.current || stopped) return;
    const target = mouse.x * Math.PI * 0.55 + swipeOffset;
    groupRef.current.rotation.y += (target - groupRef.current.rotation.y) * 0.07;
  });
  return (
    // Tilt ring ~10° toward camera for the arc perspective look
    <group position={[0, verticalOffset, 0]} rotation={[-0.22, 0, 0]}>
      <group ref={groupRef}>{children}</group>
    </group>
  );
}

// ─── All 20 result images confirmed in /public ────────────────────────────────
const RESULT_PATHS = TAROT_DATA.map((d) => `/${d.resultImage}`);

// ─── SceneContent ─────────────────────────────────────────────────────────────
function SceneContent({
  selected,
  selectedCardData,
  flipped,
  onCardSelect,
  onCardFlip,
  scrollOffset,
  gestureFlipToken,
  raycastEnabled,
  onHoverCard,
}) {
  const [backMap] = useTexture(['/Card1.jpg']);
  const resultMaps = useTexture(RESULT_PATHS);

  useEffect(() => {
    [backMap, ...resultMaps].forEach((m) => {
      if (!m) return;
      m.colorSpace = THREE.SRGBColorSpace;
      m.anisotropy = 8;
    });
  }, [backMap, resultMaps]);

  const resultMap = useMemo(() => {
    if (!selectedCardData) return resultMaps[0];
    const idx = TAROT_DATA.findIndex((d) => d.id === selectedCardData.id);
    return resultMaps[Math.max(0, idx)];
  }, [selectedCardData, resultMaps]);

  const cardAngles = useMemo(
    () => Array.from({ length: CARD_COUNT }, (_, i) => (i / CARD_COUNT) * Math.PI * 2),
    [],
  );

  return (
    <>
      <color attach="background" args={['#07021a']} />
      <ambientLight intensity={0.32} />
      <directionalLight position={[5, 8, 6]} intensity={0.85} />
      <directionalLight position={[-5, 4, 8]} intensity={0.42} color="#b4a8ff" />
      <Environment preset="city" />
      <Stars radius={100} depth={60} count={3000} factor={4} saturation={0} fade speed={0.6} />
      <DeepSpaceDust />
      {!selected && (
        <mesh position={[0, -2.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[22, 22]} />
          <MeshReflectorMaterial
            blur={[280, 72]}
            resolution={512}
            mixBlur={1}
            mixStrength={0.35}
            roughness={0.95}
            depthScale={0.7}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.4}
            color="#120b2a"
            metalness={0.08}
            transparent
            opacity={0.35}
          />
        </mesh>
      )}

      {/* ── Ring: hidden entirely once a card is selected ── */}
      <RingGroup stopped={!!selected} swipeOffset={scrollOffset} verticalOffset={-0.95}>
        {!selected &&
          cardAngles.map((angle, i) => (
            <RingCard
              key={i}
              index={i}
              angle={angle}
              backMap={backMap}
              onSelect={onCardSelect}
              onHoverChange={onHoverCard}
            />
          ))}
      </RingGroup>

      {selected && (
        <group position={[0, -0.62, 0]}>
          <SelectedCard
            key={selected.id}
            startTransform={selected.startTransform}
            backMap={backMap}
            resultMap={resultMap}
            flipped={flipped}
            onFlip={onCardFlip}
            gestureFlipToken={gestureFlipToken}
          />
        </group>
      )}

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
  const [selected, setSelected] = useState(null);
  const [selectedCardData, setSelectedCardData] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [gestureCursor, setGestureCursor] = useState({ x: 0.5, y: 0.5, visible: false });
  const [gestureFlipToken, setGestureFlipToken] = useState(0);
  const [gestureState, setGestureState] = useState('NONE');
  const [handDetected, setHandDetected] = useState(false);
  const [raycastEnabled, setRaycastEnabled] = useState(false);
  const hoveredCardRef = useRef(null);
  const lastHoverSelectTsRef = useRef(0);
  const wasPalmRef = useRef(false);
  const lastFlipTriggerTsRef = useRef(0);
  const selectedAtRef = useRef(0);
  const flipArmedRef = useRef(false);
  const palmReleasedAfterSelectRef = useRef(false);
  const [typedDescription, setTypedDescription] = useState('');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [sceneSeed, setSceneSeed] = useState(0);

  const canvasWrapRef = useRef(null);
  const gestureManagerRef = useRef(
    new GestureManager({
      smoothFactor: 0.1,
      deadZoneX: 0.0025,
      swipeSensitivity: 2.5,
      inertiaDamping: 0.9,
      stateLockMs: 200,
      palmStillMs: 100,
    }),
  );

  const handleCardSelect = (id, startTransform) => {
    if (selected?.id === id) return;
    hoveredCardRef.current = null;
    selectedAtRef.current = Date.now();
    flipArmedRef.current = true;
    palmReleasedAfterSelectRef.current = false;
    const randomCard = TAROT_DATA[Math.floor(Math.random() * TAROT_DATA.length)];
    setSelected({ id, startTransform });
    setSelectedCardData(randomCard);
    setFlipped(false);
    setPanelVisible(false);
  };

  const handleCardFlip = () => {
    flipArmedRef.current = false;
    setFlipped(true);
    setTimeout(() => setPanelVisible(true), 520);
  };

  const handleReset = () => {
    setIsTransitioning(true);
    setPanelVisible(false);
    setTimeout(() => {
      setSelected(null);
      setFlipped(false);
      setGestureFlipToken(0);
      setScrollOffset(0);
      setTypedDescription('');
      setGestureCursor({ x: 0.5, y: 0.5, visible: false });
      setGestureState('NONE');
      setHandDetected(false);
      setRaycastEnabled(false);
      hoveredCardRef.current = null;
      lastHoverSelectTsRef.current = 0;
      wasPalmRef.current = false;
      lastFlipTriggerTsRef.current = 0;
      selectedAtRef.current = 0;
      flipArmedRef.current = false;
      palmReleasedAfterSelectRef.current = false;
      setSceneSeed((v) => v + 1);
      gestureManagerRef.current.reset();
      document.body.style.cursor = 'auto';
      setTimeout(() => setIsTransitioning(false), 260);
    }, 380);
  };

  useEffect(() => {
    if (!panelVisible || !selectedCardData?.description) {
      setTypedDescription('');
      return;
    }
    const text = selectedCardData.description;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedDescription(text.slice(0, i));
      if (i >= text.length) {
        window.clearInterval(timer);
      }
    }, 26);
    return () => window.clearInterval(timer);
  }, [panelVisible, selectedCardData]);

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

  const clickCanvasAtCursor = (normalizedPos) =>
    dispatchPointerToCanvas(normalizedPos, ['pointermove', 'pointerdown', 'pointerup', 'click']);

  const hoverCanvasAtCursor = (normalizedPos) =>
    dispatchPointerToCanvas(normalizedPos, ['pointermove']);

  const handleHoverCard = (id, startTransform) => {
    if (id === null || !startTransform) {
      hoveredCardRef.current = null;
      return;
    }
    hoveredCardRef.current = { id, startTransform };
  };

  // ── Gesture ─────────────────────────────────────────────────────────────────
  const handleHandsDetected = (handsData) => {
    const now = Date.now();
    const primaryHand = handsData?.[0] ?? null;
    const result = gestureManagerRef.current.process(primaryHand, {
      hasSelectedCard: Boolean(selected),
      isFlipped: flipped,
    });

    setGestureCursor(result.cursor);
    setGestureState(result.state === 'CLOSED_FIST' ? 'FIST' : result.state === 'OPEN_PALM' ? 'PALM' : 'OTHER');
    setHandDetected(Boolean(primaryHand));
    setRaycastEnabled(result.raycastEnabled && !panelVisible);
    setScrollOffset(result.scrollOffset);
    const isPalm = result.state === 'OPEN_PALM';
    const palmEdge = isPalm && !wasPalmRef.current;

    if (result.cursor.visible && !selected && !panelVisible) {
      hoverCanvasAtCursor(result.cursor);
    }

    // Hard fallback: if palm is open and one card is currently hovered,
    // select that exact card immediately (most intuitive behavior).
    if (
      result.state === 'OPEN_PALM' &&
      !selected &&
      !panelVisible &&
      hoveredCardRef.current &&
      now - lastHoverSelectTsRef.current > 320
    ) {
      lastHoverSelectTsRef.current = now;
      handleCardSelect(hoveredCardRef.current.id, hoveredCardRef.current.startTransform);
      wasPalmRef.current = isPalm;
      return;
    }

    // Two-step reliable flip:
    // 1) preferred: release palm then open again
    // 2) fallback: keep palm open for a while after selection
    if (selected && !flipped && flipArmedRef.current) {
      if (!isPalm) {
        palmReleasedAfterSelectRef.current = true;
      }
      const afterFlyIn = now - selectedAtRef.current > 650;
      const reopenedPalm = isPalm && palmReleasedAfterSelectRef.current;
      const palmHoldFallback = isPalm && now - selectedAtRef.current > 1500;
      if (afterFlyIn && (reopenedPalm || palmHoldFallback) && now - lastFlipTriggerTsRef.current > 320) {
        lastFlipTriggerTsRef.current = now;
        flipArmedRef.current = false;
        setGestureFlipToken((token) => token + 1);
      }
    } else if (flipped) {
      flipArmedRef.current = false;
    }

    result.actions.forEach((action) => {
      if (action.type === 'select_at_cursor') {
        if (!selected && hoveredCardRef.current) {
          handleCardSelect(hoveredCardRef.current.id, hoveredCardRef.current.startTransform);
        } else {
          clickCanvasAtCursor(result.cursor);
        }
        return;
      }

      if (action.type === 'flip_selected_card' && selected && !flipped) {
        setGestureFlipToken((token) => token + 1);
      }
    });
    wasPalmRef.current = isPalm;
  };

  const handlePinchDetected = () => {};
  const guideText = selected
    ? '再次张开掌心，揭示你的命运'
    : '握拳左右滑动以浏览，张开掌心选中你的命运';

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
        onHandsDetected={handleHandsDetected}
        onPinchDetected={handlePinchDetected}
      />

      {/* ── Minimal Top Guide ── */}
      <div
        style={{
          position: 'absolute',
          top: 10,
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

      {/* ── 3D Canvas area ── */}
      <div ref={canvasWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Canvas
          style={{ width: '100%', height: '100%', pointerEvents: panelVisible ? 'none' : 'auto' }}
          camera={{ position: [0, 0.5, 11], fov: 48 }}
          shadows
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.15,
          }}
        >
          <Suspense fallback={null}>
            <SceneContent
              key={sceneSeed}
              selected={selected}
              selectedCardData={selectedCardData}
              flipped={flipped}
              onCardSelect={handleCardSelect}
              onCardFlip={handleCardFlip}
              scrollOffset={scrollOffset}
              gestureFlipToken={gestureFlipToken}
              raycastEnabled={raycastEnabled}
              onHoverCard={handleHoverCard}
            />
          </Suspense>
        </Canvas>

        {gestureCursor.visible && (
          <div
            style={{
              position: 'absolute',
              left: `${gestureCursor.x * 100}%`,
              top: `${gestureCursor.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              zIndex: 26,
              pointerEvents: 'none',
              color: '#ffd87d',
              fontSize: 'clamp(10px,1.2vw,14px)',
              textShadow: '0 0 8px rgba(255,216,125,0.85), 0 0 18px rgba(212,175,55,0.8)',
            }}
          >
            ✦
          </div>
        )}

      </div>

      {flipped && (
        <button
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

      {/* ── Result panel — in-flow layout, no canvas overlap ── */}
      <div
        style={{
          position: 'relative',
          margin: panelVisible
            ? '0 clamp(10px,2vw,22px) max(10px, env(safe-area-inset-bottom))'
            : '0 clamp(10px,2vw,22px) 0',
          maxHeight: panelVisible ? '320px' : '0px',
          opacity: panelVisible ? 1 : 0,
          transform: `translateY(${panelVisible ? '0' : '10px'})`,
          transition:
            'max-height 0.62s cubic-bezier(0.22,1,0.36,1), opacity 0.35s ease, transform 0.35s ease, margin 0.35s ease',
          background:
            'linear-gradient(180deg, rgba(10,5,26,0.97) 0%, rgba(5,2,14,0.99) 100%)',
          backdropFilter: 'blur(20px) saturate(125%)',
          WebkitBackdropFilter: 'blur(20px) saturate(125%)',
          border: '1px solid rgba(212,175,55,0.42)',
          borderRadius: 'clamp(12px,1.8vw,16px)',
          padding: 'clamp(14px,2vw,22px) clamp(16px,3.8vw,36px) clamp(14px,2vw,20px)',
          zIndex: 30,
          boxShadow: '0 -8px 48px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          pointerEvents: panelVisible ? 'auto' : 'none',
        }}
      >
        {/* Gold shimmer top border */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 1.5,
            background:
              'linear-gradient(90deg,transparent 0%,#d4af37 28%,#fff8dc 50%,#d4af37 72%,transparent 100%)',
          }}
        />

        <div
          style={{
            maxWidth: 960,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: 'clamp(16px,4vw,44px)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: 4,
                textTransform: 'uppercase',
                marginBottom: 10,
                background: 'linear-gradient(90deg,#d4af37,#fff8dc,#d4af37)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              命运揭示 · Tarot Reading
            </div>
            <h2
              style={{
                margin: '0 0 12px',
                fontSize: 'clamp(16px,2vw,21px)',
                lineHeight: 1.5,
                textAlign: 'left',
                background: 'linear-gradient(135deg,#ffd87d 0%,#fff 45%,#ffd87d 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              {selectedCardData?.name ?? ''}
            </h2>
            <div
              style={{
                height: 1,
                background:
                  'linear-gradient(90deg,rgba(212,175,55,0.45) 0%,transparent 70%)',
                marginBottom: 14,
                textAlign: 'left',
              }}
            />
            <p
              style={{
                color: 'rgba(247,239,216,0.9)',
                fontSize: 'clamp(13px,1.4vw,15px)',
                lineHeight: 2.05,
                margin: 0,
                textAlign: 'left',
              }}
            >
              {typedDescription}
            </p>
          </div>

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

      <div
        style={{
          position: 'absolute',
          top: 'max(8px, env(safe-area-inset-top))',
          left: 10,
          zIndex: 45,
          color: 'rgba(247,239,216,0.78)',
          fontSize: 11,
          lineHeight: 1.35,
          letterSpacing: 0.2,
          fontFamily: 'monospace',
          pointerEvents: 'none',
          background: 'rgba(8,4,24,0.36)',
          border: '1px solid rgba(212,175,55,0.22)',
          borderRadius: 8,
          padding: '6px 8px',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      >
        {`Hand detected: ${handDetected ? 'Yes' : 'No'}`}
        <br />
        {`Gesture: ${gestureState}`}
        <br />
        {`ScrollOffset: ${scrollOffset.toFixed(4)}`}
        <br />
        {`FlipArmed: ${flipArmedRef.current ? 'Yes' : 'No'}`}
      </div>

      <style>{`
        * { box-sizing: border-box; }

        /* Mobile: use dynamic viewport height to account for browser chrome */
        @supports (height: 100dvh) {
          body, #root { height: 100dvh !important; }
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

        ::-webkit-scrollbar { width:3px; }
        ::-webkit-scrollbar-thumb { background:rgba(212,175,55,0.3); border-radius:2px; }
      `}</style>
    </div>
  );
}

export default App;
