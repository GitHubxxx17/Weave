# Studio performance baseline

Date: 2026-11-23. Status: accepted scope from the Studio delivery roadmap.

## Goal and boundary

Capture reproducible browser measurements before changing conversation rendering.
Render the ordinary production Studio build against an isolated synthetic HTTP
fixture on a random loopback port. Never open a real profile, project folder,
provider, plugin process or user database. No production instrumentation or
Runtime/HTTP contract changes are necessary. The fixture is test tooling, not an
alternative Server implementation or evidence of real model throughput.

## Workloads

Use exactly 100, 1,000 and 5,000 visible conversation messages. Each consecutive
user/assistant pair has a completed Turn. Deterministic Markdown includes prose,
lists and code; a tool-heavy variant adds a real tool-call/result pair to each
Turn without changing the visible message count. Each case opens the Session,
switches to a small control Session and back, then sends one message. A paced
fixture emits 100 text deltas at 20 ms intervals through the existing POST SSE
contract. Input is edited while the response streams. All counts and selected
workloads are validated with Zod before starting the fixture.

## Measurements

Record browser/version, OS/architecture, viewport, commit, dirty status, build
mode, workload and repeat count. Each sample uses a fresh browser process and
ephemeral profile; built assets use no-store. Browser startup is outside timing.
Measure fresh-page navigation and warm Session switch
until the expected history is present followed by two animation frames; an input
fill-to-two-rAF proxy for responsiveness; animation-frame gaps during streaming; long tasks
and their blocking portion above 50 ms; DOM element count and optional Chromium
JS heap. Browser automation and machine scheduling affect the results: retain
raw samples and do not label them INP, FPS, React commit counts or provider
latency. React profiling requires a separate profiling build and is outside this
baseline. Preserve the same workload for later pagination/virtualization work,
but revise readiness to assert logical messages rather than mounted row count
when virtualization is implemented.

## Execution and failure

An explicit root command builds Studio, starts the fixture, opens a fresh named
Playwright CLI browser session for each sample and writes JSON to an ignored
output directory. It closes only its browser and fixture in finally, including
timeouts. It uses the installed Playwright CLI and adds no runtime dependency.
Missing browser tooling fails with setup instructions; it never installs global
tools or downloads browsers automatically. Ordinary pnpm check remains offline
and validates deterministic fixture generation and HTTP/SSE behavior; real browser
timings are an explicit local command, not a flaky CI threshold.

## Acceptance

- Production assets load and each expected history count renders.
- The stream delivers 100 ordered deltas plus completion; test content appears.
- Session switching and input edits work during the benchmark.
- Unknown API routes fail visibly instead of silently accepting empty data.
- Fixture requests stay on loopback and never read files outside Studio dist.
- Reports distinguish synthetic data from real provider and multi-Agent results.
- Reference principles: measure before optimization, isolate high-frequency
  updates and retain deterministic comparisons. These are Weave's measurement
  choices; no benchmark result is attributed to Codex, Kiro or Harness.
