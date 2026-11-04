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

		function clockOf(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
			try {
				return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
			} catch {
				return '—';
			}
		}

		function sourceLabel(source) {
			if (source === 'apikey') return 'API Key';
			if (source === 'account') return '登录账号';
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
					if (rect.height > 0) return rect;
				}
			}
			return null;
		}

		/** Viewport coordinates for a readout at the right end of the account row. */
		function measurePlacement(anchor, readout) {
			if (!anchor || !readout) return null;
			const column = findSidebarColumn(anchor);
			if (!column) return null;
			const columnRect = column.getBoundingClientRect();
			const readoutRect = readout.getBoundingClientRect();
			const width = readoutRect.width || 0;
			const height = readoutRect.height || 16;
			const rowRect = findAccountRow(anchor, column);
			const inlinePadding = 12;

			let top;
			if (rowRect) top = rowRect.top + (rowRect.height - height) / 2;
			else top = columnRect.bottom - 6 - 40;

			return {
				left: Math.max(8, Math.round(columnRect.right - inlinePadding - width)),
				top: Math.max(8, Math.round(Math.min(top, columnRect.bottom - height - 4))),
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
			const [now, setNow] = useState(() => Date.now());
			const [refreshing, setRefreshing] = useState(false);

			// Poll the Host route; a manual click forces a fresh balance.
			useEffect(() => {
				let alive = true;
				const load = async (force) => {
					if (inFlight.current) return;
					inFlight.current = true;
					if (force) setRefreshing(true);
					try {
						const res = await fetch('/dsh-sidebar-wallet/state.json' + (force ? '?refresh=1' : ''), {
							headers: { accept: 'application/json' },
						});
						const body = await res.json();
						if (!alive) return;
						if (body && body.ok) {
							setSnapshot(body);
							setError(body.balanceError || null);
						} else {
							setError((body && body.error) || '读取失败');
						}
					} catch (err) {
						if (alive) setError(String((err && err.message) || err));
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

			// Local clock: only the tooltip's peak countdown needs it.
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);

			// Place the readout into the account row; re-measure on layout changes.
			useLayoutEffect(() => {
				if (!wide) return undefined;
				let frame = 0;
				const measure = () => {
					const next = measurePlacement(anchorRef.current, readoutRef.current);
					if (!next) return;
					setPlacement((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
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
				// Neighbouring footer entries, fonts and the account name settle after
				// the first frame; a couple of late measurements keep the row aligned.
				const settles = [400, 1200, 3000].map((delay) => setTimeout(schedule, delay));
				return () => {
					cancelAnimationFrame(frame);
					if (observer) observer.disconnect();
					window.removeEventListener('resize', schedule);
					for (const timer of settles) clearTimeout(timer);
				};
			}, [wide]);

			if (!wide) return null;

			const peak = isPeak(now);
			const countdown = humanDuration(secondsToSwitch(now)) + (peak ? ' 后转谷' : ' 后转峰');
			const currency = (snapshot && snapshot.currency) || 'CNY';
			const balance = money(snapshot ? snapshot.balance : null, currency);
			const today = snapshot && snapshot.today ? snapshot.today : null;
			const todayCost = todayMoney(today ? today.cost : null);
			const officialSource = !!(today && today.source === 'official');
			const pending = !snapshot || (today && today.source === 'estimate' && !today.scanned);

			const title = buildTitle({ snapshot, error, balance, peak, countdown, refreshing });
			const aria =
				'DeepSeek 余额 ' +
				balance +
				'，今日' +
				(officialSource ? '消费 ' : '估算消费 ≈') +
				todayCost +
				'，当前' +
				(peak ? '高峰时段' : '空闲时段');

			const readoutStyle = Object.assign(
				{},
				CSS.readout,
				placement
					? { left: placement.left + 'px', top: placement.top + 'px' }
					: { left: '8px', top: '8px', visibility: 'hidden' },
				hovered ? CSS.readoutHover : null,
			);

			return h(
				'span',
				{ ref: anchorRef, style: CSS.anchor },
				h(
					'button',
					{
						ref: readoutRef,
						type: 'button',
						style: readoutStyle,
						title,
						'aria-label': aria,
						onClick: () => {
							if (readoutRefresh) readoutRefresh();
						},
						onMouseEnter: () => setHovered(true),
						onMouseLeave: () => setHovered(false),
						onFocus: () => setHovered(true),
						onBlur: () => setHovered(false),
					},
					h('span', { style: CSS.label }, '余额'),
					h('span', { style: error && snapshot == null ? CSS.errorValue : CSS.value }, balance),
					h('span', { style: CSS.dot }, '·'),
					h('span', { style: CSS.label }, '今日'),
					h(
						'span',
						{ style: error && snapshot == null ? CSS.errorValue : CSS.value },
						pending ? '…' : (officialSource ? '' : '≈') + todayCost,
					),
				),
			);
		}

		/** Manual refresh hook of the mounted readout (one readout per page). */
		let readoutRefresh = null;

		function buildTitle(input) {
			const { snapshot, error, balance, peak, countdown, refreshing } = input;
			const lines = [];
			if (snapshot) {
				lines.push(
					'余额 ' +
						balance +
						'（' +
						clockOf(snapshot.balanceAt) +
						' 更新 · ' +
						sourceLabel(snapshot.balanceSource) +
						'）',
				);
				const today = snapshot.today || {};
				if (today.source === 'official') {
					lines.push('今日消费 ' + todayMoney(today.cost) + '（官方后台口径 · ' + (today.requests || 0) + ' 次请求）');
					lines.push(
						'输入命中 ' +
							compactTokens(today.cacheHitTokens) +
							' · 未命中 ' +
							compactTokens(today.cacheMissTokens) +
							' · 输出 ' +
							compactTokens(today.outputTokens),
					);
					lines.push('官方口径：该账户全部 API 调用');
					if (today.officialError) lines.push('官方用量刷新失败：' + today.officialError);
				} else if (today.scanned) {
					lines.push('今日估算 ≈' + todayMoney(today.cost) + '（本机会话日志 · ' + (today.requests || 0) + ' 次调用）');
					lines.push(
						'输入 ' +
							compactTokens(today.cacheMissTokens) +
							' · 缓存命中 ' +
							compactTokens(today.cacheHitTokens) +
							' · 输出 ' +
							compactTokens(today.outputTokens),
					);
					lines.push(
						today.officialError
							? '官方用量不可用：' + today.officialError
							: '官方用量暂不可用（未登录 DeepSeek 账号？）',
					);
				} else {
					lines.push('今日统计中…');
					if (today.officialError) lines.push('官方用量不可用：' + today.officialError);
				}
			} else {
				lines.push('正在读取余额…');
			}
			lines.push('当前' + (peak ? '高峰时段' : '空闲时段') + ' · ' + countdown);
			lines.push(refreshing ? '刷新中…' : '点击刷新');
			if (error) lines.push(error);
			return lines.join('\n');
		}

		exports.inject = ['slots'];
		exports.apply = function apply(ctx) {
			ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{
						name: 'sidebar.footer.action',
						id: 'dsh-sidebar-wallet',
						order: 40,
						label: () => '侧边栏钱包',
					},
					Readout,
				),
			);
		};

		return module.exports;
	},
});
