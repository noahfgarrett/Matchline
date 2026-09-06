# RELEASE RUNBOOK — owner-facing

How a Matchline build gets from Noah's Mac to a user's Windows machine, what has
to exist for that to work, and what happens when it does not. This is the
counterpart to [`WINDOWS-RUNBOOK.md`](WINDOWS-RUNBOOK.md), which is about
proving extraction works; this one is about shipping.

Everything described here is implemented in `.github/workflows/`. Where a piece
is scaffolding rather than working machinery it says so, in this document and in
the workflow itself. Nothing in the pipeline reports success for work it did not
do.

---

## 1. The flow

```
develop on the Mac
        │
        ├─ push a branch ──────────►  CI: tests on ubuntu/macos/windows,
        │                                 native smoke, unsigned Windows package
        │
        ├─ dispatch by hand ───────►  Navisworks proof: self-hosted Windows box
        │                                 with a real Navisworks 2025 install
        │
        └─ push a tag `v1.0.0` ────►  Release: the full CI matrix again, then a
                                          signed Windows build, then publish
                                          │
                                          └─► users update
```

Three rules the pipeline enforces rather than documents:

1. **A tag cannot pass a weaker CI than a branch.** `release.yml` does not
   duplicate the matrix, it calls `ci.yml` as a reusable workflow. Whatever
   guards a pull request guards a release.
2. **A release that cannot be signed does not get built.** The signing-credential
   check is the first step of the Windows release job, before checkout.
3. **A release that publishes nothing does not report success.** The publish job
   fails while the distribution channel is undecided.
4. **Nothing is packaged around an unsigned binary.** The application tree is
   built first (`electron-builder --win --dir`), every executable in it is
   signed, and only then are the installer and the portable zip built from that
   tree (`electron-builder --win --prepackaged`). Signing after packaging leaves
   the copies inside the NSIS payload and the zip unsigned.

### What gets signed

In this order, all with `signtool` and an RFC 3161 timestamp:

1. Every `*.exe` and `*.dll` under `apps/desktop/release/win-unpacked` —
   `Matchline.exe`, the Electron runtime DLLs beside it, and the staged native
   tree under `resources/`: `resources/extractor/Matchline.Extractor.exe` and
   the Navisworks plugin adapter DLLs under `resources/plugins/`. The job fails
   if `Matchline.exe` or `Matchline.Extractor.exe` is not there, because a tree
   missing either would otherwise ship as a quietly smaller release.
2. `Matchline-<version>-Setup-x64.exe`, after it is built from that tree.

The portable zip carries no signature of its own — a zip is not something
`signtool` can sign or verify — but everything inside it was signed at step 1.
Verification re-checks `Matchline.exe`, the launcher, the adapter DLLs and the
installer with `signtool verify /pa`.

---

## 2. Workflow inventory

### `.github/workflows/ci.yml` — every branch push, every pull request

| Job | Runner | What it proves |
| --- | --- | --- |
| `test` | ubuntu-latest, macos-latest, windows-latest | `npm ci` → `npm run postsetup` → build → typed-package tests → integration tests → the green subset of the 1.0 acceptance gates → the donor parity suite. Windows joined the matrix in M9; the legacy step is pinned to `shell: bash` so all three runners run the identical command instead of pwsh reinterpreting the glob and the skip pattern. |
| `native-smoke` | ubuntu-latest, windows-latest | The C# half that needs no Autodesk install: builds `Matchline.Extraction.Common` and the net48 `Matchline.Extractor`, runs the real smoke harness (`native/smoke`), and stub-compiles **every** version adapter it finds under `native/navisworks-<year>/`. The adapter list is a glob, so the 2024 and 2026 adapters get compiled the day they land without anybody editing CI. Finding zero adapters fails the job. |
| `package-smoke` | windows-latest | A clean checkout still produces a Windows installer. Deliberately unsigned and consumes **no** secrets, so it works on any branch and any pull request. Asserts `*-Setup-*.exe` and `*-win-*.zip` exist and are non-empty, then uploads them with 3-day retention (they are ~230 MB per run and they are a smoke result, not a release). |

`postsetup` is run explicitly on every OS. It is not an npm lifecycle hook of
`ci` — there is no `setup` script for it to hang off — so nothing runs it
implicitly, and it is the step that puts the runner's own Electron binary and
esbuild build in place.

### `.github/workflows/release.yml` — tag push matching `v*`

