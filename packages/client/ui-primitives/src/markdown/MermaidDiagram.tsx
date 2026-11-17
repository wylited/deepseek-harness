/**
 * Live ```mermaid fences. mermaid is code-split and only imported once a
 * diagram scrolls into view, so sessions without diagrams never download it;
 * the fence's raw text is the failure fallback so a syntax error never eats
 * the author's source.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import css from './MermaidDiagram.module.css'

/** Body attribute ui-layout's theme presenter publishes for the dark palette. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

const noop = (): void => {}

type MermaidApi = typeof import('mermaid')['default']
type MermaidTheme = 'dark' | 'default'

let mermaidPromise: Promise<MermaidApi> | undefined
let initializedTheme: MermaidTheme | undefined

/**
 * mermaid's theme is baked into generated SVG, so a theme flip must
 * re-initialize; diagrams already on screen keep their old palette until the
 * next render pass, which is the accepted cost of not subscribing here.
 * @param mermaid - The loaded module's default export.
 */
function initialize(mermaid: MermaidApi): void {
  const theme: MermaidTheme = document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'default'
  if (theme === initializedTheme) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    fontFamily: 'inherit',
    suppressErrorRendering: true,
  })
  initializedTheme = theme
}

async function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(mod => mod.default)
  const mermaid = await mermaidPromise
  initialize(mermaid)
  return mermaid
}

/**
 * Remove mermaid's measuring element after a render. It lives on
 * document.body only while rendering and survives error paths, where the
 * id is the diagram id itself or its `d`-prefixed form.
 * @param id - The id passed to `render`.
 */
function removeTempElement(id: string): void {
  for (const elementId of [id, `d${id}`]) {
    const element = document.getElementById(elementId)
    if (element?.parentElement === document.body) element.remove()
  }
}

/** One document-wide observer; activated elements leave it permanently. */
class DiagramViewport {
  private observer: IntersectionObserver | undefined
  private readonly activators = new Map<Element, () => void>()

  observe(element: Element, activate: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      activate()
      return noop
    }
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const current = this.activators.get(entry.target)
        /* v8 ignore next -- the observer reports only elements still registered with it. */
        if (current === undefined) continue
        this.activators.delete(entry.target)
        this.observer?.unobserve(entry.target)
        current()
      }
      this.releaseEmptyObserver()
    })
    this.activators.set(element, activate)
    this.observer.observe(element)
    return () => {
      this.activators.delete(element)
      this.observer?.unobserve(element)
      this.releaseEmptyObserver()
    }
  }

  private releaseEmptyObserver(): void {
    if (this.activators.size > 0) return
    this.observer?.disconnect()
    this.observer = undefined
  }
}

const diagramViewport = new DiagramViewport()

/**
 * Render one settled ```mermaid fence as the diagram it describes. mermaid
 * itself loads only when the placeholder first intersects the viewport, and
 * anything it throws keeps the fence's source visible instead of blanking the
 * block.
 * @param props.code - The fence body, exactly as authored.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  // mermaid uses this id for CSS selectors and the temp element's DOM id, so
  // React's `:r1:` separators must go.
  const id = `mermaid-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const [activated, setActivated] = useState(false)
  const [svg, setSvg] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const activate = useCallback(() => { setActivated(true) }, [])

  useEffect(() => {
    if (activated) return
    const element = containerRef.current
    /* v8 ignore next -- React attaches the host ref before running effects. */
    if (element === null) return
    return diagramViewport.observe(element, activate)
  }, [activate, activated])

  useEffect(() => {
    if (!activated) return
    let cancelled = false
    // A re-render with edited fence text must not keep the previous result.
    setSvg(undefined)
    setFailed(false)
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        if (cancelled) return
        const result = await mermaid.render(id, code)
        if (cancelled) return
        setSvg(result.svg)
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        removeTempElement(id)
      }
    })()
    return () => {
      cancelled = true
      removeTempElement(id)
    }
  }, [activated, code, id])

  return (
    <div
      ref={containerRef}
      className={css.diagram}
      data-mermaid-error={failed ? 'true' : undefined}
    >
      {failed
        ? <pre className={css.fallback}><code>{code}</code></pre>
        : svg === undefined
          ? <div className={css.placeholder} />
          : <div dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  )
}
