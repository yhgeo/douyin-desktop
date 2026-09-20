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
 * only once that async call settles. When it never settles, the dialog stays, the
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

/**
 * Douyin has renamed these classes before, and a miss means the dialog is never
 * detected at all - the failure mode is silent, so a looser fallback is worth it.
 */
const BUTTON_FALLBACK_SELECTOR = '[class*="trust-login-dialog-button"]';

/** The dialog's buttons, by exact class first and a looser match second. */
function findDialogButtons(dialog) {
  const exact = [...dialog.querySelectorAll(BUTTON_SELECTOR)];
  if (exact.length > 0) return exact;
  return [...dialog.querySelectorAll(BUTTON_FALLBACK_SELECTOR)]
    .filter((node) => node.tagName === 'BUTTON' || node.getAttribute('role') === 'button');
}

/**
 * Is this button unusable?
 *
 * Semi's loading state sets `pointer-events: none`, which is what the live stuck
 * dialog showed. A plain `disabled` button is just as unclickable but keeps
 * `pointer-events: auto`, so every plausible signal is checked - the property, the
 * attribute, the aria flag, the loading class, and a spinner child. Any one of them
 * can be the only marker depending on the build, and a miss costs the user the
 * whole page.
 */
function isButtonStuck(button) {
  if (!button) return false;
  if (button.disabled) return true;
  if (button.getAttribute('aria-disabled') === 'true') return true;
  if (button.classList.contains('semi-button-loading')) return true;
  if (button.querySelector('.semi-spin, .semi-spinner, [class*="loading"]')) return true;
  return window.getComputedStyle(button).pointerEvents === 'none';
}

/**
 * Is the dialog present but no longer able to close itself?
 *
 * A loading button is the signal: Semi sets `pointer-events: none` while loading,
 * and - crucially - clicking also runs `clearTimeout(c.current)`, which cancels the
 * countdown. So before any click the dialog still closes itself, and after a click
 * the async call is the *only* remaining way out. A button left loading therefore
 * means "a click happened and the close path is now waiting on that call".
 *
 * Any single loading button is enough. Requiring *every* button to be stuck missed
 * the common case of clicking only 保存, which left the dialog wedged forever with
 * nothing recovering it.
 */
function isStuckDialogPresent() {
  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return false;

  const buttons = findDialogButtons(dialog);
  if (buttons.length === 0) return false;
  return buttons.some(isButtonStuck);
}

/** Snapshot of the dialog's shape, for diagnosing a detection miss. */
function describeDialog(dialog) {
  const buttons = findDialogButtons(dialog);
  return {
    id: dialog.id,
    buttonCount: buttons.length,
    buttons: buttons.map((button) => ({
      cls: button.className,
      pointerEvents: window.getComputedStyle(button).pointerEvents,
      disabled: Boolean(button.disabled),
      ariaDisabled: button.getAttribute('aria-disabled'),
      loadingClass: button.classList.contains('semi-button-loading'),
      hasSpinner: Boolean(button.querySelector('.semi-spin, .semi-spinner, [class*="loading"]')),
    })),
  };
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
 * Watch for the stuck state and close it as soon as it is confirmed.
 *
 * Closing is immediate - the dialog is gone within a couple of polls of the click
 * that wedged it. An earlier version waited 6s (on a 2s poll, so up to 8s before
 * anything happened), which read as "the app is broken" rather than "the app is
 * helping". Waiting buys nothing: the click's request is fire-and-forget, so
 * dismissing the dialog does not cancel it, and Douyin's own countdown path closes
 * the dialog synchronously without waiting for anything either.
 *
 * The one concession is that the state must survive two consecutive polls, so a
 * single-frame re-render is not mistaken for a wedge. At the default 400ms poll that
 * costs 400ms and bounds the whole thing at roughly 0.8s.
 *
 * @param {object} [options]
 * @param {number} [options.pollMs]
 * @param {number} [options.graceMs] how long the stuck state must persist
 * @param {number} [options.diagnoseMs] report a dialog that never looks stuck
 * @param {(info: object) => void} [options.onRecovered]
 * @param {(info: object) => void} [options.onDiagnostic]
 * @returns {() => void} detaches
 */
function installStuckDialogWatch(options = {}) {
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 400;
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 400;
  const diagnoseMs = Number.isFinite(options.diagnoseMs) ? options.diagnoseMs : 9000;
  const onRecovered = typeof options.onRecovered === 'function' ? options.onRecovered : () => {};
  const onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {};

  let stuckSince = null;
  let presentSince = null;
  let diagnosed = false;

  const timer = setInterval(() => {
    const dialog = document.getElementById(DIALOG_ID);

    if (!dialog) {
      stuckSince = null;
      presentSince = null;
      diagnosed = false;
      return;
    }

    if (presentSince === null) presentSince = Date.now();

    if (!isStuckDialogPresent()) {
      stuckSince = null;
      // The dialog normally shows for its countdown, so "present but not stuck" is
      // only worth reporting once it has outlasted any plausible countdown. Without
      // this a detection miss is invisible: nothing happens and nothing is logged.
      if (!diagnosed && Date.now() - presentSince >= diagnoseMs) {
        diagnosed = true;
        onDiagnostic({ reason: 'dialog present but never detected as stuck', ...describeDialog(dialog) });
      }
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
  describeDialog,
  findDialogButtons,
  installStuckDialogWatch,
  isButtonStuck,
  isStuckDialogPresent,
  recoverStuckDialog,
};
