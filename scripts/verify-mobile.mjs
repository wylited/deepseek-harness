#!/usr/bin/env node
/**
 * Mobile-viewport regression guard for the fork's UI surfaces: the dashboard
 * landing, the per-workspace panel, the usage page's heatmap, and the keys
 * palette/search modal. Loads the live web app at phone (390×844), tablet
 * (768×1024), and desktop (1440×900) sizes and asserts, per viewport:
 *
 *   - no horizontal overflow (document scroller, .wd-page, sections, tables)
 *   - the landing panel is attached and has real height (no detached panel)
 *   - the heatmap is visible and bounded; scrollable on phone, fitting on desktop
 *   - the keys palette opens (Cmd+P) and its panel fits inside the viewport
 *   - a workspace panel opens from a group name and "← Dashboard" returns
 *   - feed body rows render at ≥ 13px
 *   - zero console/page errors
 *
 * PASS/FAIL prints per viewport; screenshots land in
 * /tmp/mobile-<w>-{landing,palette,workspace}.png.
 *
 * Usage: node scripts/verify-mobile.mjs [<base-url-with-token>]
 * Default URL: http://127.0.0.1:3080 + token scraped from /tmp/web3080.log.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/** Locate playwright inside the pnpm store; newest pinned entry wins. */
function loadPlaywright() {
  const store = path.join(repoRoot, 'node_modules', '.pnpm')
  const entry = readdirSorted(store).filter(name => name.startsWith('playwright@')).at(-1)
  if (entry === undefined) throw new Error('playwright not found in node_modules/.pnpm')
  return createRequire(path.join(store, entry, 'node_modules/playwright/package.json'))('playwright')
}

function readdirSorted(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

function defaultUrl() {
  const log = '/tmp/web3080.log'
  let token = process.env.DSH_WEB_TOKEN
  if (token === undefined && fs.existsSync(log)) {
    const match = fs.readFileSync(log, 'utf8').match(/token=([^\s]+)/)
    token = match?.[1]
  }
  if (token === undefined) throw new Error('no token: pass a URL or set DSH_WEB_TOKEN (see /tmp/web3080.log)')
  return `http://127.0.0.1:3080/?token=${token}`
}

/** Headless chromium: the store's playwright wants a browser revision the
 *  machine may not have, so pin the newest installed headless shell. */
function chromiumExecutable(fs) {
  const cache = path.join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  if (process.env.CHROME_BIN !== undefined) return process.env.CHROME_BIN
  const shells = readdirSorted(cache).filter(name => name.startsWith('chromium_headless_shell-')).at(-1)
  if (shells === undefined) return undefined
  return path.join(cache, shells, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
}

const url = process.argv[2] ?? defaultUrl()
const { chromium } = loadPlaywright()
const executablePath = chromiumExecutable()

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '768', width: 768, height: 1024, mobile: false },
  { name: '1440', width: 1440, height: 900, mobile: false },
]

let failures = 0

