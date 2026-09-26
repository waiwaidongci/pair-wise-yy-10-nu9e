/*
 * 预订台账：锁单记录的持久化与读写
 *
 * 与作品数据分开存储（localStorage: zfl42Bookings），不改动原有作品数据结构。
 * 所有写入前先做逾时释放；对外暴露纯数据（返回副本，避免页面直接改坏台账）。
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "zfl42Bookings";
  const R = global.BookingRules;

  function load() {
    try {
      const raw = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (_e) {
      return [];
    }
  }

  let bookings = load();

  function persist() {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(bookings));
  }

  function clone(booking) {
    return booking ? JSON.parse(JSON.stringify(booking)) : null;
  }

  // 每次操作前统一释放逾时锁单，返回本次释放的副本（页面可据此提示）
  function sweep(now) {
    const expired = R.sweepExpired(bookings, now);
    if (expired.length) persist();
    return expired.map(clone);
  }

  function getWorks() {
    const ws = global.Workshop && global.Workshop.getWorks();
    return ws || [];
  }

  // 尝试锁单；冲突时返回原客户信息
  function lock(workId, input, now) {
    const ts = now == null ? Date.now() : now;
    sweep(ts);
    const work = getWorks().find(w => w.id === workId);
    if (!work) return { ok: false, code: "WORK_NOT_FOUND" };

    const check = R.lockability(work, bookings, ts);
    if (!check.lockable) {
      if (check.conflict) {
        return {
          ok: false,
          code: "CONFLICT",
          customer: check.conflict.customer,
          existing: clone(check.conflict),
          problems: check.problemText
        };
      }
      return { ok: false, code: "NOT_LOCKABLE", problems: check.problemText };
    }

    let booking;
    try {
      booking = R.createBooking(work, input, ts);
    } catch (e) {
      if (e.code === "BAD_INPUT") return { ok: false, code: "BAD_INPUT", errors: e.errors };
      throw e;
    }
    bookings.unshift(booking);
    persist();
    global.Workshop.appendWorkLog(workId, `预订锁单：客户「${booking.customer}」，截止 ${new Date(booking.deadline).toLocaleString()}`);
    return { ok: true, booking: clone(booking) };
  }

  function withBooking(id, fn) {
    const booking = bookings.find(b => b.id === id);
    if (!booking) return { ok: false, code: "NOT_FOUND" };
    return fn(booking);
  }

  // 登记收到定金
  function receiveDeposit(id, now) {
    const ts = now == null ? Date.now() : now;
    const expired = sweep(ts);
    const result = withBooking(id, b => R.confirmDeposit(b, ts));
    if (!result.ok) {
      result.expiredReleases = expired;
      return result;
    }
    persist();
    global.Workshop.appendWorkLog(result.booking.workId, `收到定金 ¥${result.booking.deposit}，订单确认`);
    global.dispatchEvent(new Event("bookings:changed"));
    result.booking = clone(result.booking);
    result.expiredReleases = expired;
    return result;
  }

  // 主动退订释放（仅待收定金期间）
  function cancel(id, detail, now) {
    const ts = now == null ? Date.now() : now;
    const expired = sweep(ts);
    const result = withBooking(id, b => R.release(b, ts, detail));
    if (result.ok) {
      persist();
      global.Workshop.appendWorkLog(result.booking.workId, "预订锁单已主动释放" + (detail ? `：${detail}` : ""));
      global.dispatchEvent(new Event("bookings:changed"));
      result.booking = clone(result.booking);
    }
    result.expiredReleases = expired;
    return result;
  }

  // 登记改稿（含「回到待交付」的状态落位与流转记录）
  function registerRework(id, detail, now) {
    const ts = now == null ? Date.now() : now;
    const result = withBooking(id, b => {
      const wasDeposited = b.status === R.DEPOSITED;
      const out = R.applyWorkMutation(b, ts, "rework", detail);
      if (!out) return { ok: false, code: "NOT_ACTIVE" };
      global.Workshop.appendWorkLog(
        b.workId,
        (wasDeposited ? "已收定金后改稿，订单失效，作品回到待交付" : "锁单期内改稿，释放锁单") +
          (detail ? `：${detail}` : "")
      );
      if (wasDeposited) global.Workshop.setDeliveryStatus(b.workId);
      return { ok: true, ...out };
    });
    if (result.ok) {
      persist();
      global.dispatchEvent(new Event("bookings:changed"));
      result.booking = clone(result.booking);
    }
    return result;
  }

  // 作品被补记缺陷 / 状态被改动时由页面调用，决定释放还是失效
  function applyWorkMutationFor(workId, kind, detail, now) {
    const ts = now == null ? Date.now() : now;
    const booking = R.findActive(bookings, workId, ts);
    if (!booking) return { ok: true, changed: false };
    const out = R.applyWorkMutation(booking, ts, kind, detail);
    if (!out) return { ok: true, changed: false };
    persist();
    if (out.outcome === "invalidated") {
      global.Workshop.setDeliveryStatus(workId);
      global.Workshop.appendWorkLog(workId, "已收定金后" + (kind === "defect" ? "补记缺陷" : "改稿") + "，订单失效，作品回到待交付" + (detail ? `：${detail}` : ""));
    } else {
      global.Workshop.appendWorkLog(workId, (kind === "defect" ? "锁单期内补记缺陷" : "锁单期内改稿") + "，释放锁单" + (detail ? `：${detail}` : ""));
    }
    global.dispatchEvent(new Event("bookings:changed"));
    return { ok: true, changed: true, outcome: out.outcome, booking: clone(out.booking) };
  }

  function activeFor(workId, now) {
    const ts = now == null ? Date.now() : now;
    sweep(ts);
    return clone(R.findActive(bookings, workId, ts));
  }

  function allRecent() {
    sweep();
    return JSON.parse(JSON.stringify(bookings)).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  }

  global.BookingLedger = {
    lock,
    receiveDeposit,
    cancel,
    registerRework,
    applyWorkMutationFor,
    activeFor,
    allRecent,
    sweep
  };
})(typeof window !== "undefined" ? window : globalThis);
