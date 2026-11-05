import { Modal } from './Modal.jsx';
import { Button } from './Button.jsx';

export function ConfirmDialog({ open, title = 'Are you sure?', message, confirmLabel = 'Confirm', variant = 'danger', busy, onConfirm, onCancel }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? undefined : onCancel}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">{message}</p>
    </Modal>
  );
}