for (const vp of VIEWPORTS) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push(`${ok ? 'ok' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
    if (!ok) failures += 1
  }

  const browser = await chromium.launch({ headless: true, executablePath })
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => errors.push(`PAGEERROR ${String(e).slice(0, 300)}`))

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.wd-page', { timeout: 15_000 })
    await page.waitForTimeout(1_500) // ledger poll + session tails settle

    // --- landing panel: attached, real height, no overflow ---------------
    // A panel wider than the viewport here means the shell is clipping it
    // (the old min-content-floor bug): content unreachable, no scrollbar.
    // Descendants may only overflow inside the designated scroll strips
    // (.wd-heat-scroll, .wd-tablewrap) or truncate via ellipsis.
    const landing = await page.evaluate(() => {
      const page_ = document.querySelector('.wd-page')
      const rect = page_?.getBoundingClientRect()
      const doc = document.scrollingElement
      const overflows = []
      if (rect !== undefined && rect.width > window.innerWidth + 1) {
        overflows.push(`.wd-page ${Math.round(rect.width)}px > viewport ${window.innerWidth}px (shell clips it)`)
      }
      for (const el of document.querySelectorAll('.wd-page, .wd-page *')) {
        const cs = getComputedStyle(el)
        const scroller = el.classList.contains('wd-heat-scroll') || el.classList.contains('wd-tablewrap')
        if (el.scrollWidth > el.clientWidth + 1 && !scroller && cs.textOverflow !== 'ellipsis') {
          overflows.push(`.${String(el.className).split(' ')[0] || el.tagName} ${el.scrollWidth}>${el.clientWidth} (${cs.overflowX})`)
        }
      }
      return {
        attached: page_?.isConnected ?? false,
        height: rect?.height ?? 0,
        docScrollW: doc?.scrollWidth ?? 0,
        innerW: window.innerWidth,
        overflows: overflows.slice(0, 6),
      }
    })
    check('landing attached with height', landing.attached && landing.height > 100, `h=${Math.round(landing.height)}`)
    check('no document horizontal overflow', landing.docScrollW <= landing.innerW + 1, `${landing.docScrollW}px vs ${landing.innerW}px`)
    check('no clipped element overflow', landing.overflows.length === 0, landing.overflows.join('; '))
    await page.screenshot({ path: `/tmp/mobile-${vp.name}-landing.png` })

    // --- heatmap: visible, bounded, scrollable on phone -------------------
    const heat = await page.evaluate(() => {
      const scroll = document.querySelector('.wd-heat-scroll')
      if (scroll === null) return { present: false }
      const rect = scroll.getBoundingClientRect()
      const pageRect = document.querySelector('.wd-page')?.getBoundingClientRect()
      return {
        present: true,
        scrollable: scroll.scrollWidth > scroll.clientWidth + 1,
        fits: scroll.scrollWidth <= scroll.clientWidth + 1,
        bounded: pageRect === undefined || rect.right <= pageRect.right + 1,
      }
    })
    if (!heat.present) {
      check('heatmap present', false, 'no .wd-heat-scroll — ledger overview failed to load?')
    } else {
      check('heatmap bounded to page', heat.bounded)
      // The year grid is ~700px of content: on any column narrower than that
      // it must scroll inside its strip (not crush, not clip).
      check('heatmap visible/scrollable in its strip', heat.fits || heat.scrollable,
        heat.scrollable ? 'scrolls' : 'fits')
      if (vp.width <= 430) check('heatmap scrollable on phone', heat.scrollable)
    }

    // --- feed body rows: readable size ------------------------------------
    const rowFont = await page.evaluate(() => {
      const row = document.querySelector('.wd-row')
      return row === null ? null : Number.parseFloat(getComputedStyle(row).fontSize)
    })
    if (rowFont !== null) check('feed row font ≥ 13px', rowFont >= 13, `${rowFont}px`)
    else console.log(`  note [${vp.name}]: no feed rows (no sessions) — font check skipped`)

    // --- workspace panel: open from a group name, back reachable ----------
    const groupName = page.locator('button.wd-group-name').first()
    if (await groupName.count() > 0) {
      await groupName.tap().catch(() => groupName.click())
      await page.waitForTimeout(600)
      const panel = await page.evaluate(() => {
        const title = document.querySelector('.wd-title')?.textContent
        const back = [...document.querySelectorAll('.wd-navbtn')].find(b => b.textContent?.includes('Dashboard'))
        const rect = back?.getBoundingClientRect()
        return {
          title,
          back: back !== undefined && rect.height > 0 && rect.width > 0,
          backText: back?.textContent ?? '',
        }
      })
      check('workspace panel opened', panel.title !== 'Dashboard' && panel.title !== undefined, `title=${panel.title}`)
      check('back control visible', panel.back && panel.backText !== '', panel.backText)
      await page.screenshot({ path: `/tmp/mobile-${vp.name}-workspace.png` })
      const backBtn = page.locator('.wd-navbtn', { hasText: 'Dashboard' }).first()
      await backBtn.tap().catch(() => backBtn.click())
      await page.waitForTimeout(400)
      const backTitle = await page.evaluate(() => document.querySelector('.wd-title')?.textContent)
      check('back returns to landing', backTitle === 'Dashboard', `title=${backTitle}`)
    } else {
      console.log(`  note [${vp.name}]: no workspace groups — panel-open check skipped`)
      await page.screenshot({ path: `/tmp/mobile-${vp.name}-workspace.png` })
    }

    // --- keys palette: opens and fits -------------------------------------
    await page.keyboard.press('Meta+p')
    await page.waitForTimeout(500)
    const palette = await page.evaluate(() => {
      const root = document.querySelector('[data-plugin="keys-palette"]')
      const panel = document.querySelector('[data-plugin="keys-palette"] .kp-panel')
      if (root === null || panel === null) return { open: false }
      const rect = panel.getBoundingClientRect()
      return {
        open: root.dataset.open === 'true',
        width: rect.width,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      }
    })
    if (!palette.open || palette.width === undefined) {
      check('palette opens', false, 'data-open != true')
    } else {
      check('palette opens', true)
      const fits = palette.left >= -1 && palette.right <= palette.innerW + 1
        && palette.top >= -1 && palette.bottom <= palette.innerH + 1
      check('palette fits viewport', fits,
        `${Math.round(palette.width)}px wide, right=${Math.round(palette.right)}, bottom=${Math.round(palette.bottom)}`)
    }
    await page.screenshot({ path: `/tmp/mobile-${vp.name}-palette.png` })
    await page.keyboard.press('Escape')

    check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } catch (error) {
    check('script completed', false, String(error).slice(0, 200))
  } finally {
    await browser.close()
  }

  const bad = checks.filter(c => c.startsWith('FAIL'))
  console.log(`\n[${vp.name}×${vp.name === '390' ? '844' : vp.name === '768' ? '1024' : '900'}] ${bad.length === 0 ? 'PASS' : 'FAIL'}`)
  for (const line of checks) console.log(`  ${line}`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
