import { useEffect, useRef, useCallback } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'

interface UseFocusTrapOptions {
  active: boolean
  onEscape?: () => void
  restoreFocus?: boolean
}

export function useFocusTrap(options: UseFocusTrapOptions): React.RefObject<HTMLDivElement> {
  const { active, onEscape, restoreFocus = true } = options
  const containerRef = useRef<HTMLDivElement>(null!)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Store the previously focused element when the trap activates
  useEffect(() => {
    if (active) {
      previousFocusRef.current = document.activeElement as HTMLElement | null
    }

    return () => {
      if (!active && restoreFocus && previousFocusRef.current) {
        previousFocusRef.current.focus()
        previousFocusRef.current = null
      }
    }
  }, [active, restoreFocus])

  // Restore focus when trap deactivates
  useEffect(() => {
    if (!active && restoreFocus && previousFocusRef.current) {
      previousFocusRef.current.focus()
      previousFocusRef.current = null
    }
  }, [active, restoreFocus])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!active) return

      // Échap ne dépend PAS de la ref : le hook est utilisable en deux
      // temps — d'abord la fermeture au clavier (une ligne dans la modale),
      // le piégeage du Tab quand la ref est attachée. Sans cette
      // distinction, brancher le hook sans ref donnait une modale toujours
      // insensible à Échap, sans le moindre signe.
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault()
        onEscape()
        return
      }

      if (e.key !== 'Tab' || !containerRef.current) return

      const focusableElements = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)

      if (focusableElements.length === 0) {
        e.preventDefault()
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      if (focusableElements.length === 1) {
        e.preventDefault()
        firstElement.focus()
        return
      }

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    },
    [active, onEscape]
  )

  useEffect(() => {
    if (!active) return

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [active, handleKeyDown])

  return containerRef
}