| Job | Runner | Notes |
| --- | --- | --- |
| `hosted-matrix` | (calls `ci.yml`) | Must be entirely green before anything else starts. |
| `windows-release` | windows-latest | Requires the signing secrets, builds, packages the application tree with `electron-builder --win --dir`, signs every binary in it, builds the installer and the portable zip from that signed tree with `--prepackaged`, signs the installer, verifies the signatures, uploads the artifacts with 30-day retention. |
| `publish` | ubuntu-latest | Gated on the same secrets plus `UPDATE_FEED_TOKEN`. **Currently fails on purpose** — see §7. |

### `.github/workflows/navisworks-proof.yml` — manual dispatch only

A hosted `check-runner` job runs first and fails fast, with a clear message, if
no *online* self-hosted runner carries the required labels — a dispatch against
an unregistered label otherwise just queues forever. Then, self-hosted,
label-gated, one run at a time: real plugin compile against the installed
Autodesk API, a deploy of the compiled DLLs into the Navisworks `Plugins`
folder (verified byte-for-byte by hash before anything runs against it), then
the proof steps from the plan: extraction, the TypeScript cache cross-check,
cache-hit, cancellation, Selection Sets, Search Sets, error classification. All
seven proof scripts (Milestone 6, `scripts/windows-proof/*.mjs`) exist and are
exercised against the fake extractor in `tests/windows-proof/scripts.test.mjs`.

---

## 3. Secrets

Set these at **GitHub → the Matchline repository → Settings → Secrets and
variables → Actions → Repository secrets**. Nothing else needs to know them: no
value appears in any workflow file, in any log, or in this document.

| Secret | What it is | Used by |
| --- | --- | --- |
| `WINDOWS_SIGNING_CERT_B64` | The Windows code-signing certificate as a base64-encoded `.pfx`. Produce it with `base64 -i matchline-signing.pfx \| pbcopy` and paste. | `release.yml` — gate + `signtool sign` |
| `WINDOWS_SIGNING_CERT_PASSWORD` | The password protecting that `.pfx`. | `release.yml` — `signtool sign` |
| `UPDATE_FEED_TOKEN` | The credential that authenticates the push to whichever update feed gets chosen. Nothing consumes it yet beyond the presence check. | `release.yml` — publish gate |

Three things worth being deliberate about:

- **Never put a certificate or a password in the repository**, including in a
  `.env`, including "temporarily". The workflows read them from the secret store
  and the certificate is written only to `RUNNER_TEMP` and deleted in an
  `if: always()` step.
- **Repository secrets, not environment secrets.** No deployment environment is
  configured; adding one would change how the jobs reference them.
- **Rotate `WINDOWS_SIGNING_CERT_PASSWORD` if a run ever prints it.** GitHub
  masks registered secret values in logs, but masking is a safety net, not a
  guarantee.

---

## 4. Getting the signing certificate

This is the single blocking item for hard gate 18 (application signed) and, by
extension, for 1.0.0 rather than 1.0.0-rc.1.

**What to buy.** An *OV code-signing certificate* from a public CA (DigiCert,
Sectigo, SSL.com, GlobalSign are the usual names). Issuance requires proving the
organisation exists — expect to supply business registration details and to pass
a callback verification. Budget one to three weeks, not one afternoon. An EV
certificate buys immediate SmartScreen reputation and costs more.

**Read this before assuming the workflow shape is right.** Since the CA/Browser
Forum tightened the baseline requirements in June 2023, public code-signing
private keys must live on FIPS-certified hardware or in a CA-operated cloud
signing service. In practice that means a freely exportable `.pfx` file is
usually **not** what a CA will hand you any more, and the three realistic paths
are:

1. **Cloud signing service** (DigiCert KeyLocker, SSL.com eSigner, Azure Trusted
   Signing). The key stays with the provider; `signtool` calls it through a
   provider DLL (`/dlib`) instead of `/f certificate.pfx`. This is the option
   that works on GitHub-hosted Windows runners. **It changes the signing step and
   the secret names** — the base64-`.pfx` shape currently in `release.yml` is
   built for a file-based certificate.
2. **EV certificate on a hardware token.** The token has to be physically
   attached to the machine that signs, so signing moves to a self-hosted Windows
   runner and the GitHub-hosted release job cannot do it. Many tokens also
   require an interactive PIN, which is hostile to automation.
