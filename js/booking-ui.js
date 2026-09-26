/*
 * 预订锁单台：页面渲染与操作
 *
 * 上半区为可锁单作品（待交付）及锁单录入，下半区为预订台账。
 * 看板作品卡片上的锁单角标也由本文件提供。
 */
(function () {
  "use strict";

  const R = window.BookingRules;
  const L = window.BookingLedger;
  const MOUNT_ID = "bookingDesk";

  /* ---------- 提示条 ---------- */
  let noticeTimer = null;
  function notify(text, type) {
    const bar = document.querySelector("#bkNotice");
    if (!bar) return;
    bar.textContent = text;
    bar.className = "bk-notice show " + (type || "info");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => bar.classList.remove("show"), type === "error" ? 8000 : 5000);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, s => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[s]);
  }

  function fmtMoney(n) {
    return "¥" + Number(n).toFixed(2);
  }

  // datetime-local 取本地时间，默认 +3 天的当前时刻
  function toLocalInput(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function workTitle(w) {
    return w ? `${w.theme} · ${w.base}` : "（作品已删除）";
  }

  /* ---------- 看板角标 ---------- */
  function badgeHtml(work) {
    if (!work || !window.BookingLedger) return "";
    const b = L.activeFor(work.id);
    if (!b) return "";
    const cls = b.status === R.HELD ? "bk-held" : "bk-paid";
    const tag = b.status === R.HELD ? "待收定金" : "已收定金";
    return `<div class="bk-badge ${cls}">🔒 ${esc(b.customer)} · ${tag}</div>`;
  }

  /* ---------- 可锁单作品 ---------- */
  function renderCandidates(works, bookings) {
    const list = works.filter(w => w.status === "待交付");
    if (!list.length) return `<div class="bk-empty">暂无待交付作品</div>`;

    const defaultDeadline = toLocalInput(Date.now() + 3 * 86400000);
    return list.map(w => {
      const active = R.findActive(bookings, w.id);
      if (active) {
        const cls = active.status === R.HELD ? "bk-held" : "bk-paid";
        const tag = R.STATE_LABELS[active.status];
        const extra = active.status === R.HELD
          ? `<div class="bk-sub">定金截止：${esc(new Date(active.deadline).toLocaleString())}</div>`
          : `<div class="bk-sub">已于 ${esc(new Date(active.depositedAt).toLocaleString())} 收到定金</div>`;
        return `<article class="bk-card bk-locked">
          <div class="bk-card-title">${esc(workTitle(w))}
            <span class="bk-state ${cls}">🔒 ${tag}</span>
          </div>
          <div class="bk-sub">客户：<b>${esc(active.customer)}</b> · 定金 ${fmtMoney(active.deposit)}</div>
          ${extra}
          <div class="bk-sub">锁单有效期间不能再接第二单</div>
        </article>`;
      }

      const check = R.lockability(w, bookings);
      const problems = check.reasons
        .filter(code => code !== "CONFLICT")
        .map(code => R.LOCK_PROBLEMS[code]);
      if (problems.length) {
        return `<article class="bk-card">
          <div class="bk-card-title">${esc(workTitle(w))}</div>
          <div class="bk-sub">交付日期：${esc(w.delivery)} · 进度 ${esc(w.progress)}%</div>
          <div class="bk-probs">${problems.map(t => `<span>${esc(t)}</span>`).join("")}</div>
        </article>`;
      }

      return `<article class="bk-card">
        <div class="bk-card-title">${esc(workTitle(w))}
          <span class="bk-state bk-open">可锁单</span>
        </div>
        <div class="bk-sub">交付日期：${esc(w.delivery)} · 进度 100% · 无缺陷</div>
        <form class="bk-lockform" data-work="${esc(w.id)}">
          <div class="bk-frow">
            <label>客户称呼<input name="customer" required maxlength="30" placeholder="如：陈先生"></label>
            <label>定金（元）<input name="deposit" type="number" min="0.01" step="0.01" required placeholder="200"></label>
          </div>
          <div class="bk-frow">
            <label>定金截止时刻<input name="deadline" type="datetime-local" required value="${defaultDeadline}"></label>
          </div>
          <label class="bk-note">备注<input name="note" maxlength="120" placeholder="取件方式、联系电话（可选）"></label>
          <button type="submit" class="bk-primary">为该作品锁单</button>
        </form>
      </article>`;
    }).join("");
  }

  /* ---------- 预订台账 ---------- */
  function countdown(b) {
    if (b.status !== R.HELD) return "";
    const ms = Date.parse(b.deadline) - Date.now();
    const attr = `data-deadline="${esc(b.deadline)}"`;
    if (ms <= 0) return `<span class="bk-over" ${attr}>已到点，待释放</span>`;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const text = h > 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 小时` : `${h} 小时 ${String(m).padStart(2, "0")} 分 ${String(s).padStart(2, "0")} 秒`;
    return `<span class="bk-tick" ${attr}>距截止 ${text}</span>`;
  }

  function renderLedgerItem(b, workMap) {
    const w = workMap[b.workId];
    const cls = b.status === R.HELD ? "bk-held" : b.status === R.DEPOSITED ? "bk-paid" : b.status === R.RELEASED ? "bk-rel" : "bk-inv";
    let actions = "";
    if (b.status === R.HELD) {
      actions = `<div class="bk-actions">
        <button data-act="deposit" data-id="${esc(b.id)}" class="bk-primary">收到定金</button>
        <button data-act="rework" data-id="${esc(b.id)}" class="bk-warn">登记改稿</button>
        <button data-act="cancel" data-id="${esc(b.id)}" class="bk-ghost">退订释放</button>
      </div>`;
    } else if (b.status === R.DEPOSITED) {
      actions = `<div class="bk-actions">
        <button data-act="rework" data-id="${esc(b.id)}" class="bk-warn">登记改稿 / 补记缺陷</button>
      </div>`;
    }
    const ended = b.endedAt
      ? `<div class="bk-sub">${esc(R.STATE_LABELS[b.status])}：${esc(b.endReason)}（${esc(new Date(b.endedAt).toLocaleString())}）</div>`
      : "";
    return `<article class="bk-ledger-item">
      <div class="bk-card-title">${esc(workTitle(w))}
        <span class="bk-state ${cls}">${R.STATE_LABELS[b.status]}</span>
      </div>
      <div class="bk-sub">客户：<b>${esc(b.customer)}</b> · 定金 ${fmtMoney(b.deposit)} · 锁单于 ${esc(new Date(b.createdAt).toLocaleString())}</div>
      <div class="bk-sub">定金截止：${esc(new Date(b.deadline).toLocaleString())} ${countdown(b)}</div>
      ${b.depositedAt ? `<div class="bk-sub">定金收到：${esc(new Date(b.depositedAt).toLocaleString())}</div>` : ""}
      ${b.note ? `<div class="bk-sub">备注：${esc(b.note)}</div>` : ""}
      ${ended}
      ${actions}
    </article>`;
  }

  function renderBookingDesk() {
    const mount = document.querySelector("#" + MOUNT_ID);
    if (!mount) return;
    const works = window.Workshop ? window.Workshop.getWorks() : [];
    const bookings = L.allRecent();
    const workMap = Object.fromEntries(works.map(w => [w.id, w]));

    const heldN = bookings.filter(b => b.status === R.HELD).length;
    const paidN = bookings.filter(b => b.status === R.DEPOSITED).length;

    mount.innerHTML = `
      <div id="bkNotice" class="bk-notice" role="status"></div>
      <section class="panel">
        <h2>预订锁单台 <span class="bk-counts">待收定金 ${heldN} 单 · 已收定金 ${paidN} 单</span></h2>
        <div class="bk-hint">
          仅「待交付、贴线进度 100%、无缺陷」的作品可锁单；锁单有效时不能重复接单，
          到截止时刻未收到定金将自动释放；收到定金后改稿或补记缺陷，订单失效并回到待交付。
        </div>
        <div id="bkCandidates" class="bk-candidates">${renderCandidates(works, bookings)}</div>
      </section>
      <section class="panel">
        <h2>预订台账</h2>
        <div id="bkLedger" class="bk-ledger">
          ${bookings.length ? bookings.map(b => renderLedgerItem(b, workMap)).join("") : '<div class="bk-empty">暂无预订记录</div>'}
        </div>
      </section>`;
  }

  /* ---------- 操作处理 ---------- */
  function afterMutation(result) {
    if (!result || !result.changed) return;
    const b = result.booking;
    if (result.outcome === "invalidated") {
      notify(`客户「${b.customer}」已付定金，改稿/补记缺陷后订单失效，作品已回到待交付。`, "error");
    } else if (result.outcome === "released") {
      notify(`锁单已释放：客户「${b.customer}」的订单不再有效，作品可重新接单。`, "warn");
    }
  }

  function onSubmit(e) {
    const form = e.target.closest(".bk-lockform");
    if (!form) return;
    e.preventDefault();
    const workId = form.dataset.work;
    const fd = new FormData(form);
    const result = L.lock(workId, {
      customer: String(fd.get("customer") || "").trim(),
      deposit: fd.get("deposit"),
      deadline: String(fd.get("deadline") || ""),
      note: String(fd.get("note") || "").trim()
    });
    if (result.ok) {
      notify(`已为「${result.booking.customer}」锁单，请在截止前收取定金。`, "ok");
      window.dispatchEvent(new Event("bookings:changed"));
      return;
    }
    if (result.code === "CONFLICT") {
      notify(`不能重复接单：该作品已被原客户「${result.customer}」锁定（${R.STATE_LABELS[result.existing.status]}）。`, "error");
    } else if (result.code === "NOT_LOCKABLE") {
      notify("当前不可锁单：" + result.problems.join("、"), "error");
    } else if (result.code === "BAD_INPUT") {
      notify(Object.values(result.errors).join("；"), "error");
    } else {
      notify("锁单失败，请检查录入信息。", "error");
    }
  }

  function onClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const bookings = L.allRecent();
    const b = bookings.find(x => x.id === id);
    if (!b) return;

    if (btn.dataset.act === "deposit") {
      const result = L.receiveDeposit(id);
      if (result.ok) {
        notify(`已登记收到客户「${result.booking.customer}」定金 ${fmtMoney(result.booking.deposit)}，订单确认。`, "ok");
        handleSweep(result.expiredReleases);
      } else if (result.code === "EXPIRED") {
        notify("已过定金截止时刻，该锁单已自动释放，不能再补收定金。", "error");
        handleSweep(result.expiredReleases);
      } else {
        notify("该锁单当前不能收取定金（可能已逾时释放）。", "error");
      }
      return;
    }

    if (btn.dataset.act === "cancel") {
      if (!window.confirm(`确认释放客户「${b.customer}」的锁单？释放后该作品可重新接单。`)) return;
      const result = L.cancel(id, "");
      if (result.ok) notify(`已释放客户「${b.customer}」的锁单。`, "warn");
      return;
    }

    if (btn.dataset.act === "rework") {
      const paid = b.status === R.DEPOSITED;
      const tip = paid
        ? `客户「${b.customer}」已付定金。登记改稿后订单将失效，作品回到待交付。请输入改稿/缺陷说明：`
        : `客户「${b.customer}」尚未付定金，改稿将直接释放锁单。请输入改稿/缺陷说明：`;
      const detail = window.prompt(tip, "");
      if (detail === null) return;
      const result = L.registerRework(id, detail.trim());
      if (!result.ok) notify("该锁单已结束，不能登记改稿。", "error");
      return;
    }
  }

  // 逾时释放后的集中提示
  function handleSweep(released) {
    (released || []).forEach(b => {
      const w = window.Workshop.getWorks().find(x => x.id === b.workId);
      notify(`「${w ? w.theme : b.workId}」客户「${b.customer}」到点未收到定金，锁单已释放。`, "warn");
    });
  }

  // 无逾时时仅原地刷新倒计时，避免重渲染打断锁单表单输入
  function tickCountdowns() {
    const mounts = document.querySelectorAll("#" + MOUNT_ID + " [data-deadline]");
    mounts.forEach(el => {
      const ms = Date.parse(el.dataset.deadline) - Date.now();
      if (ms <= 0) {
        el.className = "bk-over";
        el.textContent = "已到点，待释放";
        return;
      }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      el.className = "bk-tick";
      el.textContent = h > 24
        ? `距截止 ${Math.floor(h / 24)} 天 ${h % 24} 小时`
        : `距截止 ${h} 小时 ${String(m).padStart(2, "0")} 分 ${String(s).padStart(2, "0")} 秒`;
    });
  }

  function periodicSweep() {
    const released = L.sweep();
    if (released.length) {
      handleSweep(released);
      window.dispatchEvent(new Event("bookings:changed"));
    } else {
      tickCountdowns();
    }
  }

  /* ---------- 与原作品操作的联动 ---------- */

  // 看板状态按钮：锁单有效时拦截重复接单，改稿则按规则释放/失效
  // 返回 true = 继续执行原状态变更；false = 阻止
  function beforeStatusChange(workId, nextStatus) {
    L.sweep();
    const active = L.activeFor(workId);
    if (!active) return true;
    if (nextStatus === "待交付") {
      notify(`锁单有效：作品已被原客户「${active.customer}」锁定，不能重复接单。`, "error");
      return false;
    }
    const paid = active.status === R.DEPOSITED;
    const msg = paid
      ? `客户「${active.customer}」已付定金。将作品转回「${nextStatus}」属于改稿，订单将失效并置回待交付，确认继续？`
      : `作品已被客户「${active.customer}」锁定（尚未付定金）。转回「${nextStatus}」属于改稿，将释放该锁单，确认继续？`;
    if (!window.confirm(msg)) return false;
    const result = L.applyWorkMutationFor(workId, "rework", `状态转回「${nextStatus}」`);
    afterMutation(result);
    return !paid; // 已收定金：作品已置回待交付，阻止原状态变更；未收定金：放行，作品进入改稿工序
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .bk-notice { display: none; margin-bottom: 10px; padding: 9px 12px; border-radius: 6px; font-size: 13px; }
      .bk-notice.show { display: block; }
      .bk-notice.info { background: #e7f1ef; color: var(--teal); }
      .bk-notice.ok { background: #e3f0e4; color: #2c6b33; }
      .bk-notice.warn { background: #f7eedb; color: var(--amber); }
      .bk-notice.error { background: #f6e3e3; color: var(--red); }
      .bk-counts { font-size: 13px; color: var(--muted); font-weight: normal; margin-left: 8px; }
      .bk-hint { font-size: 12px; color: var(--muted); background: #f9fbf9; border: 1px dashed var(--line); border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; line-height: 1.6; }
      .bk-candidates { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
      .bk-ledger { display: grid; gap: 10px; }
      .bk-card, .bk-ledger-item { border: 1px solid var(--line); border-radius: 8px; padding: 11px; background: #fbfdfb; }
      .bk-card.bk-locked { border-left: 4px solid var(--violet); background: #f6f4fb; }
      .bk-card-title { font-size: 14px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
      .bk-sub { font-size: 12px; color: var(--muted); line-height: 1.7; }
      .bk-state { font-size: 12px; font-weight: 600; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
      .bk-state.bk-held { background: #f7eedb; color: var(--amber); }
      .bk-state.bk-paid { background: #e3f0e4; color: #2c6b33; }
      .bk-state.bk-open { background: #e7f1ef; color: var(--teal); }
      .bk-state.bk-rel { background: #ececec; color: #5d6764; }
      .bk-state.bk-inv { background: #f6e3e3; color: var(--red); }
      .bk-probs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
      .bk-probs span { font-size: 12px; background: #f6e3e3; color: var(--red); border-radius: 4px; padding: 2px 8px; }
      .bk-lockform { margin-top: 8px; display: grid; gap: 8px; }
      .bk-frow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .bk-lockform label { font-size: 12px; }
      .bk-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
      .bk-actions button { flex: 1; min-width: 96px; }
      .bk-primary { background: var(--teal); color: #fff; border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; }
      .bk-warn { background: var(--amber); color: #fff; border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; }
      .bk-ghost { background: transparent; color: var(--red); border: 1px solid var(--red); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
      .bk-tick { color: var(--teal); margin-left: 6px; }
      .bk-over { color: var(--red); margin-left: 6px; }
      .bk-empty { color: var(--muted); font-size: 13px; padding: 10px 0; }
      .bk-badge { font-size: 12px; margin-top: 6px; border-radius: 4px; padding: 3px 8px; display: inline-block; }
      .bk-badge.bk-held { background: #f7eedb; color: var(--amber); }
      .bk-badge.bk-paid { background: #e3f0e4; color: #2c6b33; }
      @media (max-width: 980px) { .bk-frow { grid-template-columns: 1fr; } }
    `;
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
    const mount = document.createElement("section");
    mount.id = MOUNT_ID;
    document.querySelector("main").appendChild(mount);

    mount.addEventListener("submit", onSubmit);
    mount.addEventListener("click", onClick);

    window.addEventListener("bookings:changed", renderBookingDesk);
    window.addEventListener("work:created", renderBookingDesk);
    window.addEventListener("work:defect-recorded", e => {
      const result = L.applyWorkMutationFor(e.detail.id, "defect", "补记作品缺陷");
      afterMutation(result);
      renderBookingDesk();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) periodicSweep();
    });
    setInterval(periodicSweep, 20000);

    // 启动即清理一次逾时锁单
    handleSweep(L.sweep());
    renderBookingDesk();
  }

  window.BookingUi = { badgeHtml, beforeStatusChange, renderBookingDesk };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
