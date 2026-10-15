# The Harper target, containerized.
#
# Containerization is a measurement choice, not a neutral wrapper (benchmarks README). Every
# target must be containerized IDENTICALLY — same base image family, same networking mode,
# same volume semantics — or the difference between wrappers can exceed the architectural
# difference being measured.
#
# Base images are pinned by digest in compose.yaml (x-base-images) and passed in as NODE_IMAGE
# and NODE_SLIM_IMAGE. They have no default here, so a build that bypasses compose has to name
# them rather than silently take whatever the tag points at today.
ARG NODE_IMAGE
ARG NODE_SLIM_IMAGE

# Pinned explicitly, and NOT inherited from the application's package.json.
#
# Harper is a devDependency there (it is the host platform in a real deployment, not an app
# dependency), so `--omit=dev` skips it and `npx harper` silently fetched whatever was latest
# — the container ran 5.3.0 while local development ran 5.2.12. A benchmark whose platform
# version drifts between environments is measuring something nobody can reproduce.
# containers/run-benchmark.sh passes the version from package.json; this default is a fallback.
ARG HARPER_VERSION=5.3.2

# --- the platform, built where a toolchain exists ----------------------------------------
#
# Harper is installed GLOBALLY, deliberately. It is the platform hosting the application, not
# a dependency of it — which is exactly how a real deployment works. It also sidesteps a trap:
# `harper` is already a devDependency of the application, so an in-tree `npm install harper@X`
# under `--omit=dev` reports "up to date" and installs nothing at all, silently.
#
# Built in the full image because msgpackr-extract has to be compiled here. Its linux-arm64
# prebuilt package (3.0.3, 3.0.4) ships ONLY musl binaries, so on glibc arm64 — Apple Silicon
# Podman, Graviton, Axion — its loader finds nothing and msgpackr silently falls back to pure-JS
# decoding of every record Harper reads. linux-x64 ships glibc binaries and loads the prebuilt.
# A target that quietly runs without its native decoder is the "plausible number, not an
# obvious failure" misconfiguration the measurement rules warn about, and it would also make
# tier-1 (arm64) and tier-2 (usually x64) runs measure different Harper builds.
#
# Scripts are ignored on the install and the one native build is run explicitly: since 5.3.2
# (no shrinkwrap) npm runs msgpackr-extract's install script, which falls through to node-gyp
# and fails the whole install on an image without Python.
FROM ${NODE_IMAGE} AS platform
ARG HARPER_VERSION
ENV HARPER_VERSION=${HARPER_VERSION}
RUN npm install -g --no-audit --no-fund --ignore-scripts "harper@${HARPER_VERSION}"
WORKDIR /usr/local/lib/node_modules/harper/node_modules/msgpackr-extract
RUN node -e "require('.')" 2>/dev/null \
	|| node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild

# --- the target ---------------------------------------------------------------------------
FROM ${NODE_SLIM_IMAGE}
ARG HARPER_VERSION
ENV HARPER_VERSION=${HARPER_VERSION}

COPY --from=platform /usr/local/lib/node_modules/harper /usr/local/lib/node_modules/harper
RUN ln -s ../lib/node_modules/harper/dist/bin/harper.js /usr/local/bin/harper \
	&& cd /usr/local/lib/node_modules/harper \
	&& node -e " \
		const v = require('./package.json').version; \
		if (v !== process.env.HARPER_VERSION) { console.error('harper version drift: got ' + v + ', expected ' + process.env.HARPER_VERSION); process.exit(1); } \
		if (!require('msgpackr').isNativeAccelerationEnabled) { console.error('msgpackr native acceleration is not enabled'); process.exit(1); } \
		console.log('harper ' + v + ' pinned; msgpackr native acceleration enabled'); \
	"

# Harper writes its root under $HOME. Pointing HOME at the volume mount keeps the database on
# a real filesystem — NEVER tmpfs, which distorts file I/O enough to invalidate storage
# comparisons.
ENV HOME=/data
ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so application edits do not invalidate the install layer.
COPY package.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/seed/package.json packages/seed/

# The SAME install Harper itself runs on deploy (components/Application.ts,
# packageManagerInstallArguments: `npm install --force --omit=dev --no-audit --no-fund
# --ignore-scripts`). Not `npm ci`: the lock file resolves platform-specific optional peers
# differently on linux than on the macOS host, and more importantly a container that installs
# differently from the deploy path is testing something other than what ships.
RUN npm install --force --omit=dev --no-audit --no-fund --ignore-scripts

# The application. The dataset is NOT copied in — it is loaded over the operations API
# outside the measured run, from a bind mount.
COPY config.yaml ./
COPY schemas/ schemas/
COPY resources/ resources/
COPY packages/ packages/

EXPOSE 9926 9925

# `harper run` rather than `harper dev`: dev mode forces a single worker thread and disables
# auth, which is a development configuration and not a benchmark configuration.
CMD ["harper", "run", "."]
