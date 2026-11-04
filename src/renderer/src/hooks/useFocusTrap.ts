import { useEffect, useLayoutEffect, useRef, useCallback } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'

interface UseFocusTrapOptions {
  active: boolean
  onEscape?: () => void
  restoreFocus?: boolean
}

interface ActiveTrap {
  container: React.RefObject<HTMLDivElement>
  /** Son rang d'activation : voir `activationRef`. */
  activation: number
}

/** Les pièges actifs, du plus ancien au plus récent. */
const trapStack: ActiveTrap[] = []
let activations = 0

/**
 * Une modale est à l'écran : un piège actif, avec son conteneur. Un panneau qui ne prend
 * qu'Échap (`focus-trap:escape-only`) n'en a pas, et ne couvre rien.
 */
export function isModalOpen(): boolean {
  return trapStack.some((trap) => trap.container.current !== null)
}

/**
 * Le piège qui reçoit Échap et Tab : la dernière modale. Un panneau sans conteneur ne couvre
 * rien, même ouvert après elle : il n'a la main que s'il n'y a aucune modale, sinon Échap le
 * fermerait derrière elle et Tab sortirait du cadre.
 */
function topTrap(): ActiveTrap | undefined {
  for (let i = trapStack.length - 1; i >= 0; i -= 1) {
    if (trapStack[i].container.current !== null) return trapStack[i]
  }
  return trapStack[trapStack.length - 1]
}

export function useFocusTrap(options: UseFocusTrapOptions): React.RefObject<HTMLDivElement> {
  const { active, onEscape, restoreFocus = true } = options
  const containerRef = useRef<HTMLDivElement>(null!)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Le rang se prend au rendu, où un parent passe avant ses enfants. Les effets font l'inverse :
  // deux pièges activés dans le même commit s'empileraient à l'envers, et Échap fermerait le
  // parent d'abord. Un piège qui reste actif garde son rang, quels que soient ses rendus.
  const activationRef = useRef(0)
  if (!active) activationRef.current = 0
  else if (activationRef.current === 0) activationRef.current = ++activations

  useEffect(() => {
    if (!active) return
    const trap: ActiveTrap = { container: containerRef, activation: activationRef.current }
    trapStack.push(trap)
    trapStack.sort((a, b) => a.activation - b.activation)
    return () => {
      trapStack.splice(trapStack.indexOf(trap), 1)
    }
  }, [active])

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

  // Restore focus when trap deactivates.
  //
  // En phase layout, donc avant les effets passifs de TOUS les composants du
  // même commit : quand un piège cède la place à un autre (deux dialogues en
  // file), la restauration du sortant doit précéder la capture de l'entrant,
  // quel que soit leur ordre de montage. Sinon le sortant reprend le focus à
  // l'entrant, et celui-ci capture `body` au lieu du déclencheur.
  useLayoutEffect(() => {
    if (!active && restoreFocus && previousFocusRef.current) {
      previousFocusRef.current.focus()
      previousFocusRef.current = null
    }
  }, [active, restoreFocus])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!active) return

      // Déjà prise par plus proche : la popup de note, la recherche ou une proposition de CM6,
      // ou le sommet lui-même. Une vraie frappe vide les microtâches entre deux écouteurs : le
      // piège qui vient de répondre est déjà démonté, et le suivant se croirait au sommet.
      if (e.defaultPrevented) return
      if (topTrap()?.container !== containerRef) return

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

      // Le focus est resté dehors, sur le déclencheur d'une modale qui ne l'a pas pris : le
      // navigateur l'emmènerait plus loin derrière elle, et plus aucun piège ne le rattraperait.
      if (!containerRef.current.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? lastElement : firstElement).focus()
        return
      }

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
