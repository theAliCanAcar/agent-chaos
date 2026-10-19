/**
 * agent-chaos: break your tools on purpose so your agent survives contact
 * with reality. Deterministic fault injection via a seeded PRNG, latency
 * gremlins, flaky tools, and a monkey that shakes every tool in a registry.
 *
 *   const shaky = chaosMonkey([payInvoice, sendEmail], { seed: 42, failRate: 0.3 });
 */
import {
  failure,
  isFailure,
  runTool,
  type Tool,
  type ToolContext,
  type ToolFailure,
  type ToolResult,
} from "agent-tools";

/** Mulberry32: tiny deterministic PRNG. Same seed -> same chaos, every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ChaosMode = "fail" | "latency" | "corrupt" | "hang" | "none";

export type ChaosConfig = {
  /** Seed for reproducible chaos. Default 1337. */
  seed?: number;
  /** Probability [0..1] that a call gets hit with chaos. Default 0.5. */
  rate?: number;
  /** Which kinds of chaos to unleash. Default ["fail", "latency"]. */
  modes?: ChaosMode[];
  /** Latency range in ms when "latency" fires. Default 1–50ms. */
  latencyMs?: [number, number];
  /** Custom failure injected when "fail" fires. */
  failureFactory?: (input: unknown) => ToolFailure;
  /** Called whenever chaos fires — great for assertions in tests. */
  onChaos?: (event: { mode: ChaosMode; input: unknown }) => void;
};

export type Chaotic<I, O> = Tool<I, ToolResult<O>> & {
  /** Number of times chaos actually fired. */
  chaosCount: () => number;
};

/**
 * Wrap a tool so it randomly fails, lags, corrupts, or hangs — reproducibly.
 */
export function withChaos<I, O>(t: Tool<I, O>, config: ChaosConfig = {}): Chaotic<I, O> {
  const rand = seededRandom(config.seed ?? 1337);
  const rate = clamp01(config.rate ?? 0.5);
  const modes: ChaosMode[] = config.modes ?? ["fail", "latency"];
  const [minLatency, maxLatency] = config.latencyMs ?? [1, 50];
  let fired = 0;

  const wrapped: Chaotic<I, O> = {
    name: t.name,
    description: `${t.description} (chaos-wrapped)`,
    schema: t.schema,
    ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
    chaosCount: () => fired,
    async execute(input: I, ctx: ToolContext): Promise<ToolResult<O>> {
      if (modes.length === 0 || rand() >= rate) {
        return runTool(t, input, ctx).then((o) => (o.ok ? o.value : o));
      }
      const mode = modes[Math.floor(rand() * modes.length)] ?? "fail";
      fired += 1;
      config.onChaos?.({ mode, input });

      switch (mode) {
        case "fail":
          return config.failureFactory
            ? config.failureFactory(input)
            : failure("CHAOS_FAILURE", `Injected chaos failure on ${t.name}.`, { retryable: true });
        case "latency": {
          const delay = minLatency + rand() * Math.max(0, maxLatency - minLatency);
          await sleep(delay, ctx.signal);
          const outcome = await runTool(t, input, ctx);
          return outcome.ok ? outcome.value : outcome;
        }
        case "corrupt":
          return "~~chaos-corrupted-output~~" as unknown as ToolResult<O>;
        case "hang":
          return new Promise<ToolResult<O>>((_resolve, reject) => {
            // Hang forever unless the caller aborts — the timeout() wrapper is the antidote.
            ctx.signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("Chaos hang aborted."), { code: "ABORT_ERR" })),
              { once: true }
            );
          });
        default:
          return runTool(t, input, ctx).then((o) => (o.ok ? o.value : o));
      }
    },
  };
  return wrapped;
}

/**
 * Make a tool that is flaky N times before succeeding — classic retry tester.
 */
export function flakyTool<I, O>(
  t: Tool<I, O>,
  failuresBeforeSuccess: number,
  failureFactory?: (attempt: number) => ToolFailure
): Tool<I, ToolResult<O>> {
  let attempts = 0;
  return {
    name: t.name,
    description: t.description,
    schema: t.schema,
    ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
    async execute(input: I, ctx: ToolContext): Promise<ToolResult<O>> {
      attempts += 1;
      if (attempts <= failuresBeforeSuccess) {
        return failureFactory
          ? failureFactory(attempts)
          : failure("FLAKY_FAILURE", `Flaky failure #${attempts} on ${t.name}.`, { retryable: true });
      }
      const outcome = await runTool(t, input, ctx);
      return outcome.ok ? outcome.value : outcome;
    },
  };
}

/** Shake every tool in a list with the same chaos config (shared seed stream). */
export function chaosMonkey<I, O>(tools: Array<Tool<I, O>>, config: ChaosConfig = {}): Array<Chaotic<I, O>> {
  const rand = seededRandom(config.seed ?? 1337);
  return tools.map((t, index) =>
    withChaos(t, { ...config, seed: Math.floor(rand() * 2 ** 31) + index })
  );
}

/** A tool that always explodes in exotic ways — for hardening error paths. */
export function bombTool(name = "bomb_tool"): Tool<unknown, ToolFailure> {
  return {
    name,
    description: "Always throws a non-Error value to stress-test error mapping.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<ToolFailure> {
      throw "not even an Error instance 💣";
    },
  };
}

/** Detect whether an outcome is one of our injected chaos failures. */
export function isChaosFailure(value: unknown): boolean {
  return isFailure(value) && String((value as ToolFailure).error.code).startsWith("CHAOS_");
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}