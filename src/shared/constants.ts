/** Extension UI host ID; also used to exclude our own DOM from scans. */
export const HOST_ID = '__web_sticky_scroll_host__';

/** Must match the rendered .wss-pill height in style.css. */
export const PILL_HEIGHT = 40;

/** Gap below the viewport edge or site header. */
export const PILL_GAP = 10;

/** High enough to clear ordinary page UI without exceeding Chrome's limit. */
export const Z_INDEX = 2147483600;

export const REINDEX_DEBOUNCE = 450;

/** pushState emits no event, so SPA route changes need polling. */
export const URL_POLL_INTERVAL = 1000;

/** Ignore sub-pixel progress noise. */
export const SECTION_PROGRESS_EPS = 0.004;

export const IDLE_DIM_DELAY = 2600;

export const IDLE_TICK_INTERVAL = 400;

export const TOC_PROBE_INTERVAL = 2000;