3. **A legacy or private file-based `.pfx`**, if one is available. This is what
   `release.yml` is written for today, and it is the least likely to be what a CA
   issues in 2026.

Confirm the delivery format with the CA *before* purchase, then tell whoever
picks up M9 which one it is. If the answer is option 1, the signing step in
`release.yml` needs rewriting to the provider's `signtool` integration and the
secrets change accordingly — that is a known, expected change, not a surprise.

**Installing it.** For the file-based path there is nothing to install: base64
the `.pfx`, store it as `WINDOWS_SIGNING_CERT_B64`, store the password as
`WINDOWS_SIGNING_CERT_PASSWORD`, keep the original `.pfx` somewhere safe and
offline. Losing it means re-issuance, not recovery.

---

## 5. The self-hosted Navisworks runner

`navisworks-proof.yml` targets `runs-on: [self-hosted, windows, navisworks-2025]`.
All three labels must be on the runner or the job never starts.

**Setting it up.**

1. Pick the Windows machine that has Navisworks Manage or Simulate 2025
   installed — the same box as the `WINDOWS-RUNBOOK.md` proof.
2. GitHub → repository → Settings → Actions → Runners → New self-hosted runner,
   Windows x64. Follow the download-and-configure commands it prints.
3. When the configuration script asks for additional labels, enter
   `windows,navisworks-2025`. (`self-hosted` is applied automatically; the
   default `Windows` label is capitalised and label matching is
   case-insensitive, so `windows` matches either way — entering it explicitly
   keeps the workflow readable.)
4. Install it as a service so it survives a reboot, running as an account that
   can actually launch Navisworks. The extraction proof drives a real Navisworks
   instance.
5. Later adapters get their own labelled runners — `navisworks-2024`,
   `navisworks-2026` — and their own copy of the job. A single machine can carry
   several year labels only if it has several Navisworks versions installed, and
   the concurrency group serialises the runs.

**Security notes, all load-bearing.**

- **Keep the repository private.** A self-hosted runner attached to a public
  repository executes code from any fork's pull request on your hardware. That
  is the standard warning and it is not overstated.
- **The workflow is `workflow_dispatch` only.** It never fires on a push, so a
  branch cannot start a job on this machine by accident.
- **No client models in CI.** The model is named by a `model_path` dispatch
  input pointing at a file that already exists on the runner's disk. It is never
  uploaded, never copied into the workspace, and never committed. Keep the proof
  models outside the runner's working directory so a workspace clean cannot
  touch them and a stray `git add` cannot see them.
- **Only anonymized results leave the machine.** The single uploaded artifact is
  `artifacts/windows-proof/**`, and the M6 scripts are responsible for writing
  counts and timings there — no tags, no file names, no property values
  (`RELEASE-1.0-PLAN.md` P0-3).
- Dispatch inputs reach the shell as environment variables, never spliced into a
  script body, so a crafted input cannot become a command on the runner.

---

## 6. What Milestone 6 still owes the proof workflow

`navisworks-proof.yml` calls seven scripts, and all seven now exist under
`scripts/windows-proof/`, tested against the fake extractor
(`tests/windows-proof/scripts.test.mjs`). Its preflight step still checks for
each one and would fail listing whatever was missing; each individual step
still guards its own script as well. The contract each script must satisfy:

- Invoked as `node scripts/windows-proof/<name>.mjs`, no arguments.
- Reads `MATCHLINE_PROOF_MODEL` (the model path), `MATCHLINE_PROOF_OUT` (the
  output directory, `artifacts/windows-proof`) and
  `MATCHLINE_NAVISWORKS_INSTALL_DIR` from the environment.
- Exits non-zero on any failed assertion. Exit 0 means the thing was proven.
- Writes only anonymized counts and timings into `MATCHLINE_PROOF_OUT`.

| Script | Proves |
| --- | --- |
| `extract.mjs` | The real launcher drives the real plugin over the real model and produces a cache. |
| `validate-cache.mjs` | The shipping TypeScript reader reads what the C# writer wrote. |
| `cache-hit.mjs` | A re-run hits the cache and never starts Navisworks. |
| `cancellation.mjs` | Cancelling mid-run leaves no cache and no partial file behind. |
| `selection-sets.mjs` | Selection Set membership resolves as the extraction design claims (hard gate 15). |
| `search-sets.mjs` | Search Sets either resolve fully or are honestly marked unusable — never empty-as-answer (hard gate 16). |
| `error-classification.mjs` | The error vocabulary in P0-2 maps to what really happens. |

