# nuxt-concierge

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Queues, workers and background jobs for nuxt

- [✨ &nbsp;Release Notes](/CHANGELOG.md)
  <!-- - [🏀 Online playground](https://stackblitz.com/github/your-org/my-module?file=playground%2Fapp.vue) -->
  <!-- - [📖 &nbsp;Documentation](https://example.com) -->

## Features

<!-- Highlight some of the features your module provide here -->

- Create queues and workers based on bullmq
- Create scheduled tasks
- UI for managing jobs
- Autoscan and initialize queues automatically
- Dynamically create new queues and workers
- Ability to integrate with external queues and workers

## Quick Setup

1. Add `nuxt-concierge` dependency to your project

```bash
# Using pnpm
pnpm add -D nuxt-concierge

# Using yarn
yarn add --dev nuxt-concierge

# Using npm
npm install --save-dev nuxt-concierge
```

2. Add `nuxt-concierge` to the `modules` section of `nuxt.config.ts`

```js
export default defineNuxtConfig({
  modules: ["nuxt-concierge"],
  concierge: {
    redis: {
      host: "localhost",
    },
  },
});
```

**Note**: A redis connetion **is required** for this module to work. A connection test is done during module startup, and an error is raised if a connection cannot be established.

## Usage

```ts
export default defineNuxtConfig({
  modules: ["nuxt-concierge"],
  concierge: {
    redis: {
      host: "localhost",
    },
  },
});
```

### Creating Queues

There are two ways to create queues.

1. Inline using options

We call this **Simple Queues** because only a queue name is needed. To create a simple queue:

```ts
concierge: {
  queues: ["my-queue"],
},

```

2. The second method for creating queues is by defining it using `defineQueue`.

For example:

`/concierge/queues/my-queue.ts`:

```ts
export default defineQueue("MyQueue", {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});
```

**NOTE**: your queue must be created in the `/concierge/queues` folder

The second parameter gives you full control over the queue behavior

### Creating Workers

For jobs to be processed at least one worker is required. Workers don't have to necessarily be running in a nuxt, but if you want to manage workers in nuxt, you can create one using `defineWorker`

For example:

`/concierge/workers/my-worker.ts`:

```ts
export default defineWorker("MyWorker", async (job) => {
  // Do something
});
```

Workers defined this way will **automatically be started** during application startup

**NOTE**: your queue must be created in the `/concierge/workers` folder

### Accessing queues

To access queues, a `getQueue` helper is provided.

```ts
import { $concierge } from "#concierge";

export default defineEventHandler(async (event) => {
  const { getQueue } = $concierge();
  const myQueue = getQueue("MyQueue");

  await myQueue.add("myJob", { foo: "bar" });

  return true;
});
```

This would add a job to the queue and will be processed by the worker.

### Queue Management UI

The Concierge dashboard can be accessed at:

http://localhost:3000/\_concierge/

## FAQ

1. **Does this work in a serverless environment?**

Yes and no, but mostly no. Serverless environments typically have a timeout, so workers will not be able to run in the backgorund to reliably process jobs. If you want to use this module in a serverless environment, I recommend to deploy your workers elsewhere, and just reference the queues in this module. This way you can still leverage the other features, like queue management, and ui.

2. **Can I disable the Queue management UI in production?**

The management UI is already disabled by default in production. If you waan't to enable it in production, you must enable it explicitly in the options:

```ts
export default defineNuxtConfig({
  concierge: {
    redis: {
      host: "...",
    },
    enabled: true,
  },
});
```

3. **Can I password protect the Queue management UI?**

Auth for the UI is out of scope of this module, but it can easily be done using the [Nuxt Security](https://nuxt-security.vercel.app/)


## Development

```bash
# Install dependencies
pnpm install

# Generate type stubs
pnpm dev:prepare

# Develop with the playground
pnpm dev

# Build the playground
pnpm dev:build

# Run ESLint
pnpm lint

# Run Vitest
pnpm test
pnpm test:watch

# Release new version
pnpm release
```

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/my-module/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/my-module
[npm-downloads-src]: https://img.shields.io/npm/dm/my-module.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/my-module
[license-src]: https://img.shields.io/npm/l/my-module.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://npmjs.com/package/my-module
[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt.js
[nuxt-href]: https://nuxt.com
