/*
 * fsrs.js — a faithful browser port of FSRS-4.5, byte-for-byte aligned with the
 * project's Python `fsrs` package (backend/.venv-win/.../fsrs/fsrs.py + models.py)
 * and its default parameter vector. Verified against the Python reference by
 * scripts/test_english_vocab_fsrs.mjs.
 *
 * This is the local memory-curve engine for the read-only study page. It owns
 * day-to-day scheduling in the browser (localStorage); the KaoYan project only
 * supplies the word list + an initial seed. No data leaves the device.
 *
 * Card shape (epoch-ms timestamps):
 *   { due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses,
 *     state, last_review }
 * state: 0 New | 1 Learning | 2 Review | 3 Relearning
 * rating: 1 Again | 2 Hard | 3 Good | 4 Easy
 */
(function (global) {
  "use strict";

  var W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14,
           0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
  var DECAY = -0.5;
  var FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 0.23456790123456783
  var REQUEST_RETENTION = 0.9;
  var MAX_INTERVAL = 36500;
  var DAY = 86400000;
  var MIN = 60000;

  var State = { New: 0, Learning: 1, Review: 2, Relearning: 3 };
  var Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
  var STATE_LABEL = ["新词", "学习中", "复习", "重学"];

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function clone(c) { return {
    due: c.due, stability: c.stability, difficulty: c.difficulty,
    elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days,
    reps: c.reps, lapses: c.lapses, state: c.state, last_review: c.last_review,
  }; }

  function newCard(now) {
    return { due: now, stability: 0, difficulty: 0, elapsed_days: 0,
      scheduled_days: 0, reps: 0, lapses: 0, state: State.New, last_review: null };
  }

  function initStability(r) { return Math.max(W[r - 1], 0.1); }
  function initDifficulty(r) { return clamp(W[4] - W[5] * (r - 3), 1, 10); }
  function forgettingCurve(elapsedDays, stability) {
    return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
  }
  function nextInterval(s) {
    var v = s / FACTOR * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
    return clamp(Math.round(v), 1, MAX_INTERVAL);
  }
  function nextDifficulty(d, r) {
    var nd = d - W[6] * (r - 3);
    return clamp(W[7] * W[4] + (1 - W[7]) * nd, 1, 10); // mean_reversion(init=W4, current=nd)
  }
  function nextRecallStability(d, s, retrievability, rating) {
    var hardPenalty = rating === Rating.Hard ? W[15] : 1;
    var easyBonus = rating === Rating.Easy ? W[16] : 1;
    return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
      (Math.exp((1 - retrievability) * W[10]) - 1) * hardPenalty * easyBonus);
  }
  function nextForgetStability(d, s, retrievability) {
    return W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) *
      Math.exp((1 - retrievability) * W[14]);
  }

  function updateState(s, state) {
    if (state === State.New) {
      s.again.state = State.Learning; s.hard.state = State.Learning;
      s.good.state = State.Learning; s.easy.state = State.Review;
    } else if (state === State.Learning || state === State.Relearning) {
      s.again.state = state; s.hard.state = state;
      s.good.state = State.Review; s.easy.state = State.Review;
    } else if (state === State.Review) {
      s.again.state = State.Relearning; s.hard.state = State.Review;
      s.good.state = State.Review; s.easy.state = State.Review;
      s.again.lapses += 1;
    }
  }

  function schedule(s, now, hardInterval, goodInterval, easyInterval) {
    s.again.scheduled_days = 0; s.hard.scheduled_days = hardInterval;
    s.good.scheduled_days = goodInterval; s.easy.scheduled_days = easyInterval;
    s.again.due = now + 5 * MIN;
    s.hard.due = hardInterval > 0 ? now + hardInterval * DAY : now + 10 * MIN;
    s.good.due = now + goodInterval * DAY;
    s.easy.due = now + easyInterval * DAY;
  }

  function initDs(s) {
    s.again.difficulty = initDifficulty(Rating.Again); s.again.stability = initStability(Rating.Again);
    s.hard.difficulty = initDifficulty(Rating.Hard); s.hard.stability = initStability(Rating.Hard);
    s.good.difficulty = initDifficulty(Rating.Good); s.good.stability = initStability(Rating.Good);
    s.easy.difficulty = initDifficulty(Rating.Easy); s.easy.stability = initStability(Rating.Easy);
  }

  function nextDs(s, lastD, lastS, retrievability) {
    s.again.difficulty = nextDifficulty(lastD, Rating.Again);
    s.again.stability = nextForgetStability(lastD, lastS, retrievability);
    s.hard.difficulty = nextDifficulty(lastD, Rating.Hard);
    s.hard.stability = nextRecallStability(lastD, lastS, retrievability, Rating.Hard);
    s.good.difficulty = nextDifficulty(lastD, Rating.Good);
    s.good.stability = nextRecallStability(lastD, lastS, retrievability, Rating.Good);
    s.easy.difficulty = nextDifficulty(lastD, Rating.Easy);
    s.easy.stability = nextRecallStability(lastD, lastS, retrievability, Rating.Easy);
  }

  // Returns {again, hard, good, easy} scheduling cards for the four ratings.
  function repeat(card, now) {
    var c = clone(card);
    if (c.state === State.New) { c.elapsed_days = 0; }
    else { c.elapsed_days = Math.floor((now - c.last_review) / DAY); }
    c.last_review = now;
    c.reps += 1;
    var s = { again: clone(c), hard: clone(c), good: clone(c), easy: clone(c) };
    updateState(s, c.state);

    if (c.state === State.New) {
      initDs(s);
      s.again.due = now + 1 * MIN;
      s.hard.due = now + 5 * MIN;
      s.good.due = now + 10 * MIN;
      var easyInterval = nextInterval(s.easy.stability);
      s.easy.scheduled_days = easyInterval;
      s.easy.due = now + easyInterval * DAY;
    } else if (c.state === State.Learning || c.state === State.Relearning) {
      var goodI = nextInterval(s.good.stability);
      var easyI = Math.max(nextInterval(s.easy.stability), goodI + 1);
      schedule(s, now, 0, goodI, easyI);
    } else if (c.state === State.Review) {
      var retrievability = forgettingCurve(c.elapsed_days, c.stability);
      nextDs(s, c.difficulty, c.stability, retrievability);
      var hI = nextInterval(s.hard.stability);
      var gI = nextInterval(s.good.stability);
      hI = Math.min(hI, gI);
      gI = Math.max(gI, hI + 1);
      var eI = Math.max(nextInterval(s.easy.stability), gI + 1);
      schedule(s, now, hI, gI, eI);
    }
    return s;
  }

  // Convenience: apply one rating, return the next card.
  function reviewCard(card, rating, now) { return grade(card, rating, now); }

  // The four scheduling cards ARE the cards in this port. `rating` is 1..4.
  var RATING_KEY = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
  function grade(card, rating, now) { return repeat(card, now)[RATING_KEY[rating]]; }

  function retrievabilityOf(card, now) {
    if (card.state === State.Review) {
      var elapsed = Math.max(0, Math.floor((now - card.last_review) / DAY));
      return forgettingCurve(elapsed, card.stability);
    }
    return null;
  }

  // Normalize a project seed (ISO due) into an epoch-ms card.
  function fromSeed(seed, now) {
    if (!seed || seed.state === "New") return newCard(now);
    var due = seed.due ? Date.parse(seed.due) : now;
    return {
      due: isNaN(due) ? now : due,
      stability: Number(seed.stability) || 0,
      difficulty: Number(seed.difficulty) || 0,
      elapsed_days: 0,
      scheduled_days: Number(seed.scheduled_days) || 0,
      reps: Number(seed.reps) || 0,
      lapses: Number(seed.lapses) || 0,
      state: seed.state === "Learning" ? State.Learning :
             seed.state === "Review" ? State.Review :
             seed.state === "Relearning" ? State.Relearning : State.New,
      last_review: seed.last_review ? Date.parse(seed.last_review) : (seed.due ? due : null),
    };
  }

  global.FsrsLib = {
    W: W, DECAY: DECAY, FACTOR: FACTOR, REQUEST_RETENTION: REQUEST_RETENTION,
    State: State, Rating: Rating, STATE_LABEL: STATE_LABEL, DAY: DAY,
    newCard: newCard, repeat: repeat, grade: grade, reviewCard: reviewCard,
    nextInterval: nextInterval, forgettingCurve: forgettingCurve,
    retrievabilityOf: retrievabilityOf, fromSeed: fromSeed,
    initStability: initStability, initDifficulty: initDifficulty,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
