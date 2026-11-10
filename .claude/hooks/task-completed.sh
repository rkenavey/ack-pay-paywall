#!/usr/bin/env bash
# TaskCompleted gate for the ACK-Pay paywall build. Spec: CLAUDE.md section 8.
#
# Runs when a task is being marked completed. For a spec task (subject starts
# with "T1:" .. "T7:") it runs, in order:
#   1. harness and test-hygiene checks
#   2. typecheck, lint and the task's test directories
#   3. the Reviewer agent on the task's diff
# Any failure exits 2, which keeps the task open and returns the reason to the
# agent. Tasks whose subject is not a spec task pass straight through.
#
# Hook mode:   JSON on stdin (task_subject, task_description, cwd)
# Manual mode: .claude/hooks/task-completed.sh --task T2 [--tests-only]
#
# Human-only overrides (environment of the Claude Code process, not the agent):
#   PAYWALL_SKIP_REVIEW=1          skip the Reviewer (reviewer outage)
#   PAYWALL_ALLOW_HARNESS_EDITS=1  allow a diff that touches .claude/ or CLAUDE.md
#   PAYWALL_GATE_BASE=<ref>        review the diff against this ref instead

set -u
set -o pipefail

# The Reviewer runs as a nested `claude -p`; never gate from inside it.
[ -n "${PAYWALL_GATE_ACTIVE:-}" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="hook"
TASK_KEY=""
TESTS_ONLY=0
SUBJECT=""
DESCRIPTION=""
CWD_IN=""

STEP_TIMEOUT="${PAYWALL_STEP_TIMEOUT:-600}"      # seconds, per test step
REVIEW_TIMEOUT="${PAYWALL_REVIEW_TIMEOUT:-900}"  # seconds, reviewer
TAIL_LINES=80
MAIN_BRANCH="${PAYWALL_MAIN_BRANCH:-main}"
ID_PATTERN='(PRO|SA|PS|POL|APR|STR|CL|UI|E2E)-[0-9]+'

# Test directories owned by each task (CLAUDE.md section 6).
G_PRO="packages/protocol/test"
G_T2="packages/server/test/policy"
G_T3="packages/server/test/server-agent packages/server/test/payment-service"
G_T4="packages/client/test/agent packages/client/test/ui tests/e2e/core"
G_T5="packages/server/test/stripe packages/client/test/stripe tests/e2e/stripe"
G_T6="packages/server/test/approvals packages/client/test/approvals tests/e2e/approval"
G_T7="tests/e2e/http"

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK_KEY="${2:-}"; MODE="manual"; shift 2 ;;
    --tests-only) TESTS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# block <headline> [details]  -> exit 2.
# The headline also goes to stdout: Claude Code downgrades an exit 2 to a
# non-blocking error when stdout is empty and stderr mentions a missing file,
# which test output easily does.
block() {
  echo "GATE BLOCKED [${TASK_KEY:-?}]: $1"
  {
    echo "GATE BLOCKED [${TASK_KEY:-?}]: $1"
    if [ -n "${2:-}" ]; then
      echo "----"
      printf '%s\n' "$2"
      echo "----"
    fi
    echo "The task stays open. Fix the cause and mark it completed again."
    echo "Pre-check without the reviewer: .claude/hooks/task-completed.sh --task ${TASK_KEY:-T<n>} --tests-only"
  } >&2
  exit 2
}

command -v node >/dev/null 2>&1 || { TASK_KEY="?"; block "node is not on PATH; the gate cannot run"; }

if [ "$MODE" = "hook" ]; then
  INPUT="$(cat)"
  field() {
    printf '%s' "$INPUT" | node -e '
      let s = ""
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const v = JSON.parse(s)[process.argv[1]]
          process.stdout.write(typeof v === "string" ? v : "")
        } catch {}
      })' "$1"
  }
  SUBJECT="$(field task_subject)"
  DESCRIPTION="$(field task_description)"
  CWD_IN="$(field cwd)"
  if [[ "$SUBJECT" =~ ^(T[0-9]+)[:\ ] ]]; then
    TASK_KEY="${BASH_REMATCH[1]}"
  else
    exit 0 # not a spec task (an ad-hoc todo item): nothing to gate
  fi
