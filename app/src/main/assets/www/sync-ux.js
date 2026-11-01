/* ════════════════════════════════════════════════════════════════════
   SYNC UX  (app.js 로직은 건드리지 않는 추가 모듈)
   1) 플레이리스트 곡 편집 모드
        - 곡 UI 길게 누르기 → edit 상태 (옆에 Liquid Glass Context Menu: 곡 삭제 / 곡 즐겨찾기)
        - edit 상태의 곡을 위/아래로 끌어 순서 변경 (다른 곡들이 순차적으로 부드럽게 비켜준다)
   2) 성능 거버너
        - 프레임 시간을 감시해 부하가 커지면 장식용 애니메이션/배경 갱신 빈도를 낮춘다
        - 조작이 없는 동안(idle)에는 WebView 가 불필요하게 다시 그려지지 않게 한다
          (WebView 가 다시 그려질 때마다 그 뒤의 네이티브 글래스 blur/lens 가 매번 재실행되어 발열의 원인이 됨)
════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    const doc = document.documentElement;
    const $ = id => document.getElementById(id);
    const now = () => performance.now();

    /* ════════════════════════════════════════════
       2) PERF GOVERNOR
    ════════════════════════════════════════════ */
    const P = {
        lite: false,        // 프레임 시간이 나빠졌을 때(발열/스로틀링) 켜지는 절전 모드
        quiet: false,       // 조작 없이 3.5초 이상 지나면 켜지는 "정지 화면" 모드
        lastTouch: now(),
        ema: 16.7, base: 1e9, last: 0, frames: 0, bad: 0, good: 0
    };
    window.__perf = P;

    function setClass(name, on) { if (doc.classList.contains(name) !== on) doc.classList.toggle(name, on); }

    /* app.js 의 bgLoop 가 호출: 배경 캔버스를 몇 프레임에 한 번 그릴지 */
    window.__bgEvery = function (playing) {
        if (P.lite || P.quiet) return playing ? 6 : 10;   // 10fps / 6fps
        return playing ? 3 : 6;                            // 20fps / 10fps  (이전: 30fps / 10fps)
    };

    /* app.js 의 bgLoop 가 프레임마다 호출 (이미 돌고 있는 rAF 를 재사용 → 별도 rAF 루프 없음) */
    window.__perfTick = function (t) {
        if (P.last) {
            const dt = t - P.last;
            if (dt < 250) P.ema += (dt - P.ema) * 0.05;     // 백그라운드 복귀 등 긴 정지는 제외
        }
        P.last = t;
        // 조작 중(주사율이 올라가 있고 실제 체감이 중요한 구간)에만 판단한다
        if (t - P.lastTouch > 3000 || ++P.frames < 90) return;
        if (P.ema < P.base) P.base = P.ema;
        if (P.frames % 30) return;
        if (!P.lite) {
            P.bad = P.ema > P.base * 1.5 && P.ema > 20 ? P.bad + 1 : 0;
            if (P.bad >= 4) { P.lite = true; P.bad = 0; P.good = 0; setClass('perf-lite', true); }
        } else {
            P.good = P.ema < P.base * 1.15 ? P.good + 1 : 0;
            if (P.good >= 10) { P.lite = false; P.good = 0; P.bad = 0; setClass('perf-lite', false); }
        }
    };

    function touched() {
        P.lastTouch = now();
        if (P.quiet) { P.quiet = false; setClass('ux-quiet', false); }
    }
    ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach(ev =>
        addEventListener(ev, touched, { capture: true, passive: true }));
    addEventListener('scroll', touched, { capture: true, passive: true });

    /* 조작이 멈추면 장식용 무한 애니메이션(재생 막대 등)을 멈춘다 → WebView 가 가만히 있으면 글래스도 다시 계산하지 않는다 */
    setInterval(function () {
        if (window.__bgMode) return;
        const idle = now() - P.lastTouch > 3500;
        if (idle !== P.quiet) { P.quiet = idle; setClass('ux-quiet', idle); }
    }, 1000);

    /* ════════════════════════════════════════════
       1) TRACK EDIT MODE
    ════════════════════════════════════════════ */
    const LIST_ID = 'pl-track-list';
    const LONG_MS = 420;       // 길게 누르기 판정
    const SLOP = 8;            // 길게 누르는 동안 허용되는 손가락 흔들림(px)
    const MENU_W = 208, MENU_H = 112;

    const E = {
        on: false, plId: null, tid: null, row: null,
        press: null, drag: null, settling: false, removing: false,
        suppressUntil: 0, justEntered: false,
        leaveUntil: 0, lastSnap: null
    };

    const listEl = () => $(LIST_ID);
    const rowsOf = list => Array.from(list.children).filter(n => n.classList && n.classList.contains('pl-track'));
    const kick = ms => { try { window.__glassKick && window.__glassKick(ms || 400); } catch (e) { } };
    const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { } };
    const curPl = () => (typeof plById === 'function' && E.plId) ? plById(E.plId) : null;
    const curTrack = () => { const pl = curPl(); return pl ? pl.tracks.find(t => t.id === E.tid) || null : null; };

    function overlaysOpen() {
        return ['pl-dialog-overlay', 'pl-confirm-overlay', 'pl-add-modal-overlay', 'np'].some(id => {
            const el = $(id); return el && el.classList.contains('on');
        });
    }

    /* ── enter / exit ── */
    function enter(row) {
        const list = listEl(); if (!list || typeof PL === 'undefined' || !PL.curId) return;
        const rows = rowsOf(list), i = rows.indexOf(row);
        const pl = plById(PL.curId); if (!pl || i < 0 || !pl.tracks[i]) return;
        E.on = true; E.plId = pl.id; E.tid = pl.tracks[i].id; E.row = row;
        E.justEntered = true; E.leaveUntil = 0;
        list.classList.add('te-on'); doc.classList.add('te-open');
        row.classList.add('te-editing');
        buzz(14);
        kick(500);
    }

    function exit(instant) {
        if (!E.on) return;
        const list = listEl();
        if (E.drag) { cancelAnimationFrame(E.drag.raf); E.drag = null; }
        if (E.row) { E.row.classList.remove('te-editing', 'te-dragging', 'te-settling'); E.row.style.transform = ''; E.row.style.transitionDelay = ''; }
        if (list) { list.classList.remove('te-on'); rowsOf(list).forEach(r => { r.style.transform = ''; r.style.transitionDelay = ''; }); }
        doc.classList.remove('te-open');
        if (!instant && E.lastSnap) E.leaveUntil = now() + 320;   // 네이티브 메뉴가 사라지는 애니메이션 시간
        E.on = false; E.row = null; E.tid = null; E.settling = false; E.removing = false;
        kick(400);
    }

    /* 리스트가 다시 그려지면(app.js 가 innerHTML 을 새로 만든다) 같은 곡의 새 행을 찾아 edit 상태를 이어 준다 */
    function reattach() {
        if (!E.on) return;
        const list = listEl(), pl = curPl();
        if (!list || !pl) return exit(true);
        const i = pl.tracks.findIndex(t => t.id === E.tid);
        const rows = rowsOf(list);
        if (i < 0 || !rows[i]) return exit(true);
        E.row = rows[i];
        E.row.classList.add('te-editing');
        list.classList.add('te-on');
    }

    function validate() {
        if (!E.on) return false;
        const list = listEl(), view = $('pl-detail-view');
        if (!list || !view || view.style.display === 'none' || !list.isConnected) { exit(true); return false; }
        if (typeof PL !== 'undefined' && PL.curId !== E.plId) { exit(true); return false; }
        if (overlaysOpen()) { exit(true); return false; }
        if (!E.row || !E.row.isConnected) { reattach(); }
        return E.on;
    }

    /* ── glass-bridge.js 가 읽는 스냅샷 (뷰포트 CSS px) ── */
    function snapshot() {
        if (!E.on) {
            if (E.leaveUntil > now() && E.lastSnap) return Object.assign({}, E.lastSnap, { show: false });
            E.lastSnap = null; return null;
        }
        if (!validate()) return null;
        const rr = E.row.getBoundingClientRect();
        const vw = doc.clientWidth, M = 10;
        // 하단 도크(탭 캡슐/미니 플레이어) 위쪽까지만 쓴다
        let dockTop = innerHeight;
        const nav = $('mob-nav'), bar = $('bar');
        if (nav && nav.getBoundingClientRect().height > 2) dockTop = Math.min(dockTop, nav.getBoundingClientRect().top);
        if (bar && !bar.classList.contains('bar-hidden')) dockTop = Math.min(dockTop, bar.getBoundingClientRect().top);
        dockTop -= 6;
        const x = Math.min(Math.max(rr.right - MENU_W - 14, M), vw - MENU_W - M);
        let y = rr.bottom + 6, up = false;
        if (y + MENU_H > dockTop) { y = rr.top - 6 - MENU_H; up = true; }
        if (y < 8) { y = Math.max(8, Math.min(rr.top + (rr.height - MENU_H) / 2, dockTop - MENU_H)); up = false; }
        const t = curTrack();
        const fav = !!(t && typeof isFav === 'function' && isFav(t.id));
        E.lastSnap = {
            r: { x: x, y: y, w: MENU_W, h: MENU_H }, up: up,
            show: !E.drag && !E.settling && !E.removing,
            fav: fav, del: '곡 삭제', favL: fav ? '즐겨찾기 해제' : '즐겨찾기'
        };
        return E.lastSnap;
    }

    /* ── 길게 누르기 / 드래그 입력 ── */
    function cancelPress() {
        if (E.press) { clearTimeout(E.press.timer); E.press = null; }
    }

    function onDown(ev) {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        if (E.settling || E.removing) return;
        const t = ev.target;
        const row = t.closest && t.closest('.pl-track');
        if (!row || (t.closest && t.closest('.pl-track-del'))) return;
        cancelPress();
        const p = E.press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, row: row, timer: 0, fired: false };
        if (E.on) return;                       // 이미 edit 상태: 이동이 생기면 드래그로 전환 (onMove)
        p.timer = setTimeout(function () {
            if (E.press !== p) return;
            p.fired = true;
            enter(row);
            try { row.setPointerCapture(p.id); } catch (e) { }
        }, LONG_MS);
    }

    function onMove(ev) {
        const p = E.press;
        if (E.drag) {
            if (ev.pointerId !== E.drag.pid) return;
            E.drag.y = ev.clientY; scheduleDrag();
            return;
        }
        if (!p || p.id !== ev.pointerId) return;
        const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
        if (!E.on) {
            if (!p.fired && Math.hypot(dx, dy) > SLOP) cancelPress();    // 스크롤로 판단 → 길게 누르기 취소
            return;
        }
        if (p.row === E.row && Math.abs(dy) > 4) {
            try { E.row.setPointerCapture(p.id); } catch (e) { }
            startDrag(ev);
        }
    }

    function onUp(ev) {
        if (E.justEntered) { E.justEntered = false; E.suppressUntil = now() + 350; }   // 손가락을 뗄 때 생기는 click 차단
        if (E.drag && ev.pointerId === E.drag.pid) endDrag();
        if (E.press && E.press.id === ev.pointerId) cancelPress();
    }

    /* touch-action 은 터치 시작 시점에 결정되므로, 길게 누른 직후 같은 제스처로 끌 때를 위해 touchmove 를 직접 막는다 */
    document.addEventListener('touchmove', function (e) {
        if (E.drag || (E.press && E.press.fired)) { if (e.cancelable) e.preventDefault(); }
    }, { passive: false });

    /* ── 드래그 정렬 ── */
    function startDrag(ev) {
        const list = listEl(); if (!list || !E.row) return;
        const rows = rowsOf(list), n = rows.length, i0 = rows.indexOf(E.row);
        if (i0 < 0 || n < 2) return;
        const base = rows[0].offsetTop;
        const tops = rows.map(r => r.offsetTop - base);
        const pit = rows.map((r, i) => i < n - 1 ? (rows[i + 1].offsetTop - r.offsetTop) : r.offsetHeight);   // 행 간격 포함 피치
        E.drag = {
            pid: ev.pointerId, rows: rows, n: n, i0: i0, tops: tops, pit: pit,
            y0: ev.clientY, y: ev.clientY, sc0: window.scrollY,
            cur: i0, shifts: new Array(n).fill(0), raf: 0
        };
        rows.forEach(r => { r.style.transitionDelay = ''; });
        E.row.classList.add('te-dragging');
        buzz(10);
        kick(300);                  // 드래그 중에는 메뉴를 숨긴다 (show=false)
        scheduleDrag();
    }

    function scheduleDrag() {
        const d = E.drag; if (d && !d.raf) d.raf = requestAnimationFrame(applyDrag);
    }

    function layoutFor(d, t) {
        const order = [];
        for (let k = 0; k < d.n; k++) if (k !== d.i0) order.push(k);
        order.splice(t, 0, d.i0);
        const shifts = new Array(d.n);
        let acc = 0;
        for (let s = 0; s < order.length; s++) { const idx = order[s]; shifts[idx] = acc - d.tops[idx]; acc += d.pit[idx]; }
        return shifts;
    }

    function applyDrag() {
        const d = E.drag; if (!d) return;
        d.raf = 0;
        // 화면 가장자리에서는 자동 스크롤 (사용자 스크롤은 잠겨 있으므로 프로그램 스크롤만 가능)
        const edge = 80, topInset = 56, bottomInset = 130;
        let v = 0;
        if (d.y < topInset + edge) v = -(topInset + edge - d.y) / edge * 12;
        else if (d.y > innerHeight - bottomInset - edge) v = (d.y - (innerHeight - bottomInset - edge)) / edge * 12;
        if (v) window.scrollBy(0, v);

        const dy = (d.y - d.y0) + (window.scrollY - d.sc0);
        const row = d.rows[d.i0];
        row.style.transform = 'translate3d(0,' + dy + 'px,0) scale(1.02)';

        // 끌고 있는 행의 중심이 "나머지 행들만 이어 붙인 배치"에서 각 행의 아래 경계를 몇 개나 지났는지 = 들어갈 슬롯.
        // (절반 이상 겹치면 자리를 바꾼다. 경계 근처에서 떨리지 않도록 ±5px 히스테리시스)
        const center = d.tops[d.i0] + d.pit[d.i0] / 2 + dy;
        let acc = 0, t = 0, m = 0;
        for (let k = 0; k < d.n; k++) {
            if (k === d.i0) continue;
            const edge = acc + d.pit[k];
            if (m < d.cur ? center > edge - 5 : center > edge + 5) t++;
            acc = edge; m++;
        }
        if (t !== d.cur) {
            d.cur = t; buzz(6);
            const next = layoutFor(d, t);
            // 바뀌는 행들만 갱신. 이동 방향의 "앞쪽" 행부터 아주 짧게 시차를 둔다 → 같은 방향으로 같은 거리를
            // 같은 이징으로 움직이므로 서로 겹치지 않고 꼬리를 물듯 부드럽게 따라온다.
            const changed = [];
            for (let k = 0; k < d.n; k++) if (k !== d.i0 && next[k] !== d.shifts[k]) changed.push(k);
            if (changed.length) {
                const up = next[changed[0]] < d.shifts[changed[0]];         // 위로 움직이는가
                if (!up) changed.reverse();
                changed.forEach((k, rank) => {
                    const r = d.rows[k];
                    r.style.transitionDelay = Math.min(rank, 3) * 18 + 'ms';
                    r.style.transform = next[k] ? 'translate3d(0,' + next[k] + 'px,0)' : '';
                    d.shifts[k] = next[k];
                });
            }
        }
        if (v) scheduleDrag();
    }

    function endDrag() {
        const d = E.drag; if (!d) return;
        cancelAnimationFrame(d.raf);
        E.drag = null; E.settling = true; E.suppressUntil = now() + 350;
        cancelPress();
        const row = d.rows[d.i0];
        const finalShift = layoutFor(d, d.cur)[d.i0];
        row.classList.remove('te-dragging'); row.classList.add('te-settling');
        row.style.transitionDelay = '';
        row.style.transform = 'translate3d(0,' + finalShift + 'px,0) scale(1.02)';
        kick(500);
        setTimeout(function () { commit(d); }, 300);
    }

    function commit(d) {
        const list = listEl(), pl = curPl();
        E.settling = false;
        if (!E.on || !list || !pl) { kick(300); return; }
        if (d.cur !== d.i0 && pl.tracks.length === d.n) {
            const order = [];
            for (let k = 0; k < d.n; k++) if (k !== d.i0) order.push(k);
            order.splice(d.cur, 0, d.i0);
            const old = pl.tracks.slice();
            order.forEach((oi, k) => { pl.tracks[k] = old[oi]; });
            if (typeof plSave === 'function') plSave();
            rebuild(pl.id);            // 번호/클릭 핸들러(인덱스)를 새 순서에 맞춘다
        } else {
            d.rows.forEach(r => { r.style.transform = ''; r.style.transitionDelay = ''; });
            if (E.row) { E.row.classList.remove('te-settling'); E.row.style.transform = ''; }
        }
        kick(400);
    }

    /* 트랜지션 없이 목록을 다시 만든다 (정렬이 이미 화면에 반영되어 있으므로 시각적 변화 없음) */
    function rebuild(plId) {
        const list = listEl(); if (!list) return;
        list.classList.add('te-noanim');
        plRenderDetail(plId);
        reattach();
        requestAnimationFrame(function () { requestAnimationFrame(function () { list.classList.remove('te-noanim'); }); });
    }

    /* ── Context Menu 동작 (네이티브 글래스 → __glassCmd('edit')) ── */
    function doDelete() {
        if (!E.on || !E.row || E.removing || E.drag || E.settling) return;
        const list = listEl(), rows = rowsOf(list), i = rows.indexOf(E.row);
        if (i < 0) return;
        E.removing = true; kick(300);
        const row = E.row, pit = (rows[i + 1] ? rows[i + 1].offsetTop - row.offsetTop : row.offsetHeight);
        const plId = E.plId, tid = E.tid;
        row.classList.add('te-removing');
        rows.slice(i + 1).forEach(function (r, k) {
            r.style.transitionDelay = Math.min(k, 3) * 18 + 'ms';
            r.style.transform = 'translate3d(0,' + (-pit) + 'px,0)';
        });
        setTimeout(function () {
            exit(true);
            list.classList.add('te-noanim');
            plRemoveTrack(plId, tid);           // app.js: 데이터 삭제 + 저장 + 목록 다시 그리기
            requestAnimationFrame(function () { requestAnimationFrame(function () { list.classList.remove('te-noanim'); }); });
            kick(400);
        }, 280);
    }

    function doFav() {
        const t = curTrack(); if (!t || E.drag || E.settling || E.removing) return;
        toggleFavTrack(t);                      // app.js: 즐겨찾기 토글 + 저장 + 목록 갱신
        kick(300);
    }

    window.__trackEdit = {
        snapshot: snapshot,
        cmd: function (a) { if (a === 'del') doDelete(); else if (a === 'fav') doFav(); },
        exit: exit
    };

    /* ── 바깥 탭 = 편집 종료, 길게 누른 직후의 click 은 곡 재생으로 이어지지 않게 차단 ── */
    document.addEventListener('click', function (ev) {
        if (now() < E.suppressUntil) { ev.stopPropagation(); ev.preventDefault(); return; }
        if (!E.on) return;
        const list = listEl();
        const inList = list && list.contains(ev.target);
        if (inList) { ev.stopPropagation(); ev.preventDefault(); }   // 다른 곡을 눌러도 재생하지 않고 편집만 종료
        if (!E.removing && !E.settling) exit();
    }, true);

    document.addEventListener('contextmenu', function (ev) {          // 길게 누를 때 뜨는 시스템 메뉴/텍스트 선택 방지
        if (ev.target.closest && ev.target.closest('#' + LIST_ID)) ev.preventDefault();
    }, true);

    function bind() {
        const list = listEl(); if (!list) return;
        list.addEventListener('dragstart', function (ev) { ev.preventDefault(); });   // 썸네일 이미지 길게 누름 → 이미지 드래그로 전환되는 것 방지
        list.addEventListener('pointerdown', onDown);
        list.addEventListener('pointermove', onMove);
        list.addEventListener('pointerup', onUp);
        list.addEventListener('pointercancel', function (ev) { onUp(ev); });
        list.addEventListener('lostpointercapture', function (ev) { if (E.drag && ev.pointerId === E.drag.pid) endDrag(); });
        new MutationObserver(function () { if (E.on) reattach(); }).observe(list, { childList: true });
    }
    if (listEl()) bind(); else document.addEventListener('DOMContentLoaded', bind);
    addEventListener('pointerup', function (ev) { if (E.justEntered) onUp(ev); }, true);
})();
