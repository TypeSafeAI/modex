import test from "node:test";
import assert from "node:assert/strict";
import { taskFromText } from "../src/shared/routine-text.js";

// Wednesday 11 November 2026, 10:00 local.
const now = new Date(2026, 10, 11, 10, 0, 0);
const local = (iso: string) => { const d = new Date(iso); return [d.getDay(), d.getDate(), d.getHours(), d.getMinutes()]; };

test("a weekly message becomes a seven-day task named after what it asks", () => {
  const task = taskFromText("Every week, review TypeSafe Place v0.3.0 release work in the repo. Track budgets.", now);
  assert.equal(task.name, "Review TypeSafe Place v0.3.0 release work in");
  assert.equal(task.assumed, false);
  assert.ok(task.trigger.kind === "interval" && task.trigger.every === 7 && task.trigger.unit === "days");
  assert.deepEqual(local(task.trigger.from), [4, 12, 8, 0], "the next 8 AM");
});

test("weekdays and clock times set the first run", () => {
  const friday = taskFromText("Send me weekend ideas every Friday at 7:30 pm", now).trigger;
  assert.ok(friday.kind === "interval" && friday.every === 7);
  assert.deepEqual(local(friday.from), [5, 13, 19, 30]);
  const daily = taskFromText("Check prices daily at 9 AM and alert me", now).trigger;
  assert.ok(daily.kind === "interval" && daily.every === 1 && daily.unit === "days");
  assert.deepEqual(local(daily.from), [4, 12, 9, 0], "9 AM today has passed");
  const hours = taskFromText("every 2 hours look at CI", now).trigger;
  assert.ok(hours.kind === "interval" && hours.every === 2 && hours.unit === "hours");
  const minutes = taskFromText("every minute, poll", now).trigger;
  assert.ok(minutes.kind === "interval" && minutes.every === 5 && minutes.unit === "minutes", "never more often than five minutes");
  const once = taskFromText("Tomorrow at 3pm, summarize the open pull requests", now).trigger;
  assert.ok(once.kind === "once");
  assert.deepEqual(local(once.at), [3, 11, 15, 0], "the next 3 PM is today");
});

test("a message with no schedule is daily at 8 AM and says it assumed so", () => {
  const task = taskFromText("Monitor the iOS scrolling regression and notify me when checks change.", now);
  assert.equal(task.assumed, true);
  assert.ok(task.trigger.kind === "interval" && task.trigger.every === 1 && task.trigger.unit === "days");
  assert.deepEqual(local(task.trigger.from), [4, 12, 8, 0]);
  assert.equal(task.name, "Monitor the iOS scrolling regression and notify");
  assert.equal(taskFromText("   ", now).name, "Scheduled task");
});