They have landed: dispatching the workflow on a real, labelled runner now runs
the genuine proof rather than failing at preflight. The defensive check stays
in place regardless — the intended behaviour was always that a proof job that
goes green without proving anything is worse than no job.

---

## 7. When secrets or runners are absent

Nothing here degrades quietly. This table is the whole failure surface.

| Situation | What happens | Why that is the honest answer |
| --- | --- | --- |
| Branch push or PR, no secrets anywhere | Full CI runs and can go green, including the unsigned Windows package | Day-to-day development must not need a certificate |
| Tag pushed, signing secrets missing | `windows-release` fails at its first step, before checkout. `publish` never runs | The plan's rule: fail clearly rather than silently publish an unsigned 1.0.0 |
| Tag pushed, signing secrets present, no feed decision | Matrix green, signed artifacts built, verified and uploaded to the run; `publish` fails as "not implemented" | The binaries are real and downloadable; the automated distribution is not, and the run says so |
| Tag pushed, hosted matrix red | `windows-release` never starts (`needs: hosted-matrix`) | A release is not a way around a failing test |
| Navisworks proof dispatched, no ONLINE runner registered with the labels | The hosted `check-runner` job fails within seconds, naming the required labels | It queries the runners API itself rather than waiting for a job to sit queued and look like a slow run |
| Navisworks proof dispatched, runner present, M6 scripts absent | Preflight fails listing every missing script | Scaffolding that admits it is scaffolding |
| Navisworks proof dispatched, model path not on the runner | Fails immediately with a message saying the path is runner-local | Cheaper than failing ten minutes in |

There is no `continue-on-error` anywhere in `.github/workflows/`. If a job is
green, it did the work.

---

## 8. Manual offline installer path

Two ways to get an installer without the automated feed, which is the path in
use until the publish decision lands.

**From a release run.** GitHub → Actions → the tagged run → Artifacts →
`matchline-windows-release`. It contains `Matchline-<version>-Setup-x64.exe` and
`Matchline-<version>-win-x64.zip`, both signed, kept for 30 days. Hand the
installer over on whatever channel suits — it is a normal NSIS installer:
per-user by default, installation directory changeable, desktop and Start Menu
shortcuts.

**From the Mac, locally.** `apps/desktop/electron-builder.yml` cross-builds the
Windows targets from macOS (the resedit pass that stamps name and version is
pure JavaScript), which is how the current `0.8.x` artifacts were produced:

```
npm ci
npm run postsetup
npm run build
npm run build:desktop
npm run package:win
```

Output lands in `apps/desktop/release/`. **A locally built installer is
unsigned** — Windows SmartScreen will warn on it, and it is fine for "try it"
distribution ([`INSTALL-TRY-IT.md`](INSTALL-TRY-IT.md)) but is not a release.
Only the tagged pipeline produces signed binaries.

The portable zip is the fully offline option: no installer, no elevation,
unzip and run.

---

## 9. What the update path must not do

Not enforced by these workflows, and deliberately not: it is application
behaviour, owned by M9b. Recorded here so the requirement does not go missing
between the two.

An update check may send the current version and the platform, and nothing else.
**No project data, no file names, no tags, no counts, no telemetry.** It must be
disableable, it must degrade gracefully when offline, and a failed update must
be incapable of corrupting either the application or a project. Migrations stay
opt-in with a backup, exactly as they are today. Hard gate 19 is only satisfied
when the app side proves this, not when the pipeline can push a file.

---

## 10. Open items before 1.0.0

1. **The certificate does not exist.** Gate 18. Everything in §4.
2. **The distribution channel is undecided.** `Matchline-Releases` artifact
   repository, or a signed static feed. Owner's call; `publish` stays a
   deliberate failure until it is made. Implementing it also needs
   `actions/download-artifact` added to the approved action set and
   `permissions: contents: write` on that job.
3. **The `signtool` commands have never run.** There is no certificate to run
   them with. The first real release validates them; treat a failure there as
   first-run friction, not a regression.
4. **Windows only.** This pipeline builds and signs Windows. The macOS zip stays
   a local `npm run package:mac` artifact with `identity: null` — unsigned, not
   notarised, not distributed.
5. **The Navisworks proof scripts exist and are tested** (§6) but have not yet
   run against a real Navisworks install — that happens on Noah's Windows box.
