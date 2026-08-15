# Changelog

## Unreleased

### ⚠️ Behaviour change: jobs are now retried by default

A failed job is now **attempted 3 times in total** — the initial run plus two retries — with
exponential backoff between them (1s, then 2s). Previously the `bullmq` driver passed no
`attempts` at all, so BullMQ's default of `0` applied and its retry condition
(`attemptsMade + 1 < attempts`) was never true: **a failing job was never retried in
production**, while the `memory` driver used in dev and CI retried it three times. The two
now agree.

**A non-idempotent handler that previously failed once and stopped will now run its side effects
up to three times.** If you have handlers that charge cards, send email, or post to an external
API, make them idempotent or set `attempts: 1` on those jobs before upgrading.

Opt out globally:

```ts
concierge: { defaults: { attempts: 1 } }
```

### ⚠️ Behaviour change: `worker.queues` replaces the defaults instead of merging

`concierge.worker.queues` is now exactly the map you write. Previously `@nuxt/kit` deep-merged
it against the module defaults before the module ever saw it, so a `default: 5` entry was
silently added to every config.

**This can stop an app booting.** `defineJob` defaults a job's queue to `default`, so if your
config declares only other queues:

```ts
concierge: { worker: { queues: { mail: 2 } } }
```

then any job that does not set `queue:` explicitly now fails at boot with:

```
[nuxt-concierge] job "send-email" targets queue "default", which is not declared in
concierge.worker.queues (declared: mail).
```

That error is the point — it is the guardrail that stops a job silently never running — but it
was unreachable while the merge was quietly re-adding `default`. Either declare `default` in
your map, or set `queue:` on every job.

The old behaviour also meant a consumer, a Redis connection and a no-worker watch were started
for a `default` queue nobody asked for.

### 🚀 Features

- `defineJob<Payload>` types `ctx.payload`, and `useQueue().enqueue` is generic over a generated
  job map — job names autocomplete, and a wrong payload is a compile error.
- `input` accepts any Standard Schema validator (Zod, Valibot, ArkType) and is validated on both
  enqueue and execute. A validation failure is permanent and never retried.
- Per-job `attempts` and `backoff`, with `concierge.defaults` for the fleet.
- `ModuleOptions` now accepts partial nested config: `worker: { queues }` no longer fails to
  typecheck for missing `heartbeatInterval`/`heartbeatTtl`.

### 🐛 Bug Fixes

- Any API route that enqueued a job and returned a value failed `nuxi typecheck` with
  `Cannot find module '#concierge'`. Nitro's generated route types pull server handlers into the
  app program, where the nitro-scoped declaration was invisible.
- Fixed all 12 pre-existing `typecheck` errors and added `typecheck` to CI.

## [2.0.0-alpha.3](https://github.com/genu/nuxt-concierge/compare/nuxt-concierge-v2.0.0-alpha.2...nuxt-concierge-v2.0.0-alpha.3) (2026-08-15)


### 🐛 Bug Fixes

