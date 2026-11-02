import { create } from 'zustand'

type DialogRequest =
  | { kind: 'alert'; message: string; title?: string; resolve: () => void }
  | { kind: 'confirm'; message: string; title?: string; resolve: (value: boolean) => void }

interface DialogState {
  // File des demandes : un seul dialogue à l'écran, la tête. Remplacer le
  // dialogue ouvert le faisait disparaître sans avoir été lu et laissait sa
  // promesse sans réponse — or des appelants l'attendent en tenant un verrou
  // (la renumérotation d'un livre, jusqu'au redémarrage).
  queue: DialogRequest[]

  // Alert state
  alertOpen: boolean
  alertMessage: string
  alertTitle: string | undefined
  alertResolver: (() => void) | null

  // Confirm state
  confirmOpen: boolean
  confirmMessage: string
  confirmTitle: string | undefined
  confirmResolver: ((value: boolean) => void) | null

  // Actions
  showAlert: (message: string, title?: string) => Promise<void>
  closeAlert: () => void
  showConfirm: (message: string, title?: string) => Promise<boolean>
  resolveConfirm: (value: boolean) => void
}

/** Les champs lus par les composants ne montrent que la tête de la file. */
function showingHeadOf(queue: DialogRequest[]) {
  const head = queue[0]
  const alert = head?.kind === 'alert' ? head : null
  const confirm = head?.kind === 'confirm' ? head : null
  return {
    queue,

    alertOpen: alert !== null,
    alertMessage: alert?.message ?? '',
    alertTitle: alert?.title,
    alertResolver: alert?.resolve ?? null,

    confirmOpen: confirm !== null,
    confirmMessage: confirm?.message ?? '',
    confirmTitle: confirm?.title,
    confirmResolver: confirm?.resolve ?? null,
  }
}

export const useDialogStore = create<DialogState>((set, get) => ({
  ...showingHeadOf([]),

  showAlert: (message: string, title?: string) => {
    return new Promise<void>((resolve) => {
      set(showingHeadOf([...get().queue, { kind: 'alert', message, title, resolve }]))
    })
  },

  closeAlert: () => {
    const [head, ...rest] = get().queue
    if (head?.kind !== 'alert') return
    set(showingHeadOf(rest))
    head.resolve()
  },

  showConfirm: (message: string, title?: string) => {
    return new Promise<boolean>((resolve) => {
      set(showingHeadOf([...get().queue, { kind: 'confirm', message, title, resolve }]))
    })
  },

  resolveConfirm: (value: boolean) => {
    const [head, ...rest] = get().queue
    if (head?.kind !== 'confirm') return
    set(showingHeadOf(rest))
    head.resolve(value)
  },
}))
