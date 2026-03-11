import { create } from 'zustand'

interface DialogState {
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

export const useDialogStore = create<DialogState>((set, get) => ({
  // Alert state
  alertOpen: false,
  alertMessage: '',
  alertTitle: undefined,
  alertResolver: null,

  // Confirm state
  confirmOpen: false,
  confirmMessage: '',
  confirmTitle: undefined,
  confirmResolver: null,

  showAlert: (message: string, title?: string) => {
    return new Promise<void>((resolve) => {
      set({
        alertOpen: true,
        alertMessage: message,
        alertTitle: title,
        alertResolver: resolve,
      })
    })
  },

  closeAlert: () => {
    const { alertResolver } = get()
    if (alertResolver) {
      alertResolver()
    }
    set({
      alertOpen: false,
      alertMessage: '',
      alertTitle: undefined,
      alertResolver: null,
    })
  },

  showConfirm: (message: string, title?: string) => {
    return new Promise<boolean>((resolve) => {
      set({
        confirmOpen: true,
        confirmMessage: message,
        confirmTitle: title,
        confirmResolver: resolve,
      })
    })
  },

  resolveConfirm: (value: boolean) => {
    const { confirmResolver } = get()
    if (confirmResolver) {
      confirmResolver(value)
    }
    set({
      confirmOpen: false,
      confirmMessage: '',
      confirmTitle: undefined,
      confirmResolver: null,
    })
  },
}))
