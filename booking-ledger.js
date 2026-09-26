/*
 * 预订台账：锁单记录的存储、查询与状态流转。
 *
 * 与作品数据分开存储（zfl42Bookings），不读写作品 localStorage key，
 * 旧作品数据与原有筛选、导出不受影响。
 * 读台账时先按规则处理「到点未收定金自动释放」。
 */
(function (global) {
  "use strict";

  const R = global.LockRules;
  const storageKey = "zfl42Bookings";
  let bookings = JSON.parse(localStorage.getItem(storageKey) || "null") || [];

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(bookings));
  }

  function syncExpired(nowMs) {
    const at = typeof nowMs === "number" ? nowMs : Date.now();
    let changed = false;
    bookings.forEach(b => {
      const r = R.releaseIfDue(b, new Date(at));
      if (r.ok) {
        Object.assign(b, r.patch);
        b.logs.push(r.log);
        changed = true;
      }
    });
    if (changed) persist();
    return changed;
  }

  function getAll(nowMs) {
    syncExpired(nowMs);
    return bookings;
  }

  function get(id) {
    return bookings.find(b => b.id === id) || null;
  }

  /* 指定作品当前有效的锁单（已自动处理到期释放） */
  function activeFor(workId, nowMs) {
    const at = typeof nowMs === "number" ? nowMs : Date.now();
    syncExpired(at);
    return bookings.find(b => b.workId === workId && R.isActive(b, at)) || null;
  }

  /* 指定作品最新一条锁单（无论状态，用于冲突说明与历史展示） */
  function latestFor(workId) {
    return bookings
      .filter(b => b.workId === workId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }

  function byStatus(status, nowMs) {
    return getAll(nowMs).filter(b => b.status === status);
  }

  /*
   * 登记锁单。冲突时 ok:false 并带 conflict 与原客户说明。
   */
  function placeLock(work, draft, now) {
    const time = now || new Date();
    syncExpired(time.getTime());
    const active = activeFor(work.id, time.getTime());
    const result = R.createLock(work, active, draft, time);
    if (!result.ok) return result;
    bookings.unshift(result.booking);
    persist();
    return result;
  }

  /* 确认收到定金：待定金 → 已锁定 */
  function markPaid(id, now) {
    const time = now || new Date();
    const booking = get(id);
    if (!booking) return { ok: false, reason: "锁单记录不存在" };
    syncExpired(time.getTime());
    const r = R.confirmDeposit(booking, time);
    if (!r.ok) return r;
    Object.assign(booking, r.patch);
    booking.logs.push(r.log);
    persist();
    return { ok: true, booking };
  }

  /* 改稿或补记缺陷：有效锁单 → 已失效，作品回到待交付 */
  function voidActive(workId, reason, now) {
    const time = now || new Date();
    syncExpired(time.getTime());
    const booking = activeFor(workId, time.getTime());
    if (!booking) return { ok: false, reason: "该作品当前没有有效锁单" };
    const r = R.voidLock(booking, reason, time);
    if (!r.ok) return r;
    Object.assign(booking, r.patch);
    booking.logs.push(r.log);
    persist();
    return { ok: true, booking };
  }

  global.BookingLedger = {
    storageKey,
    persist,
    syncExpired,
    getAll,
    get,
    activeFor,
    latestFor,
    byStatus,
    placeLock,
    markPaid,
    voidActive
  };
})(window);
