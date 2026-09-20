'use strict';

/**
 * Recovery for Douyin's "是否保存登录信息？" prompt when its own close path hangs.
 *
 * Why it can hang (verified against the live page and Douyin's own bundle):
 *
 *   confirmHandler -> (0,c.dg)(1, {...})       // an async call
 *                       .then(() => h())        // h() = s() + confirmCallback
 *                       .catch(() => h());
 *   h() = s() + n?.()
 *   s() = unmountComponentAtNode(container) + container.remove()
 *
 * `s()` is the only thing that removes the dialog, and on the click path it runs
 * only once that async call settles. When it never settles, the dialog stays, both
 * buttons sit in Semi's loading state (which sets `pointer-events: none`), and the
 * full-screen mask keeps swallowing every click - the page is dead until a reload.
 *
 * The countdown path is different: `defaultHandler` calls the same cleanup
 * *synchronously*, which is why waiting it out always works.
 *
 * So the recovery reuses that same synchronous path: walk React's fiber tree from
 * the dialog's container, find the component's `defaultHandler` prop, and call it.
 * That is Douyin's own cleanup, not a DOM hack, so the React root is unmounted and
 * the shortcut pause is released properly. If the prop cannot be reached (Douyin
 * changed the component), fall back to removing the container so the user is at
 * least unblocked.
 */

const DIALOG_ID = 'trust-logout-dialog';
const BUTTON_SELECTOR = '.trust-login-dialog-button-cancel, .trust-login-dialog-button-confirm';

/** A button is unusable when Semi has put it in its loading state. */
function isButtonStuck(button) {
  if (!button) return false;
  const style = window.getComputedStyle(button);
  if (style.pointerEvents === 'none') return true;
  return button.classList.contains('semi-button-loading') || button.hasAttribute('disabled');
}

/**
 * Is the dialog present but impossible to interact with?
 * That is the state a user can never escape on their own.
 */
function isStuckDialogPresent() {
  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return false;

  const buttons = [...dialog.querySelectorAll(BUTTON_SELECTOR)];
  if (buttons.length === 0) return false;
  return buttons.every(isButtonStuck);
}

/** Walk React's fiber tree from the container looking for a prop we can call. */
function findFiberProp(container, propName) {
  const rootKey = Object.keys(container).find((key) => key.startsWith('__reactContainer'));
  if (!rootKey) return null;

  const seen = new Set();
  const stack = [container[rootKey]];
  let visited = 0;

  while (stack.length && visited < 5000) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    visited += 1;

    const props = fiber.memoizedProps;
    if (props && typeof props[propName] === 'function') return props[propName];

    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  return null;
}

/**
 * Dismiss a stuck trust dialog.
 * @returns {{ recovered: boolean, via: 'defaultHandler'|'removed'|null }}
 */
function recoverStuckDialog() {
  const container = document.getElementById(DIALOG_ID);
  if (!container) return { recovered: false, via: null };

  // Douyin's own synchronous close path - what the countdown uses.
  const defaultHandler = findFiberProp(container, 'defaultHandler');
  if (defaultHandler) {
    try {
      defaultHandler();
    } catch (error) {
      // Fall through to the blunt approach below.
    }
    if (!document.getElementById(DIALOG_ID)) return { recovered: true, via: 'defaultHandler' };
  }

  // Fallback: unmount if we can, then remove the node so the mask goes with it.
  const rootKey = Object.keys(container).find((key) => key.startsWith('__reactContainer'));
  try {
    const legacyRoot = container._reactRootContainer;
    if (legacyRoot && typeof legacyRoot.unmount === 'function') legacyRoot.unmount();
  } catch (error) {
    // Ignore: removing the node below is what actually unblocks the page.
  }
  if (rootKey) delete container[rootKey];

  const node = document.getElementById(DIALOG_ID);
  if (node) node.remove();
  return { recovered: true, via: 'removed' };
}

/**
 * Watch for the stuck state and recover it automatically.
 *
 * A grace period matters: the button is loading because a save may genuinely be in
 * flight, and yanking the dialog out from under a slow request would be wrong. Only
 * once it has been unusable for `graceMs` do we step in.
 *
 * @param {object} [options]
 * @param {number} [options.graceMs]
 * @param {(info: object) => void} [options.onRecovered]
 * @param {number} [options.pollMs]
 * @returns {() => void} detaches
 */
function installStuckDialogWatch(options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 15000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 2000;
  const onRecovered = typeof options.onRecovered === 'function' ? options.onRecovered : () => {};

  let stuckSince = null;

  const timer = setInterval(() => {
    if (!isStuckDialogPresent()) {
      stuckSince = null;
      return;
    }
    if (stuckSince === null) {
      stuckSince = Date.now();
      return;
    }
    if (Date.now() - stuckSince < graceMs) return;

    const stuckMs = Date.now() - stuckSince;
    stuckSince = null;
    const result = recoverStuckDialog();
    if (result.recovered) onRecovered({ ...result, stuckMs });
  }, pollMs);

  return () => clearInterval(timer);
}

module.exports = {
  DIALOG_ID,
  installStuckDialogWatch,
  isStuckDialogPresent,
  recoverStuckDialog,
};
