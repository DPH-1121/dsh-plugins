/*
 * dsh-plugins-market —— 客户端半（浏览器 bundle）
 *
 * ★ 这是一个 **classic script**，不是 ES module：
 *   不能出现 import / export / 顶层 await。宿主是用 `<script async src=...>`
 *   加载它的（没有 type="module"），一旦写了 export 就是 SyntaxError，
 *   页面会报 “bundle ... loaded without registering ...”。
 *
 * ★ load({ id }) 里的 id **必须**等于包名 dsh-plugins-market：
 *   它同时是启动图的行 id（= cordis.patch.yml 里的 name），也是
 *   ClientModuleRegistry 用来做 arrive() 断言的键。
 *
 * ★ 只 require("react")：它是 shell 内置的 baseline seed word（0.1.5 → 0.1.7
 *   都在）。别的 baseline 词虽然也能 require，但这里刻意一个都不用 ——
 *   依赖面越小，跨版本活下来的概率越大。
 *
 * ── 这一版面板做什么 ──────────────────────────────────────────
 *
 * 只做一件事：**把搜集到的 GitHub 插件项目列出来、搜得到、复制的走**。
 * 没有安装、没有体检、没有审核、没有回滚 —— 那些已经不是这个面板的职责：
 * 官方桌面版自带「设置 → 插件 → 添加插件」，把这里复制的 `github:owner/repo`
 * 粘进去就装上了。
 *
 * ── 三条性能约定 ──────────────────────────────────────────────
 *
 *   ① **一次取全量，之后本地搜。** 索引整份（列式 + gzip，约 700KB）一次性
 *      拿到浏览器内存里；搜索在本地做，按键到出结果没有网络往返。
 *   ② **只渲染视口里的那十几行。** 8780 行 DOM 会卡，20 行不会 ——
 *      列表用绝对定位 + overscan 做虚拟滚动。
 *   ③ **模块级缓存。** 面板被关掉再打开时（组件重新挂载）不再重新取数，
 *      直接复用上一次的 payload。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugins-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;
		var useMemo = react.useMemo;
		var useRef = react.useRef;
		var memo = react.memo;

		//#region ── 常量 ────────────────────────────────────────────────
		var PANEL_ID = "dsh-plugins-market";
		var PANEL_LABEL = "插件搜集";
		var API_PATH = "/dsh-plugins-market/api";
		var REPO_HOMEPAGE = "https://github.com/DPH-1121/dsh-plugins";
		/** 行高必须与 CSS 里的 .dpm-row 高度一致 —— 虚拟滚动靠它算位置 */
		var ROW_H = 96;
		/** 视口上下各多渲染几行，滚动时不会看见空白 */
		var OVERSCAN = 6;
		/** 搜索结果上限：再多的结果人也不会翻，截断能让滚动高度稳定 */
		var MAX_RESULTS = 3000;
		//#endregion

		//#region ── 样式 ────────────────────────────────────────────────
		/*
		 * 宿主没有 CSS loader 契约。约定做法是在 factory 里注入一个 <style>：
		 *   - factory 只在「物化」时执行一次，所以注入点天然正确；
		 *   - data-plugin 必须是包名（HMR 靠它认领/移除标签）；
		 *   - data-plugin-css 用稳定的 <包名>/<文件> 形式做幂等判断；
		 *   - typeof document 守卫与 querySelector 幂等检查缺一不可（HMR 会重新物化）。
		 *
		 * 颜色一律走宿主的 --dsw-alias-* 设计令牌（带兜底值），这样浅色 / 深色
		 * 主题跟着宿主走，不用自己维护两套配色。
		 */
		var CSS = `
.dpm-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,#fff)}
.dpm-head{flex:0 0 auto;padding:14px 18px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:var(--dsw-alias-bg-base,#fff);z-index:7}
.dpm-head-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dpm-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.dpm-ver{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a919f);border:1px solid var(--dsw-alias-border-l1,#e6e8eb);border-radius:999px;padding:1px 7px}
.dpm-spacer{flex:1 1 auto}
.dpm-sub{margin:6px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5f6670);display:flex;flex-wrap:wrap;gap:3px 12px;align-items:center}
.dpm-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe);display:inline-block;margin-right:5px;vertical-align:middle}
.dpm-dot[data-tone=warn]{background:var(--dsw-alias-state-warning-primary,#d97706)}
.dpm-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary,#dc2626)}

/* 搜索行：吸顶。负 margin 抵消父容器内边距，让不透明底色铺满整宽 */
.dpm-search{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:10px 0 11px;background:var(--dsw-alias-bg-base,#fff);flex-wrap:wrap}
.dpm-input{flex:1 1 240px;min-width:160px;max-width:560px;font-family:inherit;font-size:13px;padding:8px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:inherit;transition:border-color .12s}
.dpm-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dpm-input::-webkit-search-cancel-button{display:none}
.dpm-sort{font:inherit;font-size:13px;padding:8px;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:inherit;max-width:100%}
.dpm-count{font-size:11.5px;color:var(--dsw-alias-label-secondary,#5f6670);white-space:nowrap}
.dpm-count b{color:var(--dsw-alias-label-primary,#1f2328);font-weight:650}

.dpm-btn{appearance:none;font-family:inherit;font-size:12px;line-height:1;padding:7px 11px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);white-space:nowrap;transition:background .12s,border-color .12s}
.dpm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f1f3)}
.dpm-btn:disabled{opacity:.45;cursor:not-allowed}
.dpm-btn-primary{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-weight:600}
.dpm-btn-primary:hover:not(:disabled){filter:brightness(.94)}
.dpm-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#5f6670)}
.dpm-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f1f3);color:var(--dsw-alias-label-primary,#1f2328)}
.dpm-btn-xs{font-size:11.5px;padding:5px 9px}
.dpm-btn[data-done]{background:#e8f6ee;border-color:#bfe3cd;color:#15803d}

/* 列表：虚拟滚动容器（position:relative + 绝对定位的行） */
.dpm-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 18px;scrollbar-gutter:stable}
.dpm-list{position:relative;width:100%}
.dpm-row{position:absolute;left:0;right:0;box-sizing:border-box;display:flex;gap:12px;align-items:flex-start;padding:11px 2px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f2)}
.dpm-row-main{flex:1 1 auto;min-width:0}
.dpm-repo{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dpm-repo-name{font-size:13.5px;font-weight:650;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:inherit;text-decoration:none;cursor:pointer}
.dpm-repo-name:hover{color:var(--dsw-alias-state-business-primary,#4d6bfe);text-decoration:underline}
.dpm-repo-owner{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919f)}
.dpm-desc{margin:4px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5f6670);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dpm-desc[data-empty]{font-style:italic;opacity:.65}
.dpm-meta{margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919f)}
.dpm-chip{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6670);border:1px solid var(--dsw-alias-border-l1,#eceef1);white-space:nowrap}
.dpm-chip[data-dim]{opacity:.75}
.dpm-row-side{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:7px;padding-top:1px}
.dpm-stars{display:inline-flex;align-items:baseline;gap:4px;font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-primary,#1f2328);white-space:nowrap}
.dpm-stars span{font-size:11px;color:#e3a008}
.dpm-acts{display:flex;gap:6px}
.dpm-archived{font-size:10.5px;font-weight:650;color:#b45309;background:#fef7e7;border:1px solid #f0dfae;border-radius:5px;padding:1px 6px}

.dpm-state{padding:48px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#8a919f);font-size:12.5px}
.dpm-state h4{margin:0 0 6px;font-size:13.5px;color:var(--dsw-alias-label-primary,#1f2328);font-weight:650}
.dpm-state code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);padding:1px 5px;border-radius:4px}
.dpm-state-acts{margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.dpm-skel{height:11px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#eff1f3);animation:dpmPulse 1.2s ease-in-out infinite}
@keyframes dpmPulse{0%,100%{opacity:.55}50%{opacity:1}}

.dpm-foot{flex:0 0 auto;display:flex;gap:10px;align-items:center;padding:7px 18px;border-top:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:var(--dsw-alias-bg-layer-1,#fafbfc);font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919f);flex-wrap:wrap}
.dpm-kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);border-bottom-width:2px;border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-secondary,#5f6670)}

/* 关于 / 状态覆盖层 */
.dpm-about{position:absolute;inset:0;z-index:20;background:var(--dsw-alias-bg-base,#fff);display:flex;flex-direction:column;min-height:0}
.dpm-about-head{flex:0 0 auto;display:flex;gap:10px;align-items:center;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8eb)}
.dpm-about-title{margin:0;font-size:14px;font-weight:650}
.dpm-about-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px}
.dpm-sec{margin:0 0 18px}
.dpm-sec h5{margin:0 0 8px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary,#5f6670);letter-spacing:.02em}
.dpm-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.dpm-kv-k{color:var(--dsw-alias-label-tertiary,#8a919f);white-space:nowrap}
.dpm-kv-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--dsw-alias-label-primary,#1f2328)}
.dpm-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:650;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6670)}
.dpm-tag[data-ok]{background:#e8f6ee;border-color:#bfe3cd;color:#15803d}
.dpm-tag[data-warn]{background:#fef7e7;border-color:#f0dfae;color:#a16207}
.dpm-note{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#5f6670);margin:6px 0 0}
.dpm-note code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);padding:1px 5px;border-radius:4px}
.dpm-err{font-size:11.5px;color:#b45309;background:#fef7e7;border:1px solid #f0dfae;border-radius:7px;padding:8px 10px;margin:8px 0 0;white-space:pre-wrap;word-break:break-word}

.dpm-toast{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:30;background:#1f2328;color:#fff;font-size:12px;padding:7px 13px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.22);pointer-events:none;opacity:.97}

.dpm-crash{padding:40px 20px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5f6670);text-align:center}
.dpm-crash pre{margin:12px auto 0;max-width:560px;text-align:left;font-size:11px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e6e8eb);border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap}

/* 侧栏导航图标 */
.dpm-rail{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%}
.dpm-rail svg{width:17px;height:17px;display:block}

@media (prefers-color-scheme: dark){
  .dpm-btn[data-done]{background:#17301f;border-color:#2f5c3c;color:#7ddba0}
  .dpm-archived{background:#2f2b1e;border-color:#4a4230;color:#e8c46a}
  .dpm-err{background:#2f2b1e;border-color:#4a4230;color:#e8c46a}
  .dpm-tag[data-ok]{background:#17301f;border-color:#2f5c3c;color:#7ddba0}
  .dpm-tag[data-warn]{background:#2f2b1e;border-color:#4a4230;color:#e8c46a}
  .dpm-toast{background:#e9eaec;color:#16181c}
}
`;
		var CSS_TAG_ID = "dsh-plugins-market/panel.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null
		) {
			var styleTag = document.createElement("style");
			styleTag.dataset.plugin = "dsh-plugins-market";
			styleTag.dataset.pluginCss = CSS_TAG_ID;
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
		}
		//#endregion

		//#region ── RPC ──────────────────────────────────────────────────
		/** 同源 POST，与宿主既有插件一致的传输方式。 */
		async function api(method, args) {
			var res = await fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: method, args: args || {} }),
			});
			var data;
			try {
				data = await res.json();
			} catch (err) {
				throw new Error("服务端返回了非 JSON 响应（HTTP " + res.status + "）");
			}
			if (!data || data.ok !== true) {
				throw new Error((data && data.error) || "RPC failed (HTTP " + res.status + ")");
			}
			return data.result;
		}

		/**
		 * 模块级缓存。
		 *
		 * ★ 面板被切走后组件会卸载，再切回来是**重新挂载**。没有这层缓存的话
		 *   每次切换都要重新传一份索引（约 700KB gzip）并重新建索引 ——
		 *   用户感知到的就是「点一下要等一下」。有这个缓存，第二次开始是瞬时的。
		 */
		var CACHE = { payload: null, at: 0, status: null };
		//#endregion

		//#region ── 小工具 ────────────────────────────────────────────────
		function formatStars(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (n < 1000) return String(n);
			if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
			if (n < 1000000) return Math.round(n / 1000) + "k";
			return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
		}

		function relTime(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "未知";
			var s = Math.floor(ms / 1000);
			if (s < 60) return s + " 秒前";
			var m = Math.floor(s / 60);
			if (m < 60) return m + " 分钟前";
			var hr = Math.floor(m / 60);
			if (hr < 24) return hr + " 小时前";
			return Math.floor(hr / 24) + " 天前";
		}

		function dateText(iso) {
			if (!iso) return "—";
			try {
				var d = new Date(iso);
				if (isNaN(d.getTime())) return String(iso);
				var p = function (n) { return String(n).padStart(2, "0"); };
				return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
			} catch (e) {
				return String(iso);
			}
		}

		/** 推送时间 → 「3 天前 / 2 个月前」 */
		function agoText(iso) {
			if (!iso) return null;
			var t = Date.parse(iso);
			if (!isFinite(t)) return null;
			var days = Math.floor((Date.now() - t) / 86400000);
			if (days <= 0) return "今天";
			if (days === 1) return "昨天";
			if (days < 30) return days + " 天前";
			var months = Math.floor(days / 30);
			if (months < 12) return months + " 个月前";
			return Math.floor(months / 12) + " 年前";
		}

		/** 复制到剪贴板：file:// 与非 https 下 navigator.clipboard 都可能不可用，必须有兜底 */
		function copyText(text) {
			var s = String(text == null ? "" : text);
			try {
				if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
					navigator.clipboard.writeText(s);
					return true;
				}
			} catch (e) { /* 落到下面的兜底 */ }
			try {
				var ta = document.createElement("textarea");
				ta.value = s;
				ta.setAttribute("readonly", "readonly");
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				document.body.appendChild(ta);
				ta.select();
				var ok = document.execCommand("copy");
				document.body.removeChild(ta);
				return ok;
			} catch (e2) {
				return false;
			}
		}

		/**
		 * 列式 payload → 按需取字段。
		 *
		 * 服务端发的是「列名 + 每行一个数组」（见 src/server/catalog.js 的 COLUMNS）。
		 * 前端刻意不把它整体还原成对象数组 —— 8780 个对象没必要常驻内存，
		 * 只有真正进视口的那几十行才需要字段值。
		 */
		function colIndex(cols) {
			var map = {};
			for (var i = 0; i < cols.length; i++) map[cols[i]] = i;
			return map;
		}

		function idOf(row, C) { return row[C.id]; }
		function installSpec(row, C) { return "github:" + row[C.id]; }
		function repoUrl(row, C) { return "https://github.com/" + row[C.id]; }

		function ownerOf(row, C) {
			var id = row[C.id];
			var i = id.indexOf("/");
			return i > 0 ? id.slice(0, i) : id;
		}

		function shortName(row, C) {
			var id = row[C.id];
			var i = id.indexOf("/");
			return i > 0 ? id.slice(i + 1) : id;
		}

		/** 描述：中文优先，其次英文原文 */
		function descOf(row, C) {
			return row[C.descZh] || row[C.desc] || null;
		}

		//#endregion

		//#region ── 搜索 ────────────────────────────────────────────────
		/*
		 * 搜索在本地做，所以「按键 → 出结果」没有网络往返。
		 *
		 * 索引是这样建的：每行拼一个只含可搜字段的小写串（仓库名 / 作者 / 描述 /
		 * topic / 语言），一次建好常驻内存。8780 行大约 1.2MB 字符串，
		 * 建立一次约 15ms —— 只在第一次搜索时付这个成本。
		 */
		var searchState = { blobs: null, rows: null, columns: null };

		function ensureBlobs(rows, C) {
			if (searchState.blobs && searchState.rows === rows && searchState.columns === C) return searchState.blobs;
			var blobs = new Array(rows.length);
			for (var i = 0; i < rows.length; i++) {
				var r = rows[i];
				var topics = r[C.topics] || [];
				blobs[i] = (
					r[C.id] + " " +
					(r[C.desc] || "") + " " +
					(r[C.descZh] || "") + " " +
					topics.join(" ") + " " +
					(r[C.lang] || "")
				).toLowerCase();
			}
			searchState.blobs = blobs;
			searchState.rows = rows;
			searchState.columns = C;
			return blobs;
		}

		/**
		 * 检索 + 打分。
		 *
		 * 语义：空格分隔的多个词是 **AND**（都出现才算命中），
		 * 与 GitHub 搜索框的习惯一致 —— 「dsh memory」不该把所有 dsh 插件都列出来。
		 * 打分只影响排序，不影响是否命中。
		 *
		 * 返回的是**命中项在入参 rows 里的下标**（不是行对象本身）：
		 * 前端只需要下标就能渲染，也省掉一次数组复制。
		 */
		function fuzzyTerm(term, id, blob) {
			// Ordered name abbreviations; do not match across a long description.
			if (term.length >= 3) {
				var names = id.split("/");
				for (var n = 0; n < names.length; n++) {
					var at = 0;
					for (var j = 0; j < names[n].length && at < term.length; j++) {
						if (names[n][j] === term[at]) at++;
					}
					if (at === term.length) return 2;
				}
			}
			// One missing/extra/replaced letter or adjacent transposition.
			// Short queries remain literal to avoid excessive false positives.
			if (term.length < 4) return false;
			function near(word) {
				if (Math.abs(word.length - term.length) > 1) return false;
				var p = 0;
				while (p < word.length && p < term.length && word[p] === term[p]) p++;
				if (word.length === term.length) {
					return word.slice(p + 1) === term.slice(p + 1) ||
						(word[p] === term[p + 1] && word[p + 1] === term[p] && word.slice(p + 2) === term.slice(p + 2));
				}
				return word.length > term.length ? word.slice(p + 1) === term.slice(p) : word.slice(p) === term.slice(p + 1);
			}
			if (id.split(/[^\p{L}\p{N}]+/u).some(near)) return 2;
			return blob.split(/[^\p{L}\p{N}]+/u).some(near) ? 1 : 0;
		}

		function searchRows(rows, C, query, out, sort) {
			var q = String(query || "").trim().toLowerCase();
			out.length = 0;
			var byStars = sort === "stars-desc" || sort === "stars-asc";
			if (q === "" && !byStars) return null;

			var terms = q.split(/\s+/).filter(Boolean);
			var blobs = ensureBlobs(rows, C);
			var scored = [];
			var cap = q ? MAX_RESULTS : rows.length;

			for (var i = 0; i < rows.length; i++) {
				var blob = blobs[i];
				var hit = true;
				var fuzzy = 0;
				var fuzzyScore = 0;
				for (var t = 0; t < terms.length; t++) {
					if (blob.indexOf(terms[t]) !== -1) continue;
					var match = fuzzyTerm(terms[t], String(rows[i][C.id]).toLowerCase(), blob);
					if (match) { fuzzy++; fuzzyScore += match; }
					else { hit = false; break; }
				}
				if (!hit) continue;

				var row = rows[i];
				var id = String(row[C.id]).toLowerCase();
				var name = shortName(row, C).toLowerCase();
				var score = fuzzyScore;
				for (var k = 0; k < terms.length; k++) {
					var term = terms[k];
					if (id === term) score += 5000;
					else if (name === term) score += 4000;
					else if (name.indexOf(term) === 0) score += 1200;
					else if (id.indexOf(term) === 0) score += 900;
					else if (name.indexOf(term) >= 0) score += 600;
					else if (id.indexOf(term) >= 0) score += 400;
					var topics = row[C.topics] || [];
					for (var ti = 0; ti < topics.length; ti++) {
						if (String(topics[ti]).toLowerCase().indexOf(term) >= 0) { score += 250; break; }
					}
				}
				scored.push({ i: i, s: score, f: fuzzy });
			}

			// Sort every match before applying the display cap. Missing stars count as zero.
			scored.sort(function (a, b) {
				var stars = byStars ? (Number(rows[a.i][C.stars]) || 0) - (Number(rows[b.i][C.stars]) || 0) : 0;
				return (sort === "stars-desc" ? -stars : stars) || a.f - b.f || b.s - a.s || a.i - b.i;
			});
			var n = Math.min(scored.length, cap);
			for (var m = 0; m < n; m++) out.push(scored[m].i);
			return { total: scored.length, capped: scored.length > cap };
		}

		/**
		 * 虚拟滚动：算出当前该渲染哪几项。
		 *
		 * ★ 这里有两个**必须分开**的下标，混起来是个很难看出来的 bug：
		 *
		 *     pos       这一项在**当前列表**里的第几位 → 决定它画在什么高度（top）
		 *     rowIndex  这一项在**完整 rows** 里的下标 → 决定它取哪一行数据
		 *
		 *   搜索时两者完全不同（第 0 个结果可能来自第 5432 行）。曾经把 rowIndex
		 *   同时当成 top 用，于是搜出来的 12 条被画在 5432×96 ≈ 52 万像素处 ——
		 *   计数显示「匹配 12 条」，列表却空空如也。
		 *
		 * @param {number}   total     当前列表的项数（搜索后是命中数）
		 * @param {number}   scrollTop 滚动位置
		 * @param {number}   viewH     视口高度
		 * @param {number[]} order     搜索命中的行下标；为空表示「不搜索，原样显示」
		 * @returns {{pos:number, rowIndex:number}[]}
		 */
		function windowOf(total, scrollTop, viewH, order) {
			var start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
			var end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
			var list = [];
			for (var pos = start; pos < end; pos++) {
				list.push({ pos: pos, rowIndex: order ? order[pos] : pos });
			}
			return list;
		}
		//#endregion

		//#region ── 基础组件 ────────────────────────────────────────────
		function Btn(props) {
			var cls = "dpm-btn";
			if (props.variant === "primary") cls += " dpm-btn-primary";
			else if (props.variant === "ghost") cls += " dpm-btn-ghost";
			if (props.small) cls += " dpm-btn-xs";
			return h(
				"button",
				{
					type: "button",
					className: cls,
					title: props.title || undefined,
					disabled: props.disabled || false,
					"data-done": props.done ? "1" : undefined,
					onClick: props.onClick,
				},
				props.children,
			);
		}

		function Chip(props) {
			return h("span", { className: "dpm-chip", "data-dim": props.dim ? "1" : undefined, title: props.title || undefined },
				props.children);
		}

		function KV(props) {
			var rows = props.rows || [];
			return h(
				"div",
				{ className: "dpm-kv" },
				rows.map(function (r, i) {
					return h("div", { className: "dpm-kv-k", key: "k" + i }, r[0]);
				}).concat(
					rows.map(function (r, i) {
						return h("div", { className: "dpm-kv-v", key: "v" + i }, r[1] === null || r[1] === undefined || r[1] === "" ? "—" : String(r[1]));
					}),
				),
			);
		}

		/*
		 * 一个 slot 里的组件抛错会让整块变成空白（宿主只会在控制台留一句
		 * “slot entry crashed in '<slot>'”）。所以这里自备一个错误边界，
		 * 把崩溃变成一段可读的提示 + 重试按钮。
		 *
		 * ★ 必须是 **class 组件**：React 只有 class 才有 componentDidCatch /
		 *   getDerivedStateFromError，函数组件做不到这件事。
		 */
		var ErrorBoundary = (function () {
			function EB(props) {
				react.Component.call(this, props);
				this.state = { error: null };
				this.retry = this.retry.bind(this);
			}
			EB.prototype = Object.create(react.Component.prototype);
			EB.prototype.constructor = EB;
			EB.prototype.componentDidCatch = function (error) {
				this.setState({ error: error });
			};
			EB.prototype.retry = function () {
				this.setState({ error: null });
			};
			EB.prototype.render = function () {
				if (this.state.error) {
					var err = this.state.error;
					return h(
						"div",
						{ className: "dpm-crash" },
						h("h4", null, (this.props.label || "面板") + " 出错了"),
						h("p", null, "这一块组件渲染失败，harness 本身没有受影响。下面是错误原文："),
						h("pre", null, String(err && err.stack ? err.stack : err)),
						h("div", { className: "dpm-state-acts" }, h(Btn, { onClick: this.retry }, "重试")),
					);
				}
				return this.props.children;
			};
			return EB;
		})();

		function RailIcon() {
			return h(
				"span",
				{ className: "dpm-rail", title: PANEL_LABEL },
				h(
					"svg",
					{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" },
					h("circle", { cx: "11", cy: "11", r: "7" }),
					h("path", { d: "M20 20l-3.6-3.6" }),
					h("path", { d: "M8.2 11h5.6" }),
					h("path", { d: "M11 8.2v5.6" }),
				),
			);
		}
		//#endregion

		//#region ── 行 ──────────────────────────────────────────────────
		/*
		 * ★ memo 在这里不是优化技巧，而是**滚动流畅的前提**：
		 *   虚拟滚动每滚一帧都会重算可见区间，若每行都重新渲染，
		 *   一帧要跑十几行的 diff；memo 之后只有进出视口的那一两行会渲染。
		 *   所以传给 Row 的必须是原始值（index / top），不能传每帧新建的对象。
		 */
		var Row = memo(function Row(props) {
			var row = props.row;
			var C = props.C;
			var index = props.index;
			var copied = props.copied;
			var archived = row[C.archived] === 1;

			var desc = descOf(row, C);
			var topics = (row[C.topics] || []).slice(0, 3);
			var pushed = agoText(row[C.pushedAt]);

			return h(
				"div",
				{ className: "dpm-row", style: { top: index * ROW_H, height: ROW_H } },
				h(
					"div",
					{ className: "dpm-row-main" },
					h(
						"div",
						{ className: "dpm-repo" },
						h(
							"a",
							{
								className: "dpm-repo-name",
								href: repoUrl(row, C),
								title: "在 GitHub 上打开",
								onClick: function (e) {
									e.preventDefault();
									window.open(repoUrl(row, C), "_blank", "noopener,noreferrer");
								},
							},
							row[C.id],
						),
						archived ? h("span", { className: "dpm-archived" }, "已归档") : null,
					),
					h("p", { className: "dpm-desc", "data-empty": desc ? undefined : "1" },
						desc || "（这个仓库没有填写描述）"),
					h(
						"div",
						{ className: "dpm-meta" },
						row[C.lang] ? h(Chip, { dim: true }, row[C.lang]) : null,
						topics.map(function (t) { return h(Chip, { key: t, dim: true, title: "topic: " + t }, t); }),
						pushed
							? h("span", { title: row[C.pushedAt] ? "GitHub 最近推送：" + row[C.pushedAt] : undefined },
								"更新于 " + pushed)
							: null,
						row[C.license] ? h("span", null, row[C.license]) : null,
					),
				),
				h(
					"div",
					{ className: "dpm-row-side" },
					h("span", { className: "dpm-stars", title: (row[C.stars] || 0) + " stars" },
						h("span", null, "★"), formatStars(row[C.stars])),
					h(
						"div",
						{ className: "dpm-acts" },
						h(
							Btn,
							{
								small: true,
								variant: "primary",
								done: copied === row[C.id],
								title: "复制后粘到「设置 → 插件 → 添加插件」里即可安装",
								onClick: function () { props.onCopy(installSpec(row, C), row[C.id]); },
							},
							copied === row[C.id] ? "已复制" : "复制安装地址",
						),
						h(
							Btn,
							{
								small: true,
								variant: "ghost",
								title: "复制 https://github.com/" + row[C.id],
								onClick: function () { props.onCopy(repoUrl(row, C), null); },
							},
							"链接",
						),
					),
				),
			);
		});
		//#endregion

		//#region ── 关于 / 状态 ─────────────────────────────────────────
		function About(props) {
			var status = props.status;
			var err = props.error;

			return h(
				"div",
				{ className: "dpm-about" },
				h(
					"div",
					{ className: "dpm-about-head" },
					h("h3", { className: "dpm-about-title" }, "关于这份数据"),
					h("span", { className: "dpm-spacer" }),
					props.onDropCache
						? h(Btn, {
							small: true,
							title: "丢掉服务端缓存并重新从仓库拉一份完整索引（怀疑数据不对时用）",
							onClick: props.onDropCache,
						}, "清缓存重取")
						: null,
					h(Btn, { small: true, variant: "ghost", onClick: props.onClose }, "关闭"),
				),
				h(
					"div",
					{ className: "dpm-about-body" },
					err ? h("div", { className: "dpm-err" }, String(err)) : null,

					h("div", { className: "dpm-sec" },
						h("h5", null, "面板"),
						h(KV, {
							rows: [
								["包名", PANEL_ID],
								["版本", status ? status.panel.version : "…"],
								["索引地址", status ? status.panel.indexUrl : "…"],
								["缓存目录", status ? status.panel.dataDir : "…"],
								["仓库", status ? status.panel.repoHomepage : REPO_HOMEPAGE],
							],
						}),
					),

					h("div", { className: "dpm-sec" },
						h("h5", null, "这份数据"),
						h(KV, {
							rows: [
								["采集时间", props.meta ? dateText(props.meta.generatedAt) : "—"],
								["数据来源", props.meta ? sourceLabel(props.meta.source) : "—"],
								["读取时刻", props.meta && props.meta.fetchedAt ? new Date(props.meta.fetchedAt).toLocaleString() : "—"],
								["缓存年龄", props.meta ? relTime(props.meta.ageMs) : "—"],
								["记录条数", props.meta && props.meta.counts ? props.meta.counts.total : "—"],
								["自动刷新", props.meta ? "超过 " + Math.round((props.meta.ttlMs || 0) / 60000) + " 分钟会去确认一次" : "—"],
							],
						}),
						h("p", { className: "dpm-note" },
							"索引由 GitHub Actions 定时重采（", h("code", null, "scripts/collect.mjs"),
							"）：先按 topic / 关键词在 GitHub 上搜插件仓库（负责发现），",
							"再按 ", h("code", null, "owner/repo"), " 点名直读、把 star 数与最近推送刷准（负责保鲜），",
							"最后用公开索引补上搜不到的部分。直读每 6 小时整份刷一遍，所以任意一条记录的",
							"星数与推送时间最多滞后 6 小时。这里只记录公开事实 —— 项目描述、仓库地址、作者、star 数。"),
						props.meta && props.meta.sources && props.meta.sources.length > 0
							? h("p", { className: "dpm-note" },
								"来源：" + props.meta.sources.map(function (s) {
									var coverage = s.partial && typeof s.covered === "number"
										? "，本轮覆盖 " + s.covered + "/" + (s.covered + (s.skipped || 0))
										: "";
									return s.label + "（" + s.found + " 条" + (s.failed ? "，本轮失败" : coverage) + "）";
								}).join(" · "))
							: null,
						props.meta && props.meta.error ? h("div", { className: "dpm-err" }, props.meta.error) : null,
					),

					h("div", { className: "dpm-sec" },
						h("h5", null, "运行环境（跨版本适配）"),
						status
							? h(KV, {
								rows: [
									["dsh 版本", status.harness.version || "未能探测"],
									["通道", status.harness.channel === "desktop" ? "官方桌面版" : status.harness.channel === "cli" ? "命令行 dsh" : "未知"],
									["Node", status.harness.node],
									["平台", status.harness.platform + " / " + status.harness.arch],
									["插件 API", status.caps && status.caps.webServer && status.caps.webServer.register ? "webServer.register ✓" : "webServer.register ✗"],
									["宿主服务", status.caps ? Object.keys(status.caps.services || {}).filter(function (k) { return status.caps.services[k]; }).join("、") || "—" : "—"],
								],
							})
							: h("p", { className: "dpm-note" }, "读取中…"),
						status
							? h("p", { className: "dpm-note" },
								status.harness.verified
									? h("span", { className: "dpm-tag", "data-ok": "1" }, "✓ 该版本已实测")
									: h("span", { className: "dpm-tag", "data-warn": "1" }, "未实测"),
								status.harness.verified
									? "　实测于 " + (status.harness.verifiedOn || "—") + "。"
									: "　这个版本没有实测记录" + (status.harness.nearestVerified ? "，最接近的是 " + status.harness.nearestVerified : "") + "。",
								"　本插件不声明 peerDependencies、不依赖任何第三方包，只用各版本都在的稳定 API，",
								"所以未实测的版本照样全功能可用；真正缺了什么会在上面那行「插件 API」里显示出来。")
							: null,
						status && status.capsNotes && status.capsNotes.length > 0
							? h("div", { className: "dpm-err" }, status.capsNotes.join("\n"))
							: null,
					),

					h("div", { className: "dpm-sec" },
						h("h5", null, "怎么装"),
						h("p", { className: "dpm-note" },
							"这个面板只负责**找到**插件，不负责安装。安装用官方 harness 自带的功能：",
							h("br", null),
							"桌面版：", h("code", null, "设置 → 插件 → 添加插件"),
							"，把上面复制的 ", h("code", null, "github:owner/repo"), " 粘进去。",
							h("br", null),
							"命令行：", h("code", null, "dsh plugin --profile web add github:owner/repo"),
						),
					),
				),
			);
		}

		function sourceLabel(source) {
			switch (source) {
				case "checkout": return "本地仓库检出";
				case "cache": return "本地缓存";
				case "remote": return "远程索引（刚更新）";
				case "remote-304": return "远程索引（确认无更新）";
				case "bundled": return "包内离线快照";
				default: return source || "—";
			}
		}
		//#endregion

		//#region ── 面板 ────────────────────────────────────────────────
		function Panel(props) {
			var dataState = useState(CACHE.payload);
			var payload = dataState[0];
			var setPayload = dataState[1];

			var loadState = useState(CACHE.payload ? "ready" : "loading");
			var phase = loadState[0];
			var setPhase = loadState[1];

			var errState = useState(null);
			var error = errState[0];
			var setError = errState[1];

			var qState = useState("");
			var query = qState[0];
			var setQuery = qState[1];
			var sortState = useState("relevance");
			var sort = sortState[0];
			var setSort = sortState[1];

			var debState = useState("");
			var debounced = debState[0];
			var setDebounced = debState[1];

			var scrollState = useState(0);
			var scrollTop = scrollState[0];
			var setScrollTop = scrollState[1];

			var viewState = useState(640);
			var viewH = viewState[0];
			var setViewH = viewState[1];

			var copyState = useState(null);
			var copied = copyState[0];
			var setCopied = copyState[1];

			var toastState = useState(null);
			var toast = toastState[0];
			var setToast = toastState[1];

			var aboutState = useState(false);
			var aboutOpen = aboutState[0];
			var setAboutOpen = aboutState[1];

			var aboutData = useState(null);
			var aboutStatus = aboutData[0];
			var setAboutStatus = aboutData[1];

			var aboutErrState = useState(null);
			var aboutErr = aboutErrState[0];
			var setAboutErr = aboutErrState[1];

			var bodyRef = useRef(null);
			var inputRef = useRef(null);
			var aliveRef = useRef(true);
			var toastTimer = useRef(null);

			var C = useMemo(function () {
				return payload ? colIndex(payload.cols) : null;
			}, [payload]);

			function flash(message) {
				setToast(message);
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(function () {
					if (aliveRef.current) setToast(null);
				}, 1900);
			}

			// ── 取数 ────────────────────────────────────────────────
			var load = useCallback(async function (opts) {
				var force = Boolean(opts && opts.force);
				if (!CACHE.payload) setPhase("loading");
				try {
					var res = await api("index", force ? { refresh: true } : {});
					if (!aliveRef.current) return;
					CACHE.payload = res;
					CACHE.at = Date.now();
					setPayload(res);
					setError(null);
					setPhase("ready");
				} catch (err) {
					if (!aliveRef.current) return;
					setError(String(err && err.message ? err.message : err));
					setPhase(CACHE.payload ? "ready" : "error");
				}
			}, []);

			useEffect(function () {
				aliveRef.current = true;
				if (!CACHE.payload) load();
				/*
				 * 顺手把 status 也取回来。
				 *
				 * ★ 它**不载入索引**（服务器半刻意保证这一点），所以永远是 0ms 级的：
				 *   换来的是页眉上的版本号与页脚的「dsh 0.1.7-rc.2 · 已实测」一打开
				 *   就在，而不是等用户点了「关于」才出现。跨版本适配这件事，
				 *   看得见才算数。
				 */
				if (!CACHE.status) {
					api("status")
						.then(function (s) {
							if (!aliveRef.current) return;
							CACHE.status = s;
							setAboutStatus(s);
						})
						.catch(function () { /* 拿不到就不显示，不影响任何功能 */ });
				}
				return function () {
					aliveRef.current = false;
					if (toastTimer.current) clearTimeout(toastTimer.current);
				};
			}, [load]);

			/*
			 * 打开面板时如果缓存已经超过 TTL，顺手去确认一次有没有更新。
			 * 走的仍是条件请求（远端通常只回 304），所以这一步几乎不花钱 ——
			 * 换来的是「用户不需要记得手动刷新」。
			 */
			useEffect(function () {
				if (!payload || !payload.meta) return;
				var age = payload.meta.ageMs;
				var ttl = payload.meta.ttlMs || 1800000;
				if (typeof age !== "number" || age < ttl) return;
				api("refresh", { force: true })
					.then(function (r) {
						if (!aliveRef.current) return;
						if (r && r.changed) {
							load();
							flash("数据已更新");
						}
					})
					.catch(function () { /* 后台刷新失败不打扰用户 */ });
			}, [payload, load]);

			// ── 搜索防抖 ────────────────────────────────────────────
			useEffect(function () {
				if (query === debounced) return undefined;
				var t = setTimeout(function () { setDebounced(query); }, 110);
				return function () { clearTimeout(t); };
			}, [query, debounced]);

			// ── 视口高度 ────────────────────────────────────────────
			useEffect(function () {
				function measure() {
					var el = bodyRef.current;
					if (el && el.clientHeight) setViewH(el.clientHeight);
				}
				measure();
				window.addEventListener("resize", measure);
				return function () { window.removeEventListener("resize", measure); };
			}, [phase]);

			// ── 键盘：/ 聚焦、Esc 清空 ──────────────────────────────
			useEffect(function () {
				function onKey(e) {
					var tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
					var typing = tag === "input" || tag === "textarea";
					if (e.key === "/" && !typing) {
						e.preventDefault();
						if (inputRef.current) inputRef.current.focus();
					} else if (e.key === "Escape" && typing) {
						setQuery("");
					}
				}
				window.addEventListener("keydown", onKey);
				return function () { window.removeEventListener("keydown", onKey); };
			}, []);

			// ── 派生列表 ────────────────────────────────────────────
			var hit = useMemo(function () {
				if (!payload || !C) return { order: null, total: payload ? payload.total : 0, capped: false };
				var out = [];
				var r = searchRows(payload.rows, C, debounced, out, sort);
				if (!r) return { order: null, total: payload.total, capped: false };
				return { order: out, total: r ? r.total : 0, capped: r ? r.capped : false };
			}, [payload, C, debounced, sort]);

			var rows = payload ? payload.rows : [];
			var total = hit.order ? hit.order.length : rows.length;

			var visible = useMemo(function () {
				return windowOf(total, scrollTop, viewH, hit.order);
			}, [scrollTop, viewH, total, hit]);

			// 搜索条件变化时回到顶部 —— 否则会停在上一次的位置，看起来像「没结果」
			useEffect(function () {
				var el = bodyRef.current;
				if (el) el.scrollTop = 0;
				setScrollTop(0);
			}, [debounced, sort]);

			var onCopy = useCallback(function (text, id) {
				var ok = copyText(text);
				flash(ok ? "已复制 " + text : "复制失败，请手动选中：" + text);
				if (ok && id) {
					setCopied(id);
					setTimeout(function () { if (aliveRef.current) setCopied(null); }, 1500);
				}
			}, []);

			function openAbout() {
				setAboutOpen(true);
				if (CACHE.status) {
					setAboutStatus(CACHE.status);
					return;
				}
				api("status")
					.then(function (s) {
						if (!aliveRef.current) return;
						CACHE.status = s;
						setAboutStatus(s);
					})
					.catch(function (err) {
						if (aliveRef.current) setAboutErr(String(err && err.message ? err.message : err));
					});
			}

			/**
			 * 丢掉服务端缓存并重新拉一次。
			 *
			 * 「刷新」走的是条件请求（通常只拿到 304）；当用户怀疑「我看到的这份数据
			 * 有问题」时，只刷新是没用的 —— 那正是需要把缓存整个丢掉重取的场景。
			 * 所以这条路径单独做成一个按钮，而不是让用户去翻缓存目录。
			 */
			function dropCache() {
				setPhase("loading");
				api("dropCache")
					.then(function () { return api("refresh", { force: true }); })
					.then(function () {
						CACHE.payload = null;
						return load();
					})
					.then(function () {
						if (!aliveRef.current) return;
						setPhase("ready");
						flash("缓存已清除，数据重新拉取完成");
					})
					.catch(function (err) {
						if (!aliveRef.current) return;
						setPhase("ready");
						const msg = String(err && err.message ? err.message : err);
						setAboutErr(msg);
						flash("重取失败：" + msg);
					});
			}

			var meta = payload ? payload.meta : null;

			// ── 渲染 ────────────────────────────────────────────────
			return h(
				"div",
				{ className: "dpm-root" },

				h(
					"div",
					{ className: "dpm-head" },
					h(
						"div",
						{ className: "dpm-head-row" },
						h("h2", { className: "dpm-title" },
							PANEL_LABEL,
							aboutStatus && aboutStatus.panel && aboutStatus.panel.version
								? h("span", { className: "dpm-ver" }, "v" + aboutStatus.panel.version)
								: null,
						),
						h("span", { className: "dpm-spacer" }),
						h(Btn, {
							small: true,
							disabled: phase === "loading",
							title: "去仓库确认一次有没有更新（没更新时几乎不消耗流量）",
							onClick: function () {
								setPhase("loading");
								api("refresh", { force: true })
									.then(function (r) {
										if (!aliveRef.current) return;
										if (r && r.meta && r.meta.error) {
											flash(r.meta.error);
											setPhase("ready");
											return;
										}
										if (r && r.changed) {
											return load().then(function () { flash("数据已更新"); });
										}
										if (r && r.firstLoad) return load();
										flash("已是最新数据");
										setPhase("ready");
									})
									.catch(function (err) {
										if (!aliveRef.current) return;
										setPhase("ready");
										flash("刷新失败：" + String(err && err.message ? err.message : err));
									});
							},
						}, phase === "loading" ? "刷新中…" : "刷新"),
						h(Btn, { small: true, variant: "ghost", title: "关于这份数据 / 运行环境", onClick: openAbout }, "关于"),
						props.onClose ? h(Btn, { small: true, variant: "ghost", title: "关闭面板", onClick: props.onClose }, "✕") : null,
					),
					h(
						"p",
						{ className: "dpm-sub" },
						meta
							? h("span", null,
								h("i", { className: "dpm-dot", "data-tone": meta.error ? "warn" : undefined }),
								"数据采集于 " + dateText(meta.generatedAt) + "（" + relTime(meta.ageMs) + "读取）· ",
								sourceLabel(meta.source),
							)
							: h("span", null, h("i", { className: "dpm-dot" }), "正在读取索引…"),
						meta ? h("span", null, meta.counts && meta.counts.total !== undefined ? "共 " + meta.counts.total + " 个项目" : "") : null,
						meta && meta.truncated ? h("span", null, "（超出上限，只显示 star 最高的一部分）") : null,
					),
					h(
						"div",
						{ className: "dpm-search" },
						h("input", {
							ref: inputRef,
							className: "dpm-input",
							type: "search",
							value: query,
							placeholder: "搜索仓库 / 作者 / 描述 / topic…（按 / 聚焦，Esc 清空）",
							title: "支持名称缩写和常见拼写误差；多个搜索词需同时匹配",
							onChange: function (e) { setQuery(e.target.value); },
						}),
						query !== ""
							? h(Btn, { small: true, variant: "ghost", onClick: function () { setQuery(""); if (inputRef.current) inputRef.current.focus(); } }, "清空")
							: null,
						h("select", { className: "dpm-sort", "aria-label": "搜索结果排序", value: sort, onChange: function (e) { setSort(e.target.value); } },
							h("option", { value: "relevance" }, "相关度（默认）"),
							h("option", { value: "stars-desc" }, "Star 从高到低"),
							h("option", { value: "stars-asc" }, "Star 从低到高")),
						h("span", { className: "dpm-count" },
							debounced.trim() === ""
								? h("span", null, h("b", null, String(rows.length)), " 个插件项目")
								: h("span", null, "匹配 ", h("b", null, String(total)), " 条",
									hit.capped ? "（只显示前 " + MAX_RESULTS + " 条）" : ""),
						),
					),
				),

				h(
					"div",
					{
						className: "dpm-body",
						ref: bodyRef,
						onScroll: function (e) { setScrollTop(e.currentTarget.scrollTop); },
					},
					phase === "error"
						? h(
							"div",
							{ className: "dpm-state" },
							h("h4", null, "索引读不出来"),
							h("p", null, "面板没能拿到插件索引。这通常意味着本机网络到不了 GitHub，且本地还没有缓存。"),
							error ? h("pre", null, error) : null,
							h("div", { className: "dpm-state-acts" },
								h(Btn, { variant: "primary", onClick: function () { load(); } }, "重试"),
								h(Btn, { onClick: openAbout }, "看运行环境"),
							),
						)
						: phase === "loading" && !payload
							? h(
								"div",
								{ className: "dpm-state" },
								h("h4", null, "正在读取插件索引…"),
								h("div", { style: { maxWidth: 420, margin: "18px auto 0", display: "grid", gap: 12 } },
									h("div", { className: "dpm-skel", style: { width: "70%" } }),
									h("div", { className: "dpm-skel", style: { width: "92%" } }),
									h("div", { className: "dpm-skel", style: { width: "54%" } }),
								),
							)
							: total === 0
								? h(
									"div",
									{ className: "dpm-state" },
									h("h4", null, debounced.trim() === "" ? "索引里还没有收录任何项目" : "没有匹配的项目"),
									debounced.trim() === ""
										? h("p", null, "跑一次 ", h("code", null, "node scripts/collect.mjs"), " 就能采到数据。")
										: h("p", null, "换个关键词试试；搜索支持多个词（空格分隔表示「都要命中」），也可以搜作者、topic、语言。"),
									debounced.trim() === ""
										? null
										: h("div", { className: "dpm-state-acts" },
											h(Btn, { onClick: function () { setQuery(""); } }, "清空搜索")),
								)
								: h(
									"div",
									{ className: "dpm-list", style: { height: total * ROW_H } },
									visible.map(function (item) {
										var row = rows[item.rowIndex];
										return h(Row, {
											key: row[C.id],
											// ★ 画在什么高度用 pos（当前列表里的第几位），
											//   取哪一行数据用 rowIndex —— 见 windowOf 的说明
											index: item.pos,
											row: row,
											C: C,
											copied: copied,
											onCopy: onCopy,
										});
									}),
								),
				),

				h(
					"div",
					{ className: "dpm-foot" },
					h("span", null, h("span", { className: "dpm-kbd" }, "复制安装地址"), " → 粘到「设置 → 插件 → 添加插件」"),
					h("span", { className: "dpm-spacer" }),
					aboutStatus && aboutStatus.harness
						? h("span", null,
							"dsh " + (aboutStatus.harness.version || "?") +
							(aboutStatus.harness.channel === "desktop" ? " · 桌面版" : "") +
							(aboutStatus.harness.verified ? " · 已实测" : " · 未实测"))
						: null,
					h(Btn, { small: true, variant: "ghost", onClick: openAbout }, "关于"),
				),

				aboutOpen
					? h(About, {
						status: aboutStatus,
						error: aboutErr,
						meta: meta,
						onClose: function () { setAboutOpen(false); },
						onDropCache: dropCache,
					})
					: null,

				toast ? h("div", { className: "dpm-toast" }, toast) : null,
			);
		}
		//#endregion

		//#region ── 注册 ──────────────────────────────────────────────────
		/*
		 * inject 只声明 slots：它在所有目标版本的 web 版里恒存在。
		 * ★ 客户端声明的服务若最终没有就绪，整页 boot 都会失败
		 *   （宿主会抛 “web boot: N entries did not activate”），所以这里绝不能多写。
		 *   其余一切都走 ctx.get(...) 并在使用时判空 —— layout 就是这样用的。
		 */
		var inject = ["slots"];

		function apply(ctx) {
			var layout = typeof ctx.get === "function" ? ctx.get("layout") : null;

			// 左栏导航图标：list slot → 必须有 options.id
			ctx.slots.inject("sidebar.panellist", function () {
				return ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: 6, label: PANEL_LABEL },
					RailIcon,
				);
			});

			// 中央面板：keyed slot → 必须有 options.key，且必须与上面的 id 同名，
			// 否则 layout.selectPanel(id) 会因为「main 里没有这个 key」直接抛错。
			ctx.slots.inject("main", function () {
				return ctx.slots.register(
					{ name: "main", key: PANEL_ID },
					function () {
						return h(
							ErrorBoundary,
							{ label: PANEL_LABEL },
							h(Panel, {
								onClose: function () {
									if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
								},
							}),
						);
					},
				);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;

		/*
		 * 仅供测试的内部出口。
		 *
		 * 宿主只认 apply / inject，多挂一个键不影响任何行为；而它让
		 * test/client-logic.test.mjs 能在 Node 里把整个 bundle 物化出来，
		 * 直接测搜索与虚拟滚动的**纯逻辑**。
		 *
		 * 为什么值得开这个口子：曾经有一个 bug 是「搜索命中 12 条、列表却是空的」——
		 * 原因是把「行在完整列表里的下标」当成了「它在当前结果里的位置」，
		 * 于是结果被画到 52 万像素以外。这类错误静态检查看不出来，
		 * 只有把逻辑真的跑一遍才发现得了。
		 */
		exports.__internals = {
			searchRows: searchRows,
			windowOf: windowOf,
			colIndex: colIndex,
			descOf: descOf,
			shortName: shortName,
			installSpec: installSpec,
			ROW_H: ROW_H,
		};
		return module.exports;
	},
});