* reject attempts &lt; 1 at boot instead of silently running once ([#30](https://github.com/genu/nuxt-concierge/issues/30)) ([fc9bcac](https://github.com/genu/nuxt-concierge/commit/fc9bcac1ed697691733b9e5fecd823e531711509))

## [2.0.0-alpha.2](https://github.com/genu/nuxt-concierge/compare/nuxt-concierge-v2.0.0-alpha.1...nuxt-concierge-v2.0.0-alpha.2) (2026-08-15)


### ⚠ BREAKING CHANGES

* dev-only DevTools dashboard and driver introspection SPI (spec 4) ([#28](https://github.com/genu/nuxt-concierge/issues/28))
* typed enqueue, dual-side payload validation and per-job retries ([#19](https://github.com/genu/nuxt-concierge/issues/19))

### 🚀 Features

* cron scheduling and job deduplication (spec 5) ([#29](https://github.com/genu/nuxt-concierge/issues/29)) ([36beb2d](https://github.com/genu/nuxt-concierge/commit/36beb2d2c133ef0cadd09ae5037cc501c50f40da))
* dev-only DevTools dashboard and driver introspection SPI (spec 4) ([#28](https://github.com/genu/nuxt-concierge/issues/28)) ([4336dc5](https://github.com/genu/nuxt-concierge/commit/4336dc566f263784b2c4b90ae363d678d300c01b))
* typed enqueue, dual-side payload validation and per-job retries ([#19](https://github.com/genu/nuxt-concierge/issues/19)) ([8fc1fd5](https://github.com/genu/nuxt-concierge/commit/8fc1fd58dde14fd04d07bd36446f9f4e94499c02))


### 📖 Documentation

* spec 3 decisions record ([#27](https://github.com/genu/nuxt-concierge/issues/27)) ([5c74b43](https://github.com/genu/nuxt-concierge/commit/5c74b43900faefeedb707eda958cc1a2b3c928f3))

## [2.0.0-alpha.1](https://github.com/genu/nuxt-concierge/compare/nuxt-concierge-v2.0.0-alpha...nuxt-concierge-v2.0.0-alpha.1) (2026-08-13)


### 🐛 Bug Fixes

* split ModuleOptions into user-facing and resolved config types ([#18](https://github.com/genu/nuxt-concierge/issues/18)) ([431cf62](https://github.com/genu/nuxt-concierge/commit/431cf620a1b4fda6dfa2672afa40caf130bdd783))


### 📖 Documentation

* commit the phase 1 decisions record and specs roadmap ([#17](https://github.com/genu/nuxt-concierge/issues/17)) ([d6893c8](https://github.com/genu/nuxt-concierge/commit/d6893c84eb95c4897c598502c31f78ac8cd04457))
* correct the prerelease bootstrap note ([#15](https://github.com/genu/nuxt-concierge/issues/15)) ([8560ec9](https://github.com/genu/nuxt-concierge/commit/8560ec93ece74112092cd7c75bfa9859dff87d87))

## [2.0.0-alpha](https://github.com/genu/nuxt-concierge/compare/nuxt-concierge-v1.0.60...nuxt-concierge-v2.0.0-alpha) (2026-08-13)


### ⚠ BREAKING CHANGES

* the public API is now defineJob and useQueue. Queues are declared by concierge.worker.queues, workers are infrastructure selected by CONCIERGE_ROLE, and the redis option becomes connection.

### 🚀 Features

* v2 phase 1 — standalone worker process and graceful job draining ([#13](https://github.com/genu/nuxt-concierge/issues/13)) ([f95aee6](https://github.com/genu/nuxt-concierge/commit/f95aee6cf3a3b3d5c54df88cd0712c4dca90103f))

## v1.0.60

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.59...v1.0.60)

### 🏡 Chore

- **release:** V1.0.59 ([7cb5b89](https://github.com/genu/nuxt-concierge/commit/7cb5b89))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.59

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.58...v1.0.59)

### 🏡 Chore

- **release:** V1.0.58 ([2f38497](https://github.com/genu/nuxt-concierge/commit/2f38497))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.58

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.57...v1.0.58)

### 🏡 Chore

- **release:** V1.0.57 ([da5f68c](https://github.com/genu/nuxt-concierge/commit/da5f68c))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.57

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.56...v1.0.57)

### 🏡 Chore

- **release:** V1.0.56 ([75d5c1b](https://github.com/genu/nuxt-concierge/commit/75d5c1b))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.56

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.55...v1.0.56)

### 🏡 Chore

- **release:** V1.0.55 ([0f6a558](https://github.com/genu/nuxt-concierge/commit/0f6a558))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.55

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.54...v1.0.55)

### 🏡 Chore

- **release:** V1.0.54 ([a0bbd5e](https://github.com/genu/nuxt-concierge/commit/a0bbd5e))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.54

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.53...v1.0.54)

### 🏡 Chore

- **release:** V1.0.53 ([718b915](https://github.com/genu/nuxt-concierge/commit/718b915))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.53

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.52...v1.0.53)

### 🏡 Chore

- **release:** V1.0.52 ([49d6d19](https://github.com/genu/nuxt-concierge/commit/49d6d19))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.52

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.51...v1.0.52)

### 🏡 Chore

- **release:** V1.0.51 ([1e3e296](https://github.com/genu/nuxt-concierge/commit/1e3e296))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.51

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.50...v1.0.51)

### 🏡 Chore

- **release:** V1.0.50 ([e4ff793](https://github.com/genu/nuxt-concierge/commit/e4ff793))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.50

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.49...v1.0.50)

### 🏡 Chore

- **release:** V1.0.49 ([28de658](https://github.com/genu/nuxt-concierge/commit/28de658))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.49

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.48...v1.0.49)

### 🏡 Chore

- **release:** V1.0.48 ([460eb2d](https://github.com/genu/nuxt-concierge/commit/460eb2d))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.48

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.47...v1.0.48)

### 🏡 Chore

- **release:** V1.0.47 ([33241ec](https://github.com/genu/nuxt-concierge/commit/33241ec))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.47

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.46...v1.0.47)

### 🏡 Chore

- **release:** V1.0.46 ([8f63f03](https://github.com/genu/nuxt-concierge/commit/8f63f03))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.46

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.45...v1.0.46)

## v1.0.45

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.44...v1.0.45)

### 🏡 Chore

- **release:** V1.0.44 ([0a2d662](https://github.com/genu/nuxt-concierge/commit/0a2d662))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.44

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.43...v1.0.44)

## v1.0.43

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.42...v1.0.43)

### 🏡 Chore

- **release:** V1.0.42 ([bb7949b](https://github.com/genu/nuxt-concierge/commit/bb7949b))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.42

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.41...v1.0.42)

### 🏡 Chore

- **release:** V1.0.41 ([cd62e61](https://github.com/genu/nuxt-concierge/commit/cd62e61))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.41

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.40...v1.0.41)

### 🏡 Chore

- **release:** V1.0.40 ([dd45eea](https://github.com/genu/nuxt-concierge/commit/dd45eea))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.40

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.39...v1.0.40)

### 🏡 Chore

- **release:** V1.0.39 ([6c72e0a](https://github.com/genu/nuxt-concierge/commit/6c72e0a))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.39

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.38...v1.0.39)

## v1.0.38

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.36...v1.0.38)

### 🏡 Chore

- **release:** V1.0.36 ([eeb81d8](https://github.com/genu/nuxt-concierge/commit/eeb81d8))
- **release:** V1.0.37 ([95c93b2](https://github.com/genu/nuxt-concierge/commit/95c93b2))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.37

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.36...v1.0.37)

## v1.0.36

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.35...v1.0.36)

### 🏡 Chore

- **release:** V1.0.35 ([bcf2971](https://github.com/genu/nuxt-concierge/commit/bcf2971))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.35

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.34...v1.0.35)

### 🏡 Chore

- **release:** V1.0.34 ([a5c6055](https://github.com/genu/nuxt-concierge/commit/a5c6055))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.34

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.33...v1.0.34)

### 🏡 Chore

- **release:** V1.0.33 ([ce8f5c5](https://github.com/genu/nuxt-concierge/commit/ce8f5c5))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.33

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.32...v1.0.33)

### 🏡 Chore

- **release:** V1.0.32 ([10fa3f3](https://github.com/genu/nuxt-concierge/commit/10fa3f3))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.32

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.31...v1.0.32)

### 🏡 Chore

- **release:** V1.0.31 ([cecbbec](https://github.com/genu/nuxt-concierge/commit/cecbbec))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.31

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.30...v1.0.31)

### 🏡 Chore

- **release:** V1.0.30 ([12beaf7](https://github.com/genu/nuxt-concierge/commit/12beaf7))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.30

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.29...v1.0.30)

### 🏡 Chore

- **release:** V1.0.29 ([81d9c7e](https://github.com/genu/nuxt-concierge/commit/81d9c7e))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.29

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.28...v1.0.29)

### 🏡 Chore

- **release:** V1.0.28 ([f91c4da](https://github.com/genu/nuxt-concierge/commit/f91c4da))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.28

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.27...v1.0.28)

## v1.0.27

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.26...v1.0.27)

## v1.0.26

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.25...v1.0.26)

### 🏡 Chore

- **release:** V1.0.25 ([01c71b2](https://github.com/genu/nuxt-concierge/commit/01c71b2))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.25


### 🏡 Chore

- **release:** V1.0.1 ([c3c7c89](https://github.com/genu/nuxt-concierge/commit/c3c7c89))
- **release:** V1.0.2 ([7ea93ef](https://github.com/genu/nuxt-concierge/commit/7ea93ef))
- **release:** V1.0.3 ([b11f9f7](https://github.com/genu/nuxt-concierge/commit/b11f9f7))
- **release:** V1.0.4 ([84c5abf](https://github.com/genu/nuxt-concierge/commit/84c5abf))
- **release:** V1.0.5 ([ff87526](https://github.com/genu/nuxt-concierge/commit/ff87526))
- **release:** V1.0.6 ([f297224](https://github.com/genu/nuxt-concierge/commit/f297224))
- **release:** V1.0.7 ([f60bccc](https://github.com/genu/nuxt-concierge/commit/f60bccc))
- **release:** V1.0.8 ([1fe52fb](https://github.com/genu/nuxt-concierge/commit/1fe52fb))
- **release:** V1.0.9 ([f5e7774](https://github.com/genu/nuxt-concierge/commit/f5e7774))
- **release:** V1.0.10 ([eef58a3](https://github.com/genu/nuxt-concierge/commit/eef58a3))
- **release:** V1.0.11 ([a10724c](https://github.com/genu/nuxt-concierge/commit/a10724c))
- **release:** V1.0.12 ([117fdd2](https://github.com/genu/nuxt-concierge/commit/117fdd2))
- **release:** V1.0.13 ([28e2c2a](https://github.com/genu/nuxt-concierge/commit/28e2c2a))
- **release:** V1.0.14 ([9221c79](https://github.com/genu/nuxt-concierge/commit/9221c79))
- **release:** V1.0.15 ([e631128](https://github.com/genu/nuxt-concierge/commit/e631128))
- **release:** V1.0.16 ([8ab6b5e](https://github.com/genu/nuxt-concierge/commit/8ab6b5e))
- **release:** V1.0.17 ([eb6a4ba](https://github.com/genu/nuxt-concierge/commit/eb6a4ba))
- **release:** V1.0.18 ([31eae67](https://github.com/genu/nuxt-concierge/commit/31eae67))
- **release:** V1.0.19 ([94f2043](https://github.com/genu/nuxt-concierge/commit/94f2043))
- **release:** V1.0.20 ([0098965](https://github.com/genu/nuxt-concierge/commit/0098965))
- **release:** V1.0.21 ([4e63681](https://github.com/genu/nuxt-concierge/commit/4e63681))
- **release:** V1.0.22 ([b3ea6a4](https://github.com/genu/nuxt-concierge/commit/b3ea6a4))
- **release:** V1.0.23 ([26bb686](https://github.com/genu/nuxt-concierge/commit/26bb686))
- **release:** V1.0.24 ([ca20967](https://github.com/genu/nuxt-concierge/commit/ca20967))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.24

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.23...v1.0.24)

### 🏡 Chore

- **release:** V1.0.23 ([26bb686](https://github.com/genu/nuxt-concierge/commit/26bb686))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.23

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.22...v1.0.23)

### 🏡 Chore

- **release:** V1.0.22 ([b3ea6a4](https://github.com/genu/nuxt-concierge/commit/b3ea6a4))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.22

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.21...v1.0.22)

### 🏡 Chore

- **release:** V1.0.21 ([4e63681](https://github.com/genu/nuxt-concierge/commit/4e63681))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.21

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.20...v1.0.21)

### 🏡 Chore

- **release:** V1.0.20 ([0098965](https://github.com/genu/nuxt-concierge/commit/0098965))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.20

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.19...v1.0.20)

## v1.0.19

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.18...v1.0.19)

### 🏡 Chore

- **release:** V1.0.18 ([31eae67](https://github.com/genu/nuxt-concierge/commit/31eae67))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.18

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.17...v1.0.18)

## v1.0.17

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.16...v1.0.17)

### 🏡 Chore

- **release:** V1.0.16 ([8ab6b5e](https://github.com/genu/nuxt-concierge/commit/8ab6b5e))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.16

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.15...v1.0.16)

### 🏡 Chore

- **release:** V1.0.15 ([e631128](https://github.com/genu/nuxt-concierge/commit/e631128))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.15

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.14...v1.0.15)

### 🏡 Chore

- **release:** V1.0.14 ([9221c79](https://github.com/genu/nuxt-concierge/commit/9221c79))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.14

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.13...v1.0.14)

### 🏡 Chore

- **release:** V1.0.13 ([28e2c2a](https://github.com/genu/nuxt-concierge/commit/28e2c2a))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.13

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.12...v1.0.13)

### 🏡 Chore

- **release:** V1.0.12 ([117fdd2](https://github.com/genu/nuxt-concierge/commit/117fdd2))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.12

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.11...v1.0.12)

### 🏡 Chore

- **release:** V1.0.11 ([a10724c](https://github.com/genu/nuxt-concierge/commit/a10724c))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.11

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.10...v1.0.11)

### 🏡 Chore

- **release:** V1.0.10 ([eef58a3](https://github.com/genu/nuxt-concierge/commit/eef58a3))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.10

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.9...v1.0.10)

### 🏡 Chore

- **release:** V1.0.9 ([f5e7774](https://github.com/genu/nuxt-concierge/commit/f5e7774))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.9

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.8...v1.0.9)

### 🏡 Chore

- **release:** V1.0.8 ([1fe52fb](https://github.com/genu/nuxt-concierge/commit/1fe52fb))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.8

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.7...v1.0.8)

### 🏡 Chore

- **release:** V1.0.7 ([f60bccc](https://github.com/genu/nuxt-concierge/commit/f60bccc))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.7

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.6...v1.0.7)

## v1.0.6

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.5...v1.0.6)

### 🏡 Chore

- **release:** V1.0.5 ([ff87526](https://github.com/genu/nuxt-concierge/commit/ff87526))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.5

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.3...v1.0.5)

### 🏡 Chore

- **release:** V1.0.3 ([b11f9f7](https://github.com/genu/nuxt-concierge/commit/b11f9f7))
- **release:** V1.0.4 ([84c5abf](https://github.com/genu/nuxt-concierge/commit/84c5abf))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.4

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.3...v1.0.4)

## v1.0.3

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.2...v1.0.3)

### 🏡 Chore

- **release:** V1.0.2 ([7ea93ef](https://github.com/genu/nuxt-concierge/commit/7ea93ef))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.2

[compare changes](https://github.com/genu/nuxt-concierge/compare/v1.0.1...v1.0.2)

### 🏡 Chore

- **release:** V1.0.1 ([c3c7c89](https://github.com/genu/nuxt-concierge/commit/c3c7c89))

### ❤️ Contributors

- Eugen Istoc <eugenistoc@gmail.com>

## v1.0.1
