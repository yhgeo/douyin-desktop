'use strict';

// Read the site's own online-viewer statistic, never expand a rounded label such
// as 9万 into a made-up exact count. Current pages expose the store through a
// consumed React context; older pages put it on the provider's value.store.
function numericCount(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countFromContext(value) {
  const stores = [value, value?.store, value?.current, value?.current?.store];
  for (const store of stores) {
    const stats = store?.roomStore?.roomInfo?.room?.room_view_stats;
    if (!stats || stats.is_hidden === true) continue;
    const count = numericCount(stats.display_value);
    if (count !== null) return count;
  }
  return null;
}

function readAudienceCount(element) {
  const key = Object.keys(element).find(name => name.startsWith('__reactFiber$')
    || name.startsWith('__reactInternalInstance$'));
  let fiber = key && element[key];
  const visited = new Set();
  while (fiber && !visited.has(fiber) && visited.size < 160) {
    visited.add(fiber);
    // Hooks retain the context value even when no provider appears in the
    // ancestor chain. This is the shape observed on live.douyin.com.
    let dependency = fiber.dependencies?.firstContext;
    const contexts = new Set();
    while (dependency && !contexts.has(dependency) && contexts.size < 32) {
      contexts.add(dependency);
      const count = countFromContext(dependency.memoizedValue);
      if (count !== null) return count;
      dependency = dependency.next;
    }
    const count = countFromContext(fiber.memoizedProps?.value);
    if (count !== null) return count;
    fiber = fiber.return;
  }
  return null;
}

function updateAudience(element, count) {
  const text = String(count);
  if (element.textContent.trim() === text) return false;
  // Keep any icon/tooltip children owned by React. Only replace a numeric text
  // node, including the site's abbreviated form.
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let node;
  while ((node = walker.nextNode())) {
    if (/^\s*\d+(?:[.,]\d+)*\s*[万亿wWkK]?\+?\s*$/.test(node.nodeValue)) {
      if (node.nodeValue === text) return false;
      const previousValue = node.nodeValue;
      node.nodeValue = text;
      return { node, previousValue, value: text };
    }
  }
  return false;
}

function installLiveAudience({ document: doc = document, intervalMs = 1000 } = {}) {
  let stopped = false;
  let pending = null;
  const replacements = new Map();
  const restore = element => {
    const saved = replacements.get(element);
    if (saved && saved.node.nodeValue === saved.value) saved.node.nodeValue = saved.previousValue;
    replacements.delete(element);
  };
  const update = () => {
    if (stopped) return;
    // Reacquire both DOM and fiber: React replaces them when rooms change.
    const elements = new Set(doc.querySelectorAll('[data-e2e="live-room-audience"]'));
    for (const element of replacements.keys()) if (!elements.has(element)) replacements.delete(element);
    for (const element of elements) {
      const count = readAudienceCount(element);
      if (count === null) { restore(element); continue; }
      const change = updateAudience(element, count);
      if (change) {
        const previous = replacements.get(element);
        if (previous?.node === change.node && previous.value === change.previousValue) {
          change.previousValue = previous.previousValue;
        }
        replacements.set(element, change);
      }
    }
  };
  const schedule = () => {
    if (stopped || pending !== null) return;
    pending = setTimeout(() => { pending = null; update(); }, 250);
    pending.unref?.();
  };
  const observer = new doc.defaultView.MutationObserver(schedule);
  observer.observe(doc, { subtree: true, childList: true, characterData: true });
  // A room-store update need not change the rounded DOM label, so an observer
  // alone cannot keep the exact number current.
  const timer = setInterval(update, intervalMs);
  timer.unref?.();
  update();
  const stop = () => {
    stopped = true;
    observer.disconnect();
    clearInterval(timer);
    clearTimeout(pending);
    for (const element of replacements.keys()) restore(element);
    doc.defaultView.removeEventListener('pagehide', stop);
  };
  doc.defaultView.addEventListener('pagehide', stop, { once: true });
  return [stop];
}

module.exports = { numericCount, countFromContext, readAudienceCount, updateAudience, installLiveAudience };
