'use strict';

/**
 * Run `callback` as soon as the document has a root element, and before any
 * page script executes.
 *
 * Why this exists: Electron runs preload scripts *before* the document is
 * created, so at preload time `document.documentElement` is still `null` and
 * `document.childNodes` is empty. The bundled userscript and its DOMUtils
 * dependency both assume a root element exists - `DOMUtils.addStyle` falls back
 * to `document.documentElement.childNodes` when there is no `<head>` - so
 * evaluating the bundle at the raw preload moment throws
 *
 *   TypeError: Cannot read properties of null (reading 'childNodes')
 *
 * from `DouYin.init()` -> `removeAds()` -> `addStyle()`. Because that happens in
 * the userscript's top-level entry point, the throw aborts the entire script:
 * none of the optimisations are applied, while the menu commands registered
 * earlier still work, so the settings UI opens and saves normally but the
 * settings never take effect.
 *
 * Waiting for the parser to insert `<html>` fixes that without losing
 * document-start semantics: the root element is inserted before the page's own
 * `<head>`/`<script>` content is parsed, so the bundle still runs ahead of every
 * page script (verified: `pageScriptsRanAtInject === 0`).
 *
 * @param {() => void} callback
 * @returns {() => void} cancels a pending callback
 */
function whenDocumentElementAvailable(callback) {
  let cancelled = false;
  let observer = null;

  const run = () => {
    if (cancelled || !document.documentElement) return;
    cancelled = true;
    if (observer) observer.disconnect();
    document.removeEventListener('DOMContentLoaded', run);
    document.removeEventListener('readystatechange', run);
    callback();
  };

  // Already parsed (e.g. a same-document preload re-run): run right away.
  if (document.documentElement) {
    callback();
    return () => {};
  }

  // Primary signal: the parser inserting `<html>`.
  observer = new MutationObserver(run);
  observer.observe(document, { childList: true });

  // Backstops in case the mutation never fires for any reason.
  document.addEventListener('DOMContentLoaded', run);
  document.addEventListener('readystatechange', run);

  return () => {
    cancelled = true;
    if (observer) observer.disconnect();
    document.removeEventListener('DOMContentLoaded', run);
    document.removeEventListener('readystatechange', run);
  };
}

module.exports = { whenDocumentElementAvailable };
