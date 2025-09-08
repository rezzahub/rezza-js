import _ from "lodash";
import isEqual from "lodash-es/isEqual";
import { NowSchema, RandomSchema, WaitSchema } from "./schemas";
import type {
  DAGNode,
  FullStepContext,
  StepContext,
  Warning,
  WorkflowContext,
} from "./types";
import { Skip } from "./types";
import { sleep } from "./utils";

type SharedKey<T, R> = keyof T & keyof R

export interface RunOptions {
  timeout?: number;
  now?: () => number;
}

class InputInterrupt extends Error {
  constructor(
    public step: FullStepContext,
    public waitUntil?: number,
  ) {
    super(`Interrupt at ${step}`); // (1)
  }
}

class PromiseInterrupt extends Error {
  constructor(
    public step: string,
    public promise: Promise<unknown>,
    public context: StepContext,
  ) {
    super(`Interrupt at ${step}`); // (1)
  }
}

/**
 * Represents an interruption in the workflow execution due to a time-based condition.
 * This type is used when a node is waiting for a specific time to be reached before continuing.
 */
export type InterruptedUntil = { waitUntil?: number };
/**
 * Represents an interruption in the workflow execution due to a required user input.
 * This type is used when a node is waiting for user input that conforms to a specific JSON schema.
 */
export type InterruptedValue = {
  /* The JSON schema describing the expected input structure. */
  schema: object;
};

/**
 * Represents an event that occurred during a workflow step.
 * This type is used to capture and store information about specific actions or data
 * produced during the execution of a workflow node.
 /**
  * Represents an event that occurred during a workflow step.
  * This type is used to capture and store information about specific actions or data
  * produced during the execution of a workflow node.
  */
export type StepEventWithContext = {
  /** The key or name of the event, represented as an array of strings. */
  k: string[];
  /** The value associated with the event, which can be of any type. */
  v: unknown;
  /** The timestamp of when the event occurred, represented as a number (milliseconds since epoch). */
  ts: number;
  /** Optional context object containing metadata about the step being executed */
  c: StepContext;
  /** The input keys associated with the step, represented as an array of arrays of strings. */
  i?: string[][];
};

export type StepEvent = Omit<StepEventWithContext, "c">;

/**
 * Represents the result of a workflow node execution.
 * This type is used to indicate the current state of a node's execution,
 * which can be pending, successful, erroneous, or interrupted.
 *
 * @typeParam T - The type of the value produced by the node.
 * @typeParam Node - The type of the node identifier (defaults to string).
 *
 * The Result type can be one of the following:
 * - pending: Indicates that the node is waiting for its dependencies to complete.
 * - ok: Indicates that the node has successfully completed execution.
 * - err: Indicates that an error occurred during the node's execution.
 * - intr: Indicates that the node's execution was interrupted, possibly due to
 *         a time-based condition or a need for additional input.
 */
export type Result<T, Node extends string = string> =
  | { status: "pending"; nodes: Node[]; tags?: string[] }
  | { status: "done"; value: T; tags?: string[] }
  | { status: "err"; error: Error; tags?: string[] }
  | { status: "skipped"; reason: string; tags?: string[] }
  | ({
    status: "intr";
    step: FullStepContext;
    value?: T;
    eventIdx?: number;
    tags?: string[];
  } & (
      | InterruptedUntil
      | InterruptedValue
      | (InterruptedUntil &
        InterruptedValue) // timeout
    ));

/**
 * Represents a workflow that can execute a directed acyclic graph (DAG) of nodes.
 * Each node in the workflow can compute a value and depend on other nodes.
 *
 * @typeParam T - A record type where keys are node names and values are DAGNode types.
 *
 * The Workflow class provides methods to:
 * - Execute nodes in topological order
 * - Handle dependencies between nodes
 * - Manage interruptions and resumptions in node execution
 * - Capture and replay events for idempotency
 * - Perform dry runs and actual runs of the workflow
 *
 * It implements the WorkflowContext interface, providing utility methods
 * that can be used within node computations, such as `get`, `step`, `capture`,
 * `now`, `sleep`, `waitUntil`, and `random`.
 */
export class Workflow<
  T extends Record<string, DAGNode<unknown, string>>,
  R extends Record<string, any> = Record<string, unknown>,
