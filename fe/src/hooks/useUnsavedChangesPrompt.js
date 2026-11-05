import { useEffect } from 'react';

/**
 * Warns before losing unsaved changes:
 * - browser close / reload / external navigation (beforeunload)
 * - in-app link clicks (capture-phase click on <a href> inside the app)
 * The app uses <BrowserRouter> (not a data router), so react-router's useBlocker is unavailable;
 * browser Back/Forward is therefore not intercepted.
 */
export function useUnsavedChangesPrompt(dirty, message = 'You have unsaved changes. Leave this page and discard them?') {
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    const onClick = (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || a.target === '_blank' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, message]);
}
