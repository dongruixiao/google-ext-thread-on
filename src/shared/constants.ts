/** 插件 UI 宿主节点 id（同时用于把自身从 DOM 扫描中排除） */
export const HOST_ID = '__web_sticky_scroll_host__';

/** 液态玻璃胶囊高度，与 style.css 中的 .wss-pill 保持一致 */
export const PILL_HEIGHT = 38;

/** 胶囊与页面顶部（或原站固定导航栏底部）之间的留白 */
export const PILL_GAP = 10;

/** 远高于常见页面元素，避免被站点样式盖住 */
export const Z_INDEX = 2147483600;

/** 探测到的固定导航栏高度最多按视口的这个比例计算，防止误判整屏遮罩 */
export const MAX_OVERLAY_RATIO = 0.35;

/** DOM 变动后重新索引标题的防抖时间 */
export const REINDEX_DEBOUNCE = 450;

/** SPA 路由轮询间隔（pushState 不触发事件，只能靠轮询兜底） */
export const URL_POLL_INTERVAL = 1000;

/** 小节阅读进度变化小于该阈值时不刷新 UI，减少无谓渲染 */
export const SECTION_PROGRESS_EPS = 0.004;

/** 停止滚动多久后开始淡出（智能策略） */
export const IDLE_DIM_DELAY = 2600;

/** 空闲检查间隔：用于智能模式淡出等与滚动无关的状态推进 */
export const IDLE_TICK_INTERVAL = 400;

/** 原站目录可见性的探测间隔 */
export const TOC_PROBE_INTERVAL = 1200;
