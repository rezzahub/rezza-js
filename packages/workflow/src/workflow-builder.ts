import { Parse } from "@sinclair/typebox/build/cjs/value";
import { type DoneWithNote, DoneWithNoteSchema, done } from "./schemas";
import type { DAGNode, NodeConfig, Without, WorkflowContext } from "./types";
import { type Result, Workflow } from "./workflow";

// type X = { a: number, b: number } | { a: number, c: number }
// type X = { z?: number, a: number } & ({ b: number } | { c: number })
// type K = keyof X;
// type Without<T, K extends string | number | symbol> = T extends any ? Omit<T, K> : never;
// type Y = Without<X, 'a'>;
// let y: Y = { b: 0 };
// type Y = Omit<X, 'a'>

type NodeValue = string | number | boolean | (object & { then?: never });

/**
 * A builder class for creating workflows with typed nodes
 *
 * @example
 * ```typescript
 * const workflow = WorkflowBuilder.create()
 *   .addNode({ key: "name" }, () => "World")
 *   .addNode({ key: "greeting", deps: ["name"] }, ({ get }) => `Hello, ${get("name")}!`)
 *   .build();
 *
 * const result = await workflow.run();
 * console.log(result.greeting); // Output: "Hello, World!"
 * ```
 */
export class WorkflowBuilder<
  T extends Record<string, DAGNode<unknown, string, boolean>> = Record<never, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  R extends Record<string, any> = Record<never, unknown>,
> {
  private nodes: T = {} as T;

  /**
   * Shorthand for Task nodes - default completion tracking
   */
  addTask<K extends string, D extends Extract<keyof T, string>>(
    config: Without<
      NodeConfig<K, D, DoneWithNote>,
      "type" | "stepSchemas" | "schema" | "instances" | "sagaInstances"
    >,
    compute?: (context: WorkflowContext<T>) => void,
  ) {
    return this.addNodeBase(
      {
        ...config,
        type: "task",
        schema: DoneWithNoteSchema,
      },
      (ctx) => {
        compute?.(ctx);
        return done();
      },
    );
  }

  /**
   * Shorthand for Form nodes - data collection with schema validation
   */
  addForm<
    K extends string,
    V extends NodeValue,
    D extends Extract<keyof T, string>,
    C extends Without<
      NodeConfig<K, D, V>,
      "type" | "stepSchemas" | "instances" | "sagaInstances"
    >
  >(
    config: C,
    compute?: (context: WorkflowContext<T>) => void,
  ) {
    return this.addNodeBase({ ...config, type: "form" }, (ctx) => {
      compute?.(ctx);
      return Parse(config.schema, ctx.step({
        ...config,
        key: "form_input",
      }));
    });
  }

  /**
   * Shorthand for Validation nodes - business rule enforcement
   */
  addValidation<K extends string, D extends Extract<keyof T, string>>(
    config: Without<
      NodeConfig<K, D, DoneWithNote>,
      "type" | "stepSchemas" | "schema" | "instances" | "sagaInstances"
    >,
    compute: (context: WorkflowContext<T>) => void,
  ) {
    return this.addNodeBase(
      { ...config, schema: DoneWithNoteSchema, type: "validation" },
      (step) => {
        compute?.(step);
        return done();
      },
    );
  }
  // Implementation
  addNode<
    K extends string,
    V extends NodeValue,
    D extends Extract<keyof T, string>,
    C extends Without<NodeConfig<K, D, V>, "type">,
  >(
    config: C,
    compute: (context: WorkflowContext<T>) => V,
    saga?: (context: WorkflowContext<T>, value: V) => ["cont" | "halt", V],
  ) {
    return this.addNodeBase({ ...config, type: "complex" }, compute, saga);
  }

  // Implementation that handles both v0.8 and backward compatibility signatures
  private addNodeBase<
    K extends string,
    V extends NodeValue,
    D extends Extract<keyof T, string>,
    C extends NodeConfig<K, D, V>,
  >(
    config: C,
    compute: (context: WorkflowContext<T>) => V,
    saga?: (context: WorkflowContext<T>, value: V) => ["cont" | "halt", V],
  ): WorkflowBuilder<T & Record<K, DAGNode<V, D, boolean>>, R & Record<K, Result<V>>> {
    const nodeKey = config.key;
    if (nodeKey in this.nodes) {
      throw new Error(`Node ${String(nodeKey)} already exists`);
    }

    // Check if all dependencies exist
    for (const dep of config.deps ?? []) {
      if (!(dep in this.nodes)) {
        throw new Error(`Dependency ${String(dep)} does not exist`);
      }
    }

    for (const dep of config.optionalDeps ?? []) {
      if (!(dep in this.nodes)) {
        throw new Error(`Optional dependency ${String(dep)} does not exist`);
      }
    }

    // Handle different node types
    const newNodes = {
      ...this.nodes,
      [nodeKey]: {
        compute,
        dependencies: config.deps ?? [],
        optionalDeps: config.optionalDeps,
        optionalDepsLimit: config.optionalDepsLimit,
        title: config.title,
        description: config.description,
        type: config.type,
        stepSchemas: config.stepSchemas,
        instances: "instances" in config ? config.instances : undefined,
        instance: "instance" in config ? config.instance : undefined,
        sagaInstances:
          "sagaInstances" in config ? config.sagaInstances : undefined,
        saga,
        multiple: "instances" in config,
        schema: config.schema,
      },
    };

    // Create a new instance with the updated nodes
    return new WorkflowBuilder<
      T & Record<K, DAGNode<V, D, boolean>>,
      R & Record<K, Result<V>>
    >(newNodes as T & Record<K, DAGNode<V, D, boolean>>);
  }

  /**
   * Creates a new instance of WorkflowBuilder.
   *
   * @returns A new WorkflowBuilder instance
   */
  static create(): WorkflowBuilder {
    return new WorkflowBuilder({});
  }

  private constructor(nodes: T) {
    this.nodes = nodes;
  }

  /**
   * Builds and returns a Workflow instance based on the current configuration.
   *
   * @returns  A new Workflow instance
   */
  build(): Workflow<T, R> {
    return new Workflow<T, R>(this.nodes);
  }
}
