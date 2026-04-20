import * as THREE from 'three';
import { POINTER_PIXEL_TO_RAD } from './inputConstants';

/**
 * GestureManager
 * - Low-pass filter for cursor smoothing
 * - Dead-zone swipe detection in CLOSED_FIST mode
 * - Strict gesture FSM with state lock
 */
export class GestureManager {
  constructor(config = {}) {
    this.config = {
      smoothFactor: config.smoothFactor ?? 0.1,
      deadZoneX: config.deadZoneX ?? 0.001,
      swipeSensitivity: config.swipeSensitivity ?? 6,
      inertiaDamping: config.inertiaDamping ?? 0.9,
      stateLockMs: config.stateLockMs ?? 200,
      palmStillMs: config.palmStillMs ?? 100,
      palmStillThreshold: config.palmStillThreshold ?? 0.0032,
      /** 与环旋转方向一致；自拍镜像若觉得反了可改为 -1 */
      fistScrollSign: config.fistScrollSign ?? 1,
    };

    this.smoothedCursor = { x: 0.5, y: 0.5 };
    this.currentState = 'UNKNOWN';
    this.lockedUntil = 0;
    this.prevCursor = null;
    this.scrollOffset = 0;
    this.scrollVelocity = 0;
    this.lastPalmMoveTs = 0;
    this.palmActionTriggered = false;
    this.lastHasSelectedCard = false;
    /** 握拳划动：上一帧手掌中心镜像归一化 X（与 RingCarousel 指针公式一致） */
    this.prevPalmCenterNormX = null;
    /** 用于张掌确认：上一帧检测到的手势（CLOSED_FIST / OPEN_PALM / OTHER） */
    this.prevEdgeGesture = null;
  }

  reset() {
    this.currentState = 'UNKNOWN';
    this.lockedUntil = 0;
    this.prevCursor = null;
    this.scrollOffset = 0;
    this.scrollVelocity = 0;
    this.lastPalmMoveTs = 0;
    this.palmActionTriggered = false;
    this.lastHasSelectedCard = false;
    this.prevPalmCenterNormX = null;
    this.prevEdgeGesture = null;
  }

