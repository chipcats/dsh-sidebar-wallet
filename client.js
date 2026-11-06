/**
 * dsh-sidebar-wallet — Browser half.
 *
 * Hand-written `window.__ModuleLoader__` registration row: the only entry point
 * `@deepseek-ai/dsh-client-modules` serves from /plugins, and the shape the shell
 * materializes lazily. `require` inside the factory resolves against the shell's
 * platform module table, so React comes from the page itself.
 *
 * Seating: one entry in `sidebar.footer.action`, the list slot at the sidebar
 * foot. The slot allocates a row ABOVE the settings/account row, so the entry
 * itself stays a zero-height anchor and the readout is positioned (fixed) into
 * the right end of the account row below it — the row that carries the avatar
 * image. Geometry is read from our own frame: the sidebar column (ancestor) and
 * the account row (the foot area's second child), never from another plugin's
 * content. When that frame is not found, the readout falls back to the sidebar's
 * bottom-right corner instead of disappearing.
 *
 * The readout polls the Host route once a minute. Peak/off-peak state and its
 * countdown are computed locally from the browser clock with the same rules the
 * Host uses, so the tooltip ticks without extra requests.
 */
window.__ModuleLoader__.load({
	id: 'dsh-sidebar-wallet',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const h = React.createElement;
		const { useEffect, useLayoutEffect, useRef, useState } = React;

		/** Matches the Host's balance cache TTL; the Host is the source of truth. */
		const POLL_MS = 60_000;

		// --- wording ----------------------------------------------------------
		// The UI follows the DSH interface language: the shell's locale plugin points
		// `<html lang>` at the active locale ("zh-CN" for Chinese, "en", "es", ...), so
		// reading that attribute keeps the readout in step with the Language setting
		// instead of the OS locale. navigator.language is only a fallback.
		function detectLocale() {
			try {
				const htmlLang =
					typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : '';
				const source = String(htmlLang || (typeof navigator !== 'undefined' && navigator.language) || 'zh');
				return /^zh/i.test(source) ? 'zh' : 'en';
			} catch {
				return 'zh';
			}
		}

		/** Locale tag used for time formatting. */
		function localeTag(locale) {
			return locale === 'zh' ? 'zh-CN' : 'en-GB';
		}

		const TEXT = {
			zh: {
				title: '侧边栏钱包',
				balance: '余额',
				today: '今日',
				input: '输入',
				output: '输出',
				cache: '缓存',
				rate: '峰谷',
				updated: '更新',
				calls: (count) => ' · ' + count + ' 次',
				hitMiss: (hit, miss) => '命中 ' + hit + ' · 未命中 ' + miss,
				rateValue: (peak, duration) => (peak ? '高峰' : '低谷') + ' · ' + duration + (peak ? ' 后转谷' : ' 后转峰'),
				sourceApiKey: 'API Key',
				sourceAccount: '登录账号',
				loading: '正在读取…',
				refreshing: '刷新中…',
				readFailed: '读取失败',
				officialRefreshFailed: '官方用量刷新失败：',
				officialUnavailable: '官方用量不可用：',
				balanceFailed: '余额读取失败：',
				errors: {
					NO_ACCOUNT: '未登录 DeepSeek 账号',
					NETWORK: '网络请求失败',
					AUTH: '接口拒绝了请求',
					HTTP: '接口返回异常状态',
					BODY: '导出内容读取失败',
					SIZE: '导出内容过大',
					SHAPE: '返回数据格式异常',
					NO_KEY: '未配置 DEEPSEEK_API_KEY，且未登录 DeepSeek 账号',
					UNKNOWN: '暂时不可用',
				},
				aria: (balance, cost, official, peak) =>
					'DeepSeek 余额 ' +
					balance +
					'，今日' +
					(official ? '消费 ' : '估算消费 ≈') +
					cost +
					'，当前' +
					(peak ? '高峰时段' : '低谷时段'),
			},
			en: {
				title: 'Sidebar Wallet',
				balance: 'Balance',
				today: 'Today',
				input: 'Input',
				output: 'Output',
				cache: 'Cache',
				rate: 'Rate',
				updated: 'Updated',
				calls: (count) => ' · ' + count + ' calls',
				hitMiss: (hit, miss) => 'Hit ' + hit + ' · Miss ' + miss,
				rateValue: (peak, duration) => (peak ? 'Peak · off-peak in ' : 'Off-peak · peak in ') + duration,
				sourceApiKey: 'API key',
				sourceAccount: 'Account',
				loading: 'Loading…',
				refreshing: 'Refreshing…',
				readFailed: 'Read failed',
				officialRefreshFailed: 'Official usage refresh failed: ',
				officialUnavailable: 'Official usage unavailable: ',
				balanceFailed: 'Balance request failed: ',
				errors: {
					NO_ACCOUNT: 'No DeepSeek account is signed in',
					NETWORK: 'Network request failed',
					AUTH: 'The API rejected the request',
					HTTP: 'Unexpected HTTP status',
					BODY: 'Could not read the exported file',
					SIZE: 'The exported file is too large',
					SHAPE: 'Unexpected response format',
					NO_KEY: 'No DEEPSEEK_API_KEY and no DeepSeek account is signed in',
					UNKNOWN: 'Temporarily unavailable',
				},
				aria: (balance, cost, official, peak) =>
					'DeepSeek balance ' +
					balance +
					', today' +
					(official ? "'s spend " : ' estimate ≈') +
					cost +
					', currently ' +
					(peak ? 'peak hours' : 'off-peak hours'),
			},
		};

		/** Localized reason for a Host error code, with the HTTP status when known. */
		function describeError(code, status, fallback, texts) {
			const reason = (texts.errors && texts.errors[code]) || null;
			let text = reason || fallback || texts.errors.UNKNOWN;
			if (typeof status === 'number' && Number.isFinite(status)) text += ' (HTTP ' + status + ')';
			return text;
		}

		// --- peak / off-peak (keep in sync with index.js) ---------------------
		const PEAK_HOURS = [
			[9, 12],
			[14, 18],
		];

		const HOLIDAY_VALLEY = new Set([
			"2026-01-01", "2026-01-02", "2026-01-03",
			"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
			"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
			"2026-04-04", "2026-04-05", "2026-04-06",
			"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
			"2026-06-19", "2026-06-20", "2026-06-21",
			"2026-09-25", "2026-09-26", "2026-09-27",
			"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
			"2026-10-06", "2026-10-07",
		]);

		const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

		function beijingParts(ms) {
			const d = new Date(ms + BEIJING_OFFSET_MS);
			return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay() };
		}

		function isPeak(ms) {
			const parts = beijingParts(ms);
			if (parts.weekday === 0 || parts.weekday === 6) return false;
			if (HOLIDAY_VALLEY.has(parts.day)) return false;
			return PEAK_HOURS.some(([start, end]) => parts.hour >= start && parts.hour < end);
		}

		/** Seconds until the next peak/off-peak flip, or null beyond 8 days. */
		function secondsToSwitch(ms) {
			const current = isPeak(ms);
			const start = Math.floor(ms / 1000);
			for (let t = start + 1; t <= start + 8 * 24 * 3600; t += 60) {
				if (isPeak(t * 1000) !== current) return t - start;
			}
			return null;
		}

		/** `1h06m`, `3d4h`, `12m`. */
		function humanDuration(seconds) {
			if (seconds === null || seconds === undefined) return '—';
			const total = Math.max(0, Math.round(seconds));
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			if (days > 0) return days + 'd' + hours + 'h';
			if (hours > 0) return hours + 'h' + String(minutes).padStart(2, '0') + 'm';
			return Math.max(1, minutes) + 'm';
		}

		// --- formatting -------------------------------------------------------
		function money(amount, currency) {
			if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
			return (currency === 'USD' ? '$' : '¥') + amount.toFixed(2);
		}

		/** Today's estimate: keep sub-cent activity visible instead of showing ¥0.00. */
		function todayMoney(amount) {
			if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
			if (amount > 0 && amount < 0.01) return '<¥0.01';
			return '¥' + amount.toFixed(2);
		}

		function compactTokens(count) {
			const n = Number(count) || 0;
			if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
			if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'K';
			return String(n);
		}

		/** `98.5%` from a 0..1 ratio, or null when the Host could not compute it. */
		function cacheRateText(rate, estimate) {
			if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
			const percent = Math.min(100, Math.max(0, rate * 100));
			const text = percent === 100 ? '100%' : percent.toFixed(1) + '%';
			return (estimate ? '≈' : '') + text;
		}

		function clockOf(ms, tag) {
			if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
			try {
				return new Date(ms).toLocaleTimeString(tag, { hour12: false });
			} catch {
				return '—';
			}
		}

		function sourceLabel(source, texts) {
			if (source === 'apikey') return texts.sourceApiKey;
			if (source === 'account') return texts.sourceAccount;
			return '—';
		}

		// --- visual tokens ----------------------------------------------------
		const CSS = {
			// Zero-height anchor inside the footer-action row; the readout itself is
			// positioned against the account row below it.
			anchor: {
				position: 'relative',
				display: 'block',
				flex: '0 0 auto',
				width: 0,
				height: 0,
				minWidth: 0,
				margin: 0,
				padding: 0,
				overflow: 'visible',
			},
			readout: {
				position: 'fixed',
				zIndex: 5,
				display: 'inline-flex',
				alignItems: 'baseline',
				gap: '5px',
				margin: 0,
				padding: '2px 6px',
				border: 'none',
				borderRadius: '7px',
				background: 'transparent',
				font: 'inherit',
				lineHeight: '16px',
				whiteSpace: 'nowrap',
				cursor: 'pointer',
				textAlign: 'right',
			},
			readoutHover: {
				background: 'var(--dsw-alias-bg-layer-1)',
			},
			label: {
				fontSize: '11px',
				color: 'var(--dsw-alias-label-secondary)',
			},
			value: {
				fontSize: '12px',
				fontWeight: 500,
				fontVariantNumeric: 'tabular-nums',
				color: 'var(--dsw-alias-label-primary)',
			},
			dot: {
				fontSize: '11px',
				color: 'var(--dsw-alias-label-secondary)',
			},
			errorValue: {
				fontSize: '12px',
				fontVariantNumeric: 'tabular-nums',
				color: 'var(--dsw-alias-state-error-primary)',
			},
			// Hover card: replaces the native title tooltip so the rows can be
			// aligned in two columns with theme tokens. `bg-layer-1` is the raised
			// surface (white in light, elevated dark tone in dark); `bg-overlay`
			// reads as a grey scrim next to the sidebar, so it is only a fallback.
			card: {
				position: 'fixed',
				zIndex: 6,
				display: 'flex',
				flexDirection: 'column',
				gap: '5px',
				maxWidth: '300px',
				margin: 0,
				padding: '9px 11px 8px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: '10px',
				background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-overlay))',
				// Two-layer soft shadow built from the theme's neutral ink, so it
				// reads as a raised surface in both light and dark themes without
				// a literal color.
				boxShadow:
					'0 10px 30px color-mix(in srgb, var(--dsw-static-neutral-1000) 14%, transparent), ' +
					'0 2px 8px color-mix(in srgb, var(--dsw-static-neutral-1000) 8%, transparent)',
				color: 'var(--dsw-alias-label-primary)',
				pointerEvents: 'none',
				whiteSpace: 'nowrap',
				font: 'inherit',
			},
			cardRow: {
				display: 'flex',
				alignItems: 'baseline',
				gap: '10px',
			},
			cardLabel: {
				fontSize: '11px',
				color: 'var(--dsw-alias-label-secondary)',
			},
			cardValue: {
				fontSize: '12px',
				fontVariantNumeric: 'tabular-nums',
				color: 'var(--dsw-alias-label-primary)',
			},
			cardNote: {
				fontSize: '11px',
				lineHeight: '1.4',
				whiteSpace: 'normal',
				color: 'var(--dsw-alias-label-secondary)',
			},
			cardError: {
				fontSize: '11px',
				lineHeight: '1.4',
				whiteSpace: 'normal',
				color: 'var(--dsw-alias-state-error-primary)',
			},
		};

		// --- placement --------------------------------------------------------
		/** The sidebar column: our own ancestor with column-like proportions. */
		function findSidebarColumn(node) {
			let el = node.parentElement;
			for (let i = 0; el && i < 12; i += 1, el = el.parentElement) {
				const rect = el.getBoundingClientRect();
				if (rect.width > 40 && rect.width <= 480 && rect.height >= window.innerHeight * 0.7) return el;
				if (el === document.body) break;
			}
			return null;
		}

		/**
		 * The account row: the footer area is the sibling row directly above the
		 * settings/account row, so the foot area is the ancestor whose parent is
		 * the sidebar column and whose other child is that row.
		 */
		function findAccountRow(node, column) {
			let foot = node;
			while (foot.parentElement && foot.parentElement !== column) foot = foot.parentElement;
			if (foot.parentElement !== column) return null;
			for (const child of foot.children) {
				if (!child.contains(node)) {
					const rect = child.getBoundingClientRect();
					if (rect.height > 0) return { element: child, rect };
				}
			}
			return null;
		}

		/**
		 * Layout facts of the account row: the widest button is the account launcher
		 * (avatar + name); any other button on the right half is a shell control
		 * (e.g. the "new version" pill). `contentRight` is where the launcher's own
		 * content ends, `controlsLeft` where the right-hand controls start.
		 */
		function rowLayout(rowEl, rowRect) {
			const buttons = [];
			for (const el of rowEl.querySelectorAll('button, a, [role="button"]')) {
				const rect = el.getBoundingClientRect();
				if (rect.width < 8 || rect.height < 8) continue;
				if (rect.right <= rowRect.left || rect.left >= rowRect.right) continue;
				buttons.push({ el, rect });
			}
			let launcher = null;
			for (const button of buttons) {
				if (!launcher || button.rect.width > launcher.rect.width) launcher = button;
			}
			if (launcher && launcher.rect.width <= rowRect.width * 0.45) launcher = null;
			const controls = buttons.filter(
				(button) => button !== launcher && button.rect.left > rowRect.left + rowRect.width * 0.45,
			);
			let controlsLeft = null;
			for (const control of controls) {
				if (controlsLeft === null || control.rect.left < controlsLeft) controlsLeft = control.rect.left;
			}
			let contentRight = rowRect.left;
			if (launcher) {
				contentRight = launcher.rect.left;
				for (const el of launcher.el.querySelectorAll('*')) {
					const rect = el.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0 && rect.right > contentRight) contentRight = rect.right;
				}
			}
			return { contentRight, controlsLeft };
		}

		/**
		 * Viewport coordinates for the readout and its hover card. The card is
		 * right-aligned to the sidebar column (never to the compact readout, which
		 * may sit far left of it) and capped to the column width so it can never be
		 * clipped by the window edge.
		 */
		function measurePlacement(anchor, readout) {
			if (!anchor || !readout) return null;
			const column = findSidebarColumn(anchor);
			if (!column) return null;
			const columnRect = column.getBoundingClientRect();
			const readoutRect = readout.getBoundingClientRect();
			const width = readoutRect.width || 0;
			const height = readoutRect.height || 16;
			const row = findAccountRow(anchor, column);
			const inlinePadding = 12;
			const layout = row
				? rowLayout(row.element, row.rect)
				: { contentRight: columnRect.left, controlsLeft: null };
			const minLeft = Math.max((row ? row.rect.left : columnRect.left) + 8, layout.contentRight + 8);
			const rightBound = Math.min(
				columnRect.right - inlinePadding,
				layout.controlsLeft === null ? Number.POSITIVE_INFINITY : layout.controlsLeft - 8,
			);
			const available = Math.max(0, rightBound - minLeft);

			let top;
			if (row) top = row.rect.top + (row.rect.height - height) / 2;
			else top = columnRect.bottom - 6 - 40;

			return {
				left: Math.max(minLeft, Math.round(rightBound - width)),
				top: Math.max(8, Math.round(Math.min(top, columnRect.bottom - height - 4))),
				width: Math.round(width),
				height: Math.round(height),
				available: Math.round(available),
				cardRight: Math.round(columnRect.right - inlinePadding),
				cardMaxWidth: Math.max(160, Math.round(columnRect.width - inlinePadding - 8)),
			};
		}

		// --- readout ----------------------------------------------------------
		function Readout(props) {
			const wide = props.wide !== false;
			const anchorRef = useRef(null);
			const readoutRef = useRef(null);
			const inFlight = useRef(false);
			const [snapshot, setSnapshot] = useState(null);
			const [error, setError] = useState(null);
			const [placement, setPlacement] = useState(null);
			const [hovered, setHovered] = useState(false);
			const [open, setOpen] = useState(false);
			const openTimer = useRef(null);
			const [now, setNow] = useState(() => Date.now());
			const [refreshing, setRefreshing] = useState(false);
			/** True when the account row has no room for the labelled readout. */
			const [compact, setCompact] = useState(false);
			const fullWidth = useRef(0);
			/** UI locale follows the shell's `<html lang>`; see detectLocale. */
			const [locale, setLocale] = useState(() => detectLocale());
			const textsRef = useRef(TEXT[locale]);

			const showCard = () => {
				clearTimeout(openTimer.current);
				openTimer.current = setTimeout(() => {
					// A fast pointer exit can skip the pill's mouseleave: never reveal
					// the card unless the pill is still hovered when the delay ends.
					if (!readoutRef.current || !readoutRef.current.matches(':hover')) return;
					setOpen(true);
				}, 120);
			};
			const hideCard = () => {
				clearTimeout(openTimer.current);
				setOpen(false);
			};

			// Poll the Host route; a manual click forces a fresh balance.
			useEffect(() => {
				let alive = true;
				const load = async (force) => {
					if (inFlight.current) return;
					inFlight.current = true;
					if (force) setRefreshing(true);
					const texts = textsRef.current;
					try {
						const res = await fetch('/dsh-sidebar-wallet/state.json' + (force ? '?refresh=1' : ''), {
							headers: { accept: 'application/json' },
						});
						const body = await res.json();
						if (!alive) return;
						if (body && body.ok) {
							setSnapshot(body);
							setError(
								body.balanceError
									? texts.balanceFailed +
											describeError(body.balanceErrorCode, body.balanceErrorStatus, body.balanceError, texts)
									: null,
							);
						} else {
							setError(texts.readFailed);
						}
					} catch (err) {
						if (alive) setError(texts.readFailed);
					} finally {
						inFlight.current = false;
						if (alive) setRefreshing(false);
					}
				};
				void load(false);
				const timer = setInterval(() => void load(false), POLL_MS);
				readoutRefresh = () => void load(true);
				return () => {
					alive = false;
					clearInterval(timer);
					readoutRefresh = null;
				};
			}, []);

			// Local clock: only the hover card's peak countdown needs it.
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);

			// Follow the DSH interface language: the shell's locale plugin rewrites
			// `<html lang>`, so watch that attribute instead of freezing the locale.
			useEffect(() => {
				const sync = () => setLocale(detectLocale());
				const root = typeof document !== 'undefined' ? document.documentElement : null;
				const observer = root && typeof MutationObserver !== 'undefined' ? new MutationObserver(sync) : null;
				if (observer) observer.observe(root, { attributes: true, attributeFilter: ['lang'] });
				window.addEventListener('focus', sync);
				return () => {
					if (observer) observer.disconnect();
					window.removeEventListener('focus', sync);
				};
			}, []);

			// A language switch changes every label width: reset the compact decision
			// and let the placement effect re-measure with the new copy.
			useEffect(() => {
				textsRef.current = TEXT[locale];
				fullWidth.current = 0;
				setCompact(false);
			}, [locale]);

			// Drop a pending reveal timer when the readout unmounts.
			useEffect(() => () => clearTimeout(openTimer.current), []);

			// The pointer can leave the page or the window without a mouseleave on
			// the pill (fast exits, Alt-Tab, switching windows): close the card from
			// global signals so a stale hover never leaves it floating.
			useEffect(() => {
				const closeCard = () => {
					clearTimeout(openTimer.current);
					setOpen(false);
					setHovered(false);
				};
				const onMouseOut = (event) => {
					if (!event.relatedTarget) closeCard();
				};
				const onVisibility = () => {
					if (document.hidden) closeCard();
				};
				window.addEventListener('blur', closeCard);
				document.addEventListener('mouseleave', closeCard);
				document.addEventListener('mouseout', onMouseOut);
				document.addEventListener('visibilitychange', onVisibility);
				return () => {
					window.removeEventListener('blur', closeCard);
					document.removeEventListener('mouseleave', closeCard);
					document.removeEventListener('mouseout', onMouseOut);
					document.removeEventListener('visibilitychange', onVisibility);
				};
			}, []);

			// Place the readout into the account row; re-measure on layout changes.
			useLayoutEffect(() => {
				if (!wide) return undefined;
				let frame = 0;
				const measure = () => {
					const next = measurePlacement(anchorRef.current, readoutRef.current);
					if (!next) return;
					if (compact) {
						// The shell may remove its buttons again (e.g. after an update):
						// restore the labelled form once the row has room for it.
						const width = fullWidth.current;
						if (width > 0 && next.available >= width + 12) setCompact(false);
					} else if (next.width > next.available) {
						fullWidth.current = next.width;
						setCompact(true);
						return;
					}
					setPlacement((prev) =>
						prev &&
						prev.left === next.left &&
						prev.top === next.top &&
						prev.width === next.width &&
						prev.height === next.height &&
						prev.available === next.available
							? prev
							: next,
					);
				};
				const schedule = () => {
					cancelAnimationFrame(frame);
					frame = requestAnimationFrame(measure);
				};
				schedule();
				const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
				if (observer) {
					if (anchorRef.current) observer.observe(anchorRef.current);
					if (readoutRef.current) observer.observe(readoutRef.current);
				}
				window.addEventListener('resize', schedule);
				// The shell swaps its own footer controls (the update pill, its download
				// progress) without resizing our nodes, so no ResizeObserver fires. Watch
				// the footer for those mutations rather than polling: records that land
				// inside our own anchor are skipped, so the readout's updates cannot feed
				// the observer back into a loop.
				let mutations = null;
				const anchor = anchorRef.current;
				const column = anchor ? findSidebarColumn(anchor) : null;
				const row = anchor && column ? findAccountRow(anchor, column) : null;
				const foot = row ? row.element.parentElement : null;
				if (observer && row) observer.observe(row.element);
				if (foot && typeof MutationObserver !== 'undefined') {
					mutations = new MutationObserver((records) => {
						const own = anchorRef.current;
						if (own && records.length > 0 && records.every((record) => own.contains(record.target))) return;
						schedule();
					});
					mutations.observe(foot, { childList: true, subtree: true, characterData: true, attributes: true });
				}
				const onVisibility = () => schedule();
				const onFocus = () => schedule();
				document.addEventListener('visibilitychange', onVisibility);
				window.addEventListener('focus', onFocus);
				// Neighbouring footer entries, fonts and the account name settle after
				// the first frame; a couple of late measurements keep the row aligned.
				const settles = [400, 1200, 3000].map((delay) => setTimeout(schedule, delay));
				return () => {
					cancelAnimationFrame(frame);
					if (observer) observer.disconnect();
					if (mutations) mutations.disconnect();
					window.removeEventListener('resize', schedule);
					document.removeEventListener('visibilitychange', onVisibility);
					window.removeEventListener('focus', onFocus);
					for (const timer of settles) clearTimeout(timer);
				};
			}, [wide, compact, locale]);

			if (!wide) return null;

			const T = TEXT[locale];
			const LOCALE_TAG = localeTag(locale);
			const peak = isPeak(now);
			const countdown = humanDuration(secondsToSwitch(now));
			const currency = (snapshot && snapshot.currency) || 'CNY';
			const balance = money(snapshot ? snapshot.balance : null, currency);
			const today = snapshot && snapshot.today ? snapshot.today : null;
			const todayCost = todayMoney(today ? today.cost : null);
			const officialSource = !!(today && today.source === 'official');
			const pending = !snapshot || (today && today.source === 'estimate' && !today.scanned);

			const cardRows = [];
			if (snapshot) {
				cardRows.push({ label: T.balance, value: balance });
				const requestCount = Number(today && today.requests) || 0;
				const todayValue = pending
					? '…'
					: (officialSource ? '' : '≈') + todayCost + (requestCount > 0 ? T.calls(requestCount) : '');
				cardRows.push({ label: T.today, value: todayValue });
				if (officialSource || (today && today.scanned)) {
					cardRows.push({
						label: T.input,
						value: T.hitMiss(compactTokens(today.cacheHitTokens), compactTokens(today.cacheMissTokens)),
					});
					cardRows.push({ label: T.output, value: compactTokens(today.outputTokens) });
					const cacheRate = cacheRateText(today.cacheHitRate, !officialSource);
					if (cacheRate) cardRows.push({ label: T.cache, value: cacheRate });
				}
				cardRows.push({ label: T.rate, value: T.rateValue(peak, countdown) });
				cardRows.push({
					label: T.updated,
					value: clockOf(snapshot.balanceAt, LOCALE_TAG) + ' · ' + sourceLabel(snapshot.balanceSource, T),
				});
			}

			const cardNotes = [];
			if (error) cardNotes.push({ key: 'error', text: error, error: true });
			if (today && today.officialError) {
				cardNotes.push({
					key: 'official',
					text:
						(officialSource ? T.officialRefreshFailed : T.officialUnavailable) +
						describeError(today.officialErrorCode, today.officialErrorStatus, today.officialError, T),
					error: false,
				});
			}

			const aria = T.aria(balance, todayCost, officialSource, peak);

			const readoutStyle = Object.assign(
				{},
				CSS.readout,
				placement
					? { left: placement.left + 'px', top: placement.top + 'px' }
					: { left: '8px', top: '8px', visibility: 'hidden' },
				hovered ? CSS.readoutHover : null,
			);

			// The card hangs above the readout, right-aligned to its edge, so it
			// never moves the footer row and closes with the pointer leaving the pill.
			const cardStyle = Object.assign({}, CSS.card, {
				left: (placement ? placement.cardRight : 8) + 'px',
				top: (placement ? placement.top : 8) + 'px',
				maxWidth: (placement ? placement.cardMaxWidth : 300) + 'px',
				minWidth: placement
					? Math.min(locale === 'en' ? 232 : 196, placement.cardMaxWidth) + 'px'
					: undefined,
				transform: 'translate(-100%, calc(-100% - 6px))',
			});

			return h(
				'span',
				{ ref: anchorRef, style: CSS.anchor },
				h(
					'button',
					{
						ref: readoutRef,
						type: 'button',
						style: readoutStyle,
						'aria-label': aria,
						onClick: () => {
							if (readoutRefresh) readoutRefresh();
						},
						onMouseEnter: () => {
							setHovered(true);
							showCard();
						},
						onMouseLeave: () => {
							setHovered(false);
							hideCard();
						},
						onFocus: () => {
							setHovered(true);
							showCard();
						},
						onBlur: () => {
							setHovered(false);
							hideCard();
						},
					},
					compact ? null : h('span', { style: CSS.label }, T.balance),
					h('span', { style: error && snapshot == null ? CSS.errorValue : CSS.value }, balance),
					h('span', { style: CSS.dot }, '·'),
					compact ? null : h('span', { style: CSS.label }, T.today),
					h(
						'span',
						{ style: error && snapshot == null ? CSS.errorValue : CSS.value },
						pending ? '…' : (officialSource ? '' : '≈') + todayCost,
					),
				),
				open && placement
					? h(
							'span',
							{ style: cardStyle, 'aria-hidden': 'true' },
							snapshot
								? cardRows.map((row) =>
										h(
											'span',
											{ key: row.label, style: CSS.cardRow },
											h(
												'span',
												{
													style: Object.assign({}, CSS.cardLabel, {
														flex: locale === 'en' ? '0 0 56px' : '0 0 32px',
													}),
												},
												row.label,
											),
											h('span', { style: CSS.cardValue }, row.value),
										),
									)
								: h('span', { style: CSS.cardNote }, T.loading),
							cardNotes.map((note) =>
								h('span', { key: note.key, style: note.error ? CSS.cardError : CSS.cardNote }, note.text),
							),
							refreshing ? h('span', { key: 'refreshing', style: CSS.cardNote }, T.refreshing) : null,
						)
					: null,
			);
		}

		/** Manual refresh hook of the mounted readout (one readout per page). */
		let readoutRefresh = null;

		exports.inject = ['slots'];
		exports.apply = function apply(ctx) {
			ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{
						name: 'sidebar.footer.action',
						id: 'dsh-sidebar-wallet',
						order: 40,
						label: () => TEXT[detectLocale()].title,
					},
					Readout,
				),
			);
		};

		return module.exports;
	},
});
