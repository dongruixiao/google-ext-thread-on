# 对外名称：候选与查重结果

> 当前状态：**待定**。仓库名 `web-sticky-scroll` 作为技术标识保持不变；
> 下面所有重名检查都是 2026-10-13 在 Chrome 应用商店搜索页实测的。

## 命名约束（踩过的坑）

1. 商店名称字段 **≤ 45 字符**，建议「品牌 + 一句功能说明」的结构。
2. **别用 "Sticky Scroll" 全词**：商店里已有一个同名插件（功能也是 pin 元素），会互相干扰。
3. **"pin" 开头的词搜索吃亏**：实测搜 `heading pin` 返回的 8 个结果全是 Pinterest 相关扩展，
   我们的插件会被淹没——名字里带 pin 可以，但别指望靠品类词被搜到。
4. 仓库名一旦改动，GitHub Pages 的隐私政策链接会变（上架必填项），所以**仓库名不动，只改对外展示名**。

## 候选清单（按查重结果分组）

### 方向一：曲别针 / 夹子（意象准，无重名）

| 候选 | 含义 | 查重 |
| --- | --- | --- |
| **TopClip** | 把标题「夹」在顶部 | ✅ 无同名 |
| **ClipRead** | 曲别针 + 阅读 | ✅ 无同名 |
| **ClipHead** | 夹住标题（head 有"头"的歧义） | ✅ 无同名 |
| 回形针（纯中文名） | 最形象的比喻 | ✅ 无同名；英文市场为零 |

### 方向二：clamp（CSS `clamp()` 的梗，开发者一眼懂）

| 候选 | 含义 | 查重 |
| --- | --- | --- |
| TopClamp / ClampHead / TitleClamp / StickyClamp | 把标题钳在顶部 | ✅ 均无同名 |
| Clamp | 单词最干净 | ❌ 已有同名扩展（还有 tab-clamp、clamptastic） |

### 方向三：title sticky（最好搜，最没个性）

| 候选 | 含义 | 查重 |
| --- | --- | --- |
| StickyTitle / TitleSticky | 直白描述 | ✅ 无同名（但搜索结果会被一堆便签类 "sticky notes" 占满） |
| StickyHeadings | 你原本的提议 | ✅ 无同名；⚠️ 实测搜索会被 "Disable Sticky Headers / Sticky Header Hider" 这类**反向工具**包围 |

### 方向四：pinner（有个性，但搜索吃亏）

| 候选 | 含义 | 查重 |
| --- | --- | --- |
| TitlePin / TopPinner / HeadPinner | 大头针钉住标题 | ✅ 未见同名；⚠️ 见约束 3，"pin" 品类词被 Pinterest 生态淹没 |
| Pinnit | — | ❌ 已被占用 |

## 我的推荐

**首选：TopClip（中文可叫「曲别针」）**

- 意象正是你要的"曲别针把标题别在页面顶部"，英文一个词、好念好记，中文名可以并行使用
- 商店名写成 `TopClip（曲别针）— 网页章节吸顶导航`，中英双市场都能命中
- 无重名；不含 pin，不会和 Pinterest 生态打架

**次选**：`StickyTitle`（最好搜、最稳，但没个性）；`TopClamp`（开发者梗，冷峻）。

**如果坚持 pin 系列**：可以接受"只靠品牌词被搜到、不靠品类词"，那就 `TitlePin`。

## 定了之后要改哪些地方

1. `manifest.json` 的 `name` / `description`
2. `src/popup/popup.html`、`src/options/options.html` 的标题
3. `store/listing.md` 的名称与简短说明（**简短说明里保留 Sticky / 吸顶 / 目录等关键词**，不影响搜索）
4. `README.md` 顶部那行"对外名称"
5. 重新 `npm run package` 并出 release（仓库名**不动**）
