import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('Step 0 Reverification Baseline', () => {
  const specsDir = join(process.cwd(), 'specs', '001-fork-bug-reverification');

  it('verifies research.md exists and contains Step 0 defect classifications', () => {
    const researchPath = join(specsDir, 'research.md');
    assert.ok(existsSync(researchPath), 'research.md must exist');

    const content = readFileSync(researchPath, 'utf8');
    // Verify item classifications
    assert.match(content, /2\.1.*Substring-match deletion in SQLite mirror.*Confirmed Present/i);
    assert.match(content, /2\.2.*Session-level memory snapshot staleness.*Confirmed Present/i);
    assert.match(content, /2\.3.*No semantic\/paraphrase retrieval.*Feature Gap \(Deferred\)/i);
    assert.match(content, /2\.4.*Zero subagent awareness.*Confirmed Present/i);
    assert.match(content, /2\.5.*Recovery-file accumulation on successful saves.*Confirmed Present/i);
    assert.match(content, /2\.6.*Correction\/failure logging before validation.*Confirmed Present/i);
  });

  it('verifies plan.md confirms scope boundaries and Section 3/4 deferrals', () => {
    const planPath = join(specsDir, 'plan.md');
    assert.ok(existsSync(planPath), 'plan.md must exist');

    const content = readFileSync(planPath, 'utf8');
    assert.match(content, /Defer semantic retrieval \(Item 2\.3\) as a feature gap to Section 4/i);
    assert.match(content, /Exact-match deletion\/replacement in the SQLite mirror/i);
    assert.match(content, /In-memory snapshot freshness/i);
    assert.match(content, /Ephemeral subagent isolation/i);
    assert.match(content, /Immediate unlinking of displaced recovery snapshots/i);
    assert.match(content, /Staged correction validation/i);
  });

  it('verifies all required contracts exist', () => {
    const contractsDir = join(specsDir, 'contracts');
    assert.ok(existsSync(contractsDir), 'contracts directory must exist');

    const expectedContracts = [
      'sqlite-memory-sync.md',
      'subagent-isolation.md',
      'correction-staging.md',
    ];

    for (const contract of expectedContracts) {
      const contractPath = join(contractsDir, contract);
      assert.ok(existsSync(contractPath), `Contract ${contract} must exist`);
      const content = readFileSync(contractPath, 'utf8');
      assert.ok(content.length > 50, `Contract ${contract} must not be empty`);
    }
  });

  it('verifies quickstart verification scenarios are documented', () => {
    const quickstartPath = join(specsDir, 'quickstart.md');
    assert.ok(existsSync(quickstartPath), 'quickstart.md must exist');

    const content = readFileSync(quickstartPath, 'utf8');
    assert.match(content, /Scenario 1/i);
    assert.match(content, /Scenario 2/i);
    assert.match(content, /Scenario 3/i);
    assert.match(content, /Scenario 4/i);
    assert.match(content, /Scenario 5/i);
  });
});
