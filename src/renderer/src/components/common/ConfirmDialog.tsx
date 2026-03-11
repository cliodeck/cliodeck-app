import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogStore } from '../../stores/dialogStore'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import './ConfirmDialog.css'

export function ConfirmDialog() {
  const { t } = useTranslation('common')
  const { confirmOpen, confirmMessage, confirmTitle, resolveConfirm } = useDialogStore()
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  const dialogRef = useFocusTrap({
    active: confirmOpen,
    onEscape: () => resolveConfirm(false),
    restoreFocus: true,
  })

  // Focus the confirm button when dialog opens
  useEffect(() => {
    if (confirmOpen && confirmButtonRef.current) {
      confirmButtonRef.current.focus()
    }
  }, [confirmOpen])

  if (!confirmOpen) return null

  return (
    <div className="confirm-dialog-overlay" onClick={() => resolveConfirm(false)}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={confirmTitle ? 'confirm-dialog-title' : undefined}
        aria-describedby="confirm-dialog-message"
        onClick={(e) => e.stopPropagation()}
      >
        {confirmTitle && (
          <div className="confirm-dialog-header">
            <h2 id="confirm-dialog-title" className="confirm-dialog-title">
              {confirmTitle}
            </h2>
          </div>
        )}
        <div className="confirm-dialog-body">
          <p id="confirm-dialog-message" className="confirm-dialog-message">
            {confirmMessage}
          </p>
        </div>
        <div className="confirm-dialog-footer">
          <button
            className="confirm-dialog-btn-cancel"
            onClick={() => resolveConfirm(false)}
          >
            {t('dialog.cancel')}
          </button>
          <button
            ref={confirmButtonRef}
            className="confirm-dialog-btn-confirm"
            onClick={() => resolveConfirm(true)}
          >
            {t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
