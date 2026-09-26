/*
 * 预订锁单规则（纯业务规则，不依赖 DOM / localStorage，可独立测试）
 *
 * 规则要点：
 * 1. 仅「待交付 + 贴线进度 100% + 无缺陷」的作品可以锁单。
 * 2. 锁单记录客户、定金、截止时刻；锁单有效（待收定金 / 已收定金）时
 *    同一作品不能再接第二单，冲突需指出原客户。
 * 3. 到截止时刻仍未收到定金，锁单自动释放，作品重新可被预订。
 * 4. 收到定金后改稿或补记缺陷，订单失效且作品回到待交付；
 *    尚未收到定金期间发生改稿 / 补记缺陷，则直接释放锁单。
 */
(function (global) {
  "use strict";

  const HELD = "held"; // 已锁单，等待定金
  const DEPOSITED = "deposited"; // 已收到定金
  const RELEASED = "released"; // 已释放（逾时未收定金 / 退订 / 锁定期内改稿或缺陷）
  const INVALID = "invalid"; // 已失效（收定金后改稿或补记缺陷）
  const ACTIVE_STATES = [HELD, DEPOSITED];

  const STATE_LABELS = {
    held: "待收定金",
    deposited: "已收定金",
    released: "已释放",
    invalid: "已失效"
  };

  const REASONS = {
    timeout: "到点未收到定金，自动释放",
    cancel: "客户退订，主动释放",
    heldDefect: "锁单期内补记缺陷",
    heldRework: "锁单期内改稿",
    paidDefect: "收到定金后补记缺陷",
    paidRework: "收到定金后改稿"
  };

  // 不可锁单原因（代码 => 中文说明）
  const LOCK_PROBLEMS = {
    NOT_DELIVERY: "作品不在「待交付」",
    PROGRESS_INCOMPLETE: "贴线进度未满（需 100%）",
    HAS_DEFECT: "作品存在缺陷，需先修复",
    CONFLICT: "已被其他客户锁单"
  };

  function uid() {
    return global.crypto && global.crypto.randomUUID
      ? global.crypto.randomUUID()
      : "bk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pushHistory(booking, ts, line) {
    booking.history = booking.history || [];
    booking.history.push({ at: new Date(ts).toISOString(), line });
  }

  function findActive(bookings, workId, now) {
    const ts = now == null ? Date.now() : now;
    let found = null;
    for (const b of bookings) {
      if (b.workId !== workId || !ACTIVE_STATES.includes(b.status)) continue;
      if (b.status === HELD && Date.parse(b.deadline) <= ts) continue; // 已逾时，视同等待 sweep 释放
      if (!found || Date.parse(b.createdAt) > Date.parse(found.createdAt)) found = b;
    }
    return found;
  }

  // 逾时未收到定金的锁单批量释放，返回本次被释放的记录
  function sweepExpired(bookings, now) {
    const ts = now == null ? Date.now() : now;
    const changed = [];
    for (const b of bookings) {
      if (b.status === HELD && Date.parse(b.deadline) <= ts) {
        b.status = RELEASED;
        b.endedAt = new Date(ts).toISOString();
        b.endReason = REASONS.timeout;
        pushHistory(b, ts, REASONS.timeout);
        changed.push(b);
      }
    }
    return changed;
  }

  // 判断作品当前能否锁单；不能时给出原因，CONFLICT 时附带原客户的锁单
  function lockability(work, bookings, now) {
    const ts = now == null ? Date.now() : now;
    const reasons = [];
    if (!work || work.status !== "待交付") reasons.push("NOT_DELIVERY");
    if (!work || Number(work.progress) !== 100) reasons.push("PROGRESS_INCOMPLETE");
    if (!work || (work.defect && String(work.defect).trim())) reasons.push("HAS_DEFECT");
    const conflict = work ? findActive(bookings, work.id, ts) : null;
    if (conflict) reasons.push("CONFLICT");
    return {
      lockable: reasons.length === 0,
      reasons,
      conflict,
      problemText: reasons.map(code => LOCK_PROBLEMS[code])
    };
  }

  // 校验锁单录入：客户、定金（大于 0）、截止时刻（必须晚于当前）
  function validateLockInput(input, now) {
    const ts = now == null ? Date.now() : now;
    const errors = {};
    if (!input || !input.customer || !String(input.customer).trim()) {
      errors.customer = "请填写客户称呼";
    }
    const deposit = Number(input && input.deposit);
    if (!Number.isFinite(deposit) || deposit <= 0) {
      errors.deposit = "定金需为大于 0 的金额";
    }
    const deadlineMs = Date.parse(input && input.deadline);
    if (!Number.isFinite(deadlineMs)) {
      errors.deadline = "请选择定金截止时刻";
    } else if (deadlineMs <= ts) {
      errors.deadline = "截止时刻必须晚于当前时间";
    }
    return { valid: Object.keys(errors).length === 0, errors, deposit, deadlineMs };
  }

  function createBooking(work, input, now) {
    const ts = now == null ? Date.now() : now;
    const v = validateLockInput(input, ts);
    if (!v.valid) {
      const err = new Error("锁单录入不合法");
      err.code = "BAD_INPUT";
      err.errors = v.errors;
      throw err;
    }
    const booking = {
      id: uid(),
      workId: work.id,
      customer: String(input.customer).trim(),
      deposit: v.deposit,
      deadline: new Date(v.deadlineMs).toISOString(),
      note: input.note ? String(input.note).trim() : "",
      status: HELD,
      createdAt: new Date(ts).toISOString(),
      depositedAt: null,
      endedAt: null,
      endReason: "",
      history: []
    };
    pushHistory(
      booking,
      ts,
      `锁单：客户「${booking.customer}」，定金 ¥${booking.deposit}，` +
        `截止 ${new Date(v.deadlineMs).toLocaleString()}`
    );
    return booking;
  }

  // 登记收到定金；已逾时的锁单需先经 sweep 释放，不能再补收
  function confirmDeposit(booking, now) {
    const ts = now == null ? Date.now() : now;
    if (booking.status !== HELD) return { ok: false, code: "NOT_HELD" };
    if (Date.parse(booking.deadline) <= ts) return { ok: false, code: "EXPIRED" };
    booking.status = DEPOSITED;
    booking.depositedAt = new Date(ts).toISOString();
    pushHistory(booking, ts, `收到客户「${booking.customer}」定金 ¥${booking.deposit}`);
    return { ok: true, booking };
  }

  function finish(booking, ts, status, reason, detail) {
    booking.status = status;
    booking.endedAt = new Date(ts).toISOString();
    booking.endReason = reason + (detail ? `（${detail}）` : "");
    pushHistory(booking, ts, booking.endReason);
  }

  // 主动释放（仅待收定金期间）
  function release(booking, now, detail) {
    const ts = now == null ? Date.now() : now;
    if (booking.status !== HELD) return { ok: false, code: "NOT_HELD" };
    finish(booking, ts, RELEASED, REASONS.cancel, detail);
    return { ok: true, booking };
  }

  // 作品发生改稿 / 补记缺陷时对锁单的影响：
  // 待收定金 => 释放；已收定金 => 失效。返回 null 表示当前无有效锁单。
  function applyWorkMutation(booking, now, kind, detail) {
    const ts = now == null ? Date.now() : now;
    if (booking.status === HELD) {
      finish(booking, ts, RELEASED, kind === "defect" ? REASONS.heldDefect : REASONS.heldRework, detail);
      return { outcome: "released", booking };
    }
    if (booking.status === DEPOSITED) {
      finish(booking, ts, INVALID, kind === "defect" ? REASONS.paidDefect : REASONS.paidRework, detail);
      return { outcome: "invalidated", booking };
    }
    return null;
  }

  global.BookingRules = {
    HELD,
    DEPOSITED,
    RELEASED,
    INVALID,
    ACTIVE_STATES,
    STATE_LABELS,
    REASONS,
    LOCK_PROBLEMS,
    findActive,
    sweepExpired,
    lockability,
    validateLockInput,
    createBooking,
    confirmDeposit,
    release,
    applyWorkMutation
  };
})(typeof window !== "undefined" ? window : globalThis);
