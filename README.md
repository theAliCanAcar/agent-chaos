# Agent Chaos

Chaos engineering for agents: deterministic fault injection, latency gremlins, flaky tools, and seeded randomness.

TypeScript package `agent-chaos`.

## Install

```sh
npm install github:theAliCanAcar/agent-chaos#main
```

## How to use

```ts
import { tool } from 'agent-tools';
import { withChaos } from 'agent-chaos';
import { z } from 'zod';

const pay = tool({
  name: 'pay_invoice',
  description: 'Pay an invoice',
  schema: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ paid: id }),
});

const shaky = withChaos(pay, { seed: 42, rate: 0.5, modes: ['fail', 'latency'] });
console.log(await shaky.execute({ id: 'inv-1' }, {}));
console.log(shaky.chaosCount());
```

## Use cases

### 1. Prove recovery under flaky tools

- **Scenario:** Production APIs time out and fail randomly.
- **Outcome:** Wrap tools with withChaos/chaosMonkey using a fixed seed and assert recovery behavior.

### 2. Regression-test a resilience wrapper

- **Scenario:** You added retry around payments.
- **Outcome:** Replay the same seed and confirm chaosCount and final outcomes.

## Dependencies

- `agent-tools`: `github:theAliCanAcar/agent-tools#main`

## Scripts

```sh
npm install
npm run build
```

## Notes

- Keep API keys in environment variables or a gitignored `.env`. Never commit secrets.
- Side-effecting tools should go through approval when used with `agent-approval`.
- Related packages live in separate repositories under [theAliCanAcar](https://github.com/theAliCanAcar).

## License

MIT