fi

case "$TASK_KEY" in
  T1|T2|T3|T4|T5|T6|T7) ;;
  *) block "unknown task key '$TASK_KEY' (expected T1..T7; see CLAUDE.md section 7)" ;;
esac

# Repository root: the worktree the agent is working in, else the project dir.
ROOT=""
for candidate in "$CWD_IN" "$PWD" "${CLAUDE_PROJECT_DIR:-}" "$SCRIPT_DIR/../.."; do
  [ -n "$candidate" ] && [ -d "$candidate" ] || continue
  if top="$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null)"; then
    ROOT="$top"
    break
  fi
done
[ -n "$ROOT" ] || block "not inside a git repository"
cd "$ROOT" || block "cannot cd to $ROOT"

GATE_DIR="$ROOT/.gate"
mkdir -p "$GATE_DIR"
export NO_COLOR=1 CI=1 FORCE_COLOR=0

run_with_timeout() {
  local secs="$1"
  shift
  perl -e 'alarm shift; exec @ARGV or die "exec failed: $!\n"' "$secs" "$@"
}

# run_step <name> <log> <command...>: block with the log tail when it fails.
run_step() {
  local name="$1" log="$2"
  shift 2
  if ! run_with_timeout "$STEP_TIMEOUT" "$@" >"$log" 2>&1; then
    block "$name failed (or exceeded ${STEP_TIMEOUT}s). Full log: ${log#"$ROOT"/}" "$(tail -n "$TAIL_LINES" "$log")"
  fi
}

test_files() {
  git ls-files -co --exclude-standard -- '*.test.ts' '*.test.tsx'
}

has_tests() {
  [ -d "$1" ] && [ -n "$(find "$1" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print -quit)" ]
}

# ---------------------------------------------------------------------------
# 1. Preconditions, diff, harness protection, test hygiene
# ---------------------------------------------------------------------------

git rev-parse -q --verify HEAD >/dev/null 2>&1 ||
  block "no baseline commit. Commit the spec and gate harness first (CLAUDE.md section 8) so the gate has something to diff against"
command -v pnpm >/dev/null 2>&1 || block "pnpm is not on PATH"
[ -f package.json ] || block "package.json is missing at the repository root; the T1 scaffold has not been created"

if [ -n "${PAYWALL_GATE_BASE:-}" ]; then
  BASE="$(git rev-parse -q --verify "${PAYWALL_GATE_BASE}^{commit}")" || block "PAYWALL_GATE_BASE='${PAYWALL_GATE_BASE}' is not a commit"
else
  BRANCH="$(git symbolic-ref --short -q HEAD || true)"
  if [ -n "$BRANCH" ] && [ "$BRANCH" != "$MAIN_BRANCH" ] && git rev-parse -q --verify "$MAIN_BRANCH" >/dev/null 2>&1; then
    BASE="$(git merge-base HEAD "$MAIN_BRANCH")" || block "cannot find a merge base with $MAIN_BRANCH"
  else
    BASE="$(git rev-parse HEAD)"
  fi
fi

# Snapshot the working tree (tracked + untracked, minus ignored) as a tree
# object through a scratch index, so the real index is never touched.
SCRATCH_INDEX="$GATE_DIR/index.$$"
trap 'rm -f "$SCRATCH_INDEX" "$SCRATCH_INDEX.lock"' EXIT
REAL_INDEX="$(git rev-parse --git-path index)"
[ -f "$REAL_INDEX" ] && cp "$REAL_INDEX" "$SCRATCH_INDEX"
TREE="$(GIT_INDEX_FILE="$SCRATCH_INDEX" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$SCRATCH_INDEX" git write-tree)" ||
  block "could not snapshot the working tree"

