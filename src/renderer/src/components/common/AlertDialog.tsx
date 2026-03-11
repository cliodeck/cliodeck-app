import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogStore } from '../../stores/dialogStore'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import './AlertDialog.css'

export function AlertDialog() {
  const { t } = useTranslation('common')
  const { alertOpen, alertMessage, alertTitle, closeAlert } = useDialogStore()
  const okButtonRef = useRef<HTMLButtonElement>(null)

  const dialogRef = useFocusTrap({
    active: alertOpen,
    onEscape: closeAlert,
    restoreFocus: true,
  })

  // Focus the OK button when dialog opens
  useEffect(() => {
    if (alertOpen && okButtonRef.current) {
      okButtonRef.current.focus()
    }
  }, [alertOpen])

  if (!alertOpen) return null

  return (
    <div className="alert-dialog-overlay" onClick={closeAlert}>
      <div
        ref={dialogRef}
        className="alert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={alertTitle ? 'alert-dialog-title' : undefined}
        aria-describedby="alert-dialog-message"
        onClick={(e) => e.stopPropagation()}
      >
        {alertTitle && (
          <div className="alert-dialog-header">
            <h2 id="alert-dialog-title" className="alert-dialog-title">
              {alertTitle}
            </h2>
          </div>
        )}
        <div className="alert-dialog-body">
          <p id="alert-dialog-message" className="alert-dialog-message">
            {alertMessage}
          </p>
        </div>
        <div className="alert-dialog-footer">
          <button
            ref={okButtonRef}
            className="alert-dialog-btn-ok"
            onClick={closeAlert}
          >
            {t('dialog.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
