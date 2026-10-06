import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistentDeliveryLedger } from "../mod-delivery-ledger.js";

test("Mod ledger is idempotent and marks unfinished submitted turns uncertain after restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  const first = new PersistentDeliveryLedger(path);
  assert.equal(first.begin("same-id", "one").kind, "new");
  assert.equal(first.begin("same-id", "one").kind, "duplicate");
  assert.equal(first.begin("same-id", "different").kind, "conflict");
  first.transition("same-id", "submitted", "turn started", "turn-id");

  const restarted = new PersistentDeliveryLedger(path);
  assert.equal(restarted.get("same-id")?.state, "indeterminate");
  assert.match(restarted.get("same-id")?.detail || "", /automatic resend is unsafe/);
});
