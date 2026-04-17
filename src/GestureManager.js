import * as THREE from 'three';

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
      deadZoneX: config.deadZoneX ?? 0.0025,
      swipeSensitivity: config.swipeSensitivity ?? 2.5,
      inertiaDamping: config.inertiaDamping ?? 0.9,
      stateLockMs: config.stateLockMs ?? 200,
      palmStillMs: config.palmStillMs ?? 100,
      palmStillThreshold: config.palmStillThreshold ?? 0.0032,
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
  }

  process(primaryHand, context = {}) {
    const now = Date.now();
    const hasSelectedCard = Boolean(context.hasSelectedCard);
    const isFlipped = Boolean(context.isFlipped);

    if (!primaryHand) {
      this.prevCursor = null;
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

    const nextState = this.#normalizeState(primaryHand.gesture);
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

    if (stateForFrame === 'CLOSED_FIST') {
      this.palmActionTriggered = false;
      if (Math.abs(deltaX) >= this.config.deadZoneX) {
        const impulse = deltaX * this.config.swipeSensitivity;
        this.scrollVelocity = impulse;
        this.scrollOffset += impulse;
      }
    } else if (stateForFrame === 'OPEN_PALM') {
      const motion = Math.hypot(deltaX, deltaY);
      if (motion > this.config.palmStillThreshold) {
        this.lastPalmMoveTs = now;
      }
      const stillEnough = now - this.lastPalmMoveTs >= this.config.palmStillMs;
      if (stillEnough && !this.palmActionTriggered) {
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

    return {
      cursor: { ...this.smoothedCursor, visible: true },
      state: stateForFrame,
      scrollOffset: this.scrollOffset,
      raycastEnabled: stateForFrame === 'OPEN_PALM',
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
