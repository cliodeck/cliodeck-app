import { useEffect, useLayoutEffect, useRef, useCallback } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled]), [contenteditable="true"]'

interface UseFocusTrapOptions {
  active: boolean
  onEscape?: () => void
  restoreFocus?: boolean
  /**
   * À l'écran au-dessus de toute modale (`--z-dialog`) : alerte, confirmation, message et voile de
   * reconstruction. Une modale ouverte après, par un accélérateur de menu, reste dessous : ce piège
   * garde donc Échap et Tab, quel que soit l'ordre d'ouverture.
   */
  aboveModals?: boolean
}

interface ActiveTrap {
  container: React.RefObject<HTMLDivElement>
  /** Son rang d'activation : voir `activationRef`. */
  activation: number
  aboveModals: boolean
}

/** Les pièges actifs, de bas en haut, comme à l'écran. */
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

// Échap maintenu : la répétition du clavier n'est pas un second geste. La première frappe a fermé le
// sommet : la suivante fermerait ce qui est dessous, les Réglages et leurs modifications, ou
// rejetterait la proposition de l'éditeur qui vient de reprendre le focus. Arrêtée avant tout le monde.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && e.repeat) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    true
  )
}

function returnFocus(previousFocus: React.MutableRefObject<HTMLElement | null>): void {
  previousFocus.current?.focus()
  previousFocus.current = null
}

export function useFocusTrap(options: UseFocusTrapOptions): React.RefObject<HTMLDivElement> {
  const { active, onEscape, restoreFocus = true, aboveModals = false } = options
  const containerRef = useRef<HTMLDivElement>(null!)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Le rang se prend au rendu, où un parent passe avant ses enfants. Les effets font l'inverse :
  // deux pièges activés dans le même commit s'empileraient à l'envers, et Échap fermerait le
  // parent d'abord. Un piège qui reste actif garde son rang, quels que soient ses rendus.
  // Le déclencheur aussi se retient au rendu : au commit, un champ en `autoFocus` a déjà le focus.
  const activationRef = useRef(0)
  if (!active) activationRef.current = 0
  else if (activationRef.current === 0) {
    activationRef.current = ++activations
    previousFocusRef.current = document.activeElement as HTMLElement | null
  }

  useEffect(() => {
    if (!active) return
    const trap: ActiveTrap = { container: containerRef, activation: activationRef.current, aboveModals }
    trapStack.push(trap)
    trapStack.sort((a, b) => Number(a.aboveModals) - Number(b.aboveModals) || a.activation - b.activation)
    return () => {
      trapStack.splice(trapStack.indexOf(trap), 1)
    }
  }, [active, aboveModals])

  // Un piège qui cède la place à celui-ci dans le même commit vient de rendre le focus à son propre
  // déclencheur, et c'est lui qu'il faudra retrouver, pas le bouton du sortant, vu au rendu. Si le
  // focus est déjà dans le conteneur, un `autoFocus` l'y a mis : ce qui a été vu au rendu est juste.
  useEffect(() => {
    if (!active) return
    const focused = document.activeElement as HTMLElement | null
    if (!containerRef.current?.contains(focused)) previousFocusRef.current = focused
  }, [active])

  // Restore focus when trap deactivates.
  //
  // En phase layout, donc avant les effets passifs de TOUS les composants du
  // même commit : quand un piège cède la place à un autre (deux dialogues en
  // file), la restauration du sortant doit précéder la capture de l'entrant,
  // quel que soit leur ordre de montage. Sinon le sortant reprend le focus à
  // l'entrant, et celui-ci capture `body` au lieu du déclencheur.
  //
  // Pas dans la fermeture de l'effet : elle passe en phase de mutation, et React remet ensuite le
  // focus sur l'élément qui l'avait, s'il est encore dans la page.
  useLayoutEffect(() => {
    if (!active && restoreFocus) returnFocus(previousFocusRef)
  }, [active, restoreFocus])

  // Et quand il est démonté encore actif : une modale montée à la demande, comme l'éditeur de
  // recette ou les Réglages depuis MainLayout. L'élément qui a le focus part avec elle, et React
  // ne le remet pas.
  useLayoutEffect(
    () => () => {
      if (restoreFocus) returnFocus(previousFocusRef)
    },
    [restoreFocus]
  )

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
