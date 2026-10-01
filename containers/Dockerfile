# The Harper target, containerized.
#
# Containerization is a measurement choice, not a neutral wrapper (benchmarks README). Every
# target must be containerized IDENTICALLY — same base image family, same networking mode,
# same volume semantics — or the difference between wrappers can exceed the architectural
# difference being measured.
#
# Pinned by digest-free tag deliberately: the tag is recorded with every run, and a run that
# matters pins the digest in compose.yaml.
FROM node:24-slim

# Pinned explicitly, and NOT inherited from the application's package.json.
#
# Harper is a devDependency there (it is the host platform in a real deployment, not an app
# dependency), so `--omit=dev` skips it and `npx harper` silently fetched whatever was latest
# — the container ran 5.3.0 while local development ran 5.2.12. A benchmark whose platform
# version drifts between environments is measuring something nobody can reproduce.
ARG HARPER_VERSION=5.2.12
ENV HARPER_VERSION=${HARPER_VERSION}

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

# The SAME install Harper itself runs on deploy (components/Application.ts:
# `npm install --force --omit=dev --no-audit --no-fund`). Not `npm ci`: the lock file
# resolves platform-specific optional peers differently on linux than on the macOS host, and
# more importantly a container that installs differently from the deploy path is testing
# something other than what ships.
# Harper is installed GLOBALLY, deliberately.
#
# It is the platform hosting the application, not a dependency of it — which is exactly how a
# real deployment works. It also sidesteps a trap: `harper` is already a devDependency of the
# application, so an in-tree `npm install harper@X` under `--omit=dev` reports "up to date"
# and installs nothing at all, silently. The version assertion below exists because that
# failure is invisible until the container starts and npx fetches whatever is newest.
RUN npm install --force --omit=dev --no-audit --no-fund
RUN npm install -g --no-audit --no-fund "harper@${HARPER_VERSION}" \
	&& node -e "const v=require('/usr/local/lib/node_modules/harper/package.json').version; if (v!==process.env.HARPER_VERSION) { console.error('harper version drift: got '+v+', expected '+process.env.HARPER_VERSION); process.exit(1); } console.log('harper '+v+' pinned')"

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