> implements WorkflowContext<T> {
  private events: { [K in keyof T]?: StepEvent[] } = {};
  private snapshots: { [K in keyof T]?: [number, T[K]["value"]] } = {};

  private tempResults: R | null = null;

  private tempNewEvents: { [K in keyof T]?: StepEventWithContext[] } | null =
    null;
  private newConsumedEvents: StepEventWithContext[] | null = null;
  private tempRunOpts: RunOptions | null = null;
  private tempWarnings: Warning[] | null = null;

  private currentNode: keyof T | null = null;
  private currentKeys: string[] = [];

  constructor(private nodes: T) { }

  get = <K extends string>(key: K): T[K]["value"] => {
    const result = this.tempResults?.[key as keyof R] as any;
    if (!result) return undefined;

    // Handle single result
    if (!Array.isArray(result)) {
      if (result.status === "done") return result.value;
      if (result.status === "intr") return result.value;
      return undefined;
    }

    // Handle array of results - return first completed one
    for (const r of result) {
      if (r.status === "done") return r.value;
      if (r.status === "intr") return r.value;
    }

    return undefined;
  };

  tags = () => [];

  step = <T>(context: StepContext): T => {
    throw new InputInterrupt({
      ...context,
      key: [...this.currentKeys, context.key],
    });
  };

  addTempEvent = (
    key: string,
    newEvent: unknown,
    context: StepContext<unknown>,
  ): void => {
    const event: StepEventWithContext = {
      k: [...this.currentKeys, key],
      v: newEvent,
      c: context,
      ts: this.getNow(),
    };
    this.tempNewEvents![this.currentNode!] ||= [];
    this.tempNewEvents![this.currentNode!]!.push(event);
    this.newConsumedEvents?.push(event);
  };

  capture = <T>(context: StepContext, fn: () => T | Promise<T>): T => {
    const stepKey = `capture:${context.key}`;
    try {
      return this.step<T>({ ...context, key: stepKey });
    } catch (e) {
      if (e instanceof InputInterrupt) {
        const newEvent = fn();
        if (newEvent instanceof Promise) {
          throw new PromiseInterrupt(stepKey, newEvent, context);
        }
        this.addTempEvent(stepKey, newEvent, context);
        return newEvent;
      }
      throw e;
    }
  };

  getNow = (): number =>
    this.tempRunOpts?.now ? this.tempRunOpts.now() : Date.now();
  now = (): number =>
    this.capture({ key: "now", schema: NowSchema }, this.getNow);

  sleep = (ms: number, context?: Partial<StepContext>): void => {
    this.waitUntil(this.now() + ms, { key: "sleep", ...context });
  };

  waitUntil = (datetime: number, context?: Partial<StepContext>): void => {
    if (this.getNow() < datetime)
      throw new InputInterrupt(
        {
          schema: WaitSchema,
          ...context,
          key: [...this.currentKeys, "waitUntil"],
        },
        datetime,
      );
  };

  random = (): number => {
    return this.capture({ key: "random", schema: RandomSchema }, Math.random);
  };

  private async executeNode<K extends SharedKey<T, R>>(
    key: K,
    events: StepEvent[],
  ): Promise<R[K]> {
    const node = this.nodes[key];

    const pending = this.nodes[key].dependencies.filter((n) => {
      const result = this.tempResults?.[n];
      if (!result) return true;

      // Handle single result
      if (!Array.isArray(result)) {
        return !(
          result.status === "done" ||
          (result.status === "intr" && result.value !== undefined)
        );
      }

      // Handle array of results - check if any instance is completed
      return !result.some(
        (r) =>
          r.status === "done" || (r.status === "intr" && r.value !== undefined),
      );
    });

    if (pending.length > 0) {
      return { status: "pending", nodes: pending } as R[K];
    }

    let idx = 0;
    const originalStep = this.step;
    let promiseCount = 0;
    const MAX_PROMISES = 1000;
    while (promiseCount < MAX_PROMISES) {
      const allEvents = [
        ...(this.events[key] ?? []),
        ...events,
        ...(this.tempNewEvents?.[key] ?? []),
      ];
      this.step = <T>(context: StepContext): T => {
        if (idx < allEvents?.length) {
          const event = allEvents[idx++];
          const fullKey = [...this.currentKeys, context.key];
          this.newConsumedEvents?.push({
            ...event,
            c: context,
          });
          if (isEqual(event.k, fullKey)) {
            const eventInputKeys = event.i;
            const currentInputKeys = context.inputs?.map((i) => i.key);

            if (!_.isEqual(eventInputKeys, currentInputKeys)) {
              this.tempWarnings?.push({
                type: "context_updated",
                step: fullKey,
                context,
              });
            }

            return event.v as T;
          }
          throw new Error(
            `Expected event ${fullKey} but got ${event.k} instead`,
          );
        }
        throw new InputInterrupt({
          ...context,
          key: [...this.currentKeys, context.key],
        });
      };

      // Generate instance tags if instance function exists
      let tags: string[] | undefined = undefined;
      try {
        if (node.instance) {
          tags = node.instance(this);
        }
      } catch {
        // If instance generation fails, node won't have tags but continues without them
        tags = undefined;
      }

      let value: T[K]["value"] | undefined = undefined;
      let eventIdx = 0;
      try {
        const snapshot = this.snapshots[key];
        if (node.saga && snapshot) {
          idx = snapshot[0];
          value = snapshot[1];
        } else {
          value = await node.compute(this);
        }

        if (node.saga) {
          while (true) {
            eventIdx = idx;
            const [action, newValue] = node.saga(this, value);
            if (this.tempRunOpts?.timeout) await sleep(0);
            value = newValue;
            if (action === "halt") {
              break;
            }
          }
        }

        return { status: "done", value: value, tags } as R[K];
      } catch (error) {
        if (error instanceof PromiseInterrupt) {
          try {
            const newEvent = await error.promise;
            promiseCount += 1;
            this.addTempEvent(error.step, newEvent, error.context);
          } catch (error) {
            if (error instanceof Error) {
              // console.log(error);
              return { status: "err", error, tags } as R[K];
            }
            return { status: "err", error: new Error("Unknown"), tags } as R[K];
          }
        } else if (error instanceof InputInterrupt) {
          return {
            status: "intr",
            step: error.step,
            ...(error.waitUntil ? { waitUntil: error.waitUntil } : {}),
            ...(value ? { value } : {}),
            ...(eventIdx ? { eventIdx } : {}),
            tags,
          } as R[K];
        } else if (error instanceof Skip) {
          return {
            status: "skipped",
            reason: error.message,
            tags,
          } as R[K];
        } else {
          if (error instanceof Error) {
            return { status: "err", error, tags } as R[K];
          }
          return { status: "err", error: new Error("Unknown"), tags } as R[K];
        }
      } finally {
        this.step = originalStep;
      }
    }
    return {
      status: "err",
      error: new Error("Too many promises in a single step!"),
    } as R[K];
  }

  getDependencies<K extends keyof T>(key: K): T[K]["dependencies"] {
    return this.nodes[key].dependencies;
  }

  topology(): {
    node: keyof T;
    schema: object;
    dependencies: string[];
    title?: string;
    description?: string;
    isSaga?: boolean;
    type?: string;
    stepSchemas?: Record<string, { input?: object; output?: object }>;
    optionalDeps?: string[];
    optionalDepsLimit?: number;
    instances?: (context: WorkflowContext) => string[][];
    sagaInstances?: (
      context: WorkflowContext & { getInstanceResults: () => unknown[] },
    ) => string[][];
  }[] {
    const visited = new Set<keyof T>();
    const result: {
      node: keyof T;
      schema: object;
      dependencies: string[];
      title?: string;
      description?: string;
      isSaga?: boolean;
      type?: string;
      stepSchemas?: Record<string, { input?: object; output?: object }>;
      optionalDeps?: string[];
      optionalDepsLimit?: number;
      instances?: (context: WorkflowContext) => string[][];
      sagaInstances?: (
        context: WorkflowContext & { getInstanceResults: () => unknown[] },
      ) => string[][];
    }[] = [];

    const visit = (node: keyof T) => {
      if (visited.has(node)) return;
      visited.add(node);
      for (const dep of this.nodes[node].dependencies) {
        visit(dep);
      }
      const nodeData = {
        node,
        dependencies: this.nodes[node].dependencies,
        schema: this.nodes[node].schema,
        title: this.nodes[node].title,
        isSaga: !!this.nodes[node].saga,
        description: this.nodes[node].description,
        type: this.nodes[node].type,
        stepSchemas: this.nodes[node].stepSchemas,
        optionalDeps: this.nodes[node].optionalDeps,
        optionalDepsLimit: this.nodes[node].optionalDepsLimit,
        // ...(this.nodes[node].instances && { instances: this.nodes[node].instances }),
        // ...(this.nodes[node].sagaInstances && { sagaInstances: this.nodes[node].sagaInstances }),
      };
      result.push(nodeData);
    };

    for (const node of Object.keys(this.nodes) as (keyof T)[]) {
      visit(node);
    }

    return result;
  }

  topologicalSort(): (SharedKey<T, R>)[] {
    const visited = new Set<keyof T>();
    const result: (SharedKey<T, R>)[] = [];

    const visit = (node: SharedKey<T, R>) => {
      if (visited.has(node)) return;
      visited.add(node);
      for (const dep of this.nodes[node].dependencies) {
        visit(dep);
      }
      result.push(node);
    };

    for (const node of Object.keys(this.nodes) as (SharedKey<T, R>)[]) {
      visit(node);
    }

    return result;
  }
  isRunning = false;

  executeNodes = async (incomingEvents: StepEvent[]): Promise<void> => {
    for (const node of this.topologicalSort()) {
      this.currentNode = node;
      this.currentKeys.push(node as string);

      const nodeConfig = this.nodes[node];

      // Check if this is a multi-instance node
      if (nodeConfig.instances) {
        // For now, return empty array for multiple instances
        this.tempResults![node] = [] as any;
      } else {
        // Single instance node - execute normally
        const result = await this.executeNode(
          node,
          incomingEvents.filter((e) => e.k[0] === node),
        );
        this.tempResults![node] = result;
      }

      this.currentKeys.pop();
    }
  };

  async dryRun(
    incomingEvents: StepEvent[],
    opts?: RunOptions,
  ): Promise<{
    values: R;
    warnings?: Warning[];
    newEvents: StepEventWithContext[];
    timeout: boolean;
  }> {
    if (this.isRunning) {
      throw new Error("Workflow is already running");
    }
    this.isRunning = true;
    this.tempResults = {} as any;
    this.tempNewEvents = {};
    this.newConsumedEvents = [];
    this.tempRunOpts = opts ?? null;
    this.tempWarnings = [];

    let timeout = false;

    const executionPromise = this.executeNodes(incomingEvents);

    if (opts?.timeout) {
      await Promise.race([
        executionPromise,
        sleep(opts?.timeout ?? 1000).then(() => {
          timeout = true;
        }),
      ]);
    } else {
      await executionPromise;
    }

    const results = this.tempResults;
    const warnings = this.tempWarnings;
    const newEvents = this.newConsumedEvents;
    this.tempWarnings = null;
    this.newConsumedEvents = null;
    this.tempRunOpts = null;
    this.tempResults = null;
    this.tempNewEvents = null;
    this.isRunning = false;
    return { values: results!, newEvents, timeout, warnings };
  }

  async run(
    incomingEvents?: StepEvent[],
    opts?: RunOptions,
  ): Promise<R> {
    const {
      newEvents,
      values: results,
      timeout,
    } = await this.dryRun(incomingEvents ?? [], opts);

    if (timeout) throw new Error("Timeout");

    this.events ||= {};
    for (const e of newEvents) {
      const node = e.k[0] as keyof T;
      this.events[node] ||= [];
      this.events[e.k[0]]!.push(e);
    }
    for (const k in results) {
      const result = results[k];
      if (!result) continue;

      // Handle single result
      if (!Array.isArray(result)) {
        if (result.status === "intr" && result.eventIdx) {
          this.snapshots[k] = [result.eventIdx, result.value];
        }
      } else {
        // Handle array of results - use first interrupted result for snapshots
        const interruptedResult = result.find(
          (r: Result<unknown>) => r.status === "intr" && r.eventIdx,
        );
        if (interruptedResult) {
          this.snapshots[k] = [
            interruptedResult.eventIdx,
            interruptedResult.value,
          ];
        }
      }
    }
    return results;
  }
  spawn(): Workflow<T, R> {
    return new Workflow(this.nodes);
  }
  fork(): Workflow<T, R> {
    const w = new Workflow<T, R>(this.nodes);
    w.events = { ...this.events };
    w.snapshots = { ...this.snapshots };
    return w;
  }
}
