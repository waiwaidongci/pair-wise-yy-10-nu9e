/*
 * 锁单页面操作：可锁单列表、预订台账、锁单弹窗、看板锁单标记，
 * 以及与原有「改状态 / 记缺陷 / 看详情」操作的联动。
 *
 * 不改动作品数据的存储与导出；作品仍由 index.html 内原逻辑管理。
 */
(function (global) {
  "use strict";

  const R = global.LockRules;
  const Ledger = global.BookingLedger;

  const STATE_LABEL = {};
  STATE_LABEL[R.STATE.PENDING] = "badge pending";
  STATE_LABEL[R.STATE.LOCKED] = "badge locked";
  STATE_LABEL[R.STATE.RELEASED] = "badge released";
  STATE_LABEL[R.STATE.VOID] = "badge void";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getWork(id) {
    return (global.works || []).find(w => w.id === id) || null;
  }

  function workLabel(w) {
    return w ? `${w.theme} · ${w.base}` : "作品已不存在";
  }

  function localInputValue(date) {
    const p = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
      + `T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function remainingText(booking, nowMs) {
    const diff = new Date(booking.deadline).getTime() - nowMs;
    if (diff <= 0) return "已到截止时刻";
    const mins = Math.floor(diff / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    if (days > 0) return `剩 ${days} 天 ${hours} 小时`;
    if (hours > 0) return `剩 ${hours} 小时 ${mins % 60} 分`;
    return `剩 ${mins} 分钟`;
  }

  function activeBox(b, nowMs) {
    const w = getWork(b.workId);
    const head = b.status === R.STATE.PENDING
      ? `<span class="${STATE_LABEL[b.status]}">待定金</span> <b>${esc(b.customer)}</b>`
      : `<span class="${STATE_LABEL[b.status]}">已锁定</span> <b>${esc(b.customer)}</b>`;
    const detail = b.status === R.STATE.PENDING
      ? `定金 ${b.deposit} 元 · ${esc(remainingText(b, nowMs))}<br><span class="meta">截止 ${R.formatTime(b.deadline)}</span>`
      : `已收定金 ${b.deposit} 元<br><span class="meta">收讫 ${R.formatTime(b.paidAt)}</span>`;
    return `<div class="lock-box ${b.status === R.STATE.PENDING ? "pending" : "locked"}">
      ${head}
      <div class="meta">${esc(workLabel(w))}</div>
      <div>${detail}</div>
      <div class="actions">
        ${b.status === R.STATE.PENDING
          ? `<button data-lock-action="paid" data-work-id="${b.workId}">收到定金</button>`
          : ""}
        <button class="warn" data-lock-action="revise" data-work-id="${b.workId}">改稿失效</button>
      </div>
    </div>`;
  }

  /* 看板卡片上的锁单槽位与「待交付」列计数 */
  function decorateBoard(nowMs) {
    const board = document.querySelector("#board");
    if (!board) return;
    let lockedCount = 0;
    let openCount = 0;

    board.querySelectorAll("[data-slot]").forEach(slot => {
      const w = getWork(slot.dataset.slot);
      if (!w) return;
      const active = Ledger.activeFor(w.id, nowMs);
      if (active) {
        slot.innerHTML = activeBox(active, nowMs);
        lockedCount += 1;
      } else if (R.isLockable(w)) {
        openCount += 1;
        slot.innerHTML = `<div class="lock-box open">
          <span class="badge open">可锁单</span>
          <div class="actions"><button data-lock-action="lock" data-work-id="${w.id}">锁单</button></div>
        </div>`;
      } else {
        slot.innerHTML = "";
      }
    });

    board.querySelectorAll(".col").forEach(col => {
      const name = col.querySelector("h3 span");
      if (name && name.textContent === R.LOCKABLE_STATUS) {
        const count = col.querySelector("h3 span:last-child");
        if (count) count.textContent = `${count.textContent.split(" ")[0]} · 🔒${lockedCount} · 可${openCount}`;
      }
    });
  }

  function renderLockable(nowMs) {
    const box = document.querySelector("#lockableList");
    if (!box) return;
    const list = (global.works || [])
      .filter(w => R.isLockable(w) && !Ledger.activeFor(w.id, nowMs))
      .sort((a, b) => a.delivery.localeCompare(b.delivery));
    box.innerHTML = list.length ? list.map(w => `<div class="item">
      <b>${esc(w.theme)}</b>
      <div class="meta">${esc(w.base)} · 进度 ${w.progress}% · 交付 ${w.delivery}</div>
      <div class="actions"><button data-lock-action="lock" data-work-id="${w.id}">锁单</button></div>
    </div>`).join("") : `<div class="empty">暂无满足条件的作品</div>`;
  }

  function bookingRow(b, nowMs) {
    const w = getWork(b.workId);
    const state = b.status === R.STATE.PENDING
      ? `${remainingText(b, nowMs)} · 截止 ${R.formatTime(b.deadline)}`
      : `<span class="meta">收讫 ${R.formatTime(b.paidAt)}</span>`;
    return `<div class="item">
      <b>${esc(workLabel(w))}</b>
      <div class="meta">客户：${esc(b.customer)} · 定金 ${b.deposit} 元</div>
      <div><span class="${STATE_LABEL[b.status]}">${b.status}</span> ${state}</div>
      <div class="actions">
        <button class="secondary" data-lock-action="view" data-work-id="${b.workId}">查看作品</button>
        ${b.status === R.STATE.PENDING
          ? `<button data-lock-action="paid" data-work-id="${b.workId}">收到定金</button>` : ""}
        <button class="warn" data-lock-action="revise" data-work-id="${b.workId}">改稿失效</button>
      </div>
    </div>`;
  }

  function endedRow(b) {
    const w = getWork(b.workId);
    return `<div class="item ${b.status === R.STATE.VOID ? "overdue" : ""}">
      <b>${esc(workLabel(w))}</b>
      <div class="meta">客户：${esc(b.customer)} · 定金 ${b.deposit} 元</div>
      <div><span class="${STATE_LABEL[b.status]}">${b.status}</span>
        ${esc(b.endReason || "")} · ${R.formatTime(b.endedAt)}</div>
    </div>`;
  }

  function renderLedger(nowMs) {
    const pending = document.querySelector("#pendingBookings");
    const locked = document.querySelector("#lockedBookings");
    const ended = document.querySelector("#endedBookings");
    if (!pending || !locked || !ended) return;

    pending.innerHTML = (() => {
      const list = Ledger.byStatus(R.STATE.PENDING, nowMs)
        .sort((a, b) => a.deadline.localeCompare(b.deadline));
      return list.length ? list.map(b => bookingRow(b, nowMs)).join("")
        : `<div class="empty">暂无待定金锁单</div>`;
    })();
    locked.innerHTML = (() => {
      const list = Ledger.byStatus(R.STATE.LOCKED, nowMs)
        .sort((a, b) => (b.paidAt || "").localeCompare(a.paidAt || ""));
      return list.length ? list.map(b => bookingRow(b, nowMs)).join("")
        : `<div class="empty">暂无已锁定订单</div>`;
    })();
    ended.innerHTML = (() => {
      const list = Ledger.getAll(nowMs)
        .filter(b => b.status === R.STATE.RELEASED || b.status === R.STATE.VOID)
        .sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
      return list.length ? list.slice(0, 8).map(endedRow).join("")
        : `<div class="empty">暂无释放或失效记录</div>`;
    })();
  }

  /* 作品详情弹窗中的锁单信息 */
  function renderDetailLock(nowMs) {
    const dialog = document.querySelector("#detailDialog");
    if (!dialog || !dialog.open || !global.activeId) return;
    const content = document.querySelector("#detailContent");
    if (!content) return;
    const active = Ledger.activeFor(global.activeId, nowMs);
    const latest = Ledger.latestFor(global.activeId);
    let html = "";
    if (active) {
      html = `<div class="lock-detail ${active.status === R.STATE.PENDING ? "pending" : "locked"}">
        ${active.status === R.STATE.PENDING ? "⏳ 锁单待定金" : "🔒 已锁定（已收定金）"}：客户 <b>${esc(active.customer)}</b>，
        定金 ${active.deposit} 元，截止 ${R.formatTime(active.deadline)}
        ${active.status === R.STATE.PENDING ? `（${esc(remainingText(active, nowMs))}）` : `，收讫 ${R.formatTime(active.paidAt)}`}
      </div>`;
    } else if (latest) {
      html = `<div class="lock-detail ended">最近锁单：客户 <b>${esc(latest.customer)}</b>，${latest.status}${latest.endReason ? "，" + esc(latest.endReason) : ""}</div>`;
    } else {
      html = `<div class="lock-detail">该作品暂无锁单记录</div>`;
    }
    const old = content.querySelector("#detailLockBox");
    const box = document.createElement("div");
    box.id = "detailLockBox";
    box.innerHTML = html;
    if (old) old.replaceWith(box.firstElementChild);
    else content.appendChild(box.firstElementChild);
  }

  function refreshLockUI() {
    const nowMs = Date.now();
    const changed = Ledger.syncExpired(nowMs);
    decorateBoard(nowMs);
    renderLockable(nowMs);
    renderLedger(nowMs);
    renderDetailLock(nowMs);
    return changed;
  }

  /* ---------- 锁单弹窗 ---------- */

  function openLockDialog(workId) {
    const w = getWork(workId);
    const dialog = document.querySelector("#lockDialog");
    const conflict = document.querySelector("#lockConflict");
    if (!w || !dialog) return;

    if (!R.isLockable(w)) {
      alert("只有进度已满、无缺陷且待交付的作品才能锁单。");
      return;
    }
    const active = Ledger.activeFor(workId);
    if (active) {
      alert(`不能再接第二单：该作品已锁定给${R.describe(active)}（状态：${active.status}）。`);
      return;
    }

    dialog.dataset.workId = workId;
    document.querySelector("#lockDialogTitle").textContent = `锁单 · ${w.theme}（${w.base}）`;
    conflict.hidden = true;
    conflict.textContent = "";
    document.querySelector("#lockCustomer").value = "";
    document.querySelector("#lockDeposit").value = "";
    const deadline = new Date(Date.now() + 3 * 86400000);
    document.querySelector("#lockDeadline").value = localInputValue(deadline);
    dialog.showModal();
  }

  function submitLock() {
    const dialog = document.querySelector("#lockDialog");
    const conflict = document.querySelector("#lockConflict");
    const workId = dialog.dataset.workId;
    const draft = {
      customer: document.querySelector("#lockCustomer").value,
      deposit: document.querySelector("#lockDeposit").value,
      deadline: document.querySelector("#lockDeadline").value
    };
    const result = Ledger.placeLock(getWork(workId), draft);
    if (!result.ok) {
      conflict.textContent = (result.conflict ? "接单冲突：" : "无法锁单：") + result.reason;
      conflict.hidden = false;
      return;
    }
    dialog.close();
    refreshLockUI();
    global.render && global.render();
  }

  function markPaid(workId) {
    const active = Ledger.activeFor(workId);
    if (!active) { alert("该作品当前没有有效锁单。"); return; }
    const r = Ledger.markPaid(active.id);
    if (!r.ok) { alert(r.reason); return; }
    refreshLockUI();
    global.render && global.render();
  }

  function revise(workId) {
    const active = Ledger.activeFor(workId);
    if (!active) { alert("该作品当前没有有效锁单，无需失效。"); return; }
    const reason = prompt("客户改稿或退回原因（锁单将失效，作品回到待交付）：", "客户改稿");
    if (reason === null) return;
    const r = Ledger.voidActive(workId, reason.trim() ? `客户改稿：${reason.trim()}` : "客户改稿");
    if (!r.ok) { alert(r.reason); return; }
    const w = getWork(workId);
    if (w) {
      w.logs.push(`${new Date().toLocaleString()} 客户改稿，锁单失效，作品回到待交付`);
      global.save && global.save();
    }
    refreshLockUI();
    global.render && global.render();
  }

  function onAction(event) {
    const btn = event.target.closest("[data-lock-action]");
    if (!btn) return;
    event.stopPropagation();
    const workId = btn.dataset.workId;
    switch (btn.dataset.lockAction) {
      case "lock": openLockDialog(workId); break;
      case "paid": markPaid(workId); break;
      case "revise": revise(workId); break;
      case "view": global.showDetail && global.showDetail(workId); break;
    }
  }

  /* 原操作联动：改状态前挡有效锁单；记缺陷后失效锁单 */
  function hookOriginalOps() {
    const prevUpdate = global.updateStatus;
    global.updateStatus = function (id, status) {
      const w = getWork(id);
      const active = w && Ledger.activeFor(w.id);
      if (active && status !== w.status) {
        alert(`该作品存在有效锁单（客户：${active.customer}，${active.status}），不能直接改状态。`
          + "如客户改稿，请点「改稿失效」让单子失效后再操作。");
        return;
      }
      return prevUpdate(id, status);
    };

    const prevDefect = global.recordDefect;
    global.recordDefect = function (id, text) {
      let value = String(text || "").trim();
      if (!value) value = prompt("输入断线/翘线位置") || "";
      value = value.trim();
      if (!value) return;
      const r = prevDefect(id, value);
      const voided = Ledger.voidActive(id, `补记缺陷：${value}`);
      const w = getWork(id);
      if (voided.ok && w) {
        w.logs.push(`${new Date().toLocaleString()} 补记缺陷导致锁单失效，作品回到待交付`);
        global.save && global.save();
      }
      refreshLockUI();
      global.render && global.render();
      return r;
    };

    const prevDetail = global.showDetail;
    global.showDetail = function (id) {
      const r = prevDetail(id);
      renderDetailLock(Date.now());
      return r;
    };
  }

  function mount() {
    if (mount.done) return;
    mount.done = true;
    hookOriginalOps();

    /* 捕获阶段委托：看板槽位自身会 stopPropagation，冒泡到不了 document */
    document.addEventListener("click", onAction, true);
    document.querySelector("#lockCancel").addEventListener("click", () => {
      document.querySelector("#lockDialog").close();
    });
    document.querySelector("#lockForm").addEventListener("submit", event => {
      event.preventDefault();
      submitLock();
    });

    setInterval(() => {
      const changed = refreshLockUI();
      if (changed) global.render && global.render();
    }, 15000);

    refreshLockUI();
  }

  global.BookingPage = { mount, refreshLockUI, openLockDialog };
})(window);
