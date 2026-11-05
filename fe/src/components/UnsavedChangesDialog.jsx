import { ConfirmDialog } from './ConfirmDialog.jsx';

/** Shown while a react-router blocker holds a navigation because of unsaved changes. */
export function UnsavedChangesDialog({ blocker }) {
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title="Leave without saving?"
      message="You have unsaved changes on this page. If you leave now they will be lost."
      confirmLabel="Leave page"
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    />
  );
}
