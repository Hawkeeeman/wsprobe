import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function runCli(args) {
  return execFileSync("node", ["./wsli.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      WSLI_NO_REFRESH: "1"
    }
  });
}

test("root help renders", () => {
  const out = runCli(["--help"]);
  assert.match(out, /Usage: wsli/i);
});

test("core command help renders", () => {
  const commands = ["buy", "sell", "transfer", "positions", "accounts", "logs", "history", "trade-smoke"];
  for (const command of commands) {
    const out = runCli([command, "--help"]);
    assert.match(out, new RegExp(`Usage: wsli ${command}`, "i"));
  }
});

test("removed commands are not exposed", () => {
  assert.throws(
    () => runCli(["preview-buy"]),
    /unknown command 'preview-buy'/i
  );
  assert.throws(
    () => runCli(["restrictions"]),
    /unknown command 'restrictions'/i
  );
});

test("account index rejects non-integer text", () => {
  assert.throws(
    () => runCli(["positions", "--account-type", "tfsa", "--account-index", "1abc"]),
    /--account-index must be a positive integer\./i
  );
});