CHANGED="$(git diff --name-only "$BASE" "$TREE")"
[ -n "$CHANGED" ] ||
  block "nothing to review: the working tree equals the base commit ${BASE:0:9}. Task work is committed to $MAIN_BRANCH only after the gate passes (CLAUDE.md section 8). A human can re-gate committed work with PAYWALL_GATE_BASE=<ref>"

if [ -z "${PAYWALL_ALLOW_HARNESS_EDITS:-}" ]; then
  HARNESS="$(printf '%s\n' "$CHANGED" | grep -E '^(\.claude/|CLAUDE\.md$)' || true)"
  [ -z "$HARNESS" ] ||
    block "the diff touches the human-owned spec or gate harness. Revert these files; if the spec or the gate is wrong, stop and tell the human" "$HARNESS"
fi

FILES="$(test_files)"
if [ -n "$FILES" ]; then
  SKIPPED="$(printf '%s\n' "$FILES" | grep -v '^tests/stripe-live/' | tr '\n' '\0' |
    xargs -0 grep -nE '\b(it|test|describe)\.(only|skip|todo|fails)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\(' 2>/dev/null || true)"
  [ -z "$SKIPPED" ] || block "focused, skipped or todo tests are not allowed" "$SKIPPED"
fi

# Every acceptance ID in CLAUDE.md must be named by at least one test.
inventory_check() {
  local ids missing="" id
  ids="$(grep -oE "$ID_PATTERN" CLAUDE.md | sort -u)"
  [ -n "$ids" ] || block "no acceptance IDs found in CLAUDE.md"
  [ -n "$FILES" ] || block "no test files found"
  for id in $ids; do
    if ! printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -qE "(^|[^A-Za-z0-9-])${id}([^0-9]|\$)" 2>/dev/null; then
      missing="$missing $id"
    fi
  done
  [ -z "$missing" ] ||
    block "acceptance IDs from CLAUDE.md section 6 with no test naming them (put the ID at the start of the test title)" "$missing"
}

# ---------------------------------------------------------------------------
# 2. Typecheck, lint, tests
# ---------------------------------------------------------------------------

run_step "typecheck" "$GATE_DIR/$TASK_KEY.typecheck.log" pnpm -s typecheck
run_step "lint" "$GATE_DIR/$TASK_KEY.lint.log" pnpm -s lint

# shellcheck disable=SC2086  # groups are intentionally word-split into paths
run_green() {
  local label="$1"
  shift
  run_step "tests ($label)" "$GATE_DIR/$TASK_KEY.tests.log" pnpm -s exec vitest run "$@"
}

# T1 only: tests for unimplemented behaviour must exist and must fail.
expect_red() {
  local label="$1" d log="$GATE_DIR/$TASK_KEY.red-$1.log"
  shift
  for d in "$@"; do
    has_tests "$d" || block "T1 must create tests in $d (CLAUDE.md section 6)"
  done
  if run_with_timeout "$STEP_TIMEOUT" pnpm -s exec vitest run "$@" >"$log" 2>&1; then
    block "red check: the $label tests pass against the T1 stubs, so they do not test the behaviour. Tests for unimplemented code must fail until it is implemented" "$*"
  fi
}

case "$TASK_KEY" in
  T1)
    inventory_check
    run_green "protocol" $G_PRO
    expect_red T2 $G_T2
    expect_red T3 $G_T3
    expect_red T4 $G_T4
    expect_red T5 $G_T5
    expect_red T6 $G_T6
    expect_red T7 $G_T7
    ;;
  T2) run_green "protocol, policy" $G_PRO $G_T2 ;;
  T3) run_green "T1..T3" $G_PRO $G_T2 $G_T3 ;;
  T4) run_green "T1..T4" $G_PRO $G_T2 $G_T3 $G_T4 ;;
  T5)
    run_green "T1..T5" $G_PRO $G_T2 $G_T3 $G_T4 $G_T5
    run_step "live Stripe test-mode round trip (needs STRIPE_* in .env)" "$GATE_DIR/$TASK_KEY.stripe-live.log" pnpm -s test:stripe-live
    ;;
  T6) run_green "T1..T4, T6" $G_PRO $G_T2 $G_T3 $G_T4 $G_T6 ;;
  T7)
    inventory_check
    run_step "full offline test suite" "$GATE_DIR/$TASK_KEY.tests.log" pnpm -s test
    run_step "build" "$GATE_DIR/$TASK_KEY.build.log" pnpm -s build
    run_step "live Stripe test-mode round trip (needs STRIPE_* in .env)" "$GATE_DIR/$TASK_KEY.stripe-live.log" pnpm -s test:stripe-live
    ;;