  /** 手掌中心 x（归一化 0~1）：腕 + 四指掌根 MCP 平均 */
  #palmCenterX(landmarks) {
    if (!landmarks?.length) return 0.5;
    const ids = [0, 5, 9, 13, 17];
    let s = 0;
    ids.forEach((i) => {
      s += landmarks[i]?.x ?? 0;
    });
    return s / ids.length;
  }

  process(primaryHand, context = {}) {
    const now = Date.now();
    const hasSelectedCard = Boolean(context.hasSelectedCard);
    const isFlipped = Boolean(context.isFlipped);

    if (!primaryHand) {
      this.prevCursor = null;
      this.prevPalmCenterNormX = null;
      this.prevEdgeGesture = null;
      this.#applyInertia();
      this.lastHasSelectedCard = hasSelectedCard;
      return {
        cursor: { ...this.smoothedCursor, visible: false },
        state: this.currentState,
        scrollOffset: this.scrollOffset,
        raycastEnabled: false,
        actions: [],
      };
    }

    const rawCursor = {
      x: 1 - THREE.MathUtils.clamp(primaryHand.indexTip?.x ?? 0.5, 0, 1),
      y: THREE.MathUtils.clamp(primaryHand.indexTip?.y ?? 0.5, 0, 1),
    };

    this.smoothedCursor.x += (rawCursor.x - this.smoothedCursor.x) * this.config.smoothFactor;
    this.smoothedCursor.y += (rawCursor.y - this.smoothedCursor.y) * this.config.smoothFactor;

    /** 当前帧真实手势（不受 stateLock 滞后），用于握拳划动环 */
    const detectedGesture = this.#normalizeState(primaryHand.gesture);
    const nextState = detectedGesture;
    const actions = [];

    let stateForFrame = this.currentState;
    const canSwitchState = now >= this.lockedUntil;
    const hasStateChanged = nextState !== this.currentState;
    if (canSwitchState && hasStateChanged) {
      const prevState = this.currentState;
      this.currentState = nextState;
      this.lockedUntil = now + this.config.stateLockMs;
      stateForFrame = this.currentState;

      if (nextState === 'OPEN_PALM') {
        // Strong edge-trigger: when user re-opens palm after a card is selected,
        // flip immediately for reliable confirmation.
        if (hasSelectedCard && !isFlipped) {
          actions.push({ type: 'flip_selected_card' });
          this.palmActionTriggered = true;
        }
        this.lastPalmMoveTs = now;
        if (!hasSelectedCard) this.palmActionTriggered = false;
      } else if (prevState === 'OPEN_PALM') {
        this.palmActionTriggered = false;
      }
    }

    const deltaX = this.prevCursor ? this.smoothedCursor.x - this.prevCursor.x : 0;
    const deltaY = this.prevCursor ? this.smoothedCursor.y - this.prevCursor.y : 0;
    this.prevCursor = { ...this.smoothedCursor };

    // If selection state changed (e.g. card was just selected), unlock one more PALM action
    // so the next palm-open can reliably trigger flip.
    if (hasSelectedCard !== this.lastHasSelectedCard) {
      this.palmActionTriggered = false;
      this.lastPalmMoveTs = now;
    }
    this.lastHasSelectedCard = hasSelectedCard;

    if (detectedGesture === 'CLOSED_FIST') {
      this.palmActionTriggered = false;
      const palmCx = this.#palmCenterX(primaryHand.landmarks);
      const palmXNorm = 1 - THREE.MathUtils.clamp(palmCx, 0, 1);
      if (this.prevPalmCenterNormX == null) {
        this.prevPalmCenterNormX = palmXNorm;
      }
      const palmDeltaNorm = palmXNorm - this.prevPalmCenterNormX;
      this.prevPalmCenterNormX = palmXNorm;
      const vw = Math.max(320, context.viewportWidth ?? 900);
      const pixelDelta = palmDeltaNorm * vw;
      if (Math.abs(pixelDelta) >= 0.75) {
        const impulse = pixelDelta * POINTER_PIXEL_TO_RAD * this.config.fistScrollSign;
        this.scrollVelocity = impulse;
        this.scrollOffset += impulse;
      }
    } else {
      this.prevPalmCenterNormX = null;
      if (stateForFrame === 'OPEN_PALM') {
        const motion = Math.hypot(deltaX, deltaY);
        if (motion > this.config.palmStillThreshold) {
          this.lastPalmMoveTs = now;
        }
        const stillEnough = now - this.lastPalmMoveTs >= this.config.palmStillMs;
        const selectionEdgeOnly = Boolean(context.selectionPalmEdgeOnly);
        if (stillEnough && !this.palmActionTriggered && !selectionEdgeOnly) {
          this.palmActionTriggered = true;
          if (hasSelectedCard && !isFlipped) {
            actions.push({ type: 'flip_selected_card' });
          } else if (!hasSelectedCard) {
            actions.push({ type: 'select_at_cursor' });
          }
        }
        this.#applyInertia();
      } else {
        this.#applyInertia();
      }
    }

    if (
      this.prevEdgeGesture === 'CLOSED_FIST' &&
      detectedGesture === 'OPEN_PALM' &&
      context.selectionPalmEdgeOnly
    ) {
      actions.push({ type: 'palm_confirm_select' });
    }
    this.prevEdgeGesture = detectedGesture;

    return {
      cursor: { ...this.smoothedCursor, visible: true },
      state: detectedGesture,
      scrollOffset: this.scrollOffset,
      raycastEnabled: detectedGesture === 'OPEN_PALM',
      actions,
    };
  }

  #applyInertia() {
    if (Math.abs(this.scrollVelocity) < 0.0001) {
      this.scrollVelocity = 0;
      return;
    }
    this.scrollOffset += this.scrollVelocity;
    this.scrollVelocity *= this.config.inertiaDamping;
  }

  #normalizeState(gesture) {
    if (gesture === 'CLOSED_FIST') return 'CLOSED_FIST';
    if (gesture === 'OPEN_PALM') return 'OPEN_PALM';
    return 'OTHER';
  }
}

export default GestureManager;
