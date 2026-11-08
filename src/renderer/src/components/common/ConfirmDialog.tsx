import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogStore } from '../../stores/dialogStore'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { backdropClose } from '../../utils/backdropClose'
import './ConfirmDialog.css'

export function ConfirmDialog() {
  const { t } = useTranslation('common')
  const { confirmOpen, confirmMessage, confirmTitle, confirmDanger, confirmResolver, resolveConfirm } = useDialogStore()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  const dialogRef = useFocusTrap({
    active: confirmOpen,
    onEscape: () => resolveConfirm(false),
    restoreFocus: true,
    aboveModals: true,
  })

  // Le focus initial va sur ANNULER, jamais sur Confirmer.
  //
  // Ce dialogue sert aux actions destructrices — purge du journal de
  // recherche, détachement de vault. Avec le focus sur Confirmer, deux
  // Entrée successifs suffisaient à effacer tout le journal, la purge
  // demandant justement deux confirmations d'affilée. Le geste par défaut
  // doit être celui qui ne détruit rien.
  //
  // Dépend aussi du résolveur, propre à chaque demande : deux confirmations
  // en file se succèdent sans passer par « fermé », et le focus resterait sur
  // le Confirmer qui vient de servir.
  useEffect(() => {
    if (confirmOpen && cancelButtonRef.current) {
      cancelButtonRef.current.focus()
    }
  }, [confirmOpen, confirmResolver])

  if (!confirmOpen) return null

  return (
    <div className="confirm-dialog-overlay" {...backdropClose(() => resolveConfirm(false))}>
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
            ref={cancelButtonRef}
            className="confirm-dialog-btn-cancel"
            onClick={() => resolveConfirm(false)}
          >
            {t('dialog.cancel')}
          </button>
          <button
            className={`confirm-dialog-btn-confirm${confirmDanger ? ' is-danger' : ''}`}
            onClick={() => resolveConfirm(true)}
          >
            {t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
