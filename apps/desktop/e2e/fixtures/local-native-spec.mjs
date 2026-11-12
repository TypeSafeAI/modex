// Fixed inputs for the opt-in native lifecycle qualification. Never imported by product main.
export const MODEL = "qwen3-coder:30b";
export const DIGEST = "06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca";
export const CONTEXT = 65536;
export const SENTINEL = "LM3-FIXTURE-SENTINEL-7f3a";
export const EDITED = "LM3-APPROVED-EDIT-8c42\n";
export const WRITE = "echo LM3-APPROVED-EDIT-8c42 > result.txt";
export const CHECK_COMMAND = "node check.cjs";
export const DELAY_MS = 10000;
export const GRACE_MS = 1500;
export const DELAYED_CASES = Object.freeze(["stop", "codex-loss", "server-loss"]);
export const FRESH_CASES = Object.freeze(["after-stop", "after-codex-loss", "after-server-loss"]);
export const commandFor = id => `node delayed-write.cjs ${id}`;
export const ALLOWED = Object.freeze(["cat fixture.txt", WRITE, CHECK_COMMAND, ...DELAYED_CASES.map(commandFor), ...FRESH_CASES.map(commandFor)]);
export const CHECK_SOURCE = `const fs=require('node:fs');const ok=fs.readFileSync('result.txt','utf8')===${JSON.stringify(EDITED)};fs.appendFileSync('checks.jsonl',JSON.stringify({ok,exitCode:ok?0:1})+'\\n');console.log(ok?'independent check passed':'independent check failed');process.exit(ok?0:1);\n`;
export const DELAY_SOURCE = `const fs=require('node:fs');const id=process.argv[2];const delayed=${JSON.stringify(DELAYED_CASES)}.includes(id);if(![...${JSON.stringify(DELAYED_CASES)},...${JSON.stringify(FRESH_CASES)}].includes(id))throw Error('Unknown qualification case');const startedAt=Date.now(),deadline=startedAt+(delayed?${DELAY_MS}:0);fs.appendFileSync('lifecycle-runs.jsonl',JSON.stringify({id,pid:process.pid,startedAt,deadline})+'\\n');fs.writeFileSync(id+'-started.json',JSON.stringify({id,pid:process.pid,startedAt,deadline}),{flag:'wx'});const finish=()=>{fs.appendFileSync('lifecycle-effects.jsonl',JSON.stringify({id,pid:process.pid,at:Date.now()})+'\\n');fs.writeFileSync(id+'-effect.txt',id+':one\\n',{flag:'wx'});console.log(id+' effect completed');};if(delayed)setTimeout(finish,${DELAY_MS});else finish();\n`;
export const SCENARIOS = Object.freeze({
  golden: { barrier: "approved exact edit and separately seeded check", result: EDITED, checks: 1 },
  stop: { barrier: "stop-started.json exists before deadline", dispatches: 1, effectsAfterDeadline: 0, freshAction: "after-stop", freshEffects: 1 },
  "codex-loss": { barrier: "codex-loss-started.json exists before deadline; exact owned native PID", dispatches: 1, effectsAfterDeadline: "zero or one from original command; never replayed", freshAction: "after-codex-loss", freshEffects: 1 },
  "server-loss": { barrier: "server-loss-started.json exists before deadline; exact owned inference-server PID", dispatches: 1, effectsAfterDeadline: "zero or one from original command; never replayed", freshAction: "after-server-loss", freshEffects: 1 },
});