esac

if [ "$TESTS_ONLY" = "1" ]; then
  echo "GATE [$TASK_KEY]: deterministic checks passed (reviewer not run: --tests-only)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Reviewer agent on the task diff
# ---------------------------------------------------------------------------

record_pass() {
  printf 'task=%s\ntree=%s\nbase=%s\nreview=%s\nat=%s\n' "$TASK_KEY" "$TREE" "$BASE" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$GATE_DIR/$TASK_KEY.passed"
}

if [ -n "${PAYWALL_SKIP_REVIEW:-}" ]; then
  record_pass "skipped"
  echo "GATE [$TASK_KEY]: tests passed; reviewer skipped by PAYWALL_SKIP_REVIEW"
  exit 0
fi

command -v claude >/dev/null 2>&1 ||
  block "the claude CLI is not on PATH, so the Reviewer cannot run. A human can set PAYWALL_SKIP_REVIEW=1"

DIFF_FILE="$GATE_DIR/$TASK_KEY.diff"
LIST_FILE="$GATE_DIR/$TASK_KEY.files"
git diff "$BASE" "$TREE" -- . ':(exclude)pnpm-lock.yaml' >"$DIFF_FILE"
git diff --name-status "$BASE" "$TREE" >"$LIST_FILE"

PROMPT="Review task $TASK_KEY for the TaskCompleted gate.

Task subject: ${SUBJECT:-$TASK_KEY (manual gate run; see the task brief in CLAUDE.md section 7)}
Task description: ${DESCRIPTION:-see the $TASK_KEY brief in CLAUDE.md section 7}

Unified diff of the task against base ${BASE:0:9}: .gate/$TASK_KEY.diff
Changed files (git name-status): .gate/$TASK_KEY.files
pnpm-lock.yaml is excluded from the diff.

Typecheck, lint and this task's tests have already passed. Follow your review procedure. Your final message must be the verdict JSON object and nothing else."

# The verdict is the JSON object in the reviewer's final message. `--json-schema`
# is not used: with the agent's tool list restricted to Read, Grep and Glob it
# produced no structured_output (checked on Claude Code 2.1.322).
RAW="$GATE_DIR/$TASK_KEY.review.raw.json"
VERDICT_FILE="$GATE_DIR/$TASK_KEY.review.json"
PAYWALL_GATE_ACTIVE=1 run_with_timeout "$REVIEW_TIMEOUT" claude -p "$PROMPT" \
  --agent reviewer \
  --output-format json \
  --permission-mode dontAsk \
  --no-session-persistence \
  >"$RAW" 2>"$GATE_DIR/$TASK_KEY.review.err"
REVIEW_EXIT=$?

REPORT="$(node "$SCRIPT_DIR/review-verdict.mjs" "$RAW" "$VERDICT_FILE" 2>&1)"
case $? in
  0)
    record_pass "pass"
    echo "GATE [$TASK_KEY]: tests passed and the Reviewer approved"
    printf '%s\n' "$REPORT"
    exit 0
    ;;
  3)
    block "the Reviewer rejected the diff. Every finding below must be fixed" "$REPORT"
    ;;
  *)
    block "the Reviewer returned no verdict (exit $REVIEW_EXIT, limit ${REVIEW_TIMEOUT}s). This is a gate infrastructure problem, not a problem with your work: stop and tell the human. Logs: .gate/$TASK_KEY.review.err and .gate/$TASK_KEY.review.raw.json" "$REPORT"
    ;;
esac
