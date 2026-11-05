import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * Guards unsaved changes:
 * - in-app navigation incl. browser Back/Forward → react-router useBlocker (data router required);
 *   render <UnsavedChangesDialog blocker={blocker} /> to let the user stay or leave
 * - tab close / reload / external navigation → beforeunload
 * Returns { blocker, allowNextNavigation } — call allowNextNavigation() right before a programmatic
 * navigate() that must not be blocked (e.g. /routes/new -> /routes/:id after a successful create).
 */
export function useUnsavedChangesPrompt(dirty) {
  const allowOnce = useRef(false);
  const shouldBlock = useCallback(
    ({ currentLocation, nextLocation }) => {
      if (allowOnce.current) {
        allowOnce.current = false;
        return false;
      }
      return dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search);
    },
    [dirty],
  );
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // If changes are saved while a navigation is blocked, let it through.
  useEffect(() => {
    if (blocker.state === 'blocked' && !dirty) blocker.proceed();
  }, [blocker, dirty]);

  const allowNextNavigation = useCallback(() => {
    allowOnce.current = true;
  }, []);
  return { blocker, allowNextNavigation };
}
