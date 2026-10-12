/** list must return only processes running the exact owned app executable. */
export async function stopOwnedProcesses({ list, signal, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  quietMs = 3000, forceAfterMs = 2000, timeoutMs = 15000 }) {
  const started = now();
  let quietSince;
  const seen = new Map();
  while (true) {
    const current = now();
    const pids = await list();
    if (pids.length) {
      quietSince = undefined;
      for (const pid of pids) {
        const previous = seen.get(pid);
        let name;
        if (!previous) { seen.set(pid, { at: current, forced: false }); name = "SIGTERM"; }
        else if (!previous.forced && current - previous.at >= forceAfterMs) { previous.forced = true; name = "SIGKILL"; }
        if (name) {
          try { await signal(pid, name); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
    } else {
      quietSince ??= current;
      if (current - quietSince >= quietMs) return [...seen.keys()];
    }
    if (current - started >= timeoutMs) throw new Error("Owned acceptance processes did not stop within the cleanup deadline.");
    await sleep(Math.min(100, timeoutMs - (current - started)));
  }
}
