/*
 * 锁单规则（纯业务规则，不接触 DOM 与 localStorage）
 *
 * 可锁单条件：进度已满（100%）、无缺陷、状态为「待交付」。
 * 锁单生命周期：
 *   待定金 ──收到定金──▶ 已锁定
 *   待定金 ──逾期未付──▶ 已释放（作品可重新接单）
 *   待定金/已锁定 ──改稿或补记缺陷──▶ 已失效（作品回到待交付）
 * 锁单有效（待定金未到期 或 已收定金）时，同一作品不能再接第二单。
 */
(function (global) {
  "use strict";

  const STATE = {
    PENDING: "待定金",
    LOCKED: "已锁定",
    RELEASED: "已释放",
    VOID: "已失效"
  };

  const LOCKABLE_STATUS = "待交付";

  function formatTime(value) {
    return new Date(value).toLocaleString();
  }

  /* 作品是否满足锁单条件：进度已满、无缺陷、待交付 */
  function isLockable(work) {
    return Boolean(work)
      && work.status === LOCKABLE_STATUS
      && Number(work.progress) >= 100
      && !String(work.defect || "").trim();
  }

  function deadlineMs(booking) {
    return new Date(booking.deadline).getTime();
  }

  /* 待定金锁单是否已到截止时刻仍未收定金 */
  function isDue(booking, nowMs) {
    return booking.status === STATE.PENDING && deadlineMs(booking) <= nowMs;
  }

  /* 锁单是否仍有效：已收定金长期有效；待定金在截止时刻前有效 */
  function isActive(booking, nowMs) {
    if (!booking) return false;
    const at = typeof nowMs === "number" ? nowMs : Date.now();
    if (booking.status === STATE.LOCKED) return true;
    if (booking.status === STATE.PENDING) return deadlineMs(booking) > at;
    return false;
  }

  function describe(booking) {
    return `客户「${booking.customer}」，定金 ${booking.deposit} 元，`
      + `定金截止 ${formatTime(booking.deadline)}`;
  }

  function validateDraft(draft) {
    const errors = [];
    const customer = String((draft && draft.customer) || "").trim();
    const deposit = Number(draft && draft.deposit);
    const rawDeadline = draft && draft.deadline;
    const at = rawDeadline ? new Date(rawDeadline).getTime() : NaN;

    if (!customer) errors.push("客户姓名必填");
    if (!Number.isFinite(deposit) || deposit <= 0) errors.push("定金必须是大于 0 的金额");
    if (!Number.isFinite(at)) errors.push("定金截止时刻无效");
    else if (at <= Date.now()) errors.push("定金截止时刻必须晚于当前时间");

    return { errors, customer, deposit, at };
  }

  /*
   * 尝试锁单。
   * 成功返回 { ok:true, booking }；
   * 重复接单返回 { ok:false, conflict:true, reason }，reason 中指出原客户。
   */
  function createLock(work, activeBooking, draft, now) {
    const time = now || new Date();

    if (!isLockable(work)) {
      return { ok: false, reason: "只有进度已满、无缺陷且待交付的作品才能锁单" };
    }
    if (activeBooking) {
      return {
        ok: false,
        conflict: true,
        reason: `不能再接第二单：该作品已锁定给${describe(activeBooking)}`
          + `（当前锁单状态：${activeBooking.status}）`
      };
    }

    const v = validateDraft(draft);
    if (v.errors.length) return { ok: false, reason: v.errors.join("；") };

    const deadlineIso = new Date(v.at).toISOString();
    const booking = {
      id: crypto.randomUUID(),
      workId: work.id,
      customer: v.customer,
      deposit: v.deposit,
      deadline: deadlineIso,
      status: STATE.PENDING,
      createdAt: time.toISOString(),
      paidAt: null,
      endedAt: null,
      endReason: "",
      logs: [
        `${time.toLocaleString()} 锁单：客户「${v.customer}」，定金 ${v.deposit} 元，`
          + `定金截止 ${formatTime(deadlineIso)}`
      ]
    };
    return { ok: true, booking };
  }

  /* 待定金 → 已锁定 */
  function confirmDeposit(booking, now) {
    const time = now || new Date();
    if (booking.status !== STATE.PENDING) {
      return { ok: false, reason: "只有待定金的锁单可以确认收到定金" };
    }
    if (isDue(booking, time.getTime())) {
      return { ok: false, reason: "已过定金截止时刻，锁单应先释放" };
    }
    return {
      ok: true,
      patch: { status: STATE.LOCKED, paidAt: time.toISOString() },
      log: `${time.toLocaleString()} 收到定金 ${booking.deposit} 元，锁单确认`
    };
  }

  /* 待定金到期未付 → 已释放（幂等：未到期返回 ok:false） */
  function releaseIfDue(booking, now) {
    const time = now || new Date();
    if (!isDue(booking, time.getTime())) return { ok: false };
    return {
      ok: true,
      patch: {
        status: STATE.RELEASED,
        endedAt: time.toISOString(),
        endReason: "到点未收到定金，自动释放"
      },
      log: `${time.toLocaleString()} 到点未收到定金，锁单释放，作品可重新接单`
    };
  }

  /* 有效锁单 → 已失效（客户改稿 / 补记缺陷），作品回到待交付 */
  function voidLock(booking, reason, now) {
    const time = now || new Date();
    if (!isActive(booking, time.getTime())) {
      return { ok: false, reason: "锁单已不在有效期，无需失效" };
    }
    const text = reason ? `锁单失效：${reason}` : "锁单失效";
    return {
      ok: true,
      patch: {
        status: STATE.VOID,
        endedAt: time.toISOString(),
        endReason: text
      },
      log: `${time.toLocaleString()} ${text}，作品回到待交付`
    };
  }

  global.LockRules = {
    STATE,
    LOCKABLE_STATUS,
    isLockable,
    isDue,
    isActive,
    describe,
    validateDraft,
    createLock,
    confirmDeposit,
    releaseIfDue,
    voidLock,
    formatTime
  };
})(window);
