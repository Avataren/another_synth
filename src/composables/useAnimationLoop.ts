/**
 * Shared animation loop manager
 * Consolidates multiple requestAnimationFrame callbacks into a single loop
 * to reduce overhead when multiple visualizers are active
 */

type AnimationCallback = (time: number) => void;

const animationCallbacks = new Set<AnimationCallback>();
let animationId: number | null = null;
let isRunning = false;

function startLoop() {
  if (isRunning) return;
  isRunning = true;

  const loop = (time: number) => {
    if (!isRunning) return;

    for (const callback of animationCallbacks) {
      try {
        callback(time);
      } catch (e) {
        console.error('Animation callback error:', e);
      }
    }

    if (animationCallbacks.size > 0) {
      animationId = requestAnimationFrame(loop);
    } else {
      isRunning = false;
      animationId = null;
    }
  };

  animationId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  isRunning = false;
}

/**
 * Register a callback to be called on each animation frame
 * Returns a cleanup function to unregister the callback
 */
export function registerAnimationCallback(callback: AnimationCallback): () => void {
  animationCallbacks.add(callback);
  startLoop();

  return () => {
    animationCallbacks.delete(callback);
    if (animationCallbacks.size === 0) {
      stopLoop();
    }
  };
}

/**
 * Get the current number of registered callbacks (for debugging)
 */
export function getAnimationCallbackCount(): number {
  return animationCallbacks.size;
}
