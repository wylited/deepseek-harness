/**
 * Dashboard stylesheet: plain dsh light, riding the shell's --dsw-alias-*
 * tokens (ayu-light values under the restyle palette). Straight corners and
 * typography come from the shell; this only lays out the page, the feed
 * rows, the cards/tables, and the heatmap.
 * @module dashboard/client/dashboard-css
 */
export const DASHBOARD_CSS = `
.wd-page {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 30px 64px;
  background: var(--dsw-alias-bg-base, #fafafa);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
}

.wd-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 20px;
}
.wd-header-spring { flex: 1 1 auto; }
.wd-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.wd-version {
  padding: 1px 7px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  border-radius: 0;
  background: transparent;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #787b80);
  cursor: copy;
  white-space: nowrap;
}
.wd-version:hover, .wd-version[data-copied] { color: var(--dsw-alias-brand-primary, #ff9940); }
.wd-navbtn {
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  border-radius: 0;
  background: var(--dsw-alias-bg-layer-1, #fff);
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
}
.wd-navbtn:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f5); }

.wd-section {
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  background: var(--dsw-alias-bg-layer-1, #fff);
  padding: 14px 16px;
  margin: 0 0 16px;
}
.wd-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.wd-section-title {
  margin: 0;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #787b80);
}
.wd-section-note { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9199); }
.wd-empty { padding: 6px 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a9199); }
.wd-zzz { padding: 8px 0; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8a9199); }
.wd-error {
  padding: 8px 12px;
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary, #d7373f);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d7373f) 40%, transparent);
}
.wd-updated {
  margin-top: 20px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a9199);
  text-align: center;
}

/* Ongoing agents feed. Extra gap between the status dot and the title. */
.wd-feed { display: flex; flex-direction: column; }
.wd-feeditem { border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #e5e7e8) 55%, transparent); }
.wd-feeditem:last-child { border-bottom-color: transparent; }
.wd-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 10px 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}
button.wd-row { font: inherit; color: inherit; }
button.wd-row:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f5); }
.wd-row-status {
  padding: 2px 10px 9px 38px;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #787b80);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wd-row-status[data-degraded] { color: var(--dsw-alias-label-tertiary, #8a9199); }
.wd-answer { display: flex; align-items: center; gap: 8px; padding: 0 10px 10px 38px; }
.wd-answer-q {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--dsw-alias-brand-primary, #ff9940);
}
.wd-answer-input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  padding: 5px 9px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  border-radius: 0;
  background: var(--dsw-alias-bg-layer-1, #fff);
  font: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.wd-answer-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #ff9940); }
.wd-answer-send {
  flex: none;
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  border-radius: 0;
  background: var(--dsw-alias-bg-layer-1, #fff);
  font-size: 12px;
  cursor: pointer;
}
.wd-answer-send:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #f3f4f5); }
.wd-answer-send:disabled { opacity: 0.45; cursor: default; }
.wd-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-label-tertiary, #8a9199);
  background: transparent;
}
.wd-dot[data-running] {
  border-color: var(--dsw-alias-brand-primary, #ff9940);
  background: var(--dsw-alias-brand-primary, #ff9940);
}
.wd-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wd-row-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wd-row-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9199); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wd-badge {
  flex: none;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  line-height: 16px;
  padding: 0 7px;
  color: var(--dsw-alias-label-secondary, #787b80);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wd-badge[data-accent] { color: var(--dsw-alias-brand-primary, #ff9940); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff9940) 45%, transparent); }
.wd-when {
  flex: none;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a9199);
  font-variant-numeric: tabular-nums;
}

/* Headline cards. */
.wd-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin: 0 0 16px;
}
.wd-card {
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  background: var(--dsw-alias-bg-layer-1, #fff);
  padding: 12px 14px;
}
.wd-card-num {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.wd-card-label { margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #787b80); }
.wd-card-sub { margin-top: 2px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8a9199); }

/* Tables. */
.wd-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.wd-table th {
  padding: 0 8px 7px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-align: left;
  color: var(--dsw-alias-label-tertiary, #8a9199);
}
.wd-table td { padding: 8px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #e5e7e8) 55%, transparent); }
.wd-table [data-num] {
  text-align: right;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.wd-model { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px; }
.wd-dim { color: var(--dsw-alias-label-tertiary, #8a9199); font-size: 11.5px; }
.wd-share { display: inline-block; height: 3px; vertical-align: middle; background: var(--dsw-alias-brand-primary, #ff9940); opacity: 0.6; }

/* Heatmap: trailing-year Monday-first week columns, month labels on top. */
.wd-heat-scroll { overflow-x: auto; padding-bottom: 4px; }
.wd-heat-grid { display: flex; gap: 6px; width: max-content; }
.wd-heat-days { display: grid; grid-template-rows: 15px repeat(7, 11px); gap: 2px; padding-top: 1px; }
.wd-heat-day { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 9px; line-height: 11px; color: var(--dsw-alias-label-tertiary, #8a9199); }
.wd-heat { display: flex; gap: 2px; }
.wd-heat-col { display: grid; grid-template-rows: 15px repeat(7, 11px); gap: 2px; }
.wd-heat-label { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 9px; line-height: 15px; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8a9199); }
.wd-heat-cell { width: 11px; height: 11px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2, #f3f4f5); }
.wd-heat-cell[data-level='1'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff9940) 22%, var(--dsw-alias-bg-base, #fafafa)); }
.wd-heat-cell[data-level='2'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff9940) 45%, var(--dsw-alias-bg-base, #fafafa)); }
.wd-heat-cell[data-level='3'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff9940) 70%, var(--dsw-alias-bg-base, #fafafa)); }
.wd-heat-cell[data-level='4'] { background: var(--dsw-alias-brand-primary, #ff9940); }
.wd-heat-cell[data-today] { outline: 1px solid var(--dsw-alias-label-secondary, #787b80); }

.wd-bars { display: flex; align-items: flex-end; gap: 2px; height: 40px; margin-top: 20px; }
.wd-bar { flex: 1 1 0; min-width: 2px; background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff9940) 45%, var(--dsw-alias-bg-base, #fafafa)); }
.wd-bar[data-today] { background: var(--dsw-alias-brand-primary, #ff9940); }
.wd-bars-caption {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 9.5px;
  color: var(--dsw-alias-label-tertiary, #8a9199);
}
.wd-heat-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 12px;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 9.5px;
  color: var(--dsw-alias-label-tertiary, #8a9199);
}
.wd-heat-foot .wd-heat-cell { width: 9px; height: 9px; }

/* Sidebar brand slots. */
.wd-brandmark { display: inline-flex; align-items: center; color: inherit; cursor: pointer; }
.wd-brandname { display: inline-flex; align-items: baseline; gap: 8px; cursor: pointer; white-space: nowrap; }
.wd-brandname-title { font-weight: 600; }
.wd-brandname-version { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 10px; opacity: 0.55; }

.wd-page button:focus-visible {
  outline: 1px solid var(--dsw-alias-brand-primary, #ff9940);
  outline-offset: 2px;
}
`
