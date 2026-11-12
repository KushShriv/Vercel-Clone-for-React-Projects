# Local React deployment tool

This local, single-user tool builds a selected public GitHub repository and provides a preview on your own machine. A local preview is not a public URL. The original university prototype remains in the repository and is separate from this local service.

## Before you start

Install Node.js 20 or newer and Docker with a running daemon. The launcher does not install packages or request administrator access. It uses `docker` from PATH, or Docker Desktop in `~/Applications` on macOS. On Linux, the current user must be able to access the Docker daemon. On Windows, run the launcher inside WSL2 with Docker available to that environment. macOS, Linux, and WSL2 are intended targets; fresh installations on each have not been verified. Docker, downloaded repositories and dependencies use CPU, storage and network bandwidth.

A repository and its dependencies can run arbitrary code during installation and build. Docker is not a complete security boundary. Use an isolated VM for repositories you do not trust, and do not run this tool on a machine containing sensitive data if you cannot accept that risk. The worker's restrictions need independent review and testing before this tool is treated as safe for arbitrary public input.

## Start and pair

From the repository root, run:

```sh
./start.sh
```

Open the local dashboard URL printed by the service, or use the Pages local mode, and paste in the pairing token from the same terminal. Pages-to-loopback browser behavior has not yet been verified; use the local dashboard if a browser blocks the connection. Keep the token private. The dashboard keeps it in the current tab's memory, not in the URL; reconnect after reloading. The service listens on loopback and is intended for one local user.

Use a root-level Vite project whose `package.json` declares `react`, `react-dom`, and `vite`, with `"build": "vite build"` and an npm lockfile version 2 or 3. Dependencies must resolve from the npm registry. Dependency lifecycle scripts are disabled, so projects that need them may fail. Enter a public GitHub repository URL, choose a revision if needed, and explicitly confirm that you want to run its code. The dashboard displays the job state, commit and logs. A successful local preview opens on a separate loopback origin. Preview restrictions block inline scripts and styles, forms and network requests; sites that need those features may not function. Only one build can run at a time.

Cancel an active build with **Cancel build**. Delete a finished build with **Delete build**. Press Ctrl-C in the terminal to stop the service. Closing the laptop or stopping the service makes local previews unavailable. Jobs and pairing information are kept in memory and are lost when the service stops. The service retains up to ten finished jobs during a run. The worker attempts to remove its temporary containers and network after each build and on graceful shutdown. Abrupt termination can leave Docker containers, networks, and temporary files; inspect and remove leftovers manually if a build or shutdown is interrupted.

## Verify and report issues

From a source checkout (tests are not included in the release archive), run:

```sh
node --test local-service/test/*.test.mjs
```

The in-app browser was used to pair with the local dashboard, build `amannn/vite-react-starter` at commit `730072fb4865d1a7c71fbdba0d403161914b47e9`, render its preview, and delete the job. This check did not cover Chrome, Firefox, Safari, or the Pages-to-loopback connection. These tests do not prove container isolation, platform compatibility, cross-browser pairing, or public hosting. A controlled end-to-end build, cancellation, failure and cleanup check is required on each supported platform. This project does not yet provide a verified public deployment flow, hosted multi-user service, private repository support, or custom build commands.

## Package a local release

After the required end-to-end and security checks pass, create a local archive and SHA-256 checksum from a source checkout with:

```sh
./scripts/package-release.sh 0.1.0 /path/to/output
```

The script refuses to overwrite an existing archive. Verify the downloaded archive against its checksum before extracting it. Packaging creates local files only; it does not publish a release. Do not describe a release as tested on a platform unless those checks have actually passed.
