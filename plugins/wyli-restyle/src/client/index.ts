/**
 * wyli-restyle, browser half. Three jobs, in dependency order:
 *
 * 1. ayu-light tint — an `overrideTokens` layer over the built-in light
 *    palette. Token names mirror the light `body` block of
 *    packages/client/ui-theme/src/styles/design-platform.css; every layer
 *    supplies both palette modes (light carries the ayu values, dark repeats
 *    the built-in dark values so nothing goes illegible — the theme lock
 *    below keeps dark from activating anyway). ui-layout's presenter writes
 *    the composed tokens as inline CSS variables on <body>.
 * 2. theme lock — `light` is the only theme: re-assert it on apply and on
 *    every `theme/change` whose preference is not already light. setTheme is
 *    a no-op at the current preference, so the lock never loops.
 * 3. restyle stylesheet — self-hosted Atkinson Hyperlegible (selected by the
 *    ui-theme row's textFontFamily in the profile patch) and straight
 *    corners (radius scale collapsed to 0 plus a universal border-radius
 *    reset). The code font (FiraCode Nerd Font) is a locally installed
 *    system font; nothing is bundled for it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { RESTYLE_CSS } from './restyle-css.generated.ts'

/** Required service: the theme runtime (ui-theme). */
export const inject = ['theme']

/** Override-layer identity for the ayu-light alias tint. */
const TOKEN_SOURCE = 'wyli-restyle/ayu-light'

/**
 * ayu-light alias tint. Light values: ayu palette (bg #fafafa, fg #5c6166,
 * accent #ff9940); dark values repeat the built-in dark sheet.
 */
const AYU_TOKENS: Record<string, { light: string; dark: string }> = {
  // Warm paper and surface layers.
  '--dsw-alias-bg-base': { light: '#fafafa', dark: 'rgb(21, 21, 23)' },
  '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: 'rgb(35, 35, 36)' },
  '--dsw-alias-bg-layer-2': { light: '#f3f4f5', dark: 'rgb(44, 44, 46)' },
  '--dsw-alias-bg-layer-3': { light: '#f3f4f5', dark: 'rgb(53, 54, 56)' },
  '--dsw-alias-bg-overlay': { light: '#f0f1f2', dark: 'rgb(97, 102, 107)' },
  '--dsw-alias-bg-module-platform': { light: '#f3f4f5', dark: 'rgb(53, 54, 56)' },
  '--dsw-alias-bg-multi-select': { light: '#f3f4f5', dark: 'rgb(33, 33, 35)' },
  // Warm hairlines.
  '--dsw-alias-border-l1': { light: '#e5e7e8', dark: 'rgba(255, 255, 255, 0.06)' },
  '--dsw-alias-border-l2': { light: '#e1e3e4', dark: 'rgba(255, 255, 255, 0.12)' },
  '--dsw-alias-border-l3': { light: '#d8dbdc', dark: 'rgba(255, 255, 255, 0.16)' },
  '--dsw-alias-border-l4': { light: '#ced2d3', dark: 'rgba(255, 255, 255, 0.2)' },
  // Orange accent.
  '--dsw-alias-brand-primary': { light: '#ff9940', dark: 'rgb(249, 250, 251)' },
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: 'rgb(255, 153, 64)', dark: 'rgb(86, 134, 254)' },
  '--dsw-alias-brand-text': { light: '#5c6166', dark: 'rgb(249, 250, 251)' },
  '--dsw-alias-button-primary-hover': { light: '#f28739', dark: 'rgb(235, 238, 242)' },
  '--dsw-alias-button-primary-dimmed': { light: 'rgba(255, 153, 64, 0.15)', dark: 'rgb(67, 69, 74)' },
  '--dsw-alias-button-info-fill': { light: '#ff9940', dark: 'rgb(122, 170, 255)' },
  '--dsw-alias-button-info-hover': { light: '#f28739', dark: 'rgb(65, 118, 230)' },
  '--dsw-alias-button-ghost-active-fill': { light: 'rgba(255, 153, 64, 0.14)', dark: 'rgb(67, 69, 74)' },
  '--dsw-alias-button-ghost-active-hover': { light: 'rgba(255, 153, 64, 0.22)', dark: 'rgb(97, 102, 107)' },
  '--dsw-alias-interactive-bg-hover-accent': { light: 'rgba(255, 153, 64, 0.14)', dark: 'rgba(255, 255, 255, 0.24)' },
  // Text.
  '--dsw-alias-label-primary': { light: '#5c6166', dark: 'rgb(249, 250, 251)' },
  '--dsw-alias-label-secondary': { light: '#787b80', dark: 'rgb(207, 211, 214)' },
  '--dsw-alias-link': { light: 'rgb(224, 122, 23)', dark: 'rgb(122, 170, 255)' },
  // Selection and accent-adjacent surfaces.
  '--dsw-alias-bg-document-selection': { light: 'rgba(255, 153, 64, 0.35)', dark: 'rgba(255, 153, 64, 0.35)' },
  '--dsw-alias-state-business-primary': { light: '#ff9940', dark: 'rgb(122, 170, 255)' },
  // Warmth for chat and the navigation column.
  '--dsw-specific-bubble': { light: '#fff3e2', dark: 'rgb(44, 44, 46)' },
  '--dsw-specific-bubble-highlight': { light: '#ffe3c3', dark: 'rgb(67, 69, 74)' },
  '--dsw-specific-sidebar-fill': { light: '#f3f4f5', dark: 'rgb(27, 27, 28)' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: 'rgba(255, 153, 64, 0.28)', dark: 'rgb(53, 54, 56)' },
  // Code surfaces.
  '--dsw-alias-markdown-code-block': { light: '#f3f4f5', dark: 'rgb(27, 27, 28)' },
  '--dsw-alias-markdown-inline-code': { light: '#ececec', dark: 'rgb(41, 41, 41)' },
}

/**
 * Pin the light theme and tint it ayu.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(TOKEN_SOURCE, AYU_TOKENS), 'wyli-restyle: ayu token layer')

  ctx.effect(() => {
    let timer: number | undefined

    // Re-assert light through a DELAYED write: the preference lives in a
    // settings document shared by every theme surface, and a surface whose
    // own write is still in flight folds its (now stale) response back over
    // a later write. Letting the user's transient write settle first makes
    // this the last writer, so the durable value — and every echo of it —
    // ends at light.
    const scheduleLightWrite = (): void => {
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        ctx.theme.setTheme('light')
      }, 250)
    }

    // Event trigger: any non-light preference (dark, system) flips back.
    const enforce = (): void => {
      if (ctx.theme.getTheme().preference !== 'light') scheduleLightWrite()
    }
    enforce()
    const off = ctx.on('theme/change', enforce)

    // DOM trigger: the presenter owns body[data-ds-dark-theme], and a
    // surface that missed the event can re-darken the document without any
    // theme/change here — watch the attribute itself. Removing the
    // attribute also fires the observer; the hasAttribute check keeps that
    // from re-triggering the write.
    let observer: MutationObserver | undefined
    if (typeof document !== 'undefined') {
      observer = new MutationObserver(() => {
        if (document.body.hasAttribute('data-ds-dark-theme')) scheduleLightWrite()
      })
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    }

    return () => {
      clearTimeout(timer)
      observer?.disconnect()
      off()
    }
  }, 'wyli-restyle: theme lock')

  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'wyli-restyle'
    tag.dataset.pluginCss = 'wyli-restyle/restyle.css'
    tag.textContent = RESTYLE_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'wyli-restyle: restyle stylesheet')
}
