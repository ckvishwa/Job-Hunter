# Development test loop

`npm run test:changed` does not populate an empty cache.

A worktree with no receipts used to select every unit, because a missing receipt was treated as stale. That made the command a silent full regression. A cold cache now selects units only from `git diff HEAD` plus untracked files. If git cannot be asked, or the tree is clean, the command runs nothing and prints the refusal.

`npm run test:full` remains the one uncached acceptance gate. Run it once after the milestone code is stable. A later repair runs the affected tests, then one fresh full gate.

Receipts still separate executed, reused, invalidated, and not-reusable units. A reused receipt is not a fresh execution. Python modules under `services/ai/tests/test_*.py` each have their own receipt. A shared `services/ai/app` or requirements change selects all of those modules. An edit to one module selects that module.
