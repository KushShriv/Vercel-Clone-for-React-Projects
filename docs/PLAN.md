# Plan: usable React deployment tool from GitHub Pages

Status: implementation in progress. The instruction page was published to GitHub Pages on 12 November 2026 and loads. The local workflow has passed a targeted Docker build and in-app browser test. The AWS option is experimental and has not been tested in an AWS account. The Pages-to-loopback connection, browser and platform matrix, live Docker tests on a clean machine and independent isolation review remain open; see `local-service/README.md` and `cloud/README.md`.

## Outcome and scope

A visitor reads the instructions and downloads a versioned release, start a local backend and use the Pages interface or its locally served copy. The initial tool builds an explicitly selected public GitHub repository and serves its static output on the user's own machine. A later optional setup lets them publish the output through infrastructure they own. No hosted multi-user build service, private repositories, custom build commands, or long-lived AWS keys in the browser for v1.

A real remote public URL needs infrastructure that remains reachable, a domain or public hosting provider, storage, HTTPS and ongoing cost. A laptop's local URL is not a public deployment. GitHub Pages hosts only the interface and documentation; it is not a build worker or hosting backend for arbitrary users' sites. Check [GitHub Pages limits and permitted use](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) before choosing a public SaaS model.

## Options and recommendation

- **Local build and preview first (recommended):** release plus local service, a container-isolated worker, and local preview. Lowest infrastructure burden, but the user's machine must remain on for the preview.
- **User-owned EC2 and object storage:** public output without hosting it ourselves. Requires cloud setup, a domain, costs and cleanup. Implement as a separate optional stage.
- **Shared hosted build service:** central compute, tenant isolation, billing and abuse controls; out of scope until there is a demonstrated need.

## Phase 1: local build and preview

1. Define supported macOS/Linux versions and Windows via WSL2. Provide a versioned release, checksums and `start.sh`. It checks prerequisites including Docker, starts the service on loopback, prints a pairing code and local dashboard URL, and gives a clear shutdown/cleanup path. Never silently install system packages, request root, or ask the browser for cloud credentials. Explain that Docker and downloaded code can consume disk, compute and network resources.
2. Preserve the university implementation as a prototype, but use a minimal local pipeline: validate a public `https://github.com/<owner>/<repo>` URL; clone a selected revision; build in an ephemeral, non-privileged container; serve a static output folder locally. Avoid Redis, S3 and wildcard DNS for single-user local preview. Record the commit SHA so the user knows what was built. Only support an explicit, documented Vite/React build convention initially; detect unsupported repositories and fail clearly.
3. Treat repositories and npm scripts as untrusted code. Require explicit confirmation before cloning/building. Use a non-root isolated worker with CPU, memory, process count, disk, output size and time limits, no host mounts or container socket, and no cloud credentials or access to the local service. Restrict network: ideally install dependencies in a separate restricted stage and run build without network. Docker alone is not a complete security boundary; document the residual risk and recommend an isolated VM for untrusted projects. Verify the actual restrictions with tests before claiming isolation.
4. Fix the current prototype issues if components are reused: missing `path` imports, incomplete upload waiting, failure to check build exit codes, status marked successful before final copy completes, hard-coded endpoints/bucket, errors and cleanup. Do not present a deployment as successful until the build and publish complete and output is verified. The original code runs `npm install` and repository build scripts; never run them directly on the host.
5. Define API operations for health, create job, status/logs, cancel, artifact/preview and delete. Use random job IDs, bounded logs and retention, and explicit states: queued, cloning, building, ready, failed, cancelled. Persist only what is needed for a restart or explain that jobs are lost. Support a single user and one active build at first. Show the real commit, logs and failure details.

## Phase 2: Pages and security

1. Add a local connection to the instruction page only when the real service is ready. Connect only on an explicit action and pair with the launcher. The locally served copy is the default fallback when Pages-to-loopback access is unavailable or denied.
2. Bind local services to loopback. Validate Host and Origin, use exact CORS allowlists, require a high-entropy pairing token for all API calls, limit request size and rate, and prevent DNS rebinding. Do not put tokens in URLs or logs. Never trust a GitHub URL, redirect, archive or build output without validation. Prevent path traversal and symlink escape when serving artifacts. Use safe content types and security headers; preview untrusted site content on a separate origin from the control interface.
3. Browser-test Chrome, Firefox and Safari, including loopback permission, CORS, denial, and the localhost fallback. Record actual supported versions. Publish `docs/` or a Pages workflow only after review and explicit authorization. Verify the repository subpath and deployed HTTPS URL.

## Phase 3: optional user-owned public deployment

1. Select one concrete target after the local workflow works. Prefer static object storage plus a CDN for static output; EC2 can run the build worker but is not mandatory for serving files. Provide a small reproducible setup and teardown, HTTPS, cost warning and domain instructions. Clarify which resources remain active when the user's device shuts down.
2. Keep credentials on the user's backend, not in Pages or source control. On EC2 use a scoped instance role with temporary credentials; locally use a user-managed AWS credential chain. Restrict permissions to the specific deployment prefix and avoid storing secrets in logs or the build environment. [AWS temporary credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp.html).
3. Publish to a unique deployment prefix, wait for every upload, verify output, and report the actual URL only after successful deployment. Define cache invalidation, rollback, deletion, retention, route fallback, MIME types, file limits, and ownership. Handle DNS, TLS and SPA deep links for the chosen host. Document what is and is not publicly accessible.
4. A network-accessible backend needs authenticated access, TLS, access controls, rate limits and secured workers; binding the existing prototype to `0.0.0.0` is not a deployment solution. Never expose Redis or object-storage credentials.

## Acceptance and verification

- Fresh setup on each supported platform: install prerequisites, run launcher, pair, build a controlled fixture, open local preview, cancel a run, inspect failures, stop and remove all temporary resources.
- Test build failures, timeouts, network and storage errors, oversized outputs, malicious paths/symlinks, and the guarantee that failed builds are not labelled successful. Exercise resource limits, worker isolation, cleanup and process termination.
- Test invalid Host, unapproved Origin, missing or invalid pairing token, malformed repository URLs and unauthorized API requests. Review container isolation independently before supporting arbitrary public input.
- Test a known Vite fixture including static assets and client routes; document exact supported build conventions. Test Pages-to-loopback and localhost fallback in supported browsers. Verify the instruction page and real connection flow behave as documented.
- For cloud phase: test a real user-owned account, IAM restrictions, complete uploads, public URL, HTTPS, rollback, deletion and remaining-resource/cost cleanup. Do not claim these pass before they are run.

Open decisions: supported OS/browser matrix, initial Vite convention, exact sandbox mechanism and residual-risk threshold, public hosting provider, domain setup and retention policy.
