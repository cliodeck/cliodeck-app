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
      if (!active || !containerRef.current) return

      if (e.key === 'Escape' && onEscape) {
        e.preventDefault()
        onEscape()
        return
      }

      if (e.key !== 'Tab') return

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
